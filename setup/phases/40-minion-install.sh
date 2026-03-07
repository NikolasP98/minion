#!/usr/bin/env bash
# ---
# name: "Minion Install"
# phase: 40
# description: >
#   Installs Minion via one of two methods:
#   - package (default): npm/pnpm/bun install -g @nikolasp98/minion
#   - source: git clone + pnpm install + pnpm build
#   Verifies the installation and exports binary paths for downstream phases.
# when: >
#   After environment setup. Node.js must be available.
# requires:
#   - "Phase 30 (environment setup) completed"
#   - "Node.js available"
# produces:
#   - "minion binary available (package) or MINION_ROOT with built source"
#   - "MINION_BIN, MINION_PKG_ROOT exported (package)"
#   - "MINION_ROOT, NODE_BIN_PATH exported (source)"
# flags:
#   -v, --verbose: "Enable debug-level logging"
#   --update: "Pull latest and rebuild instead of fresh clone (source only)"
# idempotent: true
# estimated_time: "1-8 minutes"
# ---

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/logging.sh"
source "${SCRIPT_DIR}/../lib/variables.sh"
source "${SCRIPT_DIR}/../lib/network.sh"

# Ensure derived variables are populated (idempotent)
derive_system_variables

# --- Package install path ---
install_via_package() {
    local exec_user="${AGENT_USERNAME:-$(whoami)}"
    local pkg_mgr="${PACKAGE_MANAGER:-npm}"
    local pkg_name="@nikolasp98/minion"

    log_info "Installing Minion via $pkg_mgr package..."

    case "$pkg_mgr" in
        npm)
            run_cmd --as "$exec_user" "npm install -g ${pkg_name}"
            ;;
        pnpm)
            # Ensure PNPM_HOME is set up
            if [ -z "${PNPM_HOME:-}" ]; then
                log_info "Running pnpm setup to configure global bin directory..."
                run_cmd --as "$exec_user" "pnpm setup" 2>/dev/null || true
                export PNPM_HOME="${AGENT_HOME_DIR:-$HOME}/.local/share/pnpm"
                export PATH="$PNPM_HOME:$PATH"
            fi
            run_cmd --as "$exec_user" "pnpm add -g ${pkg_name}"
            ;;
        bun)
            run_cmd --as "$exec_user" "bun add -g ${pkg_name}"
            ;;
        *)
            handle_error 1 "Unknown package manager: $pkg_mgr" "Minion Install"
            return 1
            ;;
    esac

    # Resolve MINION_BIN
    log_info "Resolving minion binary path..."
    MINION_BIN=$(run_cmd --as "$exec_user" "which minion" 2>/dev/null || echo "")

    if [ -z "$MINION_BIN" ]; then
        # Try known global bin paths
        local candidates=(
            "${AGENT_HOME_DIR:-$HOME}/.local/bin/minion"
            "${AGENT_HOME_DIR:-$HOME}/.local/share/pnpm/minion"
            "${AGENT_HOME_DIR:-$HOME}/.bun/bin/minion"
            "/usr/local/bin/minion"
            "/usr/bin/minion"
        )
        for candidate in "${candidates[@]}"; do
            if [ -x "$candidate" ] || run_cmd --as "$exec_user" "[ -x '$candidate' ]" 2>/dev/null; then
                MINION_BIN="$candidate"
                break
            fi
        done
    fi

    if [ -z "$MINION_BIN" ]; then
        handle_error 1 "Could not find minion binary after install" "Minion Install"
        return 1
    fi
    log_success "minion binary: $MINION_BIN"

    # Resolve MINION_PKG_ROOT (the installed package directory)
    log_info "Resolving package root..."
    case "$pkg_mgr" in
        npm)
            local npm_global_root
            npm_global_root=$(run_cmd --as "$exec_user" "npm root -g" 2>/dev/null || echo "")
            MINION_PKG_ROOT="${npm_global_root}/${pkg_name}"
            ;;
        pnpm)
            local pnpm_global_root
            pnpm_global_root=$(run_cmd --as "$exec_user" "pnpm root -g" 2>/dev/null || echo "")
            MINION_PKG_ROOT="${pnpm_global_root}/${pkg_name}"
            ;;
        bun)
            local bun_global_bin
            bun_global_bin=$(run_cmd --as "$exec_user" "bun pm -g bin" 2>/dev/null || echo "${AGENT_HOME_DIR:-$HOME}/.bun/bin")
            MINION_PKG_ROOT="$(dirname "$bun_global_bin")/install/global/node_modules/${pkg_name}"
            ;;
    esac
    log_info "Package root: $MINION_PKG_ROOT"

    # Verify install
    log_info "Verifying installation..."
    local version_output
    version_output=$(run_cmd --as "$exec_user" "'${MINION_BIN}' --version" 2>/dev/null || echo "")
    if [ -n "$version_output" ]; then
        log_success "minion --version: $version_output"
    else
        log_warn "minion --version returned empty (binary may still work)"
    fi

    # Store binary paths for downstream phases
    NODE_BIN_PATH=$(run_cmd --as "$exec_user" "which node" 2>/dev/null || echo "/usr/bin/node")
    export NODE_BIN_PATH MINION_BIN MINION_PKG_ROOT

    log_info "Node.js binary: $NODE_BIN_PATH"
}

# --- Source install path ---
install_via_source() {
    local exec_user="${AGENT_USERNAME:-$(whoami)}"

    MINION_ROOT="${MINION_ROOT:-${AGENT_HOME_DIR:-$HOME}/minion}"
    GITHUB_REPO="${GITHUB_REPO:-NikolasP98/minion}"
    GITHUB_BRANCH="${GITHUB_BRANCH:-main}"

    log_info "Install directory: $MINION_ROOT"
    log_info "Repository: $GITHUB_REPO (branch: $GITHUB_BRANCH)"

    # Check if already cloned
    if run_cmd --as "$exec_user" "[ -d '${MINION_ROOT}/.git' ]" 2>/dev/null; then
        if [ "${UPDATE_MODE:-false}" = "true" ] || [ "${FORCE_REINSTALL:-false}" = "true" ]; then
            log_info "Existing install found, updating..."
            run_cmd --as "$exec_user" "cd '${MINION_ROOT}' && git fetch origin"
            run_cmd --as "$exec_user" "cd '${MINION_ROOT}' && git checkout '${GITHUB_BRANCH}'"
            run_cmd --as "$exec_user" "cd '${MINION_ROOT}' && git pull origin '${GITHUB_BRANCH}'"
        else
            log_warn "Minion already cloned at $MINION_ROOT"
            log_info "Use --update to pull latest changes, or --force-reinstall to rebuild"

            # Verify build exists
            if run_cmd --as "$exec_user" "[ -f '${MINION_ROOT}/dist/entry.js' ]" 2>/dev/null; then
                log_success "Existing build verified (dist/entry.js exists)"
                return 0
            else
                log_warn "Build artifacts missing, rebuilding..."
            fi
        fi
    else
        log_info "Cloning Minion repository..."
        run_cmd --as "$exec_user" "git clone 'https://github.com/${GITHUB_REPO}.git' '${MINION_ROOT}'"
        run_cmd --as "$exec_user" "cd '${MINION_ROOT}' && git checkout '${GITHUB_BRANCH}'"
    fi

    # Install dependencies
    log_info "Installing dependencies with pnpm..."
    run_cmd --as "$exec_user" "cd '${MINION_ROOT}' && pnpm install --frozen-lockfile"

    # Build
    log_info "Building Minion..."
    run_cmd --as "$exec_user" "cd '${MINION_ROOT}' && pnpm build"

    # Verify build
    log_info "Verifying build artifacts..."
    if run_cmd --as "$exec_user" "[ -f '${MINION_ROOT}/dist/entry.js' ]" 2>/dev/null; then
        log_success "Build verified: dist/entry.js exists"
    else
        # Check for entry.mjs as alternative
        if run_cmd --as "$exec_user" "[ -f '${MINION_ROOT}/dist/entry.mjs' ]" 2>/dev/null; then
            log_success "Build verified: dist/entry.mjs exists"
        else
            handle_error 1 "Build verification failed: neither dist/entry.js nor dist/entry.mjs found" "Minion Install"
            return 1
        fi
    fi

    # Store binary paths for downstream phases
    NODE_BIN_PATH=$(run_cmd --as "$exec_user" "which node" 2>/dev/null || echo "/usr/bin/node")
    export NODE_BIN_PATH
    export MINION_ROOT

    log_info "Node.js binary: $NODE_BIN_PATH"
    log_info "Minion root: $MINION_ROOT"
}

# --- Main entry point ---
install_minion() {
    local install_method="${INSTALL_METHOD:-package}"
    phase_start "Minion Install" "40"

    log_info "Install method: $install_method"

    if [ "$install_method" = "source" ]; then
        install_via_source
    else
        install_via_package
    fi

    phase_end "Minion Install" "success"
    save_checkpoint "40-minion-install"
    return 0
}

# Run install if executed directly
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    install_minion
fi
