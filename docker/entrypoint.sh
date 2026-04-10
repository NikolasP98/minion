#!/bin/bash
set -e

MINION_HOME="/home/node/.minion"
GOGCLI_CONFIG="/home/node/.config/gogcli"
DEFAULT_CONFIG="/app/docker/default-config.json"

log() {
  echo "[entrypoint] $*"
}

# Create required directories if they don't exist
dirs=(
  "$MINION_HOME"
  "$MINION_HOME/workspace"
  "$MINION_HOME/agents"
  "$MINION_HOME/canvas"
  "$MINION_HOME/credentials"
  "$MINION_HOME/devices"
  "$MINION_HOME/identity"
  "$MINION_HOME/media"
  "$MINION_HOME/memory"
  "$MINION_HOME/cron"
  "$MINION_HOME/sessions"
  "$GOGCLI_CONFIG"
)

for dir in "${dirs[@]}"; do
  if [ ! -d "$dir" ]; then
    mkdir -p "$dir"
    log "Created directory: $dir"
  fi

  # Fix ownership if not already owned by node user (uid 1000)
  current_owner=$(stat -c '%u' "$dir" 2>/dev/null || stat -f '%u' "$dir" 2>/dev/null || echo "unknown")
  if [ "$current_owner" != "1000" ] && [ "$current_owner" != "unknown" ]; then
    log "Fixing ownership of $dir (was uid $current_owner, setting to 1000:1000)"
    chown -R 1000:1000 "$dir"
  fi
done

# Validate MINION_ENV (soft warning — never fatal to avoid breaking existing deploys)
if [[ -n "${MINION_ENV:-}" ]]; then
  _ENV_LOWER="$(echo "$MINION_ENV" | tr '[:upper:]' '[:lower:]')"
  if [[ "$_ENV_LOWER" != "$MINION_ENV" ]]; then
    log "WARNING: MINION_ENV should be lowercase ('$_ENV_LOWER'), got '$MINION_ENV'"
  fi
  log "Environment: MINION_ENV=$MINION_ENV"
  unset _ENV_LOWER
fi

# Copy default config only if it doesn't exist
if [ -f "$DEFAULT_CONFIG" ]; then
  if [ ! -f "$MINION_HOME/minion.json" ]; then
    cp "$DEFAULT_CONFIG" "$MINION_HOME/minion.json"
    chmod 644 "$MINION_HOME/minion.json"
    log "Created default config: $MINION_HOME/minion.json"
  else
    log "Config exists, preserving: $MINION_HOME/minion.json"
  fi
else
  log "Warning: Default config not found at $DEFAULT_CONFIG"
fi

# Pin the state directory so the node process always writes to the mounted volume
# (/home/node/.minion) regardless of how HOME is resolved inside the container.
# This guards against the case where HOME resolves to /root (e.g. running the
# image without docker-compose's HOME: /home/node override).
export MINION_STATE_DIR="/home/node/.minion"
log "Profile root pinned to MINION_STATE_DIR=$MINION_STATE_DIR"

# Drop privileges to node user and execute the main command
log "Dropping privileges to node user (uid 1000)"

# Auto-prepend node minion.mjs for Minion commands
# Allow system commands (node, bash, sh, etc.) to pass through unchanged
case "$1" in
  node|bash|sh|/bin/*|/usr/bin/*|"")
    # System command or empty - execute as-is
    exec gosu node "$@"
    ;;
  *)
    # Minion CLI command - prepend node minion.mjs
    exec gosu node node minion.mjs "$@"
    ;;
esac
