---
skill: fork-sync
description: Sync Minion fork with upstream and update all development branches
triggers:
  - sync fork
  - update from upstream
  - sync with upstream
  - update branches
  - fork workflow
  - evaluate upstream
  - upstream evaluation
  - review upstream commits
  - resume evaluation
---

# Fork Sync Workflow

Comprehensive skill for managing the Minion fork workflow, syncing with upstream, and updating all development branches.

## Critical Principle: Mirror is a Clean Mirror

**IMPORTANT**: The `mirror` branch must ALWAYS be a clean mirror of `upstream/main`. It should NEVER contain custom commits.

### Workflow for Custom Changes

When `mirror` has diverged from upstream (contains custom commits):

1. **Verify custom commits are on DEV/main**: Check that all custom work exists on development branches
2. **Reset mirror to upstream**: `git reset --hard upstream/main`
3. **Force push mirror**: `git push --force-with-lease origin mirror`
4. **Custom work remains safe**: All custom commits stay on DEV/main/feature branches

### Detection and Resolution

```bash
# Check if mirror has diverged
git fetch upstream
git log --oneline upstream/main..mirror

# If output shows commits (mirror has diverged):
# 1. Verify commits are on DEV/main
git log --oneline DEV | head -20
git log --oneline main | head -20

# 2. Reset mirror to upstream
git checkout mirror
git reset --hard upstream/main
git push --force-with-lease origin mirror
```

## Branch Structure

This fork maintains a simplified branch hierarchy:

```
upstream/main (source of truth)
    ↓
mirror (clean mirror - NO custom commits)
    ↓
DEV (integration branch: mirror + all custom work)
    ↓
main (production - deployed to servers, Docker tag: prd)
```

### Branch Purposes

- **mirror**: Clean mirror of upstream/main, NEVER contains custom work
- **DEV**: Integration branch containing all custom features and work
- **main**: Production branch, merge from DEV when ready for deployment
- **Feature branches** (manual): Update manually by rebasing or merging from DEV

## Core Workflow

### Phase 0: Clean Mirror (if needed)

**Goal**: Ensure mirror is a clean mirror of upstream

```bash
# Check if mirror has diverged
git checkout mirror
git fetch upstream
git log --oneline upstream/main..mirror

# If commits shown, mirror has diverged - fix it:
# 1. Verify custom commits exist on DEV/main
git log --oneline DEV | grep "CustomCommit"
git log --oneline main | grep "CustomCommit"

# 2. Reset mirror to upstream
git reset --hard upstream/main
git push --force-with-lease origin mirror
```

**When to run**: Any time mirror has custom commits (detected by divergence check)

### Phase 1: Sync Mirror with Upstream

**Goal**: Update local mirror to match upstream/main

```bash
# Fetch latest from upstream
git fetch upstream

# Switch to mirror (should already be clean)
git checkout mirror

# Fast-forward merge upstream changes (should succeed now)
git merge --ff-only upstream/main

# Push to fork
git push origin mirror
```

**Expected**: Fast-forward merge, no conflicts (since mirror is clean mirror)

### Phase 1.1: Determine Sync Scope

**Goal**: Check sync history to determine what needs syncing, avoiding redundant work.

**State file**: `.claude/skills/fork-sync/state/sync-history.json`

**Logic**:

```bash
SYNC_HISTORY=".claude/skills/fork-sync/state/sync-history.json"
MIRROR_HEAD=$(git rev-parse mirror)

# Step 1: Check for sync history
if [ ! -f "$SYNC_HISTORY" ]; then
  # Check if we can bootstrap from evaluation.json
  EVAL_FILE=".claude/skills/fork-sync/state/evaluation.json"
  if [ -f "$EVAL_FILE" ]; then
    EVAL_MIRROR=$(jq -r '.snapshot.mirrorHead' "$EVAL_FILE")
    # Check if evaluation's mirror head is ancestor of DEV (merge was completed)
    if git merge-base --is-ancestor "$EVAL_MIRROR" DEV 2>/dev/null; then
      echo "Bootstrapping sync-history.json from completed evaluation"
      # Create sync-history.json from evaluation.json (see bootstrap schema)
      SCOPE="bootstrapped"
    else
      SCOPE="full"
    fi
  else
    SCOPE="full"
  fi
else
  # Step 2: Compare last synced mirror head with current mirror
  LAST_SYNCED=$(jq -r '.lastSyncedMirrorHead' "$SYNC_HISTORY")

  if [ "$LAST_SYNCED" = "$MIRROR_HEAD" ]; then
    echo "Nothing to sync — mirror HEAD matches last synced commit"
    SCOPE="none"
  else
    # Step 3: Count delta commits
    DELTA=$(git rev-list --count "$LAST_SYNCED".."$MIRROR_HEAD")
    if [ "$DELTA" -le 50 ]; then
      SCOPE="incremental-light"
    else
      SCOPE="incremental-heavy"
    fi
    echo "Delta: $DELTA commits since last sync → scope: $SCOPE"
  fi
fi
```

**Routing table**:

| Scope               | Condition                                     | Path                                            |
| ------------------- | --------------------------------------------- | ----------------------------------------------- |
| `none`              | lastSyncedMirrorHead == mirror HEAD           | Stop — nothing to sync                          |
| `full`              | No sync-history, no bootstrappable evaluation | Phase 1.5 → 1.6 (if >50) → 1.7 → 2 → 2.5        |
| `incremental-light` | Delta <= 50 commits                           | Phase 1.5-incremental → 2 → 2.5                 |
| `incremental-heavy` | Delta > 50 commits                            | Phase 1.5 → 1.6 (scoped) → 1.7 → 2 → 2.5        |
| `bootstrapped`      | No sync-history but evaluation.json completed | Create sync-history.json, then re-run Phase 1.1 |

**Incremental-light shortcut**: For <=50 commits, Phase 1.5 includes inline evaluation — classify each delta file as auto-accept / rebrand / fork-feature-conflict / extpkg, then go directly to Phase 2 without needing Phase 1.6/1.7.

### Phase 1.5: Pre-Merge Evaluation

**Goal**: Analyze upstream changes before merging to understand impact and plan conflict resolution

**Scope-aware comparison base**:

- **Full mode**: Compare `merge-base(mirror, DEV)..mirror` (full gap)
- **Incremental mode**: Compare `$lastSyncedMirrorHead..mirror` (only delta since last sync)

```bash
# Determine comparison base from Phase 1.1 scope
if [ "$SCOPE" = "full" ]; then
  ANALYSIS_BASE=$(git merge-base mirror DEV)
else
  ANALYSIS_BASE=$(jq -r '.lastSyncedMirrorHead' "$SYNC_HISTORY")
fi

# Compare mirror changes since the analysis base
git diff "$ANALYSIS_BASE"..mirror --stat | head -50
git log --oneline "$ANALYSIS_BASE"..mirror --no-merges | head -30

# Generate per-file change analysis
git diff "$ANALYSIS_BASE"..mirror --name-status | sort
```

**Evaluation Process**:

1. **Categorize changes by type**:
   - Core infrastructure (package.json, workflows, build config)
   - New features (new files/directories)
   - Refactors (modified existing files)
   - Deletions (removed files - check if fork depends on them)
   - Documentation updates

2. **For each significant change, evaluate**:
   - **Worth merging?** Does this fix bugs, add useful features, or improve architecture?
   - **Breaking changes?** Does upstream remove/change APIs that fork code depends on?
   - **Conflicts with fork features?** Does upstream implement something we already have differently?
   - **Dependencies?** Do new features require config changes or have dependencies on other changes?

3. **Identify high-risk files**:
   - Files modified by both upstream and fork (will conflict)
   - Core files like package.json, tsconfig.json, workflow files
   - Files the fork heavily customized (banner.ts, rebrand-related files)

4. **Plan merge strategy**:
   - **Accept wholesale**: Upstream changes that don't conflict (most files)
   - **Manual merge**: Files with conflicts - plan which hunks to keep from each side
   - **Reject**: Upstream changes that break fork features (rare - document why)
   - **Adapt after merge**: Fork features that need updates to work with upstream changes

5. **Document evaluation**:
   Create a mental (or written) map of:
   - Major upstream features being merged
   - Expected conflicts and resolution strategy
   - Files that will need post-merge fixes
   - Tests that might break and need updates

**Expected time**: 5-10 minutes for review

**Output**: Clear understanding of what's changing and plan for Phase 2 merge

### Phase 1.6: Systematic Upstream Evaluation

**When to use**: Gap exceeds ~50 commits, or a bulk merge produced too many conflicts to resolve in one session.

**Goal**: Build a module-by-module merge shopping list — a conflict resolution playbook that guides Phase 2.

**Core principle**: Full merge (`git merge mirror`) remains the integration strategy. The evaluation produces a plan for **how to resolve each conflict**, not which commits to cherry-pick.

**State file**: `.claude/skills/fork-sync/state/evaluation.json`
**Reference**: See `evaluation-reference.md` for detailed heuristics, schema, and module presentation format.

#### Resumability

On invocation, check for existing state:

1. If `state/evaluation.json` exists and `snapshot.mirrorHead` matches current `mirror` HEAD → **resume** from `cursor.currentModuleIndex`
2. If state exists but mirror has advanced → warn user, offer incremental update or fresh start
3. If no state file → run initialization (Steps 1–3)

#### Step 1: Initialize

Snapshot current branch state and build the commit inventory.

```bash
# Determine analysis base (scope-aware)
if [ "$SCOPE" = "full" ]; then
  ANALYSIS_BASE=$(git merge-base mirror DEV)
else
  # Incremental: only analyze commits since last sync
  ANALYSIS_BASE=$(jq -r '.lastSyncedMirrorHead' "$SYNC_HISTORY")
fi

# Record snapshot
MIRROR_HEAD=$(git rev-parse mirror)
DEV_HEAD=$(git rev-parse DEV)
UPSTREAM_COUNT=$(git rev-list --count $ANALYSIS_BASE..mirror)
FORK_COUNT=$(git rev-list --count $ANALYSIS_BASE..DEV)

# Build commit list grouped by module (src/ subdirectory)
git log --oneline --name-only $ANALYSIS_BASE..mirror
```

**Note**: The `analysisBase` and `syncScope` are recorded in `evaluation.json`'s snapshot for auditability.

#### Step 2: Build Fork Feature Index

Identify which files have actual fork functionality (not just rebrand renames). This determines conflict risk per module.

```bash
# Files changed in fork
git diff --name-only $MERGE_BASE..DEV

# For each: classify as rebrand-only, config-only, or functional
git diff $MERGE_BASE..DEV -- <file>
```

Record functional changes in `forkFeatureIndex` with fork commit SHAs, feature description, and recommended resolution.

#### Step 3: Auto-Categorize

Apply heuristic tiers (see `evaluation-reference.md` Section B) to tag each commit:

- **Tier 1** — Commit message patterns (test/docs/style → skip, feat/fix → review, security → accept)
- **Tier 2** — File path overrides (native apps → accept, fork-feature files → review)
- **Tier 3** — Combination rules (resolve Tier 1/2 conflicts)

Expected: ~87% of commits auto-categorized, ~13% need manual review.

#### Step 4: Interactive Module Evaluation

Present each module to the user in priority order (see `evaluation-reference.md` Section C). For each module show:

- Commit count and conflict file count
- Fork features at risk (from `forkFeatureIndex`)
- Auto-categorization breakdown
- Commits needing manual review

User decides per module: **Accept all** | **Review individually** | **Defer** | **Skip module**

Save state after each module decision. This step is **resumable** — the user can stop and resume across sessions.

#### Step 5: Generate Merge Plan

After all modules are evaluated, compile the merge shopping list:

- **keepOurs**: Files where fork version wins
- **acceptWithRebrand**: Files needing only name substitution after merge
- **extensionPackageJson**: Accept upstream + fix `@nikolasp98/minion` dep
- **manualMerge**: Files needing hunk-by-hunk resolution (with notes)
- **autoAccept**: Files that merge cleanly

Export to `UPSTREAM_MERGE_EVALUATION.md` at project root. This document becomes the playbook for Phase 2.

**Expected time**: 15–30 minutes for first run (initialization + high-priority modules), 5–10 minutes per resumed session

### Phase 1.7: Generate Resolution Script

**Trigger:** Run immediately after Phase 1.6 Step 5 (shopping list finalized). Always run before Phase 2.

**Goal**: Convert the evaluation shopping list into a deterministic bash script that resolves all mechanical merge conflicts in seconds.

**Output**: `.claude/skills/fork-sync/scripts/resolve-conflicts.sh`

**Generation instructions:**

Read `evaluation.json`'s `mergeShoppingList`. Produce a script with this structure — emit one `resolve` call per file in each category:

```bash
#!/bin/bash
# Auto-generated by fork-sync Phase 1.7
# Generated: <ISO-8601>
# Mirror head: <git rev-parse mirror>
# Counts: <keepOurs N> keepOurs, <manualMerge N> manualMerge,
#         <acceptWithRebrand N> acceptWithRebrand, <extensionPackageJson N> extpkg,
#         <acceptDeletion N> deletions, <autoAccept N> autoAccept
# DO NOT EDIT — regenerate via Phase 1.7

set -e
# NOTE: Requires GNU sed (Linux default). On macOS: brew install gnu-sed && alias sed=gsed

REBRAND='s/from '"'"'openclaw'"'"'/from '"'"'@nikolasp98\/minion'"'"'/g; s/from "openclaw"/from "@nikolasp98\/minion"/g; s/require('"'"'openclaw'"'"')/require('"'"'@nikolasp98\/minion'"'"')/g; s/require("openclaw")/require("@nikolasp98\/minion")/g'
EXT_PKG='s/"openclaw": "workspace:\*"/"@nikolasp98\/minion": "workspace:*"/g'

resolve() {
  local f="$1" strategy="$2"
  # Idempotent: skip if not currently conflicted
  git ls-files -u -- "$f" | grep -q . || return 0
  case "$strategy" in
    ours)    git checkout --ours "$f" 2>/dev/null && git add "$f" && echo "✓ ours:    $f" ;;
    theirs)  git checkout --theirs "$f" 2>/dev/null && git add "$f" && echo "✓ theirs:  $f" ;;
    rebrand) git checkout --theirs "$f" 2>/dev/null && sed -i "$REBRAND" "$f" && git add "$f" && echo "✓ rebrand: $f" ;;
    extpkg)  git checkout --theirs "$f" 2>/dev/null && sed -i "$EXT_PKG" "$f" && git add "$f" && echo "✓ extpkg:  $f" ;;
    rm)      git rm -f "$f" 2>/dev/null && echo "✓ removed: $f" || true ;;
    *) echo "ERROR: unknown strategy '$strategy' for '$f'" >&2; return 1 ;;
  esac
}

# === keepOurs (<N> files) ===
resolve "Dockerfile" ours
# ... one line per file in keepOurs

# === acceptWithRebrand (<N> files) ===
resolve "src/agents/minion-tools.ts" rebrand
# ... one line per file in acceptWithRebrand

# === extensionPackageJson (<N> files) ===
resolve "extensions/bluebubbles/package.json" extpkg
# ... one line per file in extensionPackageJson

# === acceptDeletion (<N> files) ===
resolve ".agents/AGENT_SUBMISSION_CONTROL_POLICY.md" rm
# ... one line per file in acceptDeletion

# === autoAccept (<N> files) ===
resolve "docs/channels/telegram.md" theirs
# ... one line per file in autoAccept

# === MANUAL MERGE REQUIRED (<N> files) ===
# NOT resolved by this script — Claude handles these in Phase 2 Step 5.
# <file>: <notes from mergeShoppingList>

echo ""
echo "✓ Auto-resolution complete."
echo "MANUAL: Resolve these files, then: git add . && git merge --continue"
# list manualMerge files here as echo lines
```

**Category → strategy mapping:**

| Shopping list category | Script strategy |
| ---------------------- | --------------- |
| `keepOurs`             | `ours`          |
| `acceptWithRebrand`    | `rebrand`       |
| `extensionPackageJson` | `extpkg`        |
| `acceptDeletion`       | `rm`            |
| `autoAccept`           | `theirs`        |
| `manualMerge`          | comment only    |

**Save and commit:**

```bash
chmod +x .claude/skills/fork-sync/scripts/resolve-conflicts.sh
git add .claude/skills/fork-sync/scripts/resolve-conflicts.sh
git commit -m "feat(fork-sync): Phase 1.7 — generate conflict resolution script"
```

**If the script already exists**: overwrite it — the shopping list may have been updated by a delta update.

### Phase 2: Update DEV Branch (Worktree Method)

**Goal**: Merge updated mirror into DEV using an isolated git worktree — immune to parallel git sessions in the main workspace.

**Prerequisite**: Phase 1.7 resolution script exists at `.claude/skills/fork-sync/scripts/resolve-conflicts.sh`. Run Phase 1.7 first if it doesn't.

```bash
# Step 1: Verify resolution script is present
ls .claude/skills/fork-sync/scripts/resolve-conflicts.sh

# Step 2: Create isolated worktree pointing at DEV
git worktree add ../minion-merge-worktree DEV

# Step 3: Merge mirror into worktree (--no-commit to allow pre-commit resolution)
git -C ../minion-merge-worktree merge mirror --no-commit --no-ff

# Step 4: Run resolution script from within the worktree directory
# (script uses relative git commands, must run from worktree root)
cd ../minion-merge-worktree
bash .claude/skills/fork-sync/scripts/resolve-conflicts.sh

# Step 5: Manually resolve manualMerge files listed by the script
# Inspect each, resolve hunks per the script's comment notes
# Common files: package.json, .github/workflows/ci.yml, .github/workflows/docker-release.yml

# After resolving each file:
git -C ../minion-merge-worktree add package.json .github/workflows/ci.yml .github/workflows/docker-release.yml

# Step 6: Commit the merge
git -C ../minion-merge-worktree commit -m "Merge upstream changes from mirror"

# Step 7: Push DEV
git -C ../minion-merge-worktree push origin DEV

# Step 7.5: Update sync-history.json
# Record this sync in the persistent history
SYNC_HISTORY=".claude/skills/fork-sync/state/sync-history.json"
MIRROR_HEAD=$(git rev-parse mirror)
DEV_HEAD=$(git -C ../minion-merge-worktree rev-parse HEAD)
MERGE_COMMIT=$(git -C ../minion-merge-worktree rev-parse HEAD)
DELTA_COUNT=$(git rev-list --count "$LAST_SYNCED".."$MIRROR_HEAD" 2>/dev/null || echo "unknown")
SYNC_ID="sync-$(printf '%03d' $(($(jq '.syncs | length' "$SYNC_HISTORY") + 1)))"
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Append new entry and update top-level fields
jq --arg id "$SYNC_ID" \
   --arg now "$NOW" \
   --arg mirrorHead "$MIRROR_HEAD" \
   --arg devHead "$DEV_HEAD" \
   --arg mergeCommit "$MERGE_COMMIT" \
   --arg deltaCount "$DELTA_COUNT" \
   --arg syncType "$SCOPE" \
   '.syncs += [{
     id: $id,
     completedAt: $now,
     mirrorHead: $mirrorHead,
     devHead: $devHead,
     mergeCommit: $mergeCommit,
     upstreamCommitCount: ($deltaCount | tonumber),
     syncType: $syncType,
     evaluationUsed: false,
     notes: "Incremental sync"
   }] |
   .lastSyncedMirrorHead = $mirrorHead |
   .lastSyncedAt = $now' "$SYNC_HISTORY" > "${SYNC_HISTORY}.tmp" && mv "${SYNC_HISTORY}.tmp" "$SYNC_HISTORY"

# Step 8: Cleanup
git worktree remove ../minion-merge-worktree
```

**Why worktrees prevent interruption**: The main workspace can be on any branch. Commits, checkouts, and stash pops in the main workspace have zero effect on the worktree. The active merge state lives in `../minion-merge-worktree/.git/MERGE_HEAD` — a completely separate directory.

**Recovery if interrupted** (session ends, error, parallel git activity):

```bash
# Full reset in ~30 seconds
git worktree remove --force ../minion-merge-worktree
git worktree add ../minion-merge-worktree DEV
git -C ../minion-merge-worktree merge mirror --no-commit --no-ff
cd ../minion-merge-worktree
bash .claude/skills/fork-sync/scripts/resolve-conflicts.sh
# ... then Step 5 (manualMerge), Step 6 (commit), Step 7 (push), Step 8 (cleanup)
```

**Expected**: Resolution script resolves ~925 of 928 conflicts in under 60 seconds. Claude manually handles the 3 `manualMerge` files only.

**Note**: Feature branches and main (production) are not synced automatically. Update them manually when needed.

### Phase 2.5: Post-Merge Alias Fixup

**Goal**: Add backward-compat aliases for any new upstream `OpenClaw*` exports that the fork references by `Minion*` names (or vice versa).

**Why this is needed**: Upstream uses `OpenClaw*` naming (e.g., `createOpenClawTools`, `OpenClawConfig`). The fork uses `Minion*` naming. When upstream adds new exports, they use `OpenClaw*` names. Fork test files and code may reference the `Minion*` equivalent, which doesn't exist until we add an alias.

**When to run**: After every Phase 2 merge commit, before pushing DEV.

```bash
# Step 1: Run TypeScript type check to find broken imports
npx tsc --noEmit 2>&1 | grep "^src/" | head -40

# Step 2: Categorize errors
# - "has no exported member 'createMinionX'" → add alias in source file
# - "Cannot find name 'OpenClawX'" → change to MinionX in test, or add import
# - "Did you mean 'DEFAULT_MINION_X'?" → add alias in constants file
# - "Property 'X' does not exist on type" → add to type definition (fork feature)

# Step 3: For each missing Minion* alias, add to the source file:
#   export const createMinionX = createOpenClawX;
#   export type MinionX = OpenClawX;

# Step 4: For each missing OpenClaw* alias (upstream files importing fork names):
#   Create re-export shim files: src/module/openclaw-name.ts → re-exports minion-name.ts

# Step 5: For test files using bare OpenClawConfig without import:
#   Change to MinionConfig (which IS imported)

# Step 6: Verify
npx tsc --noEmit 2>&1 | grep "^src/" | wc -l  # Should be 0
npx oxlint --type-aware  # Should be 0 errors
```

**Common alias patterns**:

| Source file                  | Alias to add                                                         |
| ---------------------------- | -------------------------------------------------------------------- |
| `src/agents/minion-tools.ts` | `export const createMinionTools = createOpenClawTools`               |
| `src/agents/pi-tools.ts`     | `export const createMinionCodingTools = createOpenClawCodingTools`   |
| `src/browser/constants.ts`   | `export const DEFAULT_OPENCLAW_X = DEFAULT_MINION_X`                 |
| `src/browser/chrome.ts`      | `export const resolveMinionUserDataDir = resolveOpenClawUserDataDir` |
| `src/config/types.minion.ts` | `export type OpenClawConfig = MinionConfig`                          |
| `src/plugins/types.ts`       | `export type OpenClawPluginX = MinionPluginX`                        |

**Re-export shim files** (for modules renamed during rebrand):

| Shim file                       | Re-exports                    |
| ------------------------------- | ----------------------------- |
| `src/infra/openclaw-root.ts`    | `src/infra/minion-root.ts`    |
| `src/infra/tmp-openclaw-dir.ts` | `src/infra/tmp-minion-dir.ts` |
| `src/agents/openclaw-tools.ts`  | `src/agents/minion-tools.ts`  |
| `src/config/types.openclaw.ts`  | `src/config/types.minion.ts`  |

**Commit separately** from the merge commit:

```bash
git commit -m "fix: post-merge compatibility — add OpenClaw/Minion backward-compat aliases"
```

## Safety Checks

### Pre-Sync Checklist

Before starting the sync workflow:

- [ ] Working directory is clean (`git status`)
- [ ] No uncommitted changes that could conflict
- [ ] WIP changes committed to a temp branch or stashed (see WIP Preservation below)
- [ ] Upstream remote is configured (`git remote -v | grep upstream`)
- [ ] Latest upstream fetched (`git fetch upstream`)
- [ ] Mirror is clean mirror (no divergence from upstream)

### Verification Commands

After completing sync:

```bash
# Verify mirror matches upstream
git log --oneline mirror..upstream/main  # Should be empty

# Verify branch relationships
git log --oneline --graph --all --decorate -20

# Verify DEV contains mirror's commits
git merge-base --is-ancestor mirror DEV && echo "✓ DEV contains mirror" || echo "✗ DEV missing mirror commits"
```

### Post-Sync Checklist

- [ ] `mirror` matches `upstream/main` (no divergence)
- [ ] `mirror` pushed to `origin/mirror`
- [ ] `DEV` merged mirror successfully
- [ ] `DEV` pushed to remote
- [ ] Docker workflows still functional (optional: verify builds)

**Note**: Feature branches and main (production) are not synced automatically. Update them manually when needed.

## Conflict Resolution

### Mirror Has Custom Commits

**Problem**: `git merge --ff-only upstream/main` fails with "Not possible to fast-forward"

**Root Cause**: Mirror contains custom commits (violates clean mirror principle)

**Solution**:

1. Verify custom commits exist on DEV/main: `git log --oneline DEV | head`
2. Reset mirror to upstream: `git reset --hard upstream/main`
3. Force push: `git push --force-with-lease origin mirror`
4. Continue normal workflow (merge mirror → DEV)

### Merge Conflicts in DEV

If conflicts occur when merging mirror into DEV:

1. **Identify conflicts**: `git status` shows conflicted files
2. **Common conflict areas**:
   - Docker configurations (if upstream changed docker-compose.yml)
   - Workflow files (if upstream changed .github/workflows/\*)
   - Core files modified by both upstream and custom work

3. **Evaluate upstream vs fork for each conflict**:

   Do NOT default to keeping fork changes. For each conflicted hunk, ask:
   - **Is the upstream change an architectural improvement?** (e.g. new type field, refactored API, better pattern) — If yes, adopt upstream and adapt fork changes to fit the new structure.
   - **Does upstream solve the same problem differently?** — Compare both approaches. The upstream solution may be more robust, better tested, or aligned with the project's direction.
   - **Is the fork change purely additive?** (e.g. new config field, new import) — If yes, keep both: accept upstream's changes AND add the fork-specific additions.
   - **Are they independent changes to the same region?** — Keep both, adjusting whitespace/ordering as needed.

   **Rule of thumb**: Upstream is the source of truth for architecture. Fork changes should layer on top of upstream, not override it. When in doubt, adopt upstream and re-apply fork additions.

4. **Complete merge**:
   ```bash
   git add <resolved-files>
   git commit -m "Merge upstream changes, resolve conflicts"
   git push origin DEV
   ```

### Abort/Rollback

If issues occur during merge:

```bash
# Abort current merge
git merge --abort

# Reset to previous state
git reflog  # Find previous commit
git reset --hard HEAD@{1}

# Or restore from remote
git reset --hard origin/<branch-name>
```

## Common Scenarios

### Scenario 1: Regular Upstream Sync (Weekly/Bi-weekly)

When upstream has new commits and you want to pull them in:

1. **Phase 0**: Check if mirror is clean (should be)
2. **Phase 1**: Merge upstream/main → mirror (fast-forward)
3. **Phase 2**: Merge mirror → DEV
4. **Time**: ~3-5 minutes

**Note**: Feature branches and main (production) are not auto-synced. Update manually when needed.

### Scenario 2: Mirror Has Diverged

When mirror accidentally contains custom commits:

1. **Phase 0**: Verify commits on DEV/main, reset mirror to upstream
2. Continue with normal workflow
3. **Time**: ~2-3 minutes extra

### Scenario 3: Emergency Hotfix from Upstream

When upstream has a critical fix you need immediately:

1. Sync mirror (fast-forward)
2. Cherry-pick to DEV if urgent: `git cherry-pick <commit-sha>`
3. Or run full workflow if you have time

## Best Practices

1. **Keep mirror clean**: NEVER commit custom work to mirror
2. **All custom work on DEV**: Commit custom changes to DEV or feature branches
3. **Sync regularly**: Weekly or bi-weekly to avoid large merge conflicts
4. **Clean working directory**: Always start with `git status` showing clean
5. **Preserve WIP before sync**: Commit WIP to a temp branch (preferred) or stash — see WIP Preservation section
6. **Review upstream changes**: Use `git log mirror..upstream/main` before merging
7. **Test after sync**: Verify Docker images build successfully
8. **DEV before main**: Always test in DEV before merging to main (production)

## Troubleshooting

### "fatal: Not possible to fast-forward"

**Cause**: Mirror has custom commits (diverged from upstream)

**Fix**: Run Phase 0 (Clean Mirror) first

### "error: Your local changes would be overwritten"

**Cause**: Uncommitted changes in working directory

**Fix**: Use the WIP Preservation method below (temp branch preferred over stash).

### "Updates were rejected because the remote contains work"

**Cause**: Remote branch has commits not in local branch

**Fix**:

```bash
git pull --rebase origin <branch-name>
# Resolve conflicts if any
git push origin <branch-name>
```

## Quick Reference Card

```
┌──────────────────────────────────────────────────────────────────┐
│                  Fork Sync Quick Reference                       │
├──────────────────────────────────────────────────────────────────┤
│ 0. Clean mirror (if needed) → git checkout mirror               │
│                                git reset --hard upstream/main    │
│                                git push --force-with-lease       │
├──────────────────────────────────────────────────────────────────┤
│ 1. Sync mirror              → git checkout mirror               │
│                                git merge --ff-only upstream/main │
│                                git push origin mirror            │
├──────────────────────────────────────────────────────────────────┤
│ 1.1. Determine sync scope   → Check sync-history.json           │
│                                Route: none/full/inc-light/heavy  │
│                                Bootstrap from evaluation.json   │
├──────────────────────────────────────────────────────────────────┤
│ 1.5. Pre-merge evaluation   → git diff $BASE..mirror --stat     │
│      (scope-aware)            Review changes per-file           │
│                                Plan conflict resolution strategy │
├──────────────────────────────────────────────────────────────────┤
│ 1.6. Systematic evaluation  → "evaluate upstream" (resumable)   │
│      (large gaps only)        Module-by-module categorization    │
│                                Builds merge shopping list        │
│                                Delta-updates when mirror advances│
│                                See evaluation-reference.md       │
├──────────────────────────────────────────────────────────────────┤
│ 1.7. Generate script         → Read evaluation.json             │
│      (after 1.6 completes)     Write resolve-conflicts.sh       │
│                                chmod +x && commit               │
├──────────────────────────────────────────────────────────────────┤
│ 2. Update DEV (worktree)     → git worktree add ../merge-wt DEV │
│                                git -C ../merge-wt merge mirror  │
│                                bash scripts/resolve-conflicts.sh│
│                                Resolve manualMerge files (N)    │
│                                git -C ../merge-wt commit + push │
│                                Update sync-history.json (7.5)   │
│                                git worktree remove ../merge-wt  │
├──────────────────────────────────────────────────────────────────┤
│ 2.5. Alias fixup            → npx tsc --noEmit | grep ^src/    │
│      (after merge commit)     Add Minion↔OpenClaw aliases       │
│                                Create re-export shim files      │
│                                Fix test imports                 │
│                                Commit separately from merge     │
├──────────────────────────────────────────────────────────────────┤
│ Verify:                     → git log mirror..upstream/main     │
│                                (should be empty)                 │
├──────────────────────────────────────────────────────────────────┤
│ Note: Feature branches and main (production) are manual         │
└──────────────────────────────────────────────────────────────────┘
```

## WIP Preservation

**Why not stash?** Stashing before a large merge is risky: `git stash pop` after the merge replays your changes against the new HEAD, producing phantom diffs (hundreds of "deleted" lines that are actually upstream additions). Recovery requires extracting a patch and 3-way re-applying — fragile and time-consuming.

**Preferred approach — temp branch:**

```bash
# Before starting fork-sync:
git checkout DEV
git checkout -b wip/pre-sync
git add -A && git commit -m "WIP: pre-sync snapshot"
git checkout DEV

# ... run fork-sync (Phase 1 → 2 → 2.5) ...

# After sync completes:
git cherry-pick wip/pre-sync   # or: git diff DEV..wip/pre-sync | git apply --3way
git branch -D wip/pre-sync
```

**Why this works:** The WIP commit stays on a named branch with full context. After the merge, cherry-picking replays it cleanly against the new HEAD. If conflicts occur, they're real conflicts (not phantom diffs from stash replay).

**If you must stash:** Be aware that `git stash pop` after a merge will produce phantom changes. To recover:

```bash
git stash pop                          # phantom diffs appear
git diff > /tmp/wip.patch             # save actual WIP
git checkout -- .                      # discard phantom changes
git apply --3way /tmp/wip.patch       # re-apply with 3-way merge
```

## When to Use This Skill

Invoke this skill when:

- "Sync with upstream"
- "Update fork from minion/minion"
- "Pull latest from upstream"
- "Update all branches"
- "Sync DEV with upstream"
- "Fork workflow" or "fork-sync"
- "Evaluate upstream" or "resume evaluation" (Phase 1.6)
- Before starting major feature work (to start from latest upstream)
- After seeing mirror has diverged from upstream
- When a bulk merge produces too many conflicts (triggers Phase 1.6)

---

**Skill Version**: 6.0.0
**Last Updated**: 2026-02-18
**Maintained By**: Nikolas P. (NikolasP98)
