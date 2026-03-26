---
name: manage-gmail
description: Manage Gmail accounts in NanoClaw — associate accounts with groups, disassociate them, toggle channel mode (inbox polling), or remove accounts entirely. Shows a summary of all configured accounts, their group assignments, and current mode.
---

# Manage Gmail Accounts

This skill manages Gmail accounts that have already been set up with `/add-gmail`. It lets you associate/disassociate accounts with groups, toggle channel mode, and remove accounts.

## Phase 1: Account & Group Summary

### Gather state

```bash
ls ~/.gmail-mcp/tokens/ 2>/dev/null || echo "NO_TOKENS"
```

```bash
for group in groups/*/; do
  name=$(basename "$group")
  [ "$name" = "global" ] && continue
  if [ -f "$group/.mcp.json" ]; then
    echo "=== $name ==="
    cat "$group/.mcp.json"
  fi
done
```

```bash
sqlite3 store/messages.db "SELECT folder, container_config FROM registered_groups"
```

```bash
cat ~/.gmail-mcp/channel-config.json 2>/dev/null || echo "NO_CHANNEL_CONFIG"
```

### Parse and present

From the gathered data, build a summary table:

- **Tokens:** Each file in `~/.gmail-mcp/tokens/` is `{email}.json` — these are authorized accounts.
- **MCP entries:** In each group's `.mcp.json`, keys matching `gmail_*` in `mcpServers` are Gmail servers. The label is the key minus the `gmail_` prefix. The email is extracted from `GMAIL_CREDENTIALS_PATH` — the segment between `gmail/` and `/token.json`.
- **Mode:** If `gmailChannel.{label}.enabled` is `true` in the group's `.mcp.json`, mode is `channel`. If the `gmailChannel.{label}` entry exists but `enabled` is `false`, mode is `tool-only`. If there is no `gmailChannel` entry for that label, mode is `tool-only`.
- **Token validation:** If a `.mcp.json` references a token file that doesn't exist in `~/.gmail-mcp/tokens/`, flag it as `(token missing)`.

Present to the user:

```
Label        Account              Group(s)                          Mode
consulting   user@gmail.com       work_consulting                   channel
                                  personal                          tool-only
client       client@gmail.com     (not assigned)                    —
```

Accounts that have tokens but no `.mcp.json` entries show as `(not assigned)` with mode `—`.

If no tokens exist and no `.mcp.json` Gmail entries exist, tell the user: "No Gmail accounts are configured. Use `/add-gmail` to add one." and stop.

## Phase 2: Choose Operation

AskUserQuestion: What would you like to do?

- **Associate** — Add an existing account to a group
- **Disassociate** — Remove an account from a group (keeps the account)
- **Toggle channel mode** — Enable or disable inbox polling for an account in a group
- **Remove account** — Delete an account entirely (removes token, disassociates from all groups)

## Phase 3a: Associate Flow

### Pick account and group

List all unassigned account-group combinations (accounts not yet configured in a given group's `.mcp.json`).

AskUserQuestion: Which account-group combination should be associated?

- List each unassigned combination as a bold option, e.g.:
- **`consulting` (`user@gmail.com`) -> `work_consulting`** — Associate this account with this group
- **`consulting` (`user@gmail.com`) -> `personal`** — Associate this account with this group

### Configure the association

Follow the same steps as `/add-gmail` Phase 3:

#### Step 1: Create `.mcp.json` entry

For the chosen group, create or update `groups/{name}/.mcp.json`. If the file already exists, merge the new server entry into the existing `mcpServers` object:

```json
{
  "mcpServers": {
    "gmail_{label}": {
      "command": "npx",
      "args": ["-y", "@gongrzhe/server-gmail-autoauth-mcp"],
      "env": {
        "GMAIL_CREDENTIALS_PATH": "/workspace/extra/gmail/{email}/token.json",
        "GMAIL_OAUTH_PATH": "/workspace/extra/gmail/gcp-oauth.keys.json"
      }
    }
  }
}
```

#### Step 2: Add credential mounts via containerConfig

Read the group's current config from SQLite:

```bash
sqlite3 store/messages.db "SELECT container_config FROM registered_groups WHERE folder = '{group_folder}'"
```

Update `containerConfig.additionalMounts` to include the Gmail credential mounts. Merge with any existing `additionalMounts` — don't overwrite:

```json
{
  "additionalMounts": [
    {
      "hostPath": "~/.gmail-mcp/tokens/{email}.json",
      "containerPath": "gmail/{email}/token.json",
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

If the `gcp-oauth.keys.json` mount already exists from another Gmail account, don't add a duplicate.

Write back to SQLite:

```bash
sqlite3 store/messages.db "UPDATE registered_groups SET container_config = '{json}' WHERE folder = '{group_folder}'"
```

### Ask about channel mode

AskUserQuestion: Should inbox polling (channel mode) be enabled for `{label}` (`{email}`) in `{group}`?

- **Yes — enable channel mode** — New Primary inbox emails will be delivered to the group automatically
- **No — tool-only** — The agent can read/send email when asked, but won't poll for new messages

If channel mode enabled:

1. Add or update `gmailChannel.{label}` in the group's `.mcp.json`:

   ```json
   {
     "gmailChannel": {
       "{label}": { "enabled": true }
     }
   }
   ```

2. If `~/.gmail-mcp/channel-config.json` doesn't have an entry for this account, create one with defaults.

3. Register the channel JID (`gm:{label}:{group_folder}`) in the `registered_groups` table.

4. Warn before restart: "This requires restarting NanoClaw, which will interrupt any active agents or channels."

5. Rebuild and restart:

   ```bash
   rm -r data/sessions/*/agent-runner-src 2>/dev/null || true
   ./container/build.sh
   npm run build
   launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
   # Linux: systemctl --user restart nanoclaw
   ```

If tool-only, no restart needed — tell the user: "Association complete. This takes effect on the next agent invocation for `{group}`."

## Phase 3b: Disassociate Flow

### Pick account-group pair

List all currently associated account-group pairs.

AskUserQuestion: Which account-group pair should be disassociated?

- List each association as a bold option, e.g.:
- **`consulting` (`user@gmail.com`) from `work_consulting`** — Currently in channel mode
- **`consulting` (`user@gmail.com`) from `personal`** — Currently in tool-only mode

### Confirm

Check if this account-group pair has channel mode enabled.

If channel mode enabled, tell the user: "This will remove `{label}` (`{email}`) from `{group}` and disable its channel mode. `{label}` stays authorized and can be re-assigned later with `/add-gmail`. This requires restarting NanoClaw, which will interrupt any active agents or channels."

If tool-only, tell the user: "This will remove `{label}` (`{email}`) from `{group}`. `{label}` stays authorized and can be re-assigned later with `/add-gmail`. This change takes effect on the next agent invocation for that group."

AskUserQuestion: Proceed with disassociation?

- **Yes** — Confirm disassociation
- **No** — Cancel and return to operation menu

### Execute disassociation

On confirm:

1. Remove `gmail_{label}` entry from `groups/{name}/.mcp.json` `mcpServers`. If it was the only entry in `mcpServers`, leave as `{"mcpServers": {}}`.

2. Remove `gmailChannel.{label}` entry from `.mcp.json` if present. If `gmailChannel` is now empty, remove the `gmailChannel` key entirely.

3. Remove matching `additionalMounts` entry from `container_config` in SQLite (match on `containerPath` containing `gmail/{email}/token.json`). After removing, check if any other `gmail_*` servers remain in the group's `.mcp.json`; if none, also remove the `gcp-oauth.keys.json` mount.

4. If channel mode was enabled, remove the channel JID (`gm:{label}:{group_folder}`) from `registered_groups`.

5. Write updated `container_config` back to SQLite:

   ```bash
   sqlite3 store/messages.db "UPDATE registered_groups SET container_config = '{json}' WHERE folder = '{group_folder}'"
   ```

6. If channel mode was enabled, rebuild and restart:

   ```bash
   rm -r data/sessions/*/agent-runner-src 2>/dev/null || true
   ./container/build.sh
   npm run build
   launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
   # Linux: systemctl --user restart nanoclaw
   ```

   If tool-only, no restart needed.

## Phase 3c: Toggle Channel Mode

### Pick account-group pair

List all currently associated account-group pairs with their current mode.

AskUserQuestion: Which account-group pair should have its channel mode toggled?

- List each association as a bold option showing current mode, e.g.:
- **`consulting` (`user@gmail.com`) in `work_consulting`** — Currently: channel -> will switch to tool-only
- **`consulting` (`user@gmail.com`) in `personal`** — Currently: tool-only -> will switch to channel

### Confirm

If enabling channel mode, tell the user: "This will enable channel mode for `{label}` (`{email}`) in `{group}`. New Primary inbox emails will be delivered to the group automatically. This requires restarting NanoClaw, which will interrupt any active agents or channels."

If disabling channel mode, tell the user: "This will disable channel mode for `{label}` (`{email}`) in `{group}`. The agent can still read/send email when asked. This requires restarting NanoClaw, which will interrupt any active agents or channels."

AskUserQuestion: Proceed with toggle?

- **Yes** — Confirm toggle
- **No** — Cancel and return to operation menu

### Execute toggle

On confirm:

1. Update `gmailChannel.{label}.enabled` in `groups/{name}/.mcp.json` to the new value (`true` or `false`).

2. If enabling and `~/.gmail-mcp/channel-config.json` doesn't have an entry for this account, create one with defaults.

3. If enabling, register the channel JID (`gm:{label}:{group_folder}`) in `registered_groups`.

4. If disabling, remove the channel JID (`gm:{label}:{group_folder}`) from `registered_groups`.

5. Rebuild and restart (channel registration changes always require restart):

   ```bash
   rm -r data/sessions/*/agent-runner-src 2>/dev/null || true
   ./container/build.sh
   npm run build
   launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
   # Linux: systemctl --user restart nanoclaw
   ```

## Phase 3d: Remove Account

### Pick account

List all authorized accounts by label.

AskUserQuestion: Which account should be removed entirely?

- List each account as a bold option, e.g.:
- **`consulting` (`user@gmail.com`)** — Associated with: work_consulting, personal
- **`client` (`client@gmail.com`)** — Not associated with any groups

### Confirm

Look up all groups associated with the selected account.

Tell the user: "This will remove `{label}` (`{email}`) and disassociate it from these groups: `{list}`. This requires restarting NanoClaw, which will interrupt any active agents or channels. You can easily re-add this account later with `/add-gmail`."

If the account is not associated with any groups: "This will remove `{label}` (`{email}`) and delete its token. You can easily re-add this account later with `/add-gmail`."

AskUserQuestion: Proceed with account removal?

- **Yes** — Confirm removal
- **No** — Cancel and return to operation menu

### Execute removal

On confirm:

1. Run the disassociate flow (Phase 3b) for each group associated with this account. Skip individual confirmations — the user already confirmed the full removal.

2. Delete the token file:

   ```bash
   rm ~/.gmail-mcp/tokens/{email}.json
   ```

3. Remove the account entry from `~/.gmail-mcp/channel-config.json` if present.

4. Rebuild and restart:

   ```bash
   rm -r data/sessions/*/agent-runner-src 2>/dev/null || true
   ./container/build.sh
   npm run build
   launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
   # Linux: systemctl --user restart nanoclaw
   ```

## Phase 4: Repeat or Exit

After any operation completes, re-run the Phase 1 summary scan and present the updated table.

AskUserQuestion: What would you like to do next?

- **Associate** — Add an existing account to a group
- **Disassociate** — Remove an account from a group
- **Toggle channel mode** — Enable or disable inbox polling
- **Remove account** — Delete an account entirely
- **Done** — Exit

If the user picks an operation, go to the corresponding Phase 3 section. If **Done**, exit.

## Troubleshooting

For container, MCP, or channel issues, use the `/debug` skill.

Common issues:

- **Token missing:** If the summary table shows `(token missing)`, re-authorize the account with `/add-gmail`.
- **Channel mode not taking effect:** Channel registration changes require a restart. Make sure the rebuild and restart completed successfully.
- **Mount errors:** Check that `~/.gmail-mcp` is in the mount allowlist at `~/.config/nanoclaw/mount-allowlist.json`.
