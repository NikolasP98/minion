#!/usr/bin/env bash
# ---
# name: "Configuration Generation"
# phase: 50
# description: >
#   Renders configuration templates (minion.json, systemd service, SOUL.md)
#   with environment variable values. Validates JSON syntax. Deploys config
#   files to their final locations with correct ownership and permissions.
# when: >
#   After Minion is installed and alias is set up. Generates the runtime
#   configuration files the gateway needs to start.
# requires:
#   - "Phase 45 (alias setup) completed"
#   - "All configuration variables set"
# produces:
#   - "~/.minion/minion.json (mode 600)"
#   - "~/.minion/workspace/SOUL.md"
#   - "~/.config/systemd/user/minion-gateway.service"
# flags:
#   -v, --verbose: "Enable debug-level logging"
# idempotent: true
# estimated_time: "1-2 minutes"
# ---

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/logging.sh"
source "${SCRIPT_DIR}/../lib/variables.sh"
source "${SCRIPT_DIR}/../lib/templates.sh"
source "${SCRIPT_DIR}/../lib/network.sh"

# Ensure derived variables are populated (idempotent)
derive_system_variables

setup_gog_keyring_credentials() {
    local config_dir="${1:-${MINION_CONFIG_DIR:-${AGENT_HOME_DIR:-$HOME}/.minion}}"
    local env_file="${config_dir}/.env"
    local needs_keyring_setup=false

    if [ "${EXEC_MODE:-local}" = "remote" ]; then
        if ! run_cmd "grep -q 'GOG_KEYRING_PASSWORD' '${env_file}' 2>/dev/null"; then
            needs_keyring_setup=true
        fi
    else
        if ! grep -q "GOG_KEYRING_PASSWORD" "${env_file}" 2>/dev/null; then
            needs_keyring_setup=true
        fi
    fi

    if [ "$needs_keyring_setup" = true ]; then
        log_info "Generating GOG file-keyring credentials..."
        local gog_password
        gog_password=$(openssl rand -hex 32 2>/dev/null || python3 -c "import secrets; print(secrets.token_hex(32))")

        if [ "${EXEC_MODE:-local}" = "remote" ]; then
            run_cmd "touch '${env_file}' && chmod 600 '${env_file}'"
            run_cmd "grep -q 'GOG_KEYRING_BACKEND' '${env_file}' || echo 'GOG_KEYRING_BACKEND=file' >> '${env_file}'"
            run_cmd "echo 'GOG_KEYRING_PASSWORD=${gog_password}' >> '${env_file}'"
        else
            touch "${env_file}" && chmod 600 "${env_file}"
            grep -q "GOG_KEYRING_BACKEND" "${env_file}" || echo "GOG_KEYRING_BACKEND=file" >> "${env_file}"
            echo "GOG_KEYRING_PASSWORD=${gog_password}" >> "${env_file}"
        fi
        log_success "Generated GOG CLI file-keyring credentials in ${env_file}"
        log_warn "Do NOT set GOG_KEYRING_PASSWORD in systemd override files — use .env only"
    else
        log_info "GOG keyring credentials already present in .env"
    fi
}

generate_configuration() {
    phase_start "Configuration Generation" "50"

    local temp_dir="/tmp/minion-config-$$"
    mkdir -p "$temp_dir"

    local exec_user="${AGENT_USERNAME:-$(whoami)}"

    # Set defaults for channel credentials (empty if not provided)
    WHATSAPP_PHONE="${WHATSAPP_PHONE:-}"
    TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
    DISCORD_BOT_TOKEN="${DISCORD_BOT_TOKEN:-}"

    # Set defaults for deployment metadata
    DEPLOYMENT_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    DEPLOYMENT_ENVIRONMENT="${DEPLOYMENT_ENVIRONMENT:-production}"
    MINION_VERSION="${MINION_VERSION:-source}"

    # Set defaults for agent behavior
    AGENT_PERSONALITY="${AGENT_PERSONALITY:-You are a helpful AI assistant.}"
    AGENT_RESPONSIBILITIES="${AGENT_RESPONSIBILITIES:-Assist users with their requests professionally and efficiently.}"
    COMMUNICATION_STYLE="${COMMUNICATION_STYLE:-Professional, concise, and helpful}"
    DOMAIN_KNOWLEDGE="${DOMAIN_KNOWLEDGE:-General purpose knowledge and skills}"

    # Auto-set bind=loopback when tailscale serve/funnel is configured
    if [ "${TAILSCALE_MODE:-off}" = "serve" ] || [ "${TAILSCALE_MODE:-off}" = "funnel" ]; then
        if [ "${GATEWAY_BIND:-}" != "loopback" ] && [ "${GATEWAY_BIND:-}" != "auto" ]; then
            log_info "Tailscale ${TAILSCALE_MODE} requires bind=loopback; overriding GATEWAY_BIND=${GATEWAY_BIND:-unset}"
            GATEWAY_BIND="loopback"
        fi
    fi

    # Export all for template rendering
    export DEPLOYMENT_DATE DEPLOYMENT_ENVIRONMENT MINION_VERSION GATEWAY_BIND
    export AGENT_PERSONALITY AGENT_RESPONSIBILITIES COMMUNICATION_STYLE DOMAIN_KNOWLEDGE

    # --- Render minion.json ---
    log_info "Rendering minion.json configuration..."
    if ! render_template "${SCRIPT_DIR}/../templates/minion.json.template" "$temp_dir/minion.json"; then
        handle_error $? "Failed to render minion.json" "Configuration Generation"
        return 1
    fi

    log_info "Validating rendered configuration..."
    if ! validate_template "$temp_dir/minion.json"; then
        handle_error $? "Configuration validation failed" "Configuration Generation"
        return 1
    fi

    # Validate JSON syntax (if jq available)
    if command -v jq &> /dev/null; then
        if ! jq empty "$temp_dir/minion.json" 2>/dev/null; then
            log_error "Invalid JSON in rendered minion.json"
            handle_error 1 "Invalid JSON configuration" "Configuration Generation"
            return 1
        fi
        log_debug "JSON syntax valid"
    else
        log_debug "jq not available, skipping JSON validation"
    fi

    # --- Render systemd service ---
    local service_template
    if [ "${INSTALL_METHOD:-package}" = "source" ]; then
        service_template="${SCRIPT_DIR}/../templates/systemd-user.service.template"
    else
        service_template="${SCRIPT_DIR}/../templates/systemd-npm.service.template"
        # Ensure package install vars are exported for template rendering
        export MINION_BIN MINION_PKG_ROOT
    fi
    log_info "Rendering systemd service file (template: $(basename "$service_template"))..."
    if ! render_template "$service_template" "$temp_dir/minion-gateway.service"; then
        handle_error $? "Failed to render service file" "Configuration Generation"
        return 1
    fi

    # --- Render SOUL.md ---
    log_info "Rendering SOUL.md..."
    if ! render_template "${SCRIPT_DIR}/../templates/SOUL.md.template" "$temp_dir/SOUL.md"; then
        handle_error $? "Failed to render SOUL.md" "Configuration Generation"
        return 1
    fi

    # --- Generate auth-profiles.json for main agent ---
    log_info "Generating agent auth profile..."
    local profiles_json='{ "version": 1, "profiles": {'
    local first_profile=true
    local profile_count=0

    if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
        profiles_json+="\"anthropic:manual\": { \"type\": \"token\", \"provider\": \"anthropic\", \"token\": \"${ANTHROPIC_API_KEY}\" }"
        first_profile=false
        profile_count=$((profile_count + 1))
        log_debug "Added auth profile: anthropic:manual"
    fi

    if [ -n "${OPENROUTER_API_KEY:-}" ]; then
        [ "$first_profile" = "false" ] && profiles_json+=","
        profiles_json+="\"openrouter:manual\": { \"type\": \"token\", \"provider\": \"openrouter\", \"token\": \"${OPENROUTER_API_KEY}\" }"
        profile_count=$((profile_count + 1))
        log_debug "Added auth profile: openrouter:manual"
    fi

    profiles_json+='}}'

    if [ "$profile_count" -eq 0 ]; then
        log_warn "No LLM provider keys found — auth-profiles.json will be empty"
    else
        log_info "Generated $profile_count auth profile(s)"
    fi
    echo "$profiles_json" | python3 -m json.tool > "$temp_dir/auth-profiles.json" 2>/dev/null \
        || echo "$profiles_json" > "$temp_dir/auth-profiles.json"

    # --- Deploy files ---
    log_info "Deploying configuration files..."

    local config_dir="${MINION_CONFIG_DIR:-${AGENT_HOME_DIR:-$HOME}/.minion}"
    local workspace_dir="${WORKSPACE_DIR:-${config_dir}/workspace}"
    local systemd_dir="${AGENT_HOME_DIR:-$HOME}/.config/systemd/user"

    # Backup existing config before overwriting
    local existing_config="${config_dir}/minion.json"
    if [ "${EXEC_MODE:-local}" = "remote" ]; then
        if run_cmd "test -f '${existing_config}'" 2>/dev/null; then
            local backup_path="${existing_config}.$(date +%Y%m%d%H%M%S).bak"
            log_info "Backing up existing config to ${backup_path}"
            run_cmd "cp '${existing_config}' '${backup_path}'"
        fi
    else
        if [ -f "${existing_config}" ]; then
            local backup_path="${existing_config}.$(date +%Y%m%d%H%M%S).bak"
            log_info "Backing up existing config to ${backup_path}"
            cp "${existing_config}" "${backup_path}"
        fi
    fi

    if [ "${EXEC_MODE:-local}" = "remote" ]; then
        # Remote: SCP files to staging dir, then place + permission in one batch
        local remote_tmp="/tmp/minion-deploy-$$"
        local agent_auth_dir="${config_dir}/agents/main/agent"

        run_cmd --as root "mkdir -p '$remote_tmp'"

        copy_file "$temp_dir/minion.json" "$remote_tmp/minion.json" root
        copy_file "$temp_dir/minion-gateway.service" "$remote_tmp/minion-gateway.service" root
        copy_file "$temp_dir/SOUL.md" "$remote_tmp/SOUL.md" root
        copy_file "$temp_dir/auth-profiles.json" "$remote_tmp/auth-profiles.json" root

        # Batch all cp/chown/chmod into a single SSH call
        run_cmd --as root "
            mkdir -p '${agent_auth_dir}' &&
            mkdir -p '${config_dir}/agents/main/KG' &&
            cp '$remote_tmp/minion.json' '${config_dir}/minion.json' &&
            cp '$remote_tmp/SOUL.md' '${workspace_dir}/SOUL.md' &&
            cp '$remote_tmp/minion-gateway.service' '${systemd_dir}/minion-gateway.service' &&
            cp '$remote_tmp/auth-profiles.json' '${agent_auth_dir}/auth-profiles.json' &&
            chown ${exec_user}:${exec_user} '${config_dir}/minion.json' '${workspace_dir}/SOUL.md' '${systemd_dir}/minion-gateway.service' &&
            chown -R ${exec_user}:${exec_user} '${config_dir}/agents' &&
            chmod 600 '${config_dir}/minion.json' '${agent_auth_dir}/auth-profiles.json' &&
            chmod 644 '${workspace_dir}/SOUL.md' '${systemd_dir}/minion-gateway.service' &&
            rm -rf '$remote_tmp'
        "
    else
        # Local: copy directly
        cp "$temp_dir/minion.json" "${config_dir}/minion.json"
        cp "$temp_dir/SOUL.md" "${workspace_dir}/SOUL.md"
        cp "$temp_dir/minion-gateway.service" "${systemd_dir}/minion-gateway.service"

        chmod 600 "${config_dir}/minion.json"
        chmod 644 "${workspace_dir}/SOUL.md"
        chmod 644 "${systemd_dir}/minion-gateway.service"

        local agent_auth_dir="${config_dir}/agents/main/agent"
        mkdir -p "${agent_auth_dir}"
        mkdir -p "${config_dir}/agents/main/KG"
        cp "$temp_dir/auth-profiles.json" "${agent_auth_dir}/auth-profiles.json"
        chmod 600 "${agent_auth_dir}/auth-profiles.json"
    fi

    # Cleanup local temp
    rm -rf "$temp_dir"

    log_success "Configuration files deployed successfully"

    # --- Create per-agent config for initial agent ---
    local agent_name="${AGENT_NAME:-minion}"
    local per_agent_config_dir="${config_dir}/agents/${agent_name}"
    local per_agent_config="${per_agent_config_dir}/minion.json"
    if [ "${EXEC_MODE:-local}" = "remote" ]; then
        run_cmd --as root "
            mkdir -p '${per_agent_config_dir}' &&
            mkdir -p '${per_agent_config_dir}/KG' &&
            chmod 700 '${per_agent_config_dir}' &&
            chown ${exec_user}:${exec_user} '${per_agent_config_dir}' '${per_agent_config_dir}/KG'
        "
        if ! run_cmd "test -f '${per_agent_config}'" 2>/dev/null; then
            run_cmd --as root "
                printf '{\\n  \"id\": \"%s\",\\n  \"name\": \"%s\"\\n}\\n' '${agent_name}' '${agent_name}' > '${per_agent_config}' &&
                chmod 600 '${per_agent_config}' &&
                chown ${exec_user}:${exec_user} '${per_agent_config}'
            "
            log_success "Created per-agent config for ${agent_name}"
        else
            log_info "Per-agent config already exists for ${agent_name}"
        fi
    else
        mkdir -p "${per_agent_config_dir}"
        mkdir -p "${per_agent_config_dir}/KG"
        chmod 700 "${per_agent_config_dir}"
        if [ ! -f "${per_agent_config}" ]; then
            printf '{\n  "id": "%s",\n  "name": "%s"\n}\n' "${agent_name}" "${agent_name}" > "${per_agent_config}"
            chmod 600 "${per_agent_config}"
            log_success "Created per-agent config for ${agent_name}"
        else
            log_info "Per-agent config already exists for ${agent_name}"
        fi
    fi

    # --- Create .env file with proper ownership (prevents EACCES at gateway startup) ---
    local env_file="${config_dir}/.env"
    if [ "${EXEC_MODE:-local}" = "remote" ]; then
        run_cmd --as root "touch '${env_file}' && chown ${exec_user}:${exec_user} '${env_file}' && chmod 600 '${env_file}'"
    else
        touch "${env_file}" && chmod 600 "${env_file}"
    fi
    log_success ".env file ready at ${env_file}"

    # --- Generate GOG CLI file-keyring credentials (headless file keyring) ---
    setup_gog_keyring_credentials "$config_dir"

    phase_end "Configuration Generation" "success"
    save_checkpoint "50-config-generation"
    return 0
}

# Run configuration generation if executed directly
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    generate_configuration
fi
