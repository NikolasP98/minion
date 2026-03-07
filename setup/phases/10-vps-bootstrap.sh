#!/usr/bin/env bash
# ---
# name: "VPS Bootstrap"
# phase: 10
# description: >
#   Bootstraps a fresh VPS from root-only access to a fully provisioned base server.
#   Creates admin user with SSH key auth, hardens SSH, and installs Tailscale.
#   Service user creation is handled by Phase 20 (user-creation). All steps are
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
            log_warn "Failed to read SSH key from 1Password (not signed in?). Trying local SSH keys..."
        fi
    fi

    # 4. Auto-detect local SSH public key
    local ssh_key_candidates=(
        "$HOME/.ssh/id_ed25519.pub"
        "$HOME/.ssh/id_rsa.pub"
        "$HOME/.ssh/id_ecdsa.pub"
    )
    for candidate in "${ssh_key_candidates[@]}"; do
        if [ -f "$candidate" ]; then
            log_info "Using local SSH key: $candidate"
            cat "$candidate"
            return 0
        fi
    done

    log_error "No SSH public key available. Provide via:"
    log_error "  --ssh-pubkey-file=~/.ssh/id_ed25519.pub"
    log_error "  --ssh-pubkey='ssh-ed25519 AAAA...'"
    log_error "  or install and sign into 1Password CLI (op)"
    return 1
}

# --- Sub-step functions ---

step_system_update() {
    log_info "Step 1/6: System update..."
    run_cmd --as root "DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get full-upgrade -y -qq"
    log_success "System updated"
}

step_base_packages() {
    log_info "Step 2/6: Installing base packages..."
    local packages="curl git build-essential ufw fail2ban unattended-upgrades jq htop tmux rsync"
    run_cmd --as root "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $packages"
    log_success "Base packages installed"
}

step_admin_user() {
    local admin="${ADMIN_USER:-niko}"
    log_info "Step 3/6: Creating admin user: $admin..."

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
    log_info "Step 4/6: Setting up SSH key for $admin..."

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
    log_info "Step 5/6: Hardening SSH..."

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
    log_info "Step 6/6: Installing Tailscale..."

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

# --- Main ---

vps_bootstrap() {
    phase_start "VPS Bootstrap" "10"

    step_system_update
    step_base_packages
    step_admin_user
    step_ssh_key
    step_ssh_hardening
    step_tailscale

    phase_end "VPS Bootstrap" "success"
    save_checkpoint "10-vps-bootstrap"
    return 0
}

# Run if executed directly
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    vps_bootstrap
fi
