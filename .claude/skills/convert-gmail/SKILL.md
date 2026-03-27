---
name: convert-gmail
description: Convert the old single-account Gmail integration (merged from nanoclaw-gmail.git) to the new multi-account Gmail system. Detects old setup, preserves GCP credentials, removes hardcoded changes, and hands off to /add-gmail.
---

# Convert Old Gmail to Multi-Account Gmail

This skill migrates from the old single-account Gmail integration (merged from the `nanoclaw-gmail` remote) to the new multi-account system on the `skill/gmail` branch.

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

> No old Gmail integration detected. You can set up the new multi-account Gmail directly with `/add-gmail`.

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

### Rename credentials.json

If `~/.gmail-mcp/credentials.json` exists, rename it to the new expected name:

```bash
cp ~/.gmail-mcp/credentials.json ~/.gmail-mcp/gcp-oauth.keys.json
```

Use `cp` instead of `mv` so the old file remains as a backup until conversion is verified.

If `~/.gmail-mcp/credentials.json` does not exist, tell the user they'll need to provide GCP OAuth credentials during `/add-gmail` setup (Phase 1 of that skill).

## Phase 4: Remove Old Integration Artifacts

### 4a. Remove hardcoded Gmail mount from container-runner.ts

Read `src/container-runner.ts` and find the Gmail-specific mount (typically a bind mount for `~/.gmail-mcp` or `.gmail-mcp`). Remove only the Gmail-related mount line(s) — leave all other mounts intact.

### 4b. Remove hardcoded Gmail MCP server from agent-runner

Read `container/agent-runner/src/index.ts` and remove:
- The Gmail MCP server entry (e.g., `@gongrzhe/server-gmail-autoauth-mcp` in any server config)
- Any `mcp__gmail__*` entries in tool allowlists

Leave all other MCP servers and tools intact.

### 4c. Remove email handling instructions from group CLAUDE.md files

If any `groups/*/CLAUDE.md` files contain an "Email Notifications" section added by the old skill, remove that section. The new system handles email instructions differently.

### 4d. Uninstall old googleapis dependency

```bash
npm uninstall googleapis 2>/dev/null || true
```

The new system uses `@googleapis/gmail` (installed by the `skill/gmail` branch).

### 4e. Remove old gmail remote

```bash
git remote remove gmail 2>/dev/null || true
```

### 4f. Clear stale agent-runner copies

```bash
rm -r data/sessions/*/agent-runner-src 2>/dev/null || true
```

These cached copies won't pick up the agent-runner changes. They'll be re-created on next agent invocation.

## Phase 5: Verify Cleanup

```bash
# Confirm no gmail references remain in container-runner
grep -n 'gmail' src/container-runner.ts 2>/dev/null || echo "CLEAN"

# Confirm no gmail references remain in agent-runner
grep -n 'gmail' container/agent-runner/src/index.ts 2>/dev/null || echo "CLEAN"

# Confirm old dependency is gone
grep '"googleapis"' package.json 2>/dev/null || echo "CLEAN"

# Confirm GCP credentials are in the new location
ls ~/.gmail-mcp/gcp-oauth.keys.json 2>/dev/null || echo "MISSING_GCP_KEYS"
```

If any check fails (except GCP keys which were already handled), investigate and fix before proceeding.

## Phase 6: Hand Off to /add-gmail

Tell the user:

> Old Gmail integration removed. Your GCP OAuth credentials have been preserved. Now let's set up the new multi-account Gmail.

Invoke `/add-gmail`. Since `~/.gmail-mcp/gcp-oauth.keys.json` already exists, it will skip GCP setup and go straight to account authorization.
