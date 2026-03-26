---
name: add-gmail-multi
description: Add multi-account Gmail to NanoClaw. Supports multiple Gmail accounts with per-group access. Each group gets its own Gmail MCP server via .mcp.json and credential mounts via containerConfig.additionalMounts. Guides through GCP OAuth setup, per-account authorization, and group assignment.
---

# Add Multi-Account Gmail

This skill sets up Gmail access for multiple accounts, with each NanoClaw group accessing only its assigned Gmail account.

## Phase 1: Pre-flight

### Check prerequisites

```bash
ls ~/.gmail-mcp/gcp-oauth.keys.json 2>/dev/null || echo "NO_OAUTH_KEYS"
ls ~/.gmail-mcp/tokens/ 2>/dev/null || echo "NO_TOKENS_DIR"
ls -d groups/*/ 2>/dev/null | grep -v global
cat ~/.config/nanoclaw/mount-allowlist.json 2>/dev/null || echo "NO_ALLOWLIST"
```

If `gcp-oauth.keys.json` exists, skip to Phase 2 (or Phase 3 if tokens also exist).

### GCP Project Setup

Tell the user to set up Google Cloud OAuth credentials:

> 1. Open https://console.cloud.google.com — create a new project or select existing
> 2. Go to **APIs & Services > Library**, search "Gmail API", click **Enable**
> 3. Go to **APIs & Services > Credentials**, click **+ CREATE CREDENTIALS > OAuth client ID**
>    - If prompted for consent screen: choose "External", fill in app name and email, save
>    - Application type: **Desktop app**, name: anything (e.g., "NanoClaw Gmail")
> 4. Click **DOWNLOAD JSON** and save it

AskUserQuestion: Where did you save the OAuth credentials JSON file?

- **File path** — Give the full path to the downloaded JSON file
- **Paste contents** — Paste the JSON content directly

If user provides a path, copy it:

```bash
mkdir -p ~/.gmail-mcp
cp "/path/user/provided" ~/.gmail-mcp/gcp-oauth.keys.json
```

If user pastes JSON content, write it to `~/.gmail-mcp/gcp-oauth.keys.json`.

### Configure mount allowlist

Add `~/.gmail-mcp` as an allowed root so NanoClaw can mount credential files into containers. First read the current allowlist with the Read tool:

```
~/.config/nanoclaw/mount-allowlist.json
```

Then use the Edit tool to add `{ "path": "~/.gmail-mcp", "readonly": true }` to the `allowedRoots` array. Merge with existing entries — don't overwrite other allowed roots.

## Phase 2: Authorize Gmail Accounts

AskUserQuestion: Which Gmail account do you want to authorize?

- **Email address** — Enter the full Gmail address (e.g., `user@gmail.com`)

For each account the user provides, run:

```bash
npx tsx scripts/gmail-oauth.ts <email>
```

This opens a browser for OAuth consent. The script times out after 2 minutes if the user doesn't complete the flow.

If the user sees an "app isn't verified" warning, tell them to click "Advanced" then "Go to [app name] (unsafe)" — this is normal for personal OAuth apps.

After the script exits, verify the token was saved:

```bash
ls ~/.gmail-mcp/tokens/<email>.json
```

If the token file exists, authorization succeeded:

AskUserQuestion: Account authorized! Do you want to add another Gmail account?

- **Yes** — Authorize another Gmail address
- **No** — Continue to group assignment

If the token file does NOT exist (script timed out or the user closed the browser):

AskUserQuestion: Authorization for `<email>` didn't complete. What would you like to do?

- **Retry** — Open the consent screen again for the same account
- **Different account** — Try a different Gmail address instead
- **Skip** — Continue without this account (you can add it later with `/add-gmail-multi`)

Repeat until the user says no or skip.

## Phase 3: Assign Accounts to Groups

List available groups:

```bash
ls -d groups/*/ | grep -v global
```

List authorized accounts:

```bash
ls ~/.gmail-mcp/tokens/
```

For each authorized account that hasn't been assigned yet:

AskUserQuestion: Which group should `<email>` be assigned to?

- **Group folder name** — Enter the folder name (e.g., `work_consulting`)

AskUserQuestion: What label should the Gmail server use? This becomes the tool prefix — e.g., `consulting` means tools appear as `mcp__gmail_consulting__search_emails`. Suggestion: `<first part of email>`

- **Label name** — A short identifier for this Gmail account

### Step 3a: Create `.mcp.json` for the group

This tells the Claude Code SDK to spawn the Gmail MCP server for this group's agent.

For the chosen group, create or update `groups/<name>/.mcp.json`. If the file already exists, merge the new server entry into the existing `mcpServers` object. If it doesn't exist, create it:

```json
{
  "mcpServers": {
    "gmail_<label>": {
      "command": "npx",
      "args": ["-y", "@gongrzhe/server-gmail-autoauth-mcp"],
      "env": {
        "GMAIL_CREDENTIALS_PATH": "/workspace/extra/gmail/<email>/token.json",
        "GMAIL_OAUTH_PATH": "/workspace/extra/gmail/gcp-oauth.keys.json"
      }
    }
  }
}
```

### Step 3b: Add credential mounts via containerConfig

This makes the credential files available inside the container. Uses NanoClaw's `containerConfig.additionalMounts` system, which validates mounts against the allowlist.

Read the group's current config from SQLite:

```bash
sqlite3 data/nanoclaw.db "SELECT container_config FROM registered_groups WHERE folder = '<group_folder>'"
```

Update `containerConfig.additionalMounts` to include the Gmail credential mounts. The mounts use `additionalMounts` format where `containerPath` is relative (mounted at `/workspace/extra/<containerPath>`):

```json
{
  "additionalMounts": [
    {
      "hostPath": "~/.gmail-mcp/tokens/<email>.json",
      "containerPath": "gmail/<email>/token.json",
      "readonly": true
    },
    {
      "hostPath": "~/.gmail-mcp/gcp-oauth.keys.json",
      "containerPath": "gmail/gcp-oauth.keys.json",
      "readonly": true
    }
  ]
}
```

Merge with any existing `additionalMounts` — don't overwrite. Write back to SQLite:

```bash
sqlite3 data/nanoclaw.db "UPDATE registered_groups SET container_config = '<json>' WHERE folder = '<group_folder>'"
```

Alternatively, use the NanoClaw `setRegisteredGroup()` function from `src/db.ts` if running from within Node.js.

**Important:** The `containerPath` values are relative and get prefixed with `/workspace/extra/`. So `gmail/<email>/token.json` becomes `/workspace/extra/gmail/<email>/token.json` inside the container — matching what `.mcp.json` references.

## Phase 4: Build and Restart

```bash
# Clear stale agent-runner copies
rm -r data/sessions/*/agent-runner-src 2>/dev/null || true

# Rebuild container
./container/build.sh

# Rebuild and restart
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 5: Verify

Tell the user:

> Gmail is connected! To test, send a message in the group's channel:
>
> `@Andy check my recent emails`
>
> or `@Andy list my Gmail labels`

Monitor logs:

```bash
tail -f logs/nanoclaw.log | grep -iE "(gmail|mcp|email)"
```

## Troubleshooting

### Gmail MCP server not loading

Check that `.mcp.json` exists in the group folder and is valid JSON:

```bash
cat groups/<name>/.mcp.json | python3 -m json.tool
```

### Credentials not found in container

Check that the mounts were configured. Query SQLite:

```bash
sqlite3 data/nanoclaw.db "SELECT container_config FROM registered_groups WHERE folder = '<group_folder>'"
```

Verify the mount allowlist includes `~/.gmail-mcp`:

```bash
cat ~/.config/nanoclaw/mount-allowlist.json
```

Verify token file exists on host:

```bash
ls ~/.gmail-mcp/tokens/<email>.json
```

### Mount blocked by security

If logs show "Path matches blocked pattern", check the host path for blocked patterns (`credentials`, `.env`, `.secret`, etc.). The token files are named `<email>.json` to avoid the `credentials` blocked pattern.

### OAuth token expired

Re-authorize:

```bash
npx tsx scripts/gmail-oauth.ts <email>
```

### Adding another account later

Re-run `/add-gmail-multi`. It detects existing setup and skips to account authorization.

### Conflict with `/add-gmail`

If you previously ran `/add-gmail`, it hardcoded a single Gmail MCP server into the agent-runner. This will give all groups a `gmail` server in addition to any per-group `gmail_<label>` servers from `.mcp.json`. To avoid confusion, remove the hardcoded server from `container/agent-runner/src/index.ts` (the `gmail` entry in `mcpServers` and `mcp__gmail__*` in `allowedTools`), then rebuild the container.
