#!/usr/bin/env bash
# ---
# name: "Environment Setup"
# phase: 30
# description: >
#   Installs Node.js (via apt, nvm, or skip), enables pnpm via corepack,
#   installs gh CLI, and sets up essential build tools. Uses run_cmd for
#   dual-mode support.
# when: >
#   After user creation. Ensures the build toolchain is available before
#   cloning and building Minion from source.
# requires:
#   - "Phase 20 (user creation) completed"
#   - "Internet connectivity"
# produces:
#   - "Node.js 22.x installed"
#   - "pnpm available via corepack"
#   - "gh CLI installed and authenticated"
#   - "Build tools (git, curl) available"
# flags:
#   -v, --verbose: "Enable debug-level logging"
# idempotent: true
# estimated_time: "2-5 minutes"
# ---

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/logging.sh"
source "${SCRIPT_DIR}/../lib/variables.sh"
source "${SCRIPT_DIR}/../lib/network.sh"

# Ensure derived variables are populated (idempotent)
derive_system_variables

setup_environment() {
    phase_start "Environment Setup" "30"

    NODE_INSTALL_METHOD="${NODE_INSTALL_METHOD:-apt}"

    # --- Node.js ---
    local node_ver
    node_ver=$(run_cmd "node --version" 2>/dev/null || echo "")

    if [[ "$node_ver" == v22.* ]]; then
        log_info "Node.js $node_ver already installed, skipping"
    else
        log_info "Installing Node.js via $NODE_INSTALL_METHOD..."

        case "$NODE_INSTALL_METHOD" in
            "apt")
                log_info "Adding NodeSource repository for Node.js 22..."
                run_cmd --as root "curl -fsSL https://deb.nodesource.com/setup_22.x | bash -"
                run_cmd --as root "apt-get install -y nodejs"
                ;;
            "nvm")
                log_info "Installing via NVM..."
                if [ "${EXEC_MODE:-local}" = "remote" ]; then
                    run_cmd --as "$AGENT_USERNAME" "curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash"
                    run_cmd --as "$AGENT_USERNAME" "source ~/.nvm/nvm.sh && nvm install 22 && nvm use 22"
                else
                    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
                    export NVM_DIR="$HOME/.nvm"
                    # shellcheck disable=SC1091
                    [ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"
                    nvm install 22 && nvm use 22
                fi
                ;;
            "skip")
                log_warn "Skipping Node.js installation (assuming already installed)"
                ;;
            *)
                log_error "Unknown Node.js install method: $NODE_INSTALL_METHOD"
                handle_error 1 "Invalid NODE_INSTALL_METHOD" "Environment Setup"
                return 1
                ;;
        esac

        node_ver=$(run_cmd "node --version" 2>/dev/null || echo "not found")
        if [ "$node_ver" = "not found" ]; then
            handle_error 1 "Node.js not available after installation" "Environment Setup"
            return 1
        fi
    fi
    log_success "Node.js version: $node_ver"

    # Update NODE_BIN_PATH
    NODE_BIN_PATH=$(run_cmd "which node")
    export NODE_BIN_PATH

    # Configure npm to use user-local prefix (avoids EACCES on global installs)
    log_info "Configuring npm user-local prefix..."
    local exec_user="${AGENT_USERNAME:-$(whoami)}"
    if [ "${EXEC_MODE:-local}" = "remote" ]; then
        run_cmd --as "$exec_user" "npm config set prefix '~/.local'"
        # Ensure ~/.local/bin is in PATH via .bashrc
        run_cmd --as "$exec_user" "grep -q 'HOME/.local/bin' ~/.bashrc 2>/dev/null || echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc"
    else
        npm config set prefix "$HOME/.local"
        if ! grep -q 'HOME/.local/bin' ~/.bashrc 2>/dev/null; then
            echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
        fi
        export PATH="$HOME/.local/bin:$PATH"
    fi
    log_success "npm prefix set to ~/.local"

    # --- Package manager & build tools (install-method-dependent) ---
    local install_method="${INSTALL_METHOD:-package}"

    if [ "$install_method" = "source" ]; then
        # Source installs need pnpm, gh CLI, and build-essential

        # --- pnpm via corepack ---
        local pnpm_ver
        pnpm_ver=$(run_cmd "pnpm --version" 2>/dev/null || echo "")

        if [ -n "$pnpm_ver" ]; then
            log_info "pnpm $pnpm_ver already installed, skipping"
        else
            log_info "Setting up pnpm via corepack..."
            if run_cmd "command -v corepack" &> /dev/null; then
                run_cmd --as root "corepack enable" || run_cmd "corepack enable" || true
                run_cmd "corepack prepare pnpm@${PNPM_VERSION:-10.29.3} --activate" 2>/dev/null || \
                    log_warn "corepack prepare failed, trying npm fallback"
            fi

            # Verify pnpm or install fallback
            if ! run_cmd "command -v pnpm" &> /dev/null; then
                log_warn "pnpm not available via corepack, installing via npm..."
                run_cmd --as root "npm install -g pnpm@${PNPM_VERSION:-10.29.3}" || run_cmd "npm install -g pnpm@${PNPM_VERSION:-10.29.3}"
            fi

            pnpm_ver=$(run_cmd "pnpm --version" 2>/dev/null || echo "not found")
        fi
        log_success "pnpm version: $pnpm_ver"

        # --- gh CLI ---
        if run_cmd "command -v gh" &> /dev/null; then
            local gh_ver
            gh_ver=$(run_cmd "gh --version" 2>/dev/null | head -1 || echo "")
            log_info "gh CLI already installed ($gh_ver), skipping"
        else
            log_info "Installing gh CLI..."
            run_cmd --as root "type -p curl >/dev/null || apt-get install curl -y"
            run_cmd --as root "curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg 2>/dev/null"
            run_cmd --as root "chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg"
            run_cmd --as root "echo 'deb [arch=\$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main' | tee /etc/apt/sources.list.d/github-cli.list > /dev/null"
            run_cmd --as root "apt-get update && apt-get install gh -y"
        fi

        # Authenticate gh if PAT is provided
        if [ -n "${GITHUB_PAT:-}" ]; then
            log_info "Authenticating gh CLI with PAT..."
            if [ "${EXEC_MODE:-local}" = "remote" ]; then
                run_cmd --as "$AGENT_USERNAME" "echo '$GITHUB_PAT' | gh auth login --with-token"
            else
                echo "$GITHUB_PAT" | gh auth login --with-token 2>/dev/null || \
                    log_warn "gh auth login failed (may already be authenticated)"
            fi
        fi

        # --- Build tools ---
        if run_cmd "dpkg -s build-essential" &> /dev/null; then
            log_info "build-essential already installed, skipping"
        else
            log_info "Installing build tools..."
            run_cmd --as root "apt-get install -y build-essential git curl" 2>/dev/null || \
                log_warn "Could not install build tools via apt (may not have root access or not Debian-based)"
        fi
    else
        # Package installs: only need the chosen package manager
        local pkg_mgr="${PACKAGE_MANAGER:-npm}"
        log_info "Install method: package (using $pkg_mgr)"

        case "$pkg_mgr" in
            npm)
                # npm comes with Node.js, nothing extra needed
                log_info "npm $(run_cmd 'npm --version' 2>/dev/null || echo 'bundled with Node') ready"
                ;;
            pnpm)
                local pnpm_ver
                pnpm_ver=$(run_cmd "pnpm --version" 2>/dev/null || echo "")
                if [ -z "$pnpm_ver" ]; then
                    log_info "Installing pnpm globally..."
                    run_cmd --as root "npm install -g pnpm" || run_cmd "npm install -g pnpm"
                    pnpm_ver=$(run_cmd "pnpm --version" 2>/dev/null || echo "not found")
                fi
                log_success "pnpm version: $pnpm_ver"
                ;;
            bun)
                local bun_ver
                bun_ver=$(run_cmd "bun --version" 2>/dev/null || echo "")
                if [ -z "$bun_ver" ]; then
                    log_info "Installing bun..."
                    run_cmd "curl -fsSL https://bun.sh/install | bash"
                    # Source bun into current session
                    export BUN_INSTALL="${AGENT_HOME_DIR:-$HOME}/.bun"
                    export PATH="$BUN_INSTALL/bin:$PATH"
                    bun_ver=$(run_cmd "bun --version" 2>/dev/null || echo "not found")
                fi
                log_success "bun version: $bun_ver"
                ;;
            *)
                log_error "Unknown package manager: $pkg_mgr (expected npm, pnpm, or bun)"
                handle_error 1 "Invalid PACKAGE_MANAGER" "Environment Setup"
                return 1
                ;;
        esac

        # Ensure git and curl are available (needed for basic operations)
        if ! run_cmd "command -v git" &> /dev/null || ! run_cmd "command -v curl" &> /dev/null; then
            log_info "Installing git and curl..."
            run_cmd --as root "apt-get install -y git curl" 2>/dev/null || \
                log_warn "Could not install git/curl via apt"
        fi
    fi

    phase_end "Environment Setup" "success"
    save_checkpoint "30-environment-setup"
    return 0
}

# Run environment setup if executed directly
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    setup_environment
fi
