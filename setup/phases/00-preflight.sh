#!/usr/bin/env bash
# ---
# name: "Preflight Checks"
# phase: 00
# description: >
#   Validates all required variables, checks API key formats, tests connectivity
#   (SSH in remote mode, local tools in local mode), and verifies git is available
#   for source-based installation.
# when: >
#   Always runs first. Ensures the environment is ready before making changes.
# requires:
#   - "ANTHROPIC_API_KEY (always)"
#   - "VPS_HOSTNAME (remote mode)"
# produces:
#   - "Validated configuration ready for deployment"
#   - "System-derived variables populated"
# flags:
#   -v, --verbose: "Enable debug-level logging"
# idempotent: true
# estimated_time: "0.5-1 minutes"
# ---

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/logging.sh"
source "${SCRIPT_DIR}/../lib/variables.sh"
source "${SCRIPT_DIR}/../lib/network.sh"

preflight_checks() {
    phase_start "Preflight Checks" "00"

    # Derive system variables if not already done (standalone execution)
    if [ -z "${AGENT_USERNAME:-}" ]; then
        derive_system_variables
    fi

    # In bootstrap mode, skip API key and username validation (not needed yet)
    if [ "${BOOTSTRAP_MODE:-false}" = "true" ]; then
        log_info "Bootstrap mode: skipping API key and username validation"

        # Only validate SSH connectivity to root@VPS
        if [ "${EXEC_MODE:-local}" = "remote" ]; then
            log_info "Testing SSH connection to root@${VPS_HOSTNAME}..."
            if ! test_ssh_connection "$VPS_HOSTNAME" "root"; then
                handle_error 1 "Cannot connect to VPS as root via SSH" "Preflight"
                return 1
            fi
        fi

        # If API key is provided, also validate it (bootstrap + deploy)
        if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
            log_info "API key provided — will run bootstrap + deploy"
            if ! validate_api_key "$ANTHROPIC_API_KEY" "anthropic"; then
                handle_error 1 "Invalid Anthropic API key" "Preflight"
                return 1
            fi
        fi

        display_config
        phase_end "Preflight Checks" "success"
        save_checkpoint "00-preflight"
        return 0
    fi

    log_info "Validating required variables..."
    if ! validate_required_variables; then
        handle_error 1 "Required variables missing" "Preflight"
        return 1
    fi

    log_info "Validating API key format..."
    if ! validate_api_key "$ANTHROPIC_API_KEY" "anthropic"; then
        handle_error 1 "Invalid Anthropic API key" "Preflight"
        return 1
    fi

    if [ -n "${GITHUB_PAT:-}" ]; then
        if ! validate_api_key "$GITHUB_PAT" "github"; then
            log_warn "GitHub PAT format warning - continuing anyway"
        fi
    fi

    log_info "Validating username format..."
    if ! validate_username "$AGENT_USERNAME"; then
        handle_error 1 "Invalid username format" "Preflight"
        return 1
    fi

    # Check Docker availability when sandbox requires it
    if [ "${SANDBOX_MODE:-non-main}" != "off" ]; then
        log_info "Checking Docker availability (sandbox mode: ${SANDBOX_MODE})..."
        if [ "${EXEC_MODE:-local}" = "remote" ]; then
            if ! run_cmd --as root "command -v docker" &> /dev/null; then
                log_warn "Docker not found on remote host — sandbox mode '${SANDBOX_MODE}' requires Docker"
                log_warn "Either install Docker or use --sandbox-mode=off"
            fi
        else
            if ! command -v docker &> /dev/null; then
                log_warn "Docker not found — sandbox mode '${SANDBOX_MODE}' requires Docker"
                log_warn "Either install Docker or use --sandbox-mode=off"
            fi
        fi
    fi

    # Mode-specific checks
    if [ "${EXEC_MODE:-local}" = "remote" ]; then
        log_info "Testing SSH connection to VPS..."
        if ! test_ssh_connection "$VPS_HOSTNAME" "root"; then
            handle_error 1 "Cannot connect to VPS via SSH" "Preflight"
            return 1
        fi

        log_info "Checking remote dependencies (git, curl)..."
        local missing_remote=()
        for cmd in git curl; do
            if ! run_cmd --as root "command -v $cmd" &> /dev/null; then
                missing_remote+=("$cmd")
            fi
        done

        if [ ${#missing_remote[@]} -gt 0 ]; then
            log_warn "Missing remote dependencies: ${missing_remote[*]} (will install in Phase 30)"
        fi
    else
        log_info "Checking local dependencies..."
        local missing_deps=()

        for cmd in git curl; do
            if ! command -v "$cmd" &> /dev/null; then
                missing_deps+=("$cmd")
            fi
        done

        if [ ${#missing_deps[@]} -gt 0 ]; then
            log_error "Missing local dependencies: ${missing_deps[*]}"
            log_error "Install them with: sudo apt-get install -y ${missing_deps[*]}"
            handle_error 1 "Missing dependencies" "Preflight"
            return 1
        fi

        # Check Node.js
        if command -v node &> /dev/null; then
            local node_ver
            node_ver=$(node --version)
            log_info "Node.js found: $node_ver"
        else
            log_warn "Node.js not found (will be installed in Phase 30)"
        fi

        # Check pnpm
        if command -v pnpm &> /dev/null; then
            local pnpm_ver
            pnpm_ver=$(pnpm --version)
            log_info "pnpm found: $pnpm_ver"
        else
            log_warn "pnpm not found (will be set up in Phase 30)"
        fi
    fi

    display_config

    phase_end "Preflight Checks" "success"
    save_checkpoint "00-preflight"
    return 0
}

# Run preflight checks if executed directly
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    preflight_checks
fi
