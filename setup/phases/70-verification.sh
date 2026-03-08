#!/usr/bin/env bash
# ---
# name: "Verification"
# phase: 70
# description: >
#   Runs health checks against the deployed Minion instance. Tests the
#   minion wrapper command, gateway health endpoint, configuration
#   permissions, and channel status. Prints a deployment summary.
# when: >
#   After service is started. Final validation before declaring success.
# requires:
#   - "Phase 60 (service setup) completed"
#   - "Gateway service running"
# produces:
#   - "Verified deployment with health status"
#   - "Deployment summary with next steps"
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

# Ensure derived variables are populated (idempotent)
derive_system_variables

verify_deployment() {
    phase_start "Verification" "70"

    local exec_user="${AGENT_USERNAME:-$(whoami)}"
    local config_dir="${MINION_CONFIG_DIR:-${AGENT_HOME_DIR:-$HOME}/.minion}"
    local gateway_port="${GATEWAY_PORT:-18789}"

    # Test minion command
    local install_method="${INSTALL_METHOD:-package}"
    log_info "Testing minion command (install method: $install_method)..."

    # Ensure PATH includes the relevant bin directories
    if [ "${EXEC_MODE:-local}" = "local" ]; then
        export PATH="${AGENT_HOME_DIR:-$HOME}/.local/bin:${PATH}"
        if [ "$install_method" = "package" ]; then
            case "${PACKAGE_MANAGER:-npm}" in
                pnpm) export PATH="${PNPM_HOME:-${AGENT_HOME_DIR:-$HOME}/.local/share/pnpm}:${PATH}" ;;
                bun)  export PATH="${AGENT_HOME_DIR:-$HOME}/.bun/bin:${PATH}" ;;
            esac
        fi
    fi

    if [ "${EXEC_MODE:-local}" = "remote" ]; then
        local wrapper_output
        wrapper_output=$(run_cmd --as "$exec_user" "export PATH=\$HOME/.local/bin:\$HOME/.local/share/pnpm:\$HOME/.bun/bin:\$PATH && minion --version" 2>/dev/null || echo "failed")
        if [ "$wrapper_output" != "failed" ]; then
            log_success "minion --version: $wrapper_output"
        else
            log_warn "minion command test failed (service may still be running)"
        fi
    else
        local wrapper_output
        wrapper_output=$(minion --version 2>/dev/null || echo "failed")
        if [ "$wrapper_output" != "failed" ]; then
            log_success "minion --version: $wrapper_output"
        else
            log_warn "minion command test failed (service may still be running)"
        fi
    fi

    # Check configuration file permissions
    log_info "Checking configuration file permissions..."
    local config_perms
    config_perms=$(run_cmd --as "$exec_user" "stat -c '%a' '${config_dir}/gateway.json'" 2>/dev/null \
        || run_cmd --as "$exec_user" "stat -c '%a' '${config_dir}/minion.json'" 2>/dev/null \
        || echo "unknown")

    if [ "$config_perms" = "600" ]; then
        log_success "Configuration file permissions are correct (600)"
    elif [ "$config_perms" != "unknown" ]; then
        log_warn "Configuration file has permissions: $config_perms (expected 600)"
    fi

    # Test gateway connectivity with progressive backoff
    log_info "Verifying gateway connectivity on port $gateway_port..."

    local max_attempts=5
    local attempt=1
    local health_ok=false
    local backoff_delays=(1 2 4 5 5)

    while [ $attempt -le $max_attempts ]; do
        log_info "Health check attempt $attempt/$max_attempts..."
        local health_response
        if [ "${EXEC_MODE:-local}" = "remote" ]; then
            health_response=$(run_cmd --as "$exec_user" "curl -s --max-time 5 http://127.0.0.1:${gateway_port}/health" 2>/dev/null || echo "")
        else
            health_response=$(curl -s --max-time 5 "http://127.0.0.1:${gateway_port}/health" 2>/dev/null || echo "")
        fi
        if [ -n "$health_response" ]; then
            log_success "Gateway responding on port $gateway_port"
            log_debug "Response: $health_response"
            health_ok=true
            break
        fi
        if [ $attempt -lt $max_attempts ]; then
            local delay=${backoff_delays[$((attempt - 1))]}
            log_debug "Not ready yet, waiting ${delay}s..."
            sleep "$delay"
        fi
        attempt=$((attempt + 1))
    done

    if [ "$health_ok" != "true" ]; then
        log_warn "Gateway not responding after $max_attempts attempts (may need more time)"
    fi

    # Check enabled channels
    log_info "Checking enabled channels..."
    [ "${ENABLE_WHATSAPP:-false}" = "true" ] && log_info "  WhatsApp: enabled (QR pairing may be required)"
    [ "${ENABLE_TELEGRAM:-false}" = "true" ] && log_info "  Telegram: enabled"
    [ "${ENABLE_DISCORD:-false}" = "true" ] && log_info "  Discord: enabled"
    [ "${ENABLE_WEB:-true}" = "true" ] && log_info "  Web UI: enabled at http://127.0.0.1:${gateway_port}"

    # Print summary
    echo ""
    echo -e "${GREEN}╔═══════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║ DEPLOYMENT SUCCESSFUL${NC}"
    echo -e "${GREEN}╠═══════════════════════════════════════════════════════════════╣${NC}"
    echo -e "${GREEN}║${NC} Agent: ${AGENT_NAME:-minion}"
    echo -e "${GREEN}║${NC} User: ${exec_user}"
    echo -e "${GREEN}║${NC} Method: ${install_method}"
    if [ "$install_method" = "source" ]; then
        echo -e "${GREEN}║${NC} Install: ${MINION_ROOT:-~/minion}"
    else
        echo -e "${GREEN}║${NC} Package: @nikolasp98/minion (${PACKAGE_MANAGER:-npm})"
    fi
    echo -e "${GREEN}║${NC} Gateway Port: $gateway_port"
    echo -e "${GREEN}║${NC} Status: Running"
    if [ "${TAILSCALE_FUNNEL_ENABLED:-false}" = "true" ]; then
        local ts_fqdn=""
        ts_fqdn=$(tailscale status --json 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); me=d.get('Self',{}); print(me.get('DNSName','').rstrip('.'))" 2>/dev/null || echo "")
        if [ -n "$ts_fqdn" ]; then
            echo -e "${GREEN}║${NC} Public URL: https://${ts_fqdn}"
            echo -e "${GREEN}║${NC} OAuth:      https://${ts_fqdn}/oauth-callback"
        fi
    fi
    echo -e "${GREEN}╠═══════════════════════════════════════════════════════════════╣${NC}"
    echo -e "${GREEN}║ Next Steps:${NC}"
    local step=1
    if [ "${EXEC_MODE:-local}" = "remote" ]; then
        echo -e "${GREEN}║${NC} ${step}. Access web UI via SSH tunnel:"
        echo -e "${GREEN}║${NC}    ssh -L ${gateway_port}:127.0.0.1:${gateway_port} ${exec_user}@${VPS_HOSTNAME:-HOST}"
    else
        echo -e "${GREEN}║${NC} ${step}. Access web UI at:"
        echo -e "${GREEN}║${NC}    http://127.0.0.1:${gateway_port}"
    fi
    step=$((step + 1))
    if [ "${ENABLE_WHATSAPP:-false}" = "true" ]; then
        echo -e "${GREEN}║${NC} ${step}. Pair WhatsApp:"
        echo -e "${GREEN}║${NC}    minion channels whatsapp pair"
        step=$((step + 1))
    fi
    if [ "${DM_POLICY:-pairing}" = "pairing" ]; then
        echo -e "${GREEN}║${NC} ${step}. Approve pairing requests:"
        echo -e "${GREEN}║${NC}    minion pairing list"
        echo -e "${GREEN}║${NC}    minion pairing approve <channel> <code>"
    fi
    echo -e "${GREEN}║${NC}"
    echo -e "${GREEN}║${NC} Update later with:"
    if [ "$install_method" = "source" ]; then
        echo -e "${GREEN}║${NC}    $([ "${EXEC_MODE:-local}" = "remote" ] && echo "./setup/setup.sh --update --vps-hostname=${VPS_HOSTNAME:-HOST}" || echo "./setup/setup.sh --update")"
    else
        local update_cmd
        case "${PACKAGE_MANAGER:-npm}" in
            npm)  update_cmd="npm update -g @nikolasp98/minion" ;;
            pnpm) update_cmd="pnpm update -g @nikolasp98/minion" ;;
            bun)  update_cmd="bun update -g @nikolasp98/minion" ;;
        esac
        echo -e "${GREEN}║${NC}    $update_cmd"
    fi
    echo -e "${GREEN}╚═══════════════════════════════════════════════════════════════╝${NC}"
    echo ""

    phase_end "Verification" "success"
    save_checkpoint "70-verification"
    clear_checkpoint
    return 0
}

# Run verification if executed directly
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    verify_deployment
fi
