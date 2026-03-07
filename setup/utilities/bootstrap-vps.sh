#!/usr/bin/env bash
# ---
# name: "Bootstrap VPS Wrapper"
# description: >
#   Thin wrapper for bootstrapping a fresh VPS without running the full Minion
#   deployment. Sets BOOTSTRAP_MODE=true and runs only Phase 00 (preflight) and
#   Phase 10 (VPS bootstrap). Useful when preparing a server for later deployment.
# usage: >
#   bash setup/utilities/bootstrap-vps.sh --vps-hostname=152.53.91.108 [--admin-user=niko] [--verbose]
# ---

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SETUP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Source libraries
source "${SETUP_DIR}/lib/logging.sh"
source "${SETUP_DIR}/lib/variables.sh"
source "${SETUP_DIR}/lib/network.sh"

# Force bootstrap mode
BOOTSTRAP_MODE=true
EXEC_MODE=remote
DRY_RUN=false

# Parse arguments
while [[ $# -gt 0 ]]; do
    case "$1" in
        --vps-hostname=*)
            VPS_HOSTNAME="${1#*=}"
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
        --agent-name=*)
            AGENT_NAME="${1#*=}"
            ;;
        --dry-run)
            DRY_RUN=true
            ;;
        -v|--verbose)
            VERBOSE=true
            export VERBOSE
            CURRENT_LOG_LEVEL=$LOG_LEVEL_DEBUG
            ;;
        --help)
            echo "Usage: bootstrap-vps.sh --vps-hostname=HOST [OPTIONS]"
            echo ""
            echo "Bootstrap a fresh VPS (Phase 10 only)."
            echo ""
            echo "Options:"
            echo "  --vps-hostname=HOST     VPS hostname or IP (required)"
            echo "  --admin-user=USER       Admin username (default: niko)"
            echo "  --ssh-pubkey=KEY        SSH public key string"
            echo "  --ssh-pubkey-file=PATH  Path to SSH public key file"
            echo "  --op-ssh-key-ref=REF    1Password SSH key reference"
            echo "  --agent-name=NAME       Service user name (default: bot-prd)"
            echo "  --dry-run               Show what would happen"
            echo "  -v, --verbose           Debug logging"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
    shift
done

if [ -z "${VPS_HOSTNAME:-}" ]; then
    echo "Error: --vps-hostname is required"
    echo "Usage: bootstrap-vps.sh --vps-hostname=HOST [OPTIONS]"
    exit 1
fi

# Derive variables
derive_system_variables

# Export for child phases
export VPS_HOSTNAME EXEC_MODE BOOTSTRAP_MODE DRY_RUN
export ADMIN_USER AGENT_USERNAME AGENT_NAME
export SSH_PUBKEY SSH_PUBKEY_FILE OP_SSH_KEY_REF
export VERBOSE CURRENT_LOG_LEVEL LOG_DIR LOG_FILE

echo -e "${CYAN}[bootstrap-vps]${NC} Bootstrapping ${VPS_HOSTNAME}..."
echo -e "${CYAN}[bootstrap-vps]${NC} Admin user: ${ADMIN_USER:-niko}"
echo -e "${CYAN}[bootstrap-vps]${NC} Service user: ${AGENT_USERNAME:-bot-prd}"
echo ""

# Run preflight (bootstrap mode)
if [ "$DRY_RUN" = true ]; then
    echo "[DRY RUN] Would execute: 00-preflight.sh"
    echo "[DRY RUN] Would execute: 10-vps-bootstrap.sh"
    exit 0
fi

bash "${SETUP_DIR}/phases/00-preflight.sh"
bash "${SETUP_DIR}/phases/10-vps-bootstrap.sh"

log_success "VPS bootstrap complete! Server is ready for Minion deployment."
echo ""
echo "Next steps:"
echo "  1. Verify: ssh ${ADMIN_USER:-niko}@${VPS_HOSTNAME} sudo whoami"
echo "  2. Deploy: bash setup/setup.sh --vps-hostname=${VPS_HOSTNAME} --agent-name=<name> --api-key=<key>"
