#!/usr/bin/env bash
# ---
# name: "User Creation"
# phase: 20
# description: >
#   Creates the agent user account and directory structure. In remote mode,
#   creates a new system user via SSH. In local mode, skips user creation
#   (already running as the user) and just creates required directories.
#   Enables systemd lingering for user-level services.
# when: >
#   After preflight passes. Creates the user/dirs that all later phases depend on.
# requires:
#   - "Phase 00 (preflight) completed"
#   - "AGENT_USERNAME, AGENT_HOME_DIR derived"
# produces:
#   - "Agent user account (remote mode)"
#   - "~/.minion/, ~/.minion/workspace/, ~/.minion/credentials/, ~/.local/bin/"
#   - "systemd lingering enabled"
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

create_agent_user() {
    phase_start "User Creation" "20"

    log_debug "EXEC_MODE=${EXEC_MODE:-local}, AGENT_USERNAME=$AGENT_USERNAME, AGENT_HOME_DIR=$AGENT_HOME_DIR"

    if [ "${EXEC_MODE:-local}" = "remote" ]; then
        # Remote mode: create user via SSH as root
        log_info "Creating agent user: $AGENT_USERNAME on $VPS_HOSTNAME..."

        if run_cmd --as root "id $AGENT_USERNAME" &> /dev/null; then
            log_warn "User $AGENT_USERNAME already exists, skipping creation"
        else
            log_info "Creating user with home directory..."
            if ! run_cmd --as root "useradd -m -s /bin/bash $AGENT_USERNAME"; then
                handle_error $? "Failed to create user" "User Creation"
                return 1
            fi
            log_success "User $AGENT_USERNAME created successfully"
        fi

        # Add user to docker group when sandbox mode requires Docker
        log_debug "SANDBOX_MODE=${SANDBOX_MODE:-non-main}"
        if [ "${SANDBOX_MODE:-non-main}" != "off" ]; then
            if run_cmd --as root "getent group docker" &> /dev/null; then
                log_info "Adding $AGENT_USERNAME to docker group for sandbox support..."
                run_cmd --as root "usermod -aG docker $AGENT_USERNAME"
                log_success "Added $AGENT_USERNAME to docker group"
            else
                log_warn "docker group not found — skip group assignment (install Docker first)"
            fi
        fi

        # Copy deployer's SSH key + create directories + set permissions in one SSH call
        log_info "Setting up SSH key access and directory structure for $AGENT_USERNAME..."
        local admin="${ADMIN_USER:-niko}"
        run_cmd --as root "
            mkdir -p ${AGENT_HOME_DIR}/.ssh && chmod 700 ${AGENT_HOME_DIR}/.ssh &&
            (cp /home/${admin}/.ssh/authorized_keys ${AGENT_HOME_DIR}/.ssh/authorized_keys 2>/dev/null ||
             cp /root/.ssh/authorized_keys ${AGENT_HOME_DIR}/.ssh/authorized_keys 2>/dev/null || true) &&
            chmod 600 ${AGENT_HOME_DIR}/.ssh/authorized_keys 2>/dev/null || true
            mkdir -p ${AGENT_HOME_DIR}/.minion/workspace ${AGENT_HOME_DIR}/.minion/credentials ${AGENT_HOME_DIR}/.local/bin ${AGENT_HOME_DIR}/.config/systemd/user &&
            chown -R ${AGENT_USERNAME}:${AGENT_USERNAME} ${AGENT_HOME_DIR} &&
            chmod 700 ${AGENT_HOME_DIR}/.minion ${AGENT_HOME_DIR}/.minion/credentials
        "
        log_success "SSH key access and directory structure configured for $AGENT_USERNAME"

        log_info "Configuring systemd user lingering..."
        if ! run_cmd --as root "loginctl enable-linger $AGENT_USERNAME"; then
            log_warn "Failed to enable lingering (may already be enabled)"
        fi

    else
        # Local mode: just create directories (user already exists)
        log_info "Local mode: creating directory structure for current user..."

        mkdir -p "${AGENT_HOME_DIR}/.minion/workspace"
        mkdir -p "${AGENT_HOME_DIR}/.minion/credentials"
        mkdir -p "${AGENT_HOME_DIR}/.local/bin"
        mkdir -p "${AGENT_HOME_DIR}/.config/systemd/user"

        chmod 700 "${AGENT_HOME_DIR}/.minion"
        chmod 700 "${AGENT_HOME_DIR}/.minion/credentials"

        log_info "Configuring systemd user lingering..."
        if command -v loginctl &> /dev/null; then
            loginctl enable-linger "$(whoami)" 2>/dev/null || \
                log_warn "Failed to enable lingering (may need sudo or already enabled)"
        else
            log_warn "loginctl not available, skipping lingering setup"
        fi
    fi

    log_success "Directory structure ready"

    phase_end "User Creation" "success"
    save_checkpoint "20-user-creation"
    return 0
}

# Run user creation if executed directly
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    create_agent_user
fi
