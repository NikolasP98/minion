#!/usr/bin/env bash
# ---
# name: "Variable Classification & Validation"
# description: >
#   4-tier variable classification (required, inferable, system-derived, flexible),
#   validation helpers, profile loading with yq/grep fallback, and display_config.
# produces:
#   - "Validated and derived configuration variables"
#   - "Functions: validate_required_variables, derive_system_variables, display_config"
# ---

# Source logging if not already loaded
if ! command -v log_info &> /dev/null; then
    source "$(dirname "${BASH_SOURCE[0]}")/logging.sh"
fi

# --- Variable classification ---

# Required in remote mode; some optional in local mode
REQUIRED_REMOTE=(
    "VPS_HOSTNAME"
)

# LLM provider keys — at least one must be set
LLM_PROVIDER_KEYS=(
    "ANTHROPIC_API_KEY"
    "OPENROUTER_API_KEY"
)

# Always required regardless of mode (empty — provider key checked separately)
REQUIRED_ALWAYS=()

# Inferable variables (AI derives from conversation or set via profile)
INFERABLE_FROM_CONVERSATION=(
    "AGENT_NAME"
    "AGENT_PERSONALITY"
    "SANDBOX_MODE"
    "DM_POLICY"
    "ENABLE_WHATSAPP"
    "ENABLE_TELEGRAM"
    "ENABLE_DISCORD"
    "ENABLE_WEB"
)

# System-derived variables (automatically generated)
SYSTEM_DERIVED=(
    "GATEWAY_PORT"
    "GATEWAY_BIND"
    "AGENT_MODEL"
    "AGENT_USERNAME"
    "GATEWAY_AUTH_TOKEN"
    "AGENT_HOME_DIR"
    "MINION_CONFIG_DIR"
    "WORKSPACE_DIR"
    "MINION_ROOT"
    "MINION_WRAPPER"
    "MINION_BIN"
    "MINION_PKG_ROOT"
    "NODE_BIN_PATH"
)

# Flexible parameters (accept multiple input formats)
FLEXIBLE_PARAMETERS=(
    "NODE_INSTALL_METHOD"
    "INSTALL_METHOD"
    "PACKAGE_MANAGER"
    "SERVICE_MANAGER"
    "BACKUP_TARGET"
    "EXPECTED_LOAD"
    "EXEC_MODE"
    "GITHUB_REPO"
    "GITHUB_BRANCH"
)

# Validate that required variables are set (mode-aware)
validate_required_variables() {
    local missing=()

    # Always-required
    for var in "${REQUIRED_ALWAYS[@]}"; do
        if [ -z "${!var:-}" ]; then
            missing+=("$var")
        fi
    done

    # Remote-only requirements
    if [ "${EXEC_MODE:-local}" = "remote" ]; then
        for var in "${REQUIRED_REMOTE[@]}"; do
            if [ -z "${!var:-}" ]; then
                # Avoid duplicates
                local already=false
                for m in "${missing[@]}"; do
                    [ "$m" = "$var" ] && already=true
                done
                $already || missing+=("$var")
            fi
        done
    fi

    # Check that at least one LLM provider key is set
    local has_provider=false
    for var in "${LLM_PROVIDER_KEYS[@]}"; do
        if [ -n "${!var:-}" ]; then
            has_provider=true
            break
        fi
    done
    if [ "$has_provider" = "false" ]; then
        missing+=("ANTHROPIC_API_KEY or OPENROUTER_API_KEY")
    fi

    if [ ${#missing[@]} -gt 0 ]; then
        log_error "Missing required variables:"
        for var in "${missing[@]}"; do
            echo -e "  - ${YELLOW}$var${NC}"
        done
        return 1
    fi

    return 0
}

# Derive system variables from user inputs
derive_system_variables() {
    # Execution mode
    EXEC_MODE="${EXEC_MODE:-local}"

    # Install method: package (npm registry) or source (git clone + build)
    INSTALL_METHOD="${INSTALL_METHOD:-package}"
    PACKAGE_MANAGER="${PACKAGE_MANAGER:-npm}"

    # Source install settings
    GITHUB_REPO="${GITHUB_REPO:-NikolasP98/minion}"
    GITHUB_BRANCH="${GITHUB_BRANCH:-main}"

    # Agent username from agent name
    if [ -n "${AGENT_NAME:-}" ]; then
        AGENT_USERNAME="${AGENT_USERNAME:-minion-${AGENT_NAME// /-}}"
        AGENT_USERNAME="${AGENT_USERNAME,,}"  # lowercase
    else
        AGENT_USERNAME="${AGENT_USERNAME:-minion}"
    fi

    # Generate gateway port (default 18789)
    GATEWAY_PORT="${GATEWAY_PORT:-18789}"

    # Generate auth token if not provided
    if [ -z "${GATEWAY_AUTH_TOKEN:-}" ]; then
        GATEWAY_AUTH_TOKEN=$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid 2>/dev/null || openssl rand -hex 16)
    fi

    # Set directory paths based on mode
    if [ "$EXEC_MODE" = "local" ]; then
        AGENT_HOME_DIR="${AGENT_HOME_DIR:-$HOME}"
    else
        AGENT_HOME_DIR="${AGENT_HOME_DIR:-/home/${AGENT_USERNAME}}"
    fi

    if [ "$INSTALL_METHOD" = "source" ]; then
        MINION_ROOT="${MINION_ROOT:-${AGENT_HOME_DIR}/minion}"
        MINION_WRAPPER="${MINION_WRAPPER:-${AGENT_HOME_DIR}/.local/bin/minion}"
    else
        # Package install: MINION_BIN and MINION_PKG_ROOT resolved in phase 40
        MINION_BIN="${MINION_BIN:-}"
        MINION_PKG_ROOT="${MINION_PKG_ROOT:-}"
    fi
    MINION_CONFIG_DIR="${MINION_CONFIG_DIR:-${AGENT_HOME_DIR}/.minion}"
    WORKSPACE_DIR="${WORKSPACE_DIR:-${MINION_CONFIG_DIR}/workspace}"

    # Detect node binary path
    NODE_BIN_PATH="${NODE_BIN_PATH:-$(command -v node 2>/dev/null || echo "/usr/bin/node")}"

    # Channel defaults
    ENABLE_WHATSAPP="${ENABLE_WHATSAPP:-false}"
    ENABLE_TELEGRAM="${ENABLE_TELEGRAM:-false}"
    ENABLE_DISCORD="${ENABLE_DISCORD:-false}"
    ENABLE_WEB="${ENABLE_WEB:-true}"

    # Gateway defaults
    GATEWAY_BIND="${GATEWAY_BIND:-loopback}"
    if [ -z "${AGENT_MODEL:-}" ]; then
        if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
            AGENT_MODEL="anthropic/claude-sonnet-4-5"
        elif [ -n "${OPENROUTER_API_KEY:-}" ]; then
            AGENT_MODEL="openrouter/openai/gpt-4o"
        else
            AGENT_MODEL="anthropic/claude-sonnet-4-5"
        fi
    fi

    # Security defaults
    SANDBOX_MODE="${SANDBOX_MODE:-non-main}"
    DM_POLICY="${DM_POLICY:-pairing}"

    # Resource defaults
    MEMORY_LIMIT="${MEMORY_LIMIT:-2G}"
    CPU_QUOTA="${CPU_QUOTA:-100%}"

    # Bootstrap defaults
    ADMIN_USER="${ADMIN_USER:-niko}"
    BOOTSTRAP_MODE="${BOOTSTRAP_MODE:-false}"
    OP_SSH_KEY_REF="${OP_SSH_KEY_REF:-op://Personal/SSH Key/public key}"
}

# Validate API key format
validate_api_key() {
    local key="$1"
    local key_type="$2"

    case "$key_type" in
        "anthropic")
            if [[ ! "$key" =~ ^sk-ant- ]]; then
                log_error "Invalid Anthropic API key format (should start with 'sk-ant-')"
                return 1
            fi
            ;;
        "github")
            if [[ ! "$key" =~ ^(ghp_|github_pat_) ]]; then
                log_warn "GitHub PAT doesn't match expected format (ghp_* or github_pat_*)"
            fi
            ;;
    esac

    return 0
}

# Validate username format
validate_username() {
    local username="$1"

    if [[ ! "$username" =~ ^[a-z][-a-z0-9]*$ ]]; then
        log_error "Invalid username format: $username"
        log_error "  Username must start with lowercase letter and contain only lowercase letters, digits, and hyphens"
        return 1
    fi

    if [ ${#username} -gt 32 ]; then
        log_error "Username too long (max 32 characters): $username"
        return 1
    fi

    return 0
}

# Load variables from profile file (YAML) with yq/grep fallback
load_profile() {
    local profile_file="$1"

    if [ ! -f "$profile_file" ]; then
        log_error "Profile file not found: $profile_file"
        return 1
    fi

    log_info "Loading profile: $profile_file"

    if command -v yq &> /dev/null; then
        # Use yq for proper YAML parsing
        eval "$(yq eval '.agent | to_entries | .[] | "export " + .key + "=\"" + .value + "\""' "$profile_file" 2>/dev/null)" || true
        eval "$(yq eval '.channels | to_entries | .[] | "export " + .key + "=\"" + .value + "\""' "$profile_file" 2>/dev/null)" || true
        eval "$(yq eval '.security | to_entries | .[] | "export " + .key + "=\"" + .value + "\""' "$profile_file" 2>/dev/null)" || true
        eval "$(yq eval '.system | to_entries | .[] | "export " + .key + "=\"" + .value + "\""' "$profile_file" 2>/dev/null)" || true
    else
        # Fallback to grep-based parsing
        log_debug "yq not found, using grep-based profile parsing"
        while IFS=: read -r key value; do
            key=$(echo "$key" | xargs)
            value=$(echo "$value" | xargs | sed 's/^["'\'']\|["'\'']$//g')
            # Only export uppercase keys (actual variables, not YAML structure)
            if [ -n "$key" ] && [ -n "$value" ] && [[ "$key" =~ ^[A-Z_]+$ ]]; then
                export "${key}=${value}"
            fi
        done < <(grep -E '^\s+[A-Z_]+:' "$profile_file")
    fi

    return 0
}

# Load default values from defaults.yaml config
# Only sets variables that are not already set (CLI args / profile take precedence)
load_defaults() {
    local defaults_file="${SCRIPT_DIR:-$(dirname "${BASH_SOURCE[0]}")/..}/config/defaults.yaml"

    if [ ! -f "$defaults_file" ]; then
        log_debug "No defaults.yaml found at $defaults_file, skipping"
        return 0
    fi

    log_debug "Loading defaults from $defaults_file"

    if command -v yq &> /dev/null; then
        # Use yq for proper YAML parsing.
        # -r = raw output (no surrounding quotes, compatible with yq v3 and v4).
        # head -1 = guard against multi-document YAML files returning multiple lines.
        _yq() { yq -r "${1} // \"\"" "$defaults_file" 2>/dev/null | head -1; }
        PNPM_VERSION="${PNPM_VERSION:-$(_yq '.system.pnpm_version')}"
        NODE_VERSION="${NODE_VERSION:-$(_yq '.system.node_version')}"
        GATEWAY_PORT="${GATEWAY_PORT:-$(_yq '.gateway.port_start')}"
        GATEWAY_BIND="${GATEWAY_BIND:-$(_yq '.gateway.bind')}"
        INSTALL_METHOD="${INSTALL_METHOD:-$(_yq '.install.method')}"
        PACKAGE_NAME="${PACKAGE_NAME:-$(_yq '.install.package_name')}"
        PACKAGE_MANAGER="${PACKAGE_MANAGER:-$(_yq '.install.package_manager')}"
        SANDBOX_MODE="${SANDBOX_MODE:-$(_yq '.security.sandbox_mode')}"
        DM_POLICY="${DM_POLICY:-$(_yq '.security.dm_policy')}"
        unset -f _yq
    else
        # Fallback: section-aware grep-based extraction for key defaults.
        # Searches for "key:" under a specific top-level "section:" header
        # to avoid matching ambiguous keys in the wrong YAML section.
        log_debug "yq not found, using grep-based defaults parsing"
        _read_yaml_section_value() {
            local section="$1" key="$2"
            # Extract lines between "^section:" and the next "^[a-z]" header,
            # then find the key within that block.
            sed -n "/^${section}:/,/^[a-z]/p" "$defaults_file" 2>/dev/null \
                | grep -E "^\s+${key}:" | head -1 \
                | sed 's/.*:\s*//' | sed 's/\s*#.*//' | xargs
        }
        PNPM_VERSION="${PNPM_VERSION:-$(_read_yaml_section_value system pnpm_version)}"
        NODE_VERSION="${NODE_VERSION:-$(_read_yaml_section_value system node_version)}"
        GATEWAY_PORT="${GATEWAY_PORT:-$(_read_yaml_section_value gateway port_start)}"
        GATEWAY_BIND="${GATEWAY_BIND:-$(_read_yaml_section_value gateway bind)}"
        INSTALL_METHOD="${INSTALL_METHOD:-$(_read_yaml_section_value install method)}"
        PACKAGE_NAME="${PACKAGE_NAME:-$(_read_yaml_section_value install package_name)}"
        PACKAGE_MANAGER="${PACKAGE_MANAGER:-$(_read_yaml_section_value install package_manager)}"
        SANDBOX_MODE="${SANDBOX_MODE:-$(_read_yaml_section_value security sandbox_mode)}"
        DM_POLICY="${DM_POLICY:-$(_read_yaml_section_value security dm_policy)}"
        unset -f _read_yaml_section_value
    fi

    return 0
}

# Display current configuration (masks sensitive values)
display_config() {
    echo ""
    echo -e "${BLUE}=== Current Configuration ===${NC}"

    echo -e "\n${GREEN}Execution Mode:${NC} ${EXEC_MODE:-local}"

    echo -e "\n${GREEN}Required Variables:${NC}"
    for var in ANTHROPIC_API_KEY VPS_HOSTNAME TAILSCALE_AUTH_KEY GITHUB_PAT; do
        if [ -n "${!var:-}" ]; then
            if [[ "$var" == *"KEY"* ]] || [[ "$var" == *"TOKEN"* ]] || [[ "$var" == *"PAT"* ]]; then
                echo -e "  $var: ${GREEN}[SET]${NC}"
            else
                echo -e "  $var: ${GREEN}${!var}${NC}"
            fi
        else
            echo -e "  $var: ${RED}[NOT SET]${NC}"
        fi
    done

    echo -e "\n${GREEN}Install Method:${NC} ${INSTALL_METHOD:-package}"
    if [ "${INSTALL_METHOD:-package}" = "source" ]; then
        echo -e "  GITHUB_REPO: ${GITHUB_REPO:-NikolasP98/minion}"
        echo -e "  GITHUB_BRANCH: ${GITHUB_BRANCH:-main}"
        echo -e "  MINION_ROOT: ${MINION_ROOT:-[NOT SET]}"
    else
        echo -e "  PACKAGE_MANAGER: ${PACKAGE_MANAGER:-npm}"
        echo -e "  Package: @nikolasp98/minion"
        echo -e "  MINION_BIN: ${MINION_BIN:-[resolved at install]}"
        echo -e "  MINION_PKG_ROOT: ${MINION_PKG_ROOT:-[resolved at install]}"
    fi

    echo -e "\n${GREEN}Inferable Variables:${NC}"
    for var in "${INFERABLE_FROM_CONVERSATION[@]}"; do
        echo -e "  $var: ${!var:-[NOT SET]}"
    done

    echo -e "\n${GREEN}System-Derived Variables:${NC}"
    for var in "${SYSTEM_DERIVED[@]}"; do
        if [[ "$var" == *"TOKEN"* ]] && [ -n "${!var:-}" ]; then
            echo -e "  $var: [GENERATED]"
        else
            echo -e "  $var: ${!var:-[NOT SET]}"
        fi
    done
    echo ""
}

# Export functions
export -f validate_required_variables derive_system_variables
export -f validate_api_key validate_username
export -f load_defaults load_profile display_config
