# Remove Gmail Multi — Design Spec

## Overview

A new `/remove-gmail` skill that manages existing Gmail account associations. Provides two operations: **disassociate** (unlink an account from a group, keep the token) and **remove** (delete the account entirely, including token and all group associations).

## Data Model

Gmail account state is stored across three locations:

| Location | What it stores |
|----------|---------------|
| `~/.gmail-mcp/tokens/<email>.json` | OAuth refresh token for the account |
| `groups/<name>/.mcp.json` | MCP server entry (`gmail_<label>`) with env vars pointing to token/OAuth paths |
| SQLite `registered_groups.container_config` | `additionalMounts` entries that mount token + OAuth key files into the container |

The label is the user-chosen identifier (e.g., `consulting`) that becomes the MCP server name (`gmail_consulting`) and tool prefix (`mcp__gmail_consulting__*`).

The database is at `store/messages.db` (not `data/nanoclaw.db`).

## Phase 1: Account & Group Summary

On invocation, gather state from:

1. `ls ~/.gmail-mcp/tokens/` — authorized accounts (each file is `<email>.json`)
2. Read each group's `.mcp.json` file (iterate `groups/*/` directories). For each `gmail_*` key in `mcpServers`, extract the email from the `GMAIL_CREDENTIALS_PATH` env var by parsing the path segment between `gmail/` and `/token.json` (the value is a container path like `/workspace/extra/gmail/<email>/token.json`). The key name minus the `gmail_` prefix is the label.
3. `sqlite3 store/messages.db "SELECT folder, container_config FROM registered_groups"` — cross-reference mounts to detect any inconsistencies.

Present a summary table ordered by label, account, group(s):

```
Label        Account              Group(s)
consulting   user@gmail.com       work_consulting, personal
client       client@gmail.com     (not assigned)
```

If a `.mcp.json` references a token that doesn't exist on disk, flag it in the summary as `(token missing)` so the user can clean it up.

If no tokens exist and no `.mcp.json` Gmail entries exist: "No Gmail accounts are configured. Use `/add-gmail` to add one."

## Phase 2: Choose Operation

AskUserQuestion: What would you like to do?

- **Disassociate** — Remove a Gmail account from a group, but keep the account authorized (token stays)
- **Remove** — Delete a Gmail account entirely (removes token and disassociates from all groups)

## Phase 3a: Disassociate Flow

1. AskUserQuestion listing label-group pairs from the summary — which pairing to disassociate?
2. Confirm: "This will remove `<label>` (`<email>`) from `<group>`. `<label>` stays authorized and can be re-assigned to any group later with `/add-gmail`. This change takes effect on the next agent invocation for that group."
3. On confirm:
   - Remove the `gmail_<label>` entry from `groups/<name>/.mcp.json` using the Edit tool. If it was the only entry in `mcpServers`, leave the file as `{"mcpServers": {}}` (other tooling may expect the file to exist).
   - Remove the matching `additionalMounts` entry for that email's token (match on `containerPath` containing `gmail/<email>/token.json`) from SQLite `container_config`.
   - After removing the `gmail_<label>` entry, check if any other `gmail_*` servers remain in that group's `.mcp.json`. If none remain, also remove the `gcp-oauth.keys.json` mount from `additionalMounts`.
   - Write the updated `container_config` JSON back to SQLite.
4. No restart needed — changes take effect on the next agent invocation for that group.

## Phase 3b: Remove Flow

1. AskUserQuestion listing accounts by label — which account to remove?
2. Look up all groups associated with that account from the summary.
3. Confirm with restart warning: "This will remove `<label>` (`<email>`) and disassociate it from these groups: `<list>`. This requires restarting NanoClaw, which will interrupt any active agents or channels. You can easily re-add this account later with `/add-gmail`."
4. On confirm:
   - Run disassociate (Phase 3a step 3) for each associated group.
   - Delete `~/.gmail-mcp/tokens/<email>.json`.
   - Rebuild and restart:
     ```bash
     rm -r data/sessions/*/agent-runner-src 2>/dev/null || true
     ./container/build.sh
     npm run build
     launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
     # Linux: systemctl --user restart nanoclaw
     ```

## Phase 4: Repeat or Exit

After any operation completes, show the updated summary table and:

AskUserQuestion: What would you like to do next?

- **Disassociate** — Remove another account from a group
- **Remove** — Delete another account entirely
- **Done** — Exit

## Implementation Notes

- This is a skill-only implementation (SKILL.md instructions, no new scripts).
- The skill file goes in `.claude/skills/remove-gmail/SKILL.md` on the `skill/gmail` branch.
- Uses the same tools as `/add-gmail`: Bash, Read, Edit, sqlite3, AskUserQuestion.
- All user prompts use `AskUserQuestion` with structured options per NanoClaw skill conventions.
