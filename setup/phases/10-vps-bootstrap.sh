#!/usr/bin/env bash
# ---
# name: "VPS Bootstrap"
# phase: 10
# description: >
#   Bootstraps a fresh VPS from root-only access to a fully provisioned base server.
#   Creates admin user with SSH key auth, hardens SSH, installs Tailscale, and
#   creates the minion service user with scaffolded directories. All steps are
#   idempotent. Runs as root via SSH on the target VPS.
# when: >
#   Run on a brand-new VPS before any Minion deployment phases (20-70).
#   Triggered by --bootstrap flag on setup.sh or via bootstrap-vps.sh wrapper.
# requires:
#   - "Root SSH access to VPS_HOSTNAME"
#   - "SSH public key (via --ssh-pubkey, --ssh-pubkey-file, or 1Password CLI)"
# produces:
#   - "Admin user (ADMIN_USER) with sudo NOPASSWD and SSH key auth"
#   - "Hardened SSH config (no password auth, no root password login)"
#   - "Tailscale installed and ready for auth"
#   - "Minion service user (AGENT_USERNAME) with scaffolded ~/.minion/"
#   - "Base packages installed (curl, git, build-essential, ufw, fail2ban, etc.)"
# idempotent: true
# estimated_time: "3-5 minutes"
# ---

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/logging.sh"
source "${SCRIPT_DIR}/../lib/variables.sh"
source "${SCRIPT_DIR}/../lib/network.sh"

# Ensure derived variables are populated
derive_system_variables

# --- SSH Public Key Resolution ---
# Runs LOCALLY (not via run_cmd) to fetch the key, then passes it to remote commands.
get_ssh_pubkey() {
    # 1. Explicit key string
    if [ -n "${SSH_PUBKEY:-}" ]; then
        echo "$SSH_PUBKEY"
        return 0
    fi

    # 2. Key from file
    if [ -n "${SSH_PUBKEY_FILE:-}" ]; then
        if [ -f "$SSH_PUBKEY_FILE" ]; then
            cat "$SSH_PUBKEY_FILE"
            return 0
        else
            log_error "SSH public key file not found: $SSH_PUBKEY_FILE"
            return 1
        fi
    fi

    # 3. 1Password CLI
    local op_ref="${OP_SSH_KEY_REF:-op://Personal/SSH Key/public key}"
    if command -v op &> /dev/null; then
        log_info "Fetching SSH public key from 1Password: $op_ref"
        local key
        if key=$(op read "$op_ref" 2>/dev/null); then
            echo "$key"
            return 0
        else
            log_error "Failed to read SSH key from 1Password (ref: $op_ref)"
            log_error "Make sure you're signed in: op signin"
            return 1
        fi
    fi

    log_error "No SSH public key available. Provide via --ssh-pubkey, --ssh-pubkey-file, or install 1Password CLI (op)"
    return 1
}

# --- Sub-step functions ---

step_system_update() {
    log_info "Step 1/7: System update..."
    run_cmd --as root "DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get full-upgrade -y -qq"
    log_success "System updated"
}

step_base_packages() {
    log_info "Step 2/7: Installing base packages..."
    local packages="curl git build-essential ufw fail2ban unattended-upgrades jq htop tmux rsync"
    run_cmd --as root "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $packages"
    log_success "Base packages installed"
}

step_admin_user() {
    local admin="${ADMIN_USER:-niko}"
    log_info "Step 3/7: Creating admin user: $admin..."

    # Create user if doesn't exist (idempotent)
    if run_cmd --as root "id $admin" &> /dev/null; then
        log_warn "User $admin already exists, skipping creation"
    else
        run_cmd --as root "adduser --disabled-password --gecos '' $admin"
        log_success "User $admin created"
    fi

    # Add to sudo group
    run_cmd --as root "usermod -aG sudo $admin"

    # NOPASSWD sudoers entry (idempotent via tee + check)
    run_cmd --as root "echo '$admin ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/$admin && chmod 0440 /etc/sudoers.d/$admin"
    log_success "Admin user $admin configured with NOPASSWD sudo"
}

step_ssh_key() {
    local admin="${ADMIN_USER:-niko}"
    log_info "Step 4/7: Setting up SSH key for $admin..."

    # Fetch key LOCALLY
    local pubkey
    pubkey=$(get_ssh_pubkey) || return 1

    # Create .ssh dir and inject key (sort -u for idempotency)
    run_cmd --as root "mkdir -p /home/$admin/.ssh && chmod 700 /home/$admin/.ssh"

    # Add key if not already present
    run_cmd --as root "grep -qF '${pubkey}' /home/$admin/.ssh/authorized_keys 2>/dev/null || echo '${pubkey}' >> /home/$admin/.ssh/authorized_keys"
    run_cmd --as root "chmod 600 /home/$admin/.ssh/authorized_keys && chown -R $admin:$admin /home/$admin/.ssh"

    log_success "SSH key installed for $admin"
}

step_ssh_hardening() {
    local admin="${ADMIN_USER:-niko}"
    log_info "Step 5/7: Hardening SSH..."

    # Safety gate: verify SSH key login works for admin BEFORE disabling password auth
    log_info "Verifying SSH key login for $admin before hardening..."
    if ! ssh -o ConnectTimeout=5 -o BatchMode=yes -o StrictHostKeyChecking=no "${admin}@${VPS_HOSTNAME}" "echo 'SSH key auth OK'" &> /dev/null; then
        log_error "SAFETY GATE: Cannot SSH as $admin with key auth. Aborting SSH hardening to prevent lockout."
        log_error "Fix SSH key setup (step 4) before retrying."
        return 1
    fi
    log_success "SSH key auth verified for $admin"

    # Write hardening config
    run_cmd --as root "cat > /etc/ssh/sshd_config.d/99-hardening.conf << 'SSHEOF'
# Minion VPS Bootstrap — SSH hardening
PasswordAuthentication no
PermitRootLogin prohibit-password
ChallengeResponseAuthentication no
UsePAM yes
X11Forwarding no
SSHEOF"

    # Reload sshd
    run_cmd --as root "systemctl reload sshd || systemctl reload ssh"
    log_success "SSH hardened (password auth disabled, root login restricted)"
}

step_tailscale() {
    log_info "Step 6/7: Installing Tailscale..."

    # Install if not present
    if run_cmd --as root "command -v tailscale" &> /dev/null; then
        log_warn "Tailscale already installed, skipping install"
    else
        run_cmd --as root "curl -fsSL https://tailscale.com/install.sh | sh"
        log_success "Tailscale installed"
    fi

    # Check if already authenticated
    if run_cmd --as root "tailscale status" &> /dev/null; then
        log_warn "Tailscale already authenticated"
    else
        # Start tailscale up with SSH — prints auth URL for interactive login
        log_info "Starting Tailscale authentication (interactive)..."
        log_warn ">>> Follow the auth URL printed below to authenticate this server <<<"
        echo ""
        run_cmd --as root "tailscale up --ssh" || true
        echo ""
    fi

    # Enable Tailscale SSH
    run_cmd --as root "tailscale set --ssh" || true
    log_success "Tailscale configured with SSH enabled"
}

step_service_user() {
    local svc_user="${AGENT_USERNAME:-bot-prd}"
    log_info "Step 7/7: Creating minion service user: $svc_user..."

    # Create user if doesn't exist
    if run_cmd --as root "id $svc_user" &> /dev/null; then
        log_warn "User $svc_user already exists, skipping creation"
    else
        run_cmd --as root "adduser --disabled-password --gecos '' $svc_user"
        log_success "User $svc_user created"
    fi

    # Scaffold .minion directory structure
    run_cmd --as root "mkdir -p /home/$svc_user/.minion/{workspace,credentials,agents}"
    run_cmd --as root "chmod 700 /home/$svc_user/.minion"
    run_cmd --as root "chown -R $svc_user:$svc_user /home/$svc_user/.minion"

    # Enable systemd linger for user-level services
    run_cmd --as root "loginctl enable-linger $svc_user" || true

    log_success "Service user $svc_user scaffolded with .minion/ structure"
}

# --- Main ---

vps_bootstrap() {
    phase_start "VPS Bootstrap" "10"

    step_system_update
    step_base_packages
    step_admin_user
    step_ssh_key
    step_ssh_hardening
    step_tailscale
    step_service_user

    phase_end "VPS Bootstrap" "success"
    save_checkpoint "10-vps-bootstrap"
    return 0
}

# Run if executed directly
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    vps_bootstrap
fi
