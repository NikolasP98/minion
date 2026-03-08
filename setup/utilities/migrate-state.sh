#!/usr/bin/env bash
# migrate-state.sh — Full gateway migration from one server to another
#
# End-to-end migration script based on operational experience migrating
# protopi → netcup (2026-03-08). Handles dependencies, state transfer,
# path rewriting, service configuration, channel deduplication, and verification.
#
# Usage:
#   ./setup/utilities/migrate-state.sh \
#     --source-host protopi --source-user minion \
#     --target-host 152.53.91.108 --target-user bot-prd --target-admin niko \
#     [--from-host old.ts.net --to-host new.ts.net] \
#     [--disable-channels discord,whatsapp] \
#     [--skip-deps] [--skip-service-fix] [--dry-run]
#
# Phases:
#   1. Pre-flight — SSH connectivity, environment checks
#   2. Dependencies — Install bun + qmd on target (if needed)
#   3. Transfer — Stream .minion tarball source → target via SSH pipe
#   4. Rewrite — Fix all hardcoded paths and hostnames
#   5. Service — Fix systemd unit (KillMode, PATH, port consistency)
#   6. Dedup — Disable migrated channels on source to avoid conflicts
#   7. Start — Launch gateway on target
#   8. Verify — Health check, port binding, log inspection
#
# Lessons baked in from production migration:
#   - Streams tar directly (no 2× transfer through local machine)
#   - Uses `minion gateway relocate` for JSON-aware path rewriting (not sed)
#   - Fixes ALL state files: gateway.json, sessions.json, agents-list.json,
#     exec-approvals.json, qmd index.yml, auth credential JSONs
#   - Sets KillMode=mixed to prevent orphaned qmd embed processes
#   - Adds bun to PATH for qmd memory backend
#   - Kills orphaned child processes before starting
#   - Waits for full startup (~60s) before health check

set -euo pipefail

# ─── Colors ──────────────────────────────────────────────────────────────────

if [[ -t 1 ]]; then
  BOLD='\033[1m'; DIM='\033[2m'; GREEN='\033[32m'; YELLOW='\033[33m'
  RED='\033[31m'; CYAN='\033[36m'; RESET='\033[0m'
else
  BOLD=''; DIM=''; GREEN=''; YELLOW=''; RED=''; CYAN=''; RESET=''
fi

info()  { echo -e "  ${GREEN}✓${RESET} $*"; }
warn()  { echo -e "  ${YELLOW}⚠${RESET} $*"; }
fail()  { echo -e "  ${RED}✗${RESET} $*"; }
phase() { echo -e "\n${BOLD}▸ Phase $1: $2${RESET}"; }

# ─── Defaults ────────────────────────────────────────────────────────────────

SOURCE_HOST=""
SOURCE_USER=""
SOURCE_ADMIN=""
TARGET_HOST=""
TARGET_USER=""
TARGET_ADMIN=""
FROM_HOST=""
TO_HOST=""
DISABLE_CHANNELS=""
SKIP_DEPS=false
SKIP_SERVICE_FIX=false
DRY_RUN=false

EXCLUDE_DIRS=(
  ".minion/logs"
  ".minion/browser"
  ".minion/completions"
  ".minion/gateway.json.bak*"
  ".minion/canvas"
  ".minion/update-check.json"
  ".minion/.claude"
  ".minion/cron"
  ".minion/bin"
)

# ─── Argument parsing ────────────────────────────────────────────────────────

usage() {
  cat <<'USAGE'
Usage: migrate-state.sh [OPTIONS]

Migrates a Minion gateway from one server to another, including all agent state,
credentials, sessions, memory indexes, and workspaces.

Required:
  --source-host HOST        Source server hostname or IP
  --source-user USER        Source app user (owns ~/.minion, e.g. minion)
  --target-host HOST        Target server hostname or IP
  --target-user USER        Target app user (e.g. bot-prd)
  --target-admin USER       Target admin user with sudo (e.g. niko)

Optional:
  --source-admin USER       Source admin user with sudo (default: same as target-admin)
  --from-host HOSTNAME      Old Tailscale/DNS hostname to rewrite in config
  --to-host HOSTNAME        New Tailscale/DNS hostname
  --disable-channels LIST   Comma-separated channels to disable on source after
                            migration (e.g. discord,whatsapp). Prevents duplicate
                            bot connections from both servers.
  --skip-deps               Skip dependency installation (bun, qmd) on target
  --skip-service-fix        Skip systemd service file fixes on target
  --dry-run                 Show what would be done without executing
  --help                    Show this help

Example (full migration with hostname rewrite and Discord dedup):
  ./setup/utilities/migrate-state.sh \
    --source-host protopi --source-user minion \
    --target-host 152.53.91.108 --target-user bot-prd --target-admin niko \
    --from-host protopi.donkey-agama.ts.net \
    --to-host v2202603342963439612.donkey-agama.ts.net \
    --disable-channels discord

Example (dry run):
  ./setup/utilities/migrate-state.sh \
    --source-host protopi --source-user minion \
    --target-host 10.0.0.5 --target-user bot-prd --target-admin admin \
    --dry-run
USAGE
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source-host)      SOURCE_HOST="$2"; shift 2 ;;
    --source-user)      SOURCE_USER="$2"; shift 2 ;;
    --source-admin)     SOURCE_ADMIN="$2"; shift 2 ;;
    --target-host)      TARGET_HOST="$2"; shift 2 ;;
    --target-user)      TARGET_USER="$2"; shift 2 ;;
    --target-admin)     TARGET_ADMIN="$2"; shift 2 ;;
    --from-host)        FROM_HOST="$2"; shift 2 ;;
    --to-host)          TO_HOST="$2"; shift 2 ;;
    --disable-channels) DISABLE_CHANNELS="$2"; shift 2 ;;
    --skip-deps)        SKIP_DEPS=true; shift ;;
    --skip-service-fix) SKIP_SERVICE_FIX=true; shift ;;
    --dry-run)          DRY_RUN=true; shift ;;
    --help|-h)          usage 0 ;;
    *)                  echo "Unknown option: $1"; usage 1 ;;
  esac
done

# Validate required args
for var in SOURCE_HOST SOURCE_USER TARGET_HOST TARGET_USER TARGET_ADMIN; do
  if [[ -z "${!var}" ]]; then
    echo "Error: --$(echo "$var" | tr '_' '-' | tr '[:upper:]' '[:lower:]') is required"
    usage 1
  fi
done

# ─── Derived values ──────────────────────────────────────────────────────────

SOURCE_HOME="/home/${SOURCE_USER}"
TARGET_HOME="/home/${TARGET_USER}"
SOURCE_SSH="${SOURCE_USER}@${SOURCE_HOST}"
SOURCE_ADMIN_SSH="${SOURCE_ADMIN:-${TARGET_ADMIN}}@${SOURCE_HOST}"
TARGET_SSH="${TARGET_ADMIN}@${TARGET_HOST}"
TARGET_STATE_DIR="${TARGET_HOME}/.minion"

# Helper: run command on target as the app user via sudo
target_as_user() {
  ssh "$TARGET_SSH" "sudo -u ${TARGET_USER} bash -c '$*'"
}

# Helper: run systemctl --user on target as app user
target_systemctl() {
  local uid
  uid=$(ssh "$TARGET_SSH" "id -u ${TARGET_USER}")
  ssh "$TARGET_SSH" "sudo -u ${TARGET_USER} \
    XDG_RUNTIME_DIR=/run/user/${uid} \
    DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus \
    systemctl --user $*"
}

# Helper: run systemctl --user on source as app user
source_systemctl() {
  local uid
  uid=$(ssh "$SOURCE_ADMIN_SSH" "id -u ${SOURCE_USER}")
  ssh "$SOURCE_ADMIN_SSH" "sudo -u ${SOURCE_USER} \
    XDG_RUNTIME_DIR=/run/user/${uid} \
    DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus \
    systemctl --user $*"
}

# ─── Banner ──────────────────────────────────────────────────────────────────

echo -e "${BOLD}"
echo "═══════════════════════════════════════════════════════════"
echo "  Minion Gateway Migration"
echo "═══════════════════════════════════════════════════════════"
echo -e "${RESET}"
echo -e "  Source:  ${CYAN}${SOURCE_SSH}${RESET} (${SOURCE_HOME}/.minion)"
echo -e "  Target:  ${CYAN}${TARGET_USER}@${TARGET_HOST}${RESET} (${TARGET_STATE_DIR})"
echo -e "  Admin:   ${TARGET_SSH}"
echo -e "  Path:    ${RED}${SOURCE_HOME}${RESET} → ${GREEN}${TARGET_HOME}${RESET}"
if [[ -n "$FROM_HOST" && -n "$TO_HOST" ]]; then
  echo -e "  Host:    ${RED}${FROM_HOST}${RESET} → ${GREEN}${TO_HOST}${RESET}"
fi
if [[ -n "$DISABLE_CHANNELS" ]]; then
  echo -e "  Dedup:   disable ${YELLOW}${DISABLE_CHANNELS}${RESET} on source after migration"
fi
if $DRY_RUN; then
  echo -e "  Mode:    ${YELLOW}DRY RUN${RESET}"
fi
echo ""

# ─── Dry run ─────────────────────────────────────────────────────────────────

if $DRY_RUN; then
  echo "[dry-run] Would execute the following phases:"
  echo ""
  echo "  Phase 1: Pre-flight — test SSH, check environments"
  if ! $SKIP_DEPS; then
    echo "  Phase 2: Dependencies — install bun + qmd on target"
  fi
  echo "  Phase 3: Transfer — stop target, backup, stream tarball, fix ownership"
  echo "           Excluding: ${EXCLUDE_DIRS[*]}"
  echo "  Phase 4: Rewrite — minion gateway relocate"
  echo "             --from ${SOURCE_HOME} --to ${TARGET_HOME}"
  if [[ -n "$FROM_HOST" && -n "$TO_HOST" ]]; then
    echo "             --from-host ${FROM_HOST} --to-host ${TO_HOST}"
  fi
  if ! $SKIP_SERVICE_FIX; then
    echo "  Phase 5: Service — fix KillMode, add bun to PATH"
  fi
  if [[ -n "$DISABLE_CHANNELS" ]]; then
    echo "  Phase 6: Dedup — disable ${DISABLE_CHANNELS} on source, restart source"
  fi
  echo "  Phase 7: Start — launch gateway on target"
  echo "  Phase 8: Verify — health check, port binding, Discord login"
  echo ""
  exit 0
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Phase 1: Pre-flight
# ═══════════════════════════════════════════════════════════════════════════════

phase 1 "Pre-flight checks"

echo -n "  SSH to source (${SOURCE_SSH})... "
if ssh -o ConnectTimeout=5 -o BatchMode=yes "$SOURCE_SSH" "echo ok" 2>/dev/null; then
  true
else
  fail "FAILED"; exit 1
fi

echo -n "  SSH to target (${TARGET_SSH})... "
if ssh -o ConnectTimeout=5 -o BatchMode=yes "$TARGET_SSH" "echo ok" 2>/dev/null; then
  true
else
  fail "FAILED"; exit 1
fi

echo -n "  Source state dir... "
SOURCE_SIZE=$(ssh "$SOURCE_SSH" "du -sh ${SOURCE_HOME}/.minion 2>/dev/null | cut -f1" 2>/dev/null || echo "?")
if [[ "$SOURCE_SIZE" != "?" ]]; then
  info "${SOURCE_SIZE}"
else
  fail "not found at ${SOURCE_HOME}/.minion"; exit 1
fi

echo -n "  Target Node.js... "
TARGET_NODE=$(ssh "$TARGET_SSH" "node --version 2>/dev/null || echo NOT_FOUND")
if [[ "$TARGET_NODE" == "NOT_FOUND" ]]; then
  fail "Node.js not installed on target"; exit 1
else
  info "${TARGET_NODE}"
fi

echo -n "  Target minion CLI... "
MINION_BIN=$(ssh "$TARGET_SSH" "sudo -u ${TARGET_USER} bash -c 'which minion 2>/dev/null || echo NOT_FOUND'" 2>/dev/null)
if [[ "$MINION_BIN" == "NOT_FOUND" ]]; then
  warn "not found — path rewriting will use sed fallback"
  USE_MINION_CLI=false
else
  info "${MINION_BIN}"
  USE_MINION_CLI=true
fi

echo -n "  Target bun... "
TARGET_BUN=$(ssh "$TARGET_SSH" "sudo -u ${TARGET_USER} bash -c '~/.bun/bin/bun --version 2>/dev/null || echo NOT_FOUND'" 2>/dev/null)
if [[ "$TARGET_BUN" == "NOT_FOUND" ]]; then
  if $SKIP_DEPS; then
    warn "not installed (--skip-deps set, memory/qmd will not work)"
  else
    warn "not installed — will install in Phase 2"
  fi
  NEED_BUN=true
else
  info "v${TARGET_BUN}"
  NEED_BUN=false
fi

echo -n "  Target qmd... "
TARGET_QMD=$(ssh "$TARGET_SSH" "sudo -u ${TARGET_USER} bash -c '~/.bun/bin/qmd --version 2>/dev/null || echo NOT_FOUND'" 2>/dev/null)
if [[ "$TARGET_QMD" == "NOT_FOUND" ]]; then
  if $SKIP_DEPS; then
    warn "not installed (--skip-deps set)"
  else
    warn "not installed — will install in Phase 2"
  fi
  NEED_QMD=true
else
  info "${TARGET_QMD}"
  NEED_QMD=false
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Phase 2: Dependencies
# ═══════════════════════════════════════════════════════════════════════════════

if ! $SKIP_DEPS && ($NEED_BUN || $NEED_QMD); then
  phase 2 "Installing dependencies on target"

  if $NEED_BUN; then
    echo -n "  Installing bun... "
    # bun installer requires unzip
    ssh "$TARGET_SSH" "which unzip >/dev/null 2>&1 || sudo apt-get install -y unzip >/dev/null 2>&1" 2>/dev/null
    ssh "$TARGET_SSH" "sudo -u ${TARGET_USER} bash -c 'curl -fsSL https://bun.sh/install | bash'" >/dev/null 2>&1
    # Verify
    BUN_VER=$(ssh "$TARGET_SSH" "sudo -u ${TARGET_USER} bash -c '~/.bun/bin/bun --version'" 2>/dev/null || echo "FAILED")
    if [[ "$BUN_VER" == "FAILED" ]]; then
      fail "bun installation failed"; exit 1
    fi
    info "bun v${BUN_VER}"
  fi

  if $NEED_QMD; then
    echo -n "  Installing qmd via bun... "
    ssh "$TARGET_SSH" "sudo -u ${TARGET_USER} bash -c 'export PATH=\$HOME/.bun/bin:\$PATH && bun install -g @tobilu/qmd'" >/dev/null 2>&1
    QMD_VER=$(ssh "$TARGET_SSH" "sudo -u ${TARGET_USER} bash -c '~/.bun/bin/qmd --version'" 2>/dev/null || echo "FAILED")
    if [[ "$QMD_VER" == "FAILED" ]]; then
      warn "qmd installation failed — memory search will not work"
    else
      info "qmd ${QMD_VER}"
    fi
  fi
else
  if $SKIP_DEPS; then
    echo -e "\n${DIM}  Phase 2: Dependencies — skipped (--skip-deps)${RESET}"
  else
    echo -e "\n${DIM}  Phase 2: Dependencies — all present, skipping${RESET}"
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Phase 3: Transfer
# ═══════════════════════════════════════════════════════════════════════════════

phase 3 "Transferring state"

# Stop target gateway if running
echo -n "  Stopping target gateway... "
if target_systemctl "is-active minion-gateway.service" >/dev/null 2>&1; then
  target_systemctl "stop minion-gateway.service" 2>/dev/null
  info "stopped"
  # Kill any orphaned child processes (qmd embed from previous runs)
  ssh "$TARGET_SSH" "sudo pkill -u ${TARGET_USER} -f 'qmd embed' 2>/dev/null || true" 2>/dev/null
else
  info "not running"
fi

# Backup existing state
echo -n "  Backing up existing state... "
if ssh "$TARGET_SSH" "test -d ${TARGET_STATE_DIR}" 2>/dev/null; then
  ssh "$TARGET_SSH" "sudo mv ${TARGET_STATE_DIR} ${TARGET_STATE_DIR}.migration-backup"
  info "→ ${TARGET_STATE_DIR}.migration-backup"
else
  info "no existing state"
fi

# Stream tarball
echo -n "  Streaming tarball (source → target)... "
EXCLUDE_ARGS=""
for dir in "${EXCLUDE_DIRS[@]}"; do
  EXCLUDE_ARGS="${EXCLUDE_ARGS} --exclude='${dir}'"
done

# Direct SSH pipe — no intermediate storage on local machine
# shellcheck disable=SC2086
ssh "$SOURCE_SSH" "tar czf - -C ${SOURCE_HOME} ${EXCLUDE_ARGS} .minion" \
  | ssh "$TARGET_SSH" "sudo tar xzf - -C ${TARGET_HOME}/"
info "transfer complete"

# Fix ownership
echo -n "  Fixing ownership... "
ssh "$TARGET_SSH" "sudo chown -R ${TARGET_USER}:${TARGET_USER} ${TARGET_STATE_DIR}"
info "${TARGET_USER}:${TARGET_USER}"

# Create excluded directories
echo -n "  Creating excluded directories... "
ssh "$TARGET_SSH" "sudo -u ${TARGET_USER} mkdir -p ${TARGET_STATE_DIR}/logs"
info "logs/"

# ═══════════════════════════════════════════════════════════════════════════════
# Phase 4: Rewrite paths
# ═══════════════════════════════════════════════════════════════════════════════

phase 4 "Rewriting paths"

HOST_ARGS=""
if [[ -n "$FROM_HOST" && -n "$TO_HOST" ]]; then
  HOST_ARGS="--from-host '${FROM_HOST}' --to-host '${TO_HOST}'"
fi

if $USE_MINION_CLI; then
  # JSON-aware rewriting via `minion gateway relocate`
  # This handles: gateway.json, agents-list.json, exec-approvals.json,
  # agents/*/sessions/sessions.json, agents/*/qmd/xdg-config/qmd/index.yml,
  # agents/*/auth-credentials/**/*.json
  # shellcheck disable=SC2086
  ssh "$TARGET_SSH" "sudo -u ${TARGET_USER} ${MINION_BIN} gateway relocate \
    --from '${SOURCE_HOME}' --to '${TARGET_HOME}' \
    --state-dir '${TARGET_STATE_DIR}' \
    ${HOST_ARGS}" 2>&1 | sed 's/^/  /'
else
  # Fallback: sed-based replacement
  # IMPORTANT: This is less reliable than `minion gateway relocate` because:
  # - sed can leave trailing commas in JSON arrays (invalid JSON)
  # - sed doesn't distinguish path strings from content strings
  # - sed with global replacement can be overly greedy
  warn "Using sed fallback (minion CLI not available on target)"
  warn "Consider installing minion first, then re-running with relocate"

  # Target all config/state JSON and YAML files, skip workspace content,
  # session transcripts, KG databases, and qmd cache
  ssh "$TARGET_SSH" "sudo find ${TARGET_STATE_DIR} \
    \( -name 'gateway.json' \
       -o -name 'agents-list.json' \
       -o -name 'exec-approvals.json' \
       -o -name 'sessions.json' \
       -o -name 'index.yml' \
       -o -path '*/auth-credentials/*.json' \
    \) \
    -not -path '*/workspaces/*' \
    -not -path '*/xdg-cache/*' \
    -exec sed -i 's|${SOURCE_HOME}/|${TARGET_HOME}/|g' {} +"

  # Also replace without trailing slash for bare directory references
  ssh "$TARGET_SSH" "sudo find ${TARGET_STATE_DIR} \
    \( -name 'gateway.json' \
       -o -name 'agents-list.json' \
       -o -name 'exec-approvals.json' \
       -o -name 'sessions.json' \
       -o -name 'index.yml' \
       -o -path '*/auth-credentials/*.json' \
    \) \
    -not -path '*/workspaces/*' \
    -not -path '*/xdg-cache/*' \
    -exec sed -i 's|${SOURCE_HOME}\"|${TARGET_HOME}\"|g' {} +"

  if [[ -n "$FROM_HOST" && -n "$TO_HOST" ]]; then
    ssh "$TARGET_SSH" "sudo sed -i 's|${FROM_HOST}|${TO_HOST}|g' ${TARGET_STATE_DIR}/gateway.json"
    info "hostname rewritten in gateway.json"
  fi
fi

# Validate gateway.json
echo -n "  Validating gateway.json... "
if ssh "$TARGET_SSH" "sudo -u ${TARGET_USER} python3 -c \
  \"import json; json.load(open('${TARGET_STATE_DIR}/gateway.json')); print('ok')\"" 2>/dev/null; then
  true
else
  fail "gateway.json is invalid JSON after rewrite!"
  fail "Manual fix required before starting gateway"
  exit 1
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Phase 5: Service file fixes
# ═══════════════════════════════════════════════════════════════════════════════

if ! $SKIP_SERVICE_FIX; then
  phase 5 "Fixing systemd service"

  SERVICE_FILE="${TARGET_HOME}/.config/systemd/user/minion-gateway.service"

  if ssh "$TARGET_SSH" "test -f ${SERVICE_FILE}" 2>/dev/null; then
    # Fix KillMode (process → mixed to prevent orphaned qmd embed children)
    echo -n "  KillMode... "
    CURRENT_KILLMODE=$(ssh "$TARGET_SSH" "grep '^KillMode=' ${SERVICE_FILE} 2>/dev/null | cut -d= -f2" 2>/dev/null)
    if [[ "$CURRENT_KILLMODE" == "process" ]]; then
      ssh "$TARGET_SSH" "sudo sed -i 's/^KillMode=process/KillMode=mixed/' ${SERVICE_FILE}"
      # Add TimeoutStopSec if not present
      if ! ssh "$TARGET_SSH" "grep -q '^TimeoutStopSec=' ${SERVICE_FILE}" 2>/dev/null; then
        ssh "$TARGET_SSH" "sudo sed -i '/^KillMode=mixed/a TimeoutStopSec=15' ${SERVICE_FILE}"
      fi
      info "process → mixed (+ TimeoutStopSec=15)"
    elif [[ "$CURRENT_KILLMODE" == "mixed" ]]; then
      info "already mixed"
    else
      warn "unexpected value: ${CURRENT_KILLMODE:-not set}"
    fi

    # Ensure bun is in PATH
    echo -n "  PATH includes bun... "
    if ssh "$TARGET_SSH" "grep -q '\.bun/bin' ${SERVICE_FILE}" 2>/dev/null; then
      info "yes"
    else
      ssh "$TARGET_SSH" "sudo sed -i \
        's|PATH=${TARGET_HOME}/.local/bin:|PATH=${TARGET_HOME}/.bun/bin:${TARGET_HOME}/.local/bin:|' \
        ${SERVICE_FILE}" 2>/dev/null
      if ssh "$TARGET_SSH" "grep -q '\.bun/bin' ${SERVICE_FILE}" 2>/dev/null; then
        info "added"
      else
        warn "could not add — check PATH manually"
      fi
    fi

    # Check for MINION_GATEWAY_PORT / --port consistency
    echo -n "  Port consistency... "
    ENV_PORT=$(ssh "$TARGET_SSH" "grep 'MINION_GATEWAY_PORT=' ${SERVICE_FILE} 2>/dev/null | grep -oP '(?<=MINION_GATEWAY_PORT=)\d+'" 2>/dev/null || echo "")
    EXEC_PORT=$(ssh "$TARGET_SSH" "grep 'ExecStart=' ${SERVICE_FILE} 2>/dev/null | grep -oP '(?<=--port )\d+'" 2>/dev/null || echo "")
    if [[ -n "$ENV_PORT" && -n "$EXEC_PORT" && "$ENV_PORT" != "$EXEC_PORT" ]]; then
      warn "env says ${ENV_PORT}, ExecStart says ${EXEC_PORT} — fixing env to match"
      ssh "$TARGET_SSH" "sudo sed -i 's/MINION_GATEWAY_PORT=${ENV_PORT}/MINION_GATEWAY_PORT=${EXEC_PORT}/' ${SERVICE_FILE}"
    elif [[ -n "$ENV_PORT" && -n "$EXEC_PORT" ]]; then
      info "consistent (${EXEC_PORT})"
    elif [[ -n "$EXEC_PORT" ]]; then
      info "${EXEC_PORT} (from --port)"
    else
      warn "no port found in service file"
    fi

    # Reload systemd
    target_systemctl "daemon-reload" 2>/dev/null
    info "systemd daemon-reload complete"
  else
    warn "service file not found at ${SERVICE_FILE}"
    warn "Gateway will need manual service setup before starting"
  fi
else
  echo -e "\n${DIM}  Phase 5: Service fix — skipped (--skip-service-fix)${RESET}"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Phase 6: Channel deduplication
# ═══════════════════════════════════════════════════════════════════════════════

if [[ -n "$DISABLE_CHANNELS" ]]; then
  phase 6 "Disabling channels on source"

  # Build a Python script to disable channels in source gateway.json
  # This prevents duplicate bot connections (Discord, WhatsApp, etc.)
  IFS=',' read -ra CHANNELS <<< "$DISABLE_CHANNELS"
  PYTHON_SCRIPT="import json
with open('${SOURCE_HOME}/.minion/gateway.json') as f:
    c = json.load(f)
disabled = []
channels = c.get('channels', {})
"
  for ch in "${CHANNELS[@]}"; do
    ch=$(echo "$ch" | tr -d ' ')
    PYTHON_SCRIPT+="
if '${ch}' in channels:
    channels['${ch}']['enabled'] = False
    for acc in channels['${ch}'].get('accounts', {}):
        channels['${ch}']['accounts'][acc]['enabled'] = False
    disabled.append('${ch}')
"
  done
  PYTHON_SCRIPT+="
with open('${SOURCE_HOME}/.minion/gateway.json', 'w') as f:
    json.dump(c, f, indent=2)
print('Disabled: ' + ', '.join(disabled) if disabled else 'No channels matched')
"

  echo -n "  Disabling channels... "
  RESULT=$(ssh "$SOURCE_SSH" "python3 -c \"${PYTHON_SCRIPT}\"" 2>/dev/null)
  info "${RESULT}"

  # Restart source gateway to apply
  echo -n "  Restarting source gateway... "
  if source_systemctl "restart minion-gateway.service" 2>/dev/null; then
    info "restarted"
  else
    warn "could not restart — may need manual restart"
  fi
else
  echo -e "\n${DIM}  Phase 6: Channel dedup — skipped (no --disable-channels)${RESET}"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Phase 7: Start target gateway
# ═══════════════════════════════════════════════════════════════════════════════

phase 7 "Starting target gateway"

echo -n "  Starting service... "
if target_systemctl "start minion-gateway.service" 2>/dev/null; then
  info "started"
else
  fail "failed to start — check: journalctl --user -u minion-gateway"
  exit 1
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Phase 8: Verification
# ═══════════════════════════════════════════════════════════════════════════════

phase 8 "Verification (waiting 60s for startup)"

# Gateway startup takes ~30-60s (qmd memory initialization for all agents)
echo -n "  Waiting for startup"
for i in $(seq 1 12); do
  echo -n "."
  sleep 5
  if ssh "$TARGET_SSH" "sudo -u ${TARGET_USER} curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18789/" 2>/dev/null | grep -q "200"; then
    echo ""
    break
  fi
  if [[ $i -eq 12 ]]; then
    echo ""
    warn "gateway did not respond within 60s — checking status..."
  fi
done

# Service status
echo -n "  Service status... "
SERVICE_STATUS=$(target_systemctl "is-active minion-gateway.service" 2>/dev/null || echo "unknown")
if [[ "$SERVICE_STATUS" == "active" ]]; then
  info "active (running)"
else
  fail "${SERVICE_STATUS}"
fi

# Port binding
echo -n "  Port 18789... "
if ssh "$TARGET_SSH" "sudo ss -tlnp | grep -q ':18789'" 2>/dev/null; then
  info "listening"
else
  fail "not listening"
fi

# HTTP health check
echo -n "  Health check... "
HTTP_CODE=$(ssh "$TARGET_SSH" "sudo -u ${TARGET_USER} curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18789/" 2>/dev/null || echo "000")
if [[ "$HTTP_CODE" == "200" ]]; then
  info "HTTP 200"
else
  fail "HTTP ${HTTP_CODE}"
fi

# Tailscale funnel (if hostname provided)
if [[ -n "$TO_HOST" ]]; then
  echo -n "  Tailscale funnel (${TO_HOST})... "
  FUNNEL_CODE=$(curl -s -o /dev/null -w '%{http_code}' "https://${TO_HOST}/" 2>/dev/null || echo "000")
  if [[ "$FUNNEL_CODE" == "200" ]]; then
    info "HTTP 200"
  else
    warn "HTTP ${FUNNEL_CODE} (funnel may not be configured)"
  fi
fi

# Check for EACCES errors (the main gotcha from production migration)
echo -n "  Checking for EACCES errors... "
EACCES_COUNT=$(ssh "$TARGET_SSH" "sudo grep -c 'EACCES' ${TARGET_STATE_DIR}/logs/minion.log 2>/dev/null || echo 0" 2>/dev/null)
if [[ "$EACCES_COUNT" -gt 0 ]]; then
  fail "${EACCES_COUNT} EACCES errors found — paths may still need rewriting"
  warn "Check: grep EACCES ${TARGET_STATE_DIR}/logs/minion.log"
else
  info "none"
fi

# Check Discord logins (if Discord was part of the migration)
echo -n "  Discord bot logins... "
DISCORD_LOGINS=$(ssh "$TARGET_SSH" "sudo grep -c 'logged in to discord' ${TARGET_STATE_DIR}/logs/minion.log 2>/dev/null || echo 0" 2>/dev/null)
if [[ "$DISCORD_LOGINS" -gt 0 ]]; then
  info "${DISCORD_LOGINS} bot(s) connected"
else
  warn "no Discord logins detected in logs"
fi

# ─── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}═══════════════════════════════════════════════════════════${RESET}"
if [[ "$SERVICE_STATUS" == "active" && "$HTTP_CODE" == "200" && "$EACCES_COUNT" -eq 0 ]]; then
  echo -e "${BOLD}  ${GREEN}Migration successful!${RESET}"
else
  echo -e "${BOLD}  ${YELLOW}Migration completed with warnings${RESET}"
fi
echo -e "${BOLD}═══════════════════════════════════════════════════════════${RESET}"
echo ""
echo "  Source: ${SOURCE_SSH} (channels ${DISABLE_CHANNELS:-unchanged})"
echo "  Target: ${TARGET_USER}@${TARGET_HOST} (active)"
echo ""

if [[ -n "$DISABLE_CHANNELS" ]]; then
  echo "  Channels disabled on source: ${DISABLE_CHANNELS}"
  echo "  Send a test message to verify bots respond from the target server."
else
  echo -e "  ${YELLOW}WARNING: No channels were disabled on source.${RESET}"
  echo "  If both servers run the same bot tokens, you'll get duplicate connections."
  echo "  Disable channels on source manually, or re-run with --disable-channels."
fi
echo ""

# Cleanup reminder
echo "  Cleanup (when ready):"
echo "    ssh ${TARGET_SSH} \"sudo rm -rf ${TARGET_STATE_DIR}.migration-backup\""
echo ""
