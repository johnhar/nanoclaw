---
name: convert-gmail
description: Convert the old single-account Gmail integration (merged from nanoclaw-gmail.git) to the new multi-account Gmail system. Detects old setup, preserves GCP credentials, removes hardcoded changes, and hands off to /add-multi-gmail.
---

# Convert Old Gmail to Multi-Account Gmail

This skill migrates from the old single-account Gmail integration (merged from the `nanoclaw-gmail` remote) to the new multi-account system.

## Phase 1: Detect Old Integration

### Check for old Gmail artifacts

```bash
# Hardcoded gmail mount in container-runner
grep -n 'gmail-mcp\|gmail' src/container-runner.ts 2>/dev/null || echo "NO_CONTAINER_RUNNER_GMAIL"

# Hardcoded gmail MCP server in agent-runner
grep -rn 'gmail\|mcp__gmail' container/agent-runner/src/index.ts 2>/dev/null || echo "NO_AGENT_RUNNER_GMAIL"

# Old credentials.json (not the new gcp-oauth.keys.json)
ls ~/.gmail-mcp/credentials.json 2>/dev/null || echo "NO_OLD_CREDENTIALS"

# Old googleapis dependency
grep '"googleapis"' package.json 2>/dev/null || echo "NO_OLD_GOOGLEAPIS"

# Old channel files from nanoclaw-gmail remote
git remote -v 2>/dev/null | grep gmail || echo "NO_GMAIL_REMOTE"

# Email handling instructions in group CLAUDE.md files
grep -rn 'Email Notifications' groups/*/CLAUDE.md 2>/dev/null || echo "NO_EMAIL_INSTRUCTIONS"
```

### Evaluate detection results

If NONE of the above checks find anything, tell the user:

> No old Gmail integration detected. You can set up the new multi-account Gmail directly with `/add-multi-gmail`.

Stop here — do not proceed.

If at least one check finds old artifacts, continue to Phase 2.

## Phase 2: Confirm With User

Summarize what was found. Example:

> I found the old Gmail integration:
> - Hardcoded Gmail mount in `src/container-runner.ts`
> - Gmail MCP server in `container/agent-runner/src/index.ts`
> - Old `credentials.json` at `~/.gmail-mcp/`
> - `googleapis` dependency in `package.json`
>
> I'll convert this to the new multi-account system. Your GCP OAuth credentials will be preserved — you'll just need to re-authorize the account (quick browser OAuth, ~30 seconds).

AskUserQuestion: Ready to convert? This will remove the old Gmail hardcoding and set up the new per-group system.

- **Yes** — Proceed with conversion
- **No** — Cancel

If the user declines, stop here.

## Phase 3: Preserve GCP Credentials

### Copy credentials to new location

If `~/.gmail-mcp/credentials.json` or `~/.gmail-mcp/gcp-oauth.keys.json` exists, copy to the new directory:

```bash
mkdir -p ~/.multi-gmail-mcp
cp ~/.gmail-mcp/gcp-oauth.keys.json ~/.multi-gmail-mcp/gcp-oauth.keys.json 2>/dev/null || true
# Old format used credentials.json — copy as gcp-oauth.keys.json
cp ~/.gmail-mcp/credentials.json ~/.multi-gmail-mcp/gcp-oauth.keys.json 2>/dev/null || true
```

Use `cp` instead of `mv` so the old files remain as a backup until conversion is verified.

If neither file exists, tell the user they'll need to provide GCP OAuth credentials during `/add-multi-gmail` setup (Phase 1 of that skill).

## Phase 4: Remove Old Integration via Git Revert

### Find the old Gmail merge commit

```bash
# Look for the merge from gmail/main or nanoclaw-gmail — NOT johnhar/skill/multi-gmail
git log --merges --oneline | grep -i "gmail/main\|nanoclaw-gmail"
```

### Revert the old merge

```bash
git revert -m 1 <old-gmail-merge-commit>
```

This cleanly undoes the old Gmail code (hardcoded mounts, MCP server entries, `googleapis` dependency, `gmail.ts` channel file) without affecting any commits before or after it, including the multi-gmail merge.

If the revert has conflicts, resolve them by reading the conflicted files. The intent is to remove everything the old Gmail merge introduced.

### Non-git cleanup

These items aren't tracked by git or weren't part of the merge commit:

```bash
# Remove old gmail remote
git remote remove gmail 2>/dev/null || true

# Clear stale agent-runner copies (they cache old MCP config)
rm -r data/sessions/*/agent-runner-src 2>/dev/null || true
```

### Remove old mount allowlist entry

Read `~/.config/nanoclaw/mount-allowlist.json` and remove any `allowedRoots` entry with path `~/.gmail-mcp`. Leave all other entries intact. The new `/add-multi-gmail` skill will add `~/.multi-gmail-mcp` during setup.

## Phase 5: Verify Cleanup

```bash
# Confirm no old gmail references remain in container-runner
grep -n 'gmail' src/container-runner.ts 2>/dev/null || echo "CLEAN"

# Confirm no old gmail references remain in agent-runner
grep -n 'gmail' container/agent-runner/src/index.ts 2>/dev/null || echo "CLEAN"

# Confirm old dependency is gone
grep '"googleapis"' package.json 2>/dev/null || echo "CLEAN"

# Confirm GCP credentials are in the new location
ls ~/.multi-gmail-mcp/gcp-oauth.keys.json 2>/dev/null || echo "MISSING_GCP_KEYS"
```

If any check fails (except GCP keys which were already handled), investigate and fix before proceeding.

## Phase 6: Hand Off to /add-multi-gmail

Tell the user:

> Old Gmail integration removed. Your GCP OAuth credentials have been preserved at `~/.multi-gmail-mcp/`. Now let's set up the new multi-account Gmail.

Invoke `/add-multi-gmail`. Since `~/.multi-gmail-mcp/gcp-oauth.keys.json` already exists, it will skip GCP setup and go straight to account authorization.

See `docs/multi-gmail.md` for architecture details and comparison with the old system.
