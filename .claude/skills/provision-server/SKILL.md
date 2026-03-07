---
skill: provision-server
description: >
  Provision a new Minion instance on a remote server. Handles the full lifecycle:
  SSH connectivity check, dry run, credential collection, setup execution, monitoring,
  verification, and server config registration. Use when deploying a new agent instance,
  setting up a dev environment on a VPS, or provisioning a new tenant.
triggers:
  - provision server
  - deploy new instance
  - set up VPS
  - new agent deployment
  - provision remote
  - deploy minion
  - new server setup
  - add server
  - provision tenant
---

# Server Provisioning — Expert Workflow

End-to-end provisioning of Minion instances on remote servers using the setup framework
at `setup/setup.sh`.

## Architecture Overview

### Setup Framework

- **Entry point**: `setup/setup.sh` — orchestrates all phases
- **Phases**: `setup/phases/` — 00 through 70 (plus 95-decommission, 99-rollback)
- **Libraries**: `setup/lib/` — logging, variables, network, templates
- **Templates**: `setup/templates/` — minion.json, systemd, SOUL.md, wrapper
- **Config**: `setup/config/defaults.yaml` — all default values
- **Profiles**: External `minions` repo or `setup/profiles/`

### Phase Sequence

| Phase | Name             | Purpose                                                             |
| ----- | ---------------- | ------------------------------------------------------------------- |
| 00    | Preflight        | Validate environment, test SSH connectivity                         |
| 10    | VPS Bootstrap    | Fresh VPS setup: admin user, SSH hardening, Tailscale, service user |
| 20    | User Creation    | Create agent user, directories, enable linger                       |
| 30    | Environment      | Install/verify Node.js, pnpm, gh CLI, build tools                   |
| 40    | Install          | Clone repo, checkout branch, pnpm install + build                   |
| 45    | Alias            | Create `~/.local/bin/minion` wrapper                                |
| 50    | Config           | Render templates, deploy with correct permissions                   |
| 60    | Service          | Enable + start systemd user service                                 |
| 65    | Tailscale Funnel | Expose gateway + OAuth callback over public HTTPS (opt-in)          |
| 70    | Verification     | Health checks, deployment summary                                   |

### Server Config Files

- **Production**: `.github/servers/production.json`
- **Development**: `.github/servers/development.json`

Format:

```json
{
  "id": "env-tenant-name",
  "host": "hostname-or-ip",
  "user": "minion-username",
  "admin_user": "admin-username",
  "port": 22,
  "deployment_path": "/home/username/.minion",
  "platform": "linux/amd64",
  "gateway_port": 18789,
  "bridge_port": 18790,
  "tenant": "tenant-name",
  "region": "us-east",
  "local_build": false
}
```

## Provisioning Workflow

### Step 0: VPS Bootstrap (Fresh Servers Only)

For brand-new VPS instances that only have root SSH access, run the bootstrap phase first.

**Detection**: Try `ssh niko@<host> echo ok` — if it fails, bootstrap is needed.

**Option A**: Standalone bootstrap wrapper:

```bash
bash setup/utilities/bootstrap-vps.sh \
  --vps-hostname=<ip-or-hostname> \
  --admin-user=niko \
  --verbose
```

**Option B**: Bootstrap + full deploy in one command:

```bash
bash setup/setup.sh --bootstrap \
  --vps-hostname=<host> \
  --admin-user=niko \
  --agent-name=<name> \
  --api-key=<key> \
  --verbose
```

**SSH key resolution** (in priority order):

1. `--ssh-pubkey=<key>` — explicit key string
2. `--ssh-pubkey-file=<path>` — path to public key file
3. 1Password CLI — `op read "op://Personal/SSH Key/public key"` (default, requires `op` CLI)
4. Override 1Password ref: `--op-ssh-key-ref=<ref>`

**What Phase 10 does** (all idempotent):

1. System update (apt full-upgrade)
2. Base packages (curl, git, build-essential, ufw, fail2ban, jq, htop, tmux, rsync)
3. Admin user creation with NOPASSWD sudo
4. SSH key injection from local machine
5. SSH hardening (safety gate: verifies key auth works before disabling passwords)
6. Tailscale install + interactive auth (prints URL for login)
7. Service user creation with scaffolded `~/.minion/` directories

**Post-bootstrap verification**:

```bash
ssh niko@<host> sudo whoami    # → "root"
ssh niko@<host> tailscale status  # → shows connected
```

**Safety note**: The SSH hardening step will NOT disable password auth until it confirms the admin user can authenticate via SSH key. If key auth fails, it aborts with a clear error.

### Step 1: Verify Connectivity

Test SSH access to the target server before anything else:

```bash
ssh -o ConnectTimeout=5 -o BatchMode=yes root@<hostname> echo "SSH OK as root"
ssh -o ConnectTimeout=5 -o BatchMode=yes deploy@<hostname> echo "SSH OK as deploy"
```

Root access is required for user creation (phase 20) and package installation (phase 30).

### Step 2: Check for Port Conflicts

If the server already hosts other Minion instances, verify port availability:

- Check `.github/servers/production.json` and `development.json` for existing port allocations
- Default gateway port: 18789, bridge: 18790
- Dev instances conventionally use offset ports (e.g., 28789/28790)

### Step 3: Dry Run

Always run a dry run first to verify configuration:

```bash
bash setup/setup.sh \
  --vps-hostname=<host> \
  --agent-name=<name> \
  --branch=<branch> \
  --gateway-port=<port> \
  --api-key=placeholder \
  --dry-run --verbose
```

Review the output to confirm:

- Correct `AGENT_USERNAME` derivation (minion-{agent-name})
- Correct `AGENT_HOME_DIR` path
- No variable conflicts with existing deployments

### Step 3b: Plan Tailscale Funnel (if Google OAuth or other public callbacks needed)

If the agent will use Google Workspace (gogcli), or any service requiring a public HTTPS callback URL, Tailscale Funnel **must** be configured. This exposes the gateway and the OAuth callback server over HTTPS via the server's Tailscale domain.

Ask the user:

- Does this agent need Google OAuth (Drive, Gmail, Calendar)?
- Does this server have Tailscale installed and authenticated?

If yes to both, add `--tailscale-funnel` to the setup command. Also confirm `--tailscale-key` if Tailscale needs to be authenticated.

**Critical constraint**: Never run `tailscale serve` on a Funnel-enabled server — it removes the Funnel flag from the entire HTTPS endpoint. Always use `tailscale funnel` for all route changes.

### Step 4: Collect Credentials

Prompt the user for required values:

| Credential        | Required                         | Notes                               |
| ----------------- | -------------------------------- | ----------------------------------- |
| Anthropic API key | Always                           | Starts with `sk-ant-`               |
| GitHub PAT        | If repo is private               | Starts with `ghp_` or `github_pat_` |
| Gateway port      | If server has existing instances | Must not conflict                   |

### Step 5: Execute Provisioning

Run the full provisioning in the background (it takes 5-10 minutes):

```bash
bash setup/setup.sh \
  --vps-hostname=<host> \
  --agent-name=<name> \
  --branch=<branch> \
  --gateway-port=<port> \
  --api-key=<key> \
  --github-pat=<pat> \
  --verbose
```

### Step 6: Monitor Progress

Poll the output periodically. Key milestones to watch for:

- Phase 00: "Preflight Checks" passed
- Phase 20: "User created successfully"
- Phase 30: Node.js + pnpm versions confirmed
- Phase 40: "pnpm install" + "pnpm build" complete (longest phase)
- Phase 60: "Service is running (status: active)"
- Phase 70: "Gateway responding on port XXXXX" + "DEPLOYMENT SUCCESSFUL"

### Step 7: Register Server Config

After successful provisioning, add the server entry to the appropriate config file:

- Production instances -> `.github/servers/production.json`
- Development instances -> `.github/servers/development.json`

### Step 8: Lessons Learned

After provisioning, review the full output for improvement observations using the
`lessons-learned` skill. Common findings:

- Version drift (pnpm, Node.js updates available)
- SSH round-trip inefficiencies
- Health check timing
- Output formatting issues
- Missing flags or options

## Key Flags Reference

### Modes

- `--mode=remote` — Orchestrate via SSH (auto-detected when `--vps-hostname` is set)
- `--bootstrap` — Run VPS bootstrap (Phase 10) before deployment phases
- `--update` — Pull latest + rebuild existing install
- `--decommission` — Stop services, free disk, preserve config

### Bootstrap (Phase 10)

- `--admin-user=USER` — Admin username to create (default: niko)
- `--ssh-pubkey=KEY` — SSH public key string
- `--ssh-pubkey-file=PATH` — Path to SSH public key file
- `--op-ssh-key-ref=REF` — 1Password reference for SSH key (default: `op://Personal/SSH Key/public key`)

### Configuration

- `--vps-hostname=HOST` — Target server (implies remote mode)
- `--agent-name=NAME` — Agent name (derives username as `minion-{name}`)
- `--branch=BRANCH` — Git branch to deploy (default: main)
- `--gateway-port=PORT` — Gateway listen port (default: 18789)
- `--api-key=KEY` — Anthropic API key (required)
- `--github-pat=TOKEN` — GitHub PAT for private repo access
- `--tenant=NAME` — Tenant identifier for multi-tenant setups
- `--profile=PROFILE` — Load from profile file
- `--tailscale-funnel` — Enable Tailscale Funnel (Phase 65). **Required for Google OAuth and any public HTTPS callback.** The server must have Tailscale installed and authenticated.
- `--tailscale-key=KEY` — Tailscale auth key (if Tailscale needs to be authenticated during provisioning)
- `--oauth-callback-port=PORT` — OAuth callback server port (default: 51234)

### Execution Control

- `--dry-run` — Preview without executing
- `--start-from=PHASE` — Resume from a specific phase
- `--skip-phase=PHASE` — Skip a phase (repeatable)
- `--verbose` — Debug-level logging

## Multi-Tenant Considerations

When deploying multiple agents on the same server:

- Each agent gets its own Linux user (`minion-{name}`)
- Each needs a unique gateway port
- Bridge port conventionally follows gateway port + 1
- Config directories are isolated under each user's home
- Use `--tenant=NAME` for config path suffixing when agents share a username

## Troubleshooting

### Service won't start

```bash
ssh minion-{name}@<host> "systemctl --user status minion-gateway"
ssh minion-{name}@<host> "journalctl --user -u minion-gateway -n 50"
```

### Health check fails

The gateway may need more warmup time. Check if the process is running:

```bash
ssh minion-{name}@<host> "systemctl --user is-active minion-gateway"
```

### Resume after failure

The framework saves checkpoints. Resume from the last successful phase:

```bash
bash setup/setup.sh --start-from=50 --vps-hostname=<host> --agent-name=<name> ...
```

### Rollback

Automatic on phase failure. Manual rollback:

```bash
bash setup/phases/99-rollback.sh
```
