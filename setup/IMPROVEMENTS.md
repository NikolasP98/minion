# Setup Framework — Improvement Proposals

Structured tracker for setup framework enhancements. LLM agents and contributors
can propose new items (`- [ ]`), add details in nested bullets, and check off
completed work (`- [x]`).

---

## High Priority

- [ ] **Health monitoring phase (Phase 75)**
  - Description: Add a post-verification phase that sets up periodic health checks via systemd timer or cron. Alerts when the gateway stops responding.
  - Affected files: `phases/75-health-monitoring.sh`, `templates/health-timer.service.template`
  - Dependencies: Phase 70 (verification)
  - Effort: Medium

- [ ] **Structured JSON logging**
  - Description: Replace plain-text log lines with JSON-structured logs (`{"ts":..., "level":..., "phase":..., "msg":...}`). Easier to parse, query, and ship to log aggregators.
  - Affected files: `lib/logging.sh`, all phase scripts (consumer changes minimal)
  - Dependencies: None
  - Effort: Medium

- [ ] **SQLite state integration**
  - Description: Wire up `config/schema.sql` so deployments, agents, and health checks are tracked in a local `state.db`. Currently the schema exists but nothing writes to it.
  - Affected files: `lib/state.sh` (new), `phases/00-preflight.sh`, `phases/70-verification.sh`, `config/schema.sql`
  - Dependencies: SQLite3 available on target
  - Effort: Large

## Medium Priority

- [ ] **Publish automation (name swap + 2FA)**
  - Description: Publishing `@nikolasp98/minion` requires manually swapping `package.json` name from `minion` to the scoped name, then swapping back. Automate with a `publish` script that: (1) stamps version, (2) swaps name, (3) builds, (4) publishes with `--ignore-scripts`, (5) restores name. Integrate `op` CLI for 2FA OTP.
  - Affected files: `scripts/publish.ts` (new), `package.json` (scripts)
  - Dependencies: 1Password CLI (`op`) for OTP
  - Effort: Small

- [ ] **Disable prepack for publish**
  - Description: The `prepack` lifecycle script runs a full build including DTS generation, which blocks `npm publish` when types fail. Either remove `prepack` entirely or gate it behind a `CI` env check. Current workaround is `--ignore-scripts`.
  - Affected files: `package.json` (scripts.prepack)
  - Dependencies: None
  - Effort: Small

- [ ] **Server config tracks install method**
  - Description: `.github/servers/*.json` configs don't record whether a server uses `package` or `source` install method. Add `installMethod` and `packageManager` fields so provisioning and update scripts know how to handle each server.
  - Affected files: `.github/servers/production.json`, `.github/servers/development.json`, provision-server skill
  - Dependencies: None
  - Effort: Small

- [ ] **Tailscale auto-configuration**
  - Description: If `--tailscale-key` is provided, automatically install Tailscale, authenticate, and configure SSH access. Currently the key is accepted but not acted on.
  - Affected files: `phases/30-environment-setup.sh` or new `phases/35-tailscale.sh`
  - Dependencies: Tailscale auth key
  - Effort: Medium

- [ ] **Template conditionals**
  - Description: Extend `lib/templates.sh` to support `{{#IF VAR}}...{{/IF}}` blocks, removing the need for post-render fixups. The SOUL.md template already uses mustache-like `{{#ENABLE_*}}` syntax that isn't processed.
  - Affected files: `lib/templates.sh`, `templates/SOUL.md.template`
  - Dependencies: None
  - Effort: Small

- [ ] **Port allocation manager**
  - Description: Automatic port allocation for multi-agent deployments. Query `state.db` for used ports, assign next available, and register allocation.
  - Affected files: `lib/variables.sh`, `config/schema.sql` (port_allocations table already exists)
  - Dependencies: SQLite state integration
  - Effort: Medium

- [ ] **Minions `fetch-profile.sh` utility**
  - Description: Add a utility that fetches profiles from the minions repo by name (e.g., `fetch-profile.sh customer-support`) without requiring a full clone. Supports `minions:profile-name` shorthand in `--profile=`.
  - Affected files: `utilities/fetch-profile.sh` (new), `setup.sh` (profile resolution)
  - Dependencies: Minions repo structure finalized
  - Effort: Small

- [ ] **Interactive setup wizard**
  - Description: When run with no flags, walk the user through configuration with prompts (agent name, API key, channels, etc.) using `read -p` and `select`.
  - Affected files: `setup.sh`, `lib/interactive.sh` (new)
  - Dependencies: None
  - Effort: Medium

## Low Priority

- [ ] **Suppress Control UI warning on headless servers**
  - Description: Gateway logs noisy `Control UI is not available` warnings on servers without the web UI built. Either suppress the warning when `MINION_DISABLE_CONTROL_UI=1` is set, or auto-detect headless environments and skip the warning.
  - Affected files: Gateway control-ui initialization code
  - Dependencies: None
  - Effort: Small

- [ ] **Dry-run test suite**
  - Description: Automated test harness that runs `--dry-run` with various flag combinations and asserts expected output. Uses bats or plain bash assertions.
  - Affected files: `tests/` (new directory), CI integration
  - Dependencies: None
  - Effort: Medium

- [ ] **Config diff on update**
  - Description: When running `--update`, show a diff of what changed in `minion.json` before applying. Allows the operator to review config changes.
  - Affected files: `phases/50-config-generation.sh`
  - Dependencies: `diff` available on target
  - Effort: Small

## Completed

- [x] **Decommission mode (Phase 95)**
  - Description: Non-destructive shutdown that stops services, frees disk (removes node_modules/dist), preserves config and credentials, writes `.decommissioned` marker, and prints reactivation instructions.
  - Delivered in: `phases/95-decommission.sh`, `--decommission` flag
  - Completed: 2026-02-12

- [x] **Cascading rollback (Phase 99)**
  - Description: Automatic cascading cleanup on phase failure. Rolls back from the last checkpoint in reverse phase order.
  - Delivered in: `phases/99-rollback.sh`, checkpoint system in `lib/logging.sh`
  - Completed: 2026-02-12

- [x] **Fix `allCommands` reference error in Telegram bot**
  - Description: `src/telegram/bot-native-commands.ts` referenced `allCommands` after it was renamed to `allCommandsFull`. Gateway crashed on startup when Telegram channel was enabled. Fixed references to use `commandsToRegister`.
  - Delivered in: `src/telegram/bot-native-commands.ts` (lines 364, 368)
  - Completed: 2026-02-15

- [x] **Consolidate CORE_PACKAGE_NAMES across codebase**
  - Description: Package name check (`"minion"`) was hardcoded in 4 separate files, causing version resolution to fail for the `@nikolasp98/minion` scoped package (reported `0.0.0`). Unified to `CORE_PACKAGE_NAMES = new Set(["minion", "@nikolasp98/minion"])` in all locations.
  - Delivered in: `src/version.ts`, `src/infra/minion-root.ts`, `src/infra/update-runner.ts`, `src/cli/update-cli/shared.ts`
  - Completed: 2026-02-15

- [x] **Build-time version injection**
  - Description: npm package had no version metadata at runtime because `package.json` was not bundled. Added `__MINION_VERSION__` define injection via tsdown config and `scripts/stamp-version.ts` for `yyyy.M.d` date-based versioning.
  - Delivered in: `tsdown.config.ts`, `scripts/stamp-version.ts`, `src/version.ts`
  - Completed: 2026-02-15

- [x] **Migrate bernibites from nohup to systemd**
  - Description: bernibites `bot-prd` was running the gateway via `nohup` instead of a proper systemd user service. Created and enabled systemd service with linger for reliable restarts.
  - Delivered in: `~bot-prd/.config/systemd/user/minion-gateway.service` on bernibites
  - Completed: 2026-02-15

- [x] **`minion gateway relocate` CLI command**
  - Description: Rewrites all hardcoded absolute paths in `.minion` state files after server migration. Targets gateway.json, agents-list.json, exec-approvals.json, per-agent sessions.json, qmd index.yml, and auth credential files. Supports `--dry-run`, `--from-host`/`--to-host` for hostname rewriting. JSON-aware (no sed trailing-comma bugs).
  - Delivered in: `src/cli/gateway-cli/relocate.ts`, `src/cli/gateway-cli/register.ts`
  - Completed: 2026-03-08

- [x] **Server-to-server state migration utility**
  - Description: Shell script that automates cloning `.minion` state between servers: streaming tarball via SSH pipe (no intermediate storage), fixing ownership, running `minion gateway relocate`, validating JSON. Leaves service management to the operator.
  - Delivered in: `setup/utilities/migrate-state.sh`
  - Completed: 2026-03-08

- [x] **Fix KillMode=process orphaning child processes**
  - Description: `KillMode=process` in generated systemd units left orphaned `qmd embed` processes across restarts, consuming memory and blocking new gateway startups. Changed to `KillMode=mixed` with `TimeoutStopSec=15` so children are cleaned up after main process exits.
  - Delivered in: `src/platform/daemon/systemd-unit.ts`
  - Completed: 2026-03-08

- [x] **Remove redundant MINION_GATEWAY_PORT from service env**
  - Description: `buildServiceEnvironment()` emitted `MINION_GATEWAY_PORT` in the systemd env block even though `--port` was already in ExecStart args. This caused drift when they disagreed (env=28789, arg=18789). Removed the env var — `--port` in ExecStart is the canonical source.
  - Delivered in: `src/platform/daemon/service-env.ts`
  - Completed: 2026-03-08

---

## Proposal Template

Copy this template when adding a new proposal:

```markdown
- [ ] **Title**
  - Description: What this improvement does and why it matters.
  - Affected files: `path/to/file.sh`, `path/to/other.sh`
  - Dependencies: Other proposals or external requirements
  - Effort: Small / Medium / Large
```
