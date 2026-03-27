---
name: add-multi-gmail
description: Add Gmail to NanoClaw with multi-account support. Each group can have one or more Gmail accounts, each accessed via its own MCP server configured in .mcp.json with credential mounts via containerConfig.additionalMounts. Guides through GCP OAuth setup, per-account authorization, and group assignment.
---

# Add Multi-Account Gmail

This skill sets up Gmail access for NanoClaw groups. Each group can have one or more Gmail accounts, and the same account can be shared across multiple groups.

## Phase 1: Pre-flight

### Check if already applied

Check if `src/channels/multi-gmail.ts` exists. If it does, skip to Phase 2 (Setup). The code changes are already in place.

### Merge the skill branch

```bash
# TODO: Maintainers — change remote and branch to: upstream skill/multi-gmail
git remote add johnhar https://github.com/johnhar/nanoclaw.git 2>/dev/null || true
git fetch johnhar skill/multi-gmail
git merge johnhar/skill/multi-gmail
npm install
npm run build
```

### Check for old Gmail integration

After merge, check if old Gmail exists by looking for `src/channels/gmail.ts` that imports `from 'googleapis'` (not `from '@googleapis/gmail'`):

```bash
grep "from 'googleapis'" src/channels/gmail.ts 2>/dev/null || echo "NO_OLD_GMAIL"
```

- **Old detected** — Tell user: "Old single-account Gmail integration detected. Run `/convert-gmail` to clean it up, then run `/add-multi-gmail` again." **Stop here.**
- **Not detected** — Continue to Phase 2

### Check prerequisites

```bash
ls ~/.multi-gmail-mcp/gcp-oauth.keys.json 2>/dev/null || echo "NO_OAUTH_KEYS"
ls ~/.multi-gmail-mcp/tokens/ 2>/dev/null || echo "NO_TOKENS_DIR"
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
mkdir -p ~/.multi-gmail-mcp
cp "/path/user/provided" ~/.multi-gmail-mcp/gcp-oauth.keys.json
```

If user pastes JSON content, write it to `~/.multi-gmail-mcp/gcp-oauth.keys.json`.

### Configure mount allowlist

Add `~/.multi-gmail-mcp` as an allowed root so NanoClaw can mount credential files into containers. First read the current allowlist with the Read tool:

```
~/.config/nanoclaw/mount-allowlist.json
```

Then use the Edit tool to add `{ "path": "~/.multi-gmail-mcp", "readonly": true }` to the `allowedRoots` array. Merge with existing entries — don't overwrite other allowed roots.

## Phase 2: Authorize Gmail Accounts

Ask the user: "Which Gmail address do you want to authorize? (e.g., `user@gmail.com`)"

Wait for the user to type an email address, then run:

```bash
npx tsx scripts/gmail-oauth.ts <email>
```

Before running the command, tell the user:

> I'm about to open Google's authorization screen in your browser. If the authorization needs to be restarted for any reason, just let me know. Otherwise I'll automatically detect when you've completed it successfully.

If the user sees an "app isn't verified" warning, tell them to click "Advanced" then "Go to [app name] (unsafe)" — this is normal for personal OAuth apps.

The script waits for the OAuth callback and exits automatically on success. After it completes, verify the token was saved:

```bash
ls ~/.multi-gmail-mcp/tokens/<email>.json
```

If the token file exists, authorization succeeded:

AskUserQuestion: Account authorized! Do you want to add another Gmail account?

- **Yes** — Authorize another Gmail address
- **No** — Continue to group assignment

If the user says the authorization needs to be restarted:

AskUserQuestion: What would you like to do?

- **Retry** — Open the consent screen again for the same account
- **Different account** — Try a different Gmail address instead
- **Skip** — Continue without this account (you can add it later with `/add-multi-gmail`)

Repeat until the user says no or skip.

## Phase 3: Assign Accounts to Groups

List available groups:

```bash
ls -d groups/*/ | grep -v global
```

List authorized accounts:

```bash
ls ~/.multi-gmail-mcp/tokens/
```

For each authorized account that hasn't been assigned yet:

AskUserQuestion: Which group should `<email>` be assigned to?

- **Group folder name** — Enter the folder name (e.g., `work_consulting`)

AskUserQuestion: What label should the Gmail server use? This becomes the tool prefix — e.g., `consulting` means tools appear as `mcp__gmail_consulting__search_emails`. Suggestion: `<first part of email>`

- **Label name** — A short identifier for this Gmail account

AskUserQuestion: Should incoming emails on `<label>` (`<email>`) automatically trigger the agent in `<group>`?

- **Yes** — Channel mode: new Primary inbox emails are delivered to the group automatically
- **No** — Tool-only: the agent can read/send email when asked, but won't monitor the inbox

If the user chooses channel mode:

1. Add `gmailChannel` config to the group's `.mcp.json`:

```json
{
  "gmailChannel": {
    "<label>": { "enabled": true }
  }
}
```

Merge with existing `.mcp.json` content — don't overwrite.

2. Create or update `~/.multi-gmail-mcp/channel-config.json` with defaults if this account doesn't have an entry yet:

```json
{
  "<label>": {
    "pollInterval": 30,
    "filter": "is:unread category:primary"
  }
}
```

3. Register the channel JID in `registered_groups`:

```bash
sqlite3 store/messages.db "INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, requires_trigger) VALUES ('gm:<label>:<group_folder>', 'Gmail (<label>)', '<group_folder>', '.*', datetime('now'), 0)"
```

4. Add email handling instructions to the group's `CLAUDE.md` (before the formatting section, if any):

```markdown
## Email Notifications

When you receive an email notification (messages starting with `[Email from ...`), inform the user about it but do NOT reply to the email unless specifically asked. You have Gmail tools available — use them only when the user explicitly asks you to reply, forward, or take action on an email.
```

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
sqlite3 store/messages.db "SELECT container_config FROM registered_groups WHERE folder = '<group_folder>'"
```

Update `containerConfig.additionalMounts` to include the Gmail credential mounts. The mounts use `additionalMounts` format where `containerPath` is relative (mounted at `/workspace/extra/<containerPath>`):

```json
{
  "additionalMounts": [
    {
      "hostPath": "~/.multi-gmail-mcp/tokens/<email>.json",
      "containerPath": "gmail/<email>/token.json",
      "readonly": true
    },
    {
      "hostPath": "~/.multi-gmail-mcp/gcp-oauth.keys.json",
      "containerPath": "gmail/gcp-oauth.keys.json",
      "readonly": true
    }
  ]
}
```

Merge with any existing `additionalMounts` — don't overwrite. Write back to SQLite:

```bash
sqlite3 store/messages.db "UPDATE registered_groups SET container_config = '<json>' WHERE folder = '<group_folder>'"
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
sqlite3 store/messages.db "SELECT container_config FROM registered_groups WHERE folder = '<group_folder>'"
```

Verify the mount allowlist includes `~/.multi-gmail-mcp`:

```bash
cat ~/.config/nanoclaw/mount-allowlist.json
```

Verify token file exists on host:

```bash
ls ~/.multi-gmail-mcp/tokens/<email>.json
```

### Mount blocked by security

If logs show "Path matches blocked pattern", check the host path for blocked patterns (`credentials`, `.env`, `.secret`, etc.). The token files are named `<email>.json` to avoid the `credentials` blocked pattern.

### OAuth token expired

Re-authorize:

```bash
npx tsx scripts/gmail-oauth.ts <email>
```

### Adding another account later

Re-run `/add-multi-gmail`. It detects existing setup and skips to account authorization.
