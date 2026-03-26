# Gmail Channel Mode & /manage-gmail — Design Spec

## Overview

Two additions to the `skill/gmail` branch:

1. **Gmail Channel Mode** — A `GmailChannel` class (`src/channels/gmail.ts`) that polls Gmail inboxes and injects incoming emails as messages into NanoClaw groups. One instance per account, with fan-out to multiple groups.
2. **`/manage-gmail` skill** — Post-setup management: associate/disassociate accounts to groups, toggle channel mode, remove accounts.

## Gmail Channel Mode

### Architecture

- **File**: `src/channels/gmail.ts` on `skill/gmail` branch
- **Pattern**: One `GmailChannel` instance per authorized account (label)
- **Registration**: `registerChannel('gmail_{label}', factory)` for each account with at least one group that has channel mode enabled
- **Dependency**: `@googleapis/gmail` npm package (lightweight, Gmail-only — not the full `googleapis` bundle)
- **MCP tools**: Unchanged — agent-side tools via `@gongrzhe/server-gmail-autoauth-mcp` remain separate

### Discovery & Startup

The `gmail.ts` module, on import:

1. Scans `~/.gmail-mcp/tokens/` for authorized accounts (each file is `{email}.json`)
2. For each account, scans group `.mcp.json` files to find entries with `gmailChannel.{label}.enabled = true`
3. Reads account-level polling config from `~/.gmail-mcp/channel-config.json`
4. Calls `registerChannel('gmail_{label}', factory)` for each account that has at least one group with channel mode enabled
5. Factory returns `null` if token is missing or no groups have channel mode enabled

### JID Format

```
gm:{label}:{group_folder}
```

Example: `gm:consulting:work_consulting`

The JID identifies the account + group combination, consistent with how other channels work (one JID per group, many messages within it). Thread IDs are stored as message-level metadata, not in the JID.

- `ownsJid`: each GmailChannel instance checks for `gm:{its_label}:` prefix — no collision between accounts
- Group routing: `registered_groups` maps the JID directly to the group folder (exact match, no prefix matching needed)
- Outbound: channel parses JID to extract label (which account to send from). Thread ID for replies is retrieved from stored message metadata.

### Inbound Flow

1. `connect()` starts a polling loop using the interval from `~/.gmail-mcp/channel-config.json` (default: 30 seconds)
2. Polls Gmail API: `users.messages.list` with the account's configured filter (default: `is:unread category:primary`), limited to 10 messages per poll cycle to stay within API quotas
3. Fetches new emails with `users.messages.get`
4. For each new email, looks up which groups have channel mode enabled for this account
5. Calls `onMessage` once per group with JID `gm:{label}:{group_folder}`. The message ID includes the Gmail thread ID for deduplication and reply threading.
6. Calls `onChatMetadata` with the email subject as the chat name, so the orchestrator can track Gmail threads
7. Marks email as read after all groups have been notified
8. Message content formatted as: `[Email from sender@example.com] Subject: {subject}\n\n{body}`

**Fan-out behavior**: When the same account is enabled for channel mode in multiple groups, the same email is stored once per group (different JIDs) and each group's agent processes independently. This is intentional — each group may have different context, memory, and instructions.

**First connect**: On initial connection, only emails received after the channel starts are processed. Historical unread emails are not backfilled to avoid flooding groups.

### Email Metadata Storage

The channel stores email metadata needed for outbound replies alongside each inbound message. The message ID encodes the Gmail thread ID (e.g., `gm:{gmail_message_id}`). The channel maintains an in-memory map of recent thread metadata:

```typescript
Map<threadId, { from: string, subject: string, messageId: string, references: string[] }>
```

This metadata is used when `sendMessage` is called to construct a properly threaded reply with correct `To`, `Subject` (prefixed with `Re:`), `In-Reply-To`, and `References` headers.

### Outbound Flow

1. Agent responds in a group
2. `findChannel(channels, 'gm:consulting:work_consulting')` matches the GmailChannel for `consulting`
3. Channel looks up the most recent thread metadata for this group to determine reply-to address, subject, and threading headers
4. Sends reply as plain text via Gmail API using the account's OAuth token
5. Reply is threaded into the original conversation

### Config Storage

**Per-group** — in `groups/{name}/.mcp.json`:

```json
{
  "mcpServers": {
    "gmail_consulting": {
      "command": "npx",
      "args": ["-y", "@gongrzhe/server-gmail-autoauth-mcp"],
      "env": {
        "GMAIL_CREDENTIALS_PATH": "/workspace/extra/gmail/user@gmail.com/token.json",
        "GMAIL_OAUTH_PATH": "/workspace/extra/gmail/gcp-oauth.keys.json"
      }
    }
  },
  "gmailChannel": {
    "consulting": { "enabled": true }
  }
}
```

`gmailChannel` is optional. Absent or `"enabled": false` = tool-only mode.

**Per-account** — in `~/.gmail-mcp/channel-config.json`:

```json
{
  "consulting": {
    "pollInterval": 30,
    "filter": "is:unread category:primary"
  }
}
```

Created with defaults when the first group enables channel mode for an account. Shared by all groups using that account — polling is an account-level concern.

### Group Registration for Channel Mode

When `/add-gmail` enables channel mode for a group, it registers the JID `gm:{label}:{group_folder}` in `registered_groups`. This is a separate entry from any existing channel JID the group may have (e.g., a WhatsApp JID). A group can have multiple JIDs across different channels — the orchestrator processes each independently.

The `RegisteredGroup` fields for a Gmail channel registration:

- `name`: `"Gmail ({label})"` (e.g., `"Gmail (consulting)"`)
- `folder`: the group folder (e.g., `"work_consulting"`)
- `trigger`: `".*"` (match all — emails are pre-filtered by the Gmail API query)
- `requiresTrigger`: `false` (emails auto-deliver, no trigger word needed)

### Error Handling

- **Token expired during polling**: Log warning, skip cycle. OAuth2 client auto-refreshes the token on the next cycle.
- **Gmail API rate limit**: Exponential backoff, log warning. Per-cycle message limit (10) prevents quota exhaustion.
- **Group removed while channel active**: Channel checks `registeredGroups()` on each poll, stops delivering to unregistered groups.
- **Account token deleted**: Channel detects missing token file, stops polling, logs error.

### Changes to `/add-gmail` Skill

Phase 3 (Assign Accounts to Groups) adds a question after label assignment:

```
AskUserQuestion: Should incoming emails on `consulting` (`user@gmail.com`)
automatically trigger the agent in `work_consulting`?

- **Yes** — Channel mode: new Primary inbox emails are delivered to the group automatically
- **No** — Tool-only: the agent can read/send email when asked, but won't monitor the inbox
```

If yes:
- Write `gmailChannel.{label}.enabled = true` into the group's `.mcp.json`
- Create `~/.gmail-mcp/channel-config.json` with defaults if it doesn't exist
- Register the channel JID `gm:{label}:{group_folder}` in `registered_groups`

Phase 4 (Build and Restart) already rebuilds and restarts, which picks up the new channel registration.

### Dependencies

- `@googleapis/gmail` npm package added to `package.json`
- `src/channels/gmail.ts` — new file
- `src/channels/gmail.test.ts` — unit tests
- `src/channels/index.ts` — add `import './gmail.js'`

## `/manage-gmail` Skill

Replaces the earlier `/remove-gmail` spec. A skill-only implementation (SKILL.md instructions, no new scripts).

### Phase 1: Account & Group Summary

On invocation, gather state from:

1. `ls ~/.gmail-mcp/tokens/` — authorized accounts
2. Read each group's `.mcp.json` — find `gmail_*` server entries and `gmailChannel` config. Extract email from `GMAIL_CREDENTIALS_PATH` by parsing the path segment between `gmail/` and `/token.json`. The key name minus `gmail_` prefix is the label.
3. `sqlite3 store/messages.db "SELECT folder, container_config FROM registered_groups"` — cross-reference mounts
4. `cat ~/.gmail-mcp/channel-config.json` — account-level polling config

Present a summary table:

```
Label        Account              Group(s)                          Mode
consulting   user@gmail.com       work_consulting                   channel
                                  personal                          tool-only
client       client@gmail.com     (not assigned)                    —
```

If a `.mcp.json` references a token that doesn't exist on disk, flag it as `(token missing)`.

If no tokens exist and no `.mcp.json` Gmail entries exist: "No Gmail accounts are configured. Use `/add-gmail` to add one."

### Phase 2: Choose Operation

```
AskUserQuestion: What would you like to do?

- **Associate** — Add an existing account to a group
- **Disassociate** — Remove an account from a group (keeps the account)
- **Toggle channel mode** — Enable or disable inbox polling for an account in a group
- **Remove account** — Delete an account entirely (removes token, disassociates from all groups)
```

### Phase 3a: Associate Flow

1. AskUserQuestion listing unassigned account-group combinations — which to associate?
2. Follow the same steps as `/add-gmail` Phase 3 (create `.mcp.json` entry, add `additionalMounts` to SQLite)
3. Ask whether to enable channel mode for this association
4. If channel mode enabled, requires restart: "This requires restarting NanoClaw, which will interrupt any active agents or channels."
5. If tool-only, no restart needed — takes effect on next agent invocation

### Phase 3b: Disassociate Flow

1. AskUserQuestion listing account-group pairs — which to disassociate?
2. Check if this account-group pair has channel mode enabled.
3. If channel mode enabled: "This will remove `{label}` (`{email}`) from `{group}` and disable its channel mode. `{label}` stays authorized and can be re-assigned later with `/add-gmail`. This requires restarting NanoClaw, which will interrupt any active agents or channels."
4. If tool-only: "This will remove `{label}` (`{email}`) from `{group}`. `{label}` stays authorized and can be re-assigned later with `/add-gmail`. This change takes effect on the next agent invocation for that group."
5. On confirm:
   - Remove `gmail_{label}` entry from `groups/{name}/.mcp.json`. If it was the only entry in `mcpServers`, leave as `{"mcpServers": {}}`.
   - Remove `gmailChannel.{label}` entry from `.mcp.json` if present.
   - Remove matching `additionalMounts` entry (match on `containerPath` containing `gmail/{email}/token.json`). After removing, check if any other `gmail_*` servers remain; if none, also remove the `gcp-oauth.keys.json` mount.
   - If channel mode was enabled, remove the channel JID from `registered_groups`.
   - Write updated `container_config` back to SQLite.
   - If channel mode was enabled, rebuild and restart. Otherwise no restart needed.

### Phase 3c: Toggle Channel Mode

1. AskUserQuestion listing account-group pairs with current mode — which to toggle?
2. If enabling: "This will enable channel mode for `{label}` (`{email}`) in `{group}`. New Primary inbox emails will be delivered to the group automatically. This requires restarting NanoClaw, which will interrupt any active agents or channels."
3. If disabling: "This will disable channel mode for `{label}` (`{email}`) in `{group}`. The agent can still read/send email when asked. This requires restarting NanoClaw, which will interrupt any active agents or channels."
4. On confirm:
   - Update `gmailChannel.{label}.enabled` in `groups/{name}/.mcp.json`
   - If enabling and `~/.gmail-mcp/channel-config.json` doesn't have this account, create entry with defaults
   - If enabling, register channel JID in `registered_groups`
   - If disabling, remove channel JID from `registered_groups`
   - Rebuild and restart (channel registration changes require restart)

### Phase 3d: Remove Account

1. AskUserQuestion listing accounts by label — which to remove?
2. Look up all groups associated with that account.
3. Confirm: "This will remove `{label}` (`{email}`) and disassociate it from these groups: `{list}`. This requires restarting NanoClaw, which will interrupt any active agents or channels. You can easily re-add this account later with `/add-gmail`."
4. On confirm:
   - Run disassociate (Phase 3b) for each associated group
   - Delete `~/.gmail-mcp/tokens/{email}.json`
   - Remove account entry from `~/.gmail-mcp/channel-config.json` if present
   - Rebuild and restart

### Phase 4: Repeat or Exit

After any operation, show updated summary table and:

```
AskUserQuestion: What would you like to do next?

- **Associate** — Add an existing account to a group
- **Disassociate** — Remove an account from a group
- **Toggle channel mode** — Enable or disable inbox polling
- **Remove account** — Delete an account entirely
- **Done** — Exit
```

## Skill Surface Summary

| Skill | Purpose |
|-------|---------|
| `/add-gmail` | Setup + add accounts: GCP OAuth, authorize, assign to groups, set channel mode |
| `/manage-gmail` | Ongoing ops: associate/disassociate, toggle channel, remove account |
| `/debug` | Existing skill, covers Gmail troubleshooting |

## Implementation Notes

- Channel code (`src/channels/gmail.ts`) is a source code change on the `skill/gmail` branch
- `/manage-gmail` is skill-only (SKILL.md instructions, no new scripts)
- `/add-gmail` SKILL.md needs updates for the channel mode question
- All user prompts use `AskUserQuestion` with structured options
- Database path: `store/messages.db`
- The earlier `/remove-gmail` spec (`2026-03-26-remove-gmail-multi-design.md`) is superseded by the `/manage-gmail` section of this spec
