#!/usr/bin/env bash
# ---
# name: "Decommission"
# phase: 95
# description: >
#   Non-destructive shutdown of an agent deployment. Stops and disables the
#   systemd service, removes heavy build artifacts (node_modules, dist) to
#   free disk space, opens permissions so other VPS users can access the
#   home directory, but preserves config, workspace, credentials, source
#   code, wrapper, and service file. Leaves a .decommissioned marker and
#   prints reactivation instructions.
# when: >
#   Run via --decommission flag to park a deployment without destroying it.
#   The agent can be reactivated later with pnpm install + pnpm build + systemctl start.
# requires:
#   - "An existing Minion deployment"
# produces:
#   - "Stopped service, freed disk space, open permissions"
#   - ".decommissioned marker file in MINION_ROOT"
# flags:
#   -v, --verbose: "Enable debug-level logging"
# idempotent: true
# estimated_time: "30 seconds"
# ---

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/logging.sh"
source "${SCRIPT_DIR}/../lib/variables.sh"
source "${SCRIPT_DIR}/../lib/network.sh"

# Ensure derived variables are populated (idempotent)
derive_system_variables

decommission_deployment() {
    phase_start "Decommission" "95"

    local exec_user="${AGENT_USERNAME:-$(whoami)}"
    local agent_home="${AGENT_HOME_DIR:-$HOME}"
    local minion_root="${MINION_ROOT:-${agent_home}/minion}"
    local config_dir="${MINION_CONFIG_DIR:-${agent_home}/.minion}"
    local workspace_dir="${WORKSPACE_DIR:-${config_dir}/workspace}"

    log_info "Decommissioning agent: $exec_user"
    log_info "Home directory: $agent_home"
    log_info "Source directory: $minion_root"

    # 1. Stop the service
    log_info "Stopping minion-gateway service..."
    run_cmd --as "$exec_user" "systemctl --user stop minion-gateway.service" || true

    # 2. Disable the service
    log_info "Disabling minion-gateway service..."
    run_cmd --as "$exec_user" "systemctl --user disable minion-gateway.service" || true

    # 3. Remove heavy build artifacts
    log_info "Removing node_modules/ and dist/ to free disk space..."
    run_cmd --as "$exec_user" "rm -rf '${minion_root}/node_modules'"
    run_cmd --as "$exec_user" "rm -rf '${minion_root}/dist'"

    # 4. Open home directory permissions
    log_info "Opening home directory permissions (755)..."
    run_cmd --as root "chmod 755 '${agent_home}'"

    # 5. Open source directory recursively
    log_info "Opening source directory permissions..."
    run_cmd --as root "find '${minion_root}' -type d -exec chmod 755 {} +"
    run_cmd --as root "find '${minion_root}' -type f -exec chmod 644 {} +"

    # 6. Open config directories
    log_info "Opening config directory permissions..."
    run_cmd --as root "chmod 755 '${config_dir}'"
    run_cmd --as root "chmod 755 '${workspace_dir}'"

    # 7. Keep credentials locked down
    log_info "Preserving credentials/ permissions (700)..."
    if run_cmd --as "$exec_user" "test -d '${config_dir}/credentials'" 2>/dev/null; then
        run_cmd --as root "chmod 700 '${config_dir}/credentials'"
    fi

    # 8. Keep gateway config locked down
    log_info "Preserving gateway config permissions (600)..."
    for cfg_name in gateway.json minion.json; do
        if run_cmd --as "$exec_user" "test -f '${config_dir}/${cfg_name}'" 2>/dev/null; then
            run_cmd --as root "chmod 600 '${config_dir}/${cfg_name}'"
        fi
    done

    # 9. Write decommissioned marker
    local timestamp
    timestamp="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    log_info "Writing .decommissioned marker..."
    run_cmd --as "$exec_user" "echo 'Decommissioned at ${timestamp} by $(whoami)' > '${minion_root}/.decommissioned'"

    log_success "Agent decommissioned successfully"

    # 10. Print reactivation instructions
    echo ""
    echo -e "${CYAN}╔═══════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║              Reactivation Instructions                        ║${NC}"
    echo -e "${CYAN}╚═══════════════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "  To reactivate this agent, run:"
    echo ""
    echo -e "  ${GREEN}# As ${exec_user} (or via sudo -u ${exec_user}):${NC}"
    echo -e "  cd ${minion_root}"
    echo -e "  pnpm install"
    echo -e "  pnpm build"
    echo -e "  systemctl --user enable minion-gateway.service"
    echo -e "  systemctl --user start minion-gateway.service"
    echo -e "  rm -f ${minion_root}/.decommissioned"
    echo ""
    echo -e "  ${GREEN}# Restore home directory permissions (optional):${NC}"
    echo -e "  sudo chmod 750 ${agent_home}"
    echo ""

    phase_end "Decommission" "success"
    return 0
}

# Run decommission if executed directly
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    decommission_deployment
fi
