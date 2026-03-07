#!/usr/bin/env bash
# ---
# name: "Minion Setup Orchestrator"
# description: >
#   Single entry-point for deploying Minion on a VPS.
#   Supports two install methods: package (npm install -g @nikolasp98/minion)
#   or source (git clone + pnpm install + pnpm build). Package is default.
#   Supports two exec modes: remote (orchestrate VPS via SSH from local machine)
#   and local (run directly on the VPS).
# when: >
#   Run this to deploy a new Minion instance or update an existing one.
#   Use --mode=remote from your local machine, or --mode=local on the VPS itself.
#   If --vps-hostname is provided, mode auto-detects to remote.
# flags:
#   --mode=MODE: "local or remote (auto-detect if omitted)"
#   --install-dir=PATH: "Where to clone minion (default: ~/minion)"
#   --repo=REPO: "GitHub repo (default: NikolasP98/minion)"
#   --branch=BRANCH: "Git branch (default: main)"
#   --update: "Pull latest source and rebuild"
#   --profile=PROFILE: "Load from profile file"
#   --vps-hostname=HOST: "VPS hostname (implies --mode=remote)"
#   --api-key=KEY: "Anthropic API key"
#   --tailscale-key=KEY: "Tailscale auth key"
#   --github-pat=TOKEN: "GitHub PAT"
#   --agent-name=NAME: "Agent name"
#   --tenant=NAME: "Tenant identifier"
#   --dry-run: "Show what would happen"
#   --skip-phase=PHASE: "Skip specific phase"
#   --start-from=PHASE: "Resume from phase"
#   -v, --verbose: "Debug-level logging"
#   --help: "Usage information"
# idempotent: true
# ---

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source libraries
source "${SCRIPT_DIR}/lib/logging.sh"
source "${SCRIPT_DIR}/lib/variables.sh"
source "${SCRIPT_DIR}/lib/network.sh"
source "${SCRIPT_DIR}/lib/templates.sh"
source "${SCRIPT_DIR}/lib/interactive.sh"

# Load defaults from config/defaults.yaml (before CLI args, so args can override)
load_defaults

# Default values
DRY_RUN=false
NON_INTERACTIVE=false
BOOTSTRAP_MODE=false
SKIP_PHASES=()
START_FROM_PHASE=""
PROFILE=""
UPDATE_MODE=false
DECOMMISSION_MODE=false

# Display usage information
usage() {
    cat << 'EOF'
Minion Setup - VPS Deployment Framework

Usage: setup.sh [OPTIONS]

Modes:
    --mode=MODE             Execution mode: local, remote (auto-detect if omitted)
                            If --vps-hostname is set, defaults to remote; otherwise local.

Install Method:
    --install-method=METHOD Install method: package (default), source
                            package: npm install -g @nikolasp98/minion (fast, no build)
                            source:  git clone + pnpm install + pnpm build
    --pkg-manager=PM        Package manager for package installs: npm (default), pnpm, bun

Source Install (only with --install-method=source):
    --install-dir=PATH      Where to clone minion (default: ~/minion)
    --repo=REPO             GitHub repo (default: NikolasP98/minion)
    --branch=BRANCH         Git branch to checkout (default: main)
    --update                Pull latest source and rebuild (for existing installs)
    --decommission          Stop services, free disk space, preserve config (non-destructive)

Configuration:
    --profile=PROFILE       Load configuration from profile file
    --vps-hostname=HOST     VPS hostname or IP address (implies --mode=remote)
    --api-key=KEY           Anthropic API key (at least one LLM provider key required)
    --openrouter-key=KEY    OpenRouter API key (alternative to --api-key)
    --tailscale-key=KEY     Tailscale auth key
    --tailscale-funnel      Enable Tailscale Funnel (required for Google OAuth & public HTTPS callbacks)
    --github-pat=TOKEN      GitHub Personal Access Token
    --gateway-port=PORT     Gateway listen port (default: 18789)
    --gateway-bind=MODE     Bind mode: loopback, lan, tailnet (default: loopback)
    --gateway-token=TOKEN   Gateway auth token (auto-generated if omitted)
    --oauth-callback-port=PORT  OAuth callback server port (default: 51234)

Agent:
    --agent-name=NAME       Agent name
    --agent-personality=DESC  Agent personality description
    --sandbox-mode=MODE     Sandbox mode: off, non-main, all (default: non-main)
    --dm-policy=POLICY      DM policy: open, pairing (default: pairing)
    --tenant=NAME           Tenant identifier (for multi-tenant)

Channels:
    --enable-whatsapp       Enable WhatsApp channel
    --enable-telegram       Enable Telegram channel
    --enable-discord        Enable Discord channel
    --whatsapp-phone=PHONE  WhatsApp phone number
    --telegram-token=TOKEN  Telegram bot token
    --discord-token=TOKEN   Discord bot token

System:
    --node-method=METHOD    Node.js install method: apt, nvm, skip (default: apt)

Bootstrap (fresh VPS):
    --bootstrap             Run VPS bootstrap (Phase 10) before deployment phases
    --admin-user=USER       Admin username to create (default: niko)
    --ssh-pubkey=KEY        SSH public key string to install
    --ssh-pubkey-file=PATH  Path to SSH public key file
    --op-ssh-key-ref=REF    1Password reference for SSH key (default: op://Personal/SSH Key/public key)

Execution:
    --non-interactive       Skip the interactive wizard; all values must be provided via flags
    --dry-run               Show what would be done without executing
    --skip-phase=PHASE      Skip specific phase (can be repeated)
    --start-from=PHASE      Start from specific phase (resume deployment)
    --force-reinstall       Force reinstall even if present
    -v, --verbose           Enable debug-level logging
    --help                  Show this help message

Examples:
    # Interactive mode (default — wizard prompts for all settings)
    ./setup/setup.sh

    # Interactive with a pre-filled API key (wizard shows it as default)
    ./setup/setup.sh --api-key=sk-ant-xxx

    # Non-interactive (for agent-driven provisioning — all values via flags)
    ./setup/setup.sh --non-interactive \
       --vps-hostname=server.example.com \
       --agent-name=mybot \
       --api-key=sk-ant-xxx \
       --gateway-port=18789

    # Non-interactive with Google OAuth (Tailscale Funnel)
    ./setup/setup.sh --non-interactive \
       --vps-hostname=server.example.com \
       --api-key=sk-ant-xxx \
       --tailscale-funnel \
       --tailscale-key=tskey-xxx

    # Non-interactive with source install
    ./setup/setup.sh --non-interactive --install-method=source --api-key=sk-ant-xxx

    # Update existing install (always non-interactive)
    ./setup/setup.sh --update --verbose

    # Decommission (stop services, free disk, preserve config)
    ./setup/setup.sh --decommission --vps-hostname=server.example.com --agent-name=mybot

    # Dry run
    ./setup/setup.sh --dry-run --api-key=sk-ant-test --verbose

Bootstrap (fresh VPS):
    # Bootstrap a fresh VPS (creates admin user, hardens SSH, installs Tailscale)
    ./setup/setup.sh --bootstrap \
       --vps-hostname=152.53.91.108 \
       --admin-user=niko \
       --verbose

    # Bootstrap + full deploy in one go
    ./setup/setup.sh --bootstrap \
       --vps-hostname=152.53.91.108 \
       --admin-user=niko \
       --agent-name=bot \
       --api-key=sk-ant-xxx \
       --verbose

    # Bootstrap with explicit SSH key (instead of 1Password)
    ./setup/setup.sh --bootstrap \
       --vps-hostname=server.example.com \
       --ssh-pubkey-file=~/.ssh/id_ed25519.pub

EOF
    exit 0
}

# Parse command line arguments
parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --help)
                usage
                ;;
            --mode=*)
                EXEC_MODE="${1#*=}"
                ;;
            --install-dir=*)
                MINION_ROOT="${1#*=}"
                ;;
            --repo=*)
                GITHUB_REPO="${1#*=}"
                ;;
            --branch=*)
                GITHUB_BRANCH="${1#*=}"
                ;;
            --update)
                UPDATE_MODE=true
                ;;
            --decommission)
                DECOMMISSION_MODE=true
                ;;
            --profile=*)
                PROFILE="${1#*=}"
                ;;
            --vps-hostname=*)
                VPS_HOSTNAME="${1#*=}"
                ;;
            --api-key=*)
                ANTHROPIC_API_KEY="${1#*=}"
                ;;
            --openrouter-key=*)
                OPENROUTER_API_KEY="${1#*=}"
                ;;
            --tailscale-key=*)
                TAILSCALE_AUTH_KEY="${1#*=}"
                ;;
            --tailscale-funnel)
                TAILSCALE_FUNNEL_ENABLED=true
                ;;
            --oauth-callback-port=*)
                OAUTH_CALLBACK_PORT="${1#*=}"
                ;;
            --github-pat=*)
                GITHUB_PAT="${1#*=}"
                ;;
            --agent-name=*)
                AGENT_NAME="${1#*=}"
                ;;
            --agent-personality=*)
                AGENT_PERSONALITY="${1#*=}"
                ;;
            --sandbox-mode=*)
                SANDBOX_MODE="${1#*=}"
                ;;
            --dm-policy=*)
                DM_POLICY="${1#*=}"
                ;;
            --tenant=*)
                MINION_TENANT="${1#*=}"
                ;;
            --enable-whatsapp)
                ENABLE_WHATSAPP=true
                ;;
            --enable-telegram)
                ENABLE_TELEGRAM=true
                ;;
            --enable-discord)
                ENABLE_DISCORD=true
                ;;
            --whatsapp-phone=*)
                WHATSAPP_PHONE="${1#*=}"
                ;;
            --telegram-token=*)
                TELEGRAM_BOT_TOKEN="${1#*=}"
                ;;
            --discord-token=*)
                DISCORD_BOT_TOKEN="${1#*=}"
                ;;
            --gateway-port=*)
                GATEWAY_PORT="${1#*=}"
                ;;
            --gateway-bind=*)
                GATEWAY_BIND="${1#*=}"
                ;;
            --gateway-token=*)
                GATEWAY_AUTH_TOKEN="${1#*=}"
                ;;
            --install-method=*)
                INSTALL_METHOD="${1#*=}"
                ;;
            --pkg-manager=*)
                PACKAGE_MANAGER="${1#*=}"
                ;;
            --node-method=*)
                NODE_INSTALL_METHOD="${1#*=}"
                ;;
            --non-interactive)
                NON_INTERACTIVE=true
                ;;
            --dry-run)
                DRY_RUN=true
                ;;
            --skip-phase=*)
                SKIP_PHASES+=("${1#*=}")
                ;;
            --start-from=*)
                START_FROM_PHASE="${1#*=}"
                ;;
            --bootstrap)
                BOOTSTRAP_MODE=true
                ;;
            --admin-user=*)
                ADMIN_USER="${1#*=}"
                ;;
            --ssh-pubkey=*)
                SSH_PUBKEY="${1#*=}"
                ;;
            --ssh-pubkey-file=*)
                SSH_PUBKEY_FILE="${1#*=}"
                ;;
            --op-ssh-key-ref=*)
                OP_SSH_KEY_REF="${1#*=}"
                ;;
            --force-reinstall)
                FORCE_REINSTALL=true
                ;;
            -v|--verbose)
                VERBOSE=true
                export VERBOSE
                CURRENT_LOG_LEVEL=$LOG_LEVEL_DEBUG
                ;;
            *)
                echo "Unknown option: $1"
                echo "Run with --help for usage information"
                exit 1
                ;;
        esac
        shift
    done

    # Auto-detect mode: if VPS_HOSTNAME is set, default to remote
    if [ -z "${EXEC_MODE:-}" ]; then
        if [ -n "${VPS_HOSTNAME:-}" ]; then
            EXEC_MODE="remote"
        else
            EXEC_MODE="local"
        fi
    fi

    export EXEC_MODE
}

# Load profile if specified
load_profile_if_specified() {
    if [ -n "$PROFILE" ]; then
        local profile_file="${SCRIPT_DIR}/profiles/${PROFILE}.profile.yaml"
        if [ ! -f "$profile_file" ]; then
            # Try without .profile.yaml extension
            profile_file="${SCRIPT_DIR}/profiles/${PROFILE}"
        fi

        if [ -f "$profile_file" ]; then
            load_profile "$profile_file"
        else
            log_error "Profile not found: $PROFILE"
            exit 1
        fi
    fi
}

# Check if phase should be skipped
should_skip_phase() {
    local phase="$1"

    # Check if phase is in skip list
    for skip in "${SKIP_PHASES[@]}"; do
        if [ "$phase" = "$skip" ]; then
            return 0
        fi
    done

    # Check if we should start from a later phase
    if [ -n "$START_FROM_PHASE" ]; then
        local phase_num="${phase%%-*}"
        local start_num="${START_FROM_PHASE%%-*}"

        if [ "$phase_num" -lt "$start_num" ]; then
            return 0
        fi
    fi

    return 1
}

# Execute deployment phase
execute_phase() {
    local phase_script="$1"
    local phase_name="${phase_script##*/}"
    phase_name="${phase_name%.sh}"

    if should_skip_phase "$phase_name"; then
        log_info "Skipping phase: $phase_name"
        return 0
    fi

    if [ "$DRY_RUN" = true ]; then
        log_info "[DRY RUN] Would execute phase: $phase_name"
        return 0
    fi

    log_info "Executing phase: $phase_name"

    if ! bash "$phase_script"; then
        log_error "Phase failed: $phase_name"
        log_info "Starting rollback..."
        bash "${SCRIPT_DIR}/phases/99-rollback.sh"
        exit 1
    fi

    return 0
}

# Export all configuration variables for child processes
export_variables() {
    export VPS_HOSTNAME TAILSCALE_AUTH_KEY ANTHROPIC_API_KEY OPENROUTER_API_KEY GITHUB_PAT
    export BOOTSTRAP_MODE ADMIN_USER SSH_PUBKEY SSH_PUBKEY_FILE OP_SSH_KEY_REF
    export AGENT_NAME AGENT_PERSONALITY SANDBOX_MODE DM_POLICY
    export ENABLE_WHATSAPP ENABLE_TELEGRAM ENABLE_DISCORD ENABLE_WEB
    export WHATSAPP_PHONE TELEGRAM_BOT_TOKEN DISCORD_BOT_TOKEN
    export INSTALL_METHOD PACKAGE_MANAGER
    export NODE_INSTALL_METHOD FORCE_REINSTALL UPDATE_MODE DECOMMISSION_MODE
    export GATEWAY_PORT GATEWAY_BIND AGENT_MODEL AGENT_USERNAME GATEWAY_AUTH_TOKEN
    export AGENT_HOME_DIR MINION_CONFIG_DIR WORKSPACE_DIR
    export MINION_ROOT MINION_WRAPPER MINION_BIN MINION_PKG_ROOT NODE_BIN_PATH
    export GITHUB_REPO GITHUB_BRANCH EXEC_MODE
    export MEMORY_LIMIT CPU_QUOTA
    export MINION_TENANT
    export TAILSCALE_FUNNEL_ENABLED OAUTH_CALLBACK_PORT
    export EXEC_USER NON_INTERACTIVE
    export DRY_RUN VERBOSE CURRENT_LOG_LEVEL
    export LOG_DIR LOG_FILE
} 2>/dev/null  # suppress errors for unset variables

# Main deployment sequence
main() {
    echo -e "${CYAN}"
    cat << "BANNER"
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║   ██████╗ ██████╗ ███████╗███╗   ██╗ ██████╗██╗      █████╗  ║
║  ██╔═══██╗██╔══██╗██╔════╝████╗  ██║██╔════╝██║     ██╔══██╗ ║
║  ██║   ██║██████╔╝█████╗  ██╔██╗ ██║██║     ██║     ███████║ ║
║  ██║   ██║██╔═══╝ ██╔══╝  ██║╚██╗██║██║     ██║     ██╔══██║ ║
║  ╚██████╔╝██║     ███████╗██║ ╚████║╚██████╗███████╗██║  ██║ ║
║   ╚═════╝ ╚═╝     ╚══════╝╚═╝  ╚═══╝ ╚═════╝╚══════╝╚═╝  ╚═╝║
║                                                               ║
║              VPS Setup Framework                              ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
BANNER
    echo -e "${NC}"

    log_info "Starting Minion setup"
    log_info "Log file: $LOG_FILE"

    # Parse arguments
    parse_args "$@"

    # Load profile (before wizard, so profile values show as pre-filled defaults)
    load_profile_if_specified

    # Run interactive wizard unless suppressed
    # Skipped for: --non-interactive, --update, --decommission, --dry-run, non-TTY stdin
    if [ "$NON_INTERACTIVE" = "false" ] && \
       [ "$UPDATE_MODE" = "false" ] && \
       [ "$DECOMMISSION_MODE" = "false" ] && \
       [ "$DRY_RUN" = "false" ] && \
       [ -t 0 ]; then
        if ! run_interactive_wizard; then
            log_error "Setup wizard aborted."
            exit 1
        fi
    elif [ "$NON_INTERACTIVE" = "true" ]; then
        log_info "Non-interactive mode: using provided flags and defaults"
    fi

    # Derive system variables from inputs
    derive_system_variables

    # Export everything for child processes
    export_variables

    log_info "Execution mode: $EXEC_MODE"

    # Decommission mode: run only phase 95 and exit
    if [ "$DECOMMISSION_MODE" = true ]; then
        log_warn "DECOMMISSION MODE - Stopping services and freeing disk space"
        execute_phase "${SCRIPT_DIR}/phases/95-decommission.sh"
        log_success "Decommission completed"
        return 0
    fi

    if [ "$DRY_RUN" = true ]; then
        log_warn "DRY RUN MODE - No changes will be made"
        display_config
        echo ""
        log_info "Phases that would execute:"
    fi

    # Execute phases in sequence
    local phases=(
        "00-preflight.sh"
    )

    # Prepend bootstrap phase when --bootstrap is set
    if [ "${BOOTSTRAP_MODE:-false}" = "true" ]; then
        phases=("00-preflight.sh" "10-vps-bootstrap.sh")
        # If no LLM provider key provided, bootstrap-only (skip deployment phases)
        if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -z "${OPENROUTER_API_KEY:-}" ]; then
            log_info "Bootstrap-only mode (no API key provided, skipping deployment phases)"
            for phase_script in "${phases[@]}"; do
                execute_phase "${SCRIPT_DIR}/phases/${phase_script}"
            done
            if [ "$DRY_RUN" = true ]; then
                echo ""
                log_info "Dry run complete. No changes were made."
                exit 0
            fi
            log_success "VPS bootstrap completed successfully!"
            return 0
        fi
        # API key provided: bootstrap + full deploy
        phases+=("20-user-creation.sh")
    else
        phases+=("20-user-creation.sh")
    fi

    phases+=(
        "30-environment-setup.sh"
        "40-minion-install.sh"
        "45-alias-setup.sh"
        "50-config-generation.sh"
        "60-service-setup.sh"
        "65-tailscale-funnel.sh"
        "70-verification.sh"
    )

    for phase_script in "${phases[@]}"; do
        execute_phase "${SCRIPT_DIR}/phases/${phase_script}"
    done

    if [ "$DRY_RUN" = true ]; then
        echo ""
        log_info "Dry run complete. No changes were made."
        exit 0
    fi

    log_success "Minion setup completed successfully!"
    return 0
}

# Run main function with all arguments
main "$@"
