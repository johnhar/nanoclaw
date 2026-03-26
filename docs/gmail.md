# Gmail Integration

## Overview

NanoClaw's Gmail integration gives agent groups access to Gmail via MCP tools. Each group can have one or more Gmail accounts assigned to it, and the same account can be shared across multiple groups.

There are two modes:

- **Tool-only** — The agent can read, search, and send email when asked. No inbox monitoring.
- **Channel mode** — `GmailChannel` polls the inbox on an interval and delivers new messages to the group automatically. The agent can also reply.

Setup and ongoing management are handled by two skills: `/add-gmail` and `/manage-gmail`.

## Benefits

- **No secret leakage between groups** — Each container only receives the token mounts for its own group. Other groups' credentials are never injected.
- **Multi-account support** — A group can have multiple Gmail accounts (each with its own label and MCP server entry). Accounts can be shared across groups.
- **Flexible assignment** — Accounts can be associated, disassociated, and re-assigned at any time without re-authorizing.
- **Channel mode** — Groups that need proactive email delivery (e.g., a work inbox that should route support threads to an agent) can enable inbox polling without any additional infrastructure.

## User Experience

### `/add-gmail` — Initial setup

1. **GCP OAuth setup** — If no OAuth credentials exist, the skill walks through creating a GCP project, enabling the Gmail API, and downloading the OAuth client JSON. The file is saved to `~/.gmail-mcp/gcp-oauth.keys.json`.
2. **Account authorization** — Runs `npx tsx scripts/gmail-oauth.ts <email>`, which opens Google's consent screen and waits for the OAuth callback. The token is saved to `~/.gmail-mcp/tokens/<email>.json`. Additional accounts can be added in the same session.
3. **Group assignment** — For each account, the user picks a group folder and a short label (e.g., `consulting`). The label becomes the MCP server name (`gmail_consulting`) and the tool prefix (`mcp__gmail_consulting__*`).
4. **Channel mode** — Optionally enable inbox polling for the account in that group. This registers a channel JID (`gm:<label>:<group_folder>`) and adds `gmailChannel` config to the group's `.mcp.json`.
5. **Build and restart** — Rebuilds the container and restarts NanoClaw.

### `/manage-gmail` — Ongoing operations

Shows a summary table of all authorized accounts, their group assignments, and current mode. Provides four operations:

- **Associate** — Add an existing account to a group (with optional channel mode).
- **Disassociate** — Remove an account from a group. The token is kept; the account can be re-assigned later.
- **Toggle channel mode** — Switch an account-group pair between tool-only and channel mode.
- **Remove account** — Delete the token and disassociate from all groups.

Changes that affect channel registration require a restart. Tool-only association changes take effect on the next agent invocation.

## Architecture

### MCP-based tool access

Each Gmail account is exposed inside a container as an MCP server running `@gongrzhe/server-gmail-autoauth-mcp`. The server is configured in the group's `groups/{name}/.mcp.json`:

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

The Claude Code SDK reads `.mcp.json` when spawning an agent and starts the MCP servers automatically.

### Credential isolation via `additionalMounts`

Credentials are never passed directly to containers. Instead, `containerConfig.additionalMounts` in the `registered_groups` SQLite row lists the specific token files to mount:

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

`containerPath` values are relative and are mounted at `/workspace/extra/<containerPath>` inside the container — matching what `.mcp.json` references. The mount system validates all host paths against `~/.config/nanoclaw/mount-allowlist.json` before mounting.

### `GmailChannel` — inbox polling

`GmailChannel` (`src/channels/gmail.ts`) implements the `Channel` interface and handles inbox polling for a single Gmail account. Key behaviors:

- **One instance per account, not per group** — A single `GmailChannel` fans out new messages to all groups that have channel mode enabled for that account.
- **Poll loop** — `setInterval` at `pollInterval` seconds (default: 30). Fetches messages matching `filter` (default: `is:unread category:primary`), processes new ones, marks them read.
- **Dedup** — In-memory set of processed Gmail message IDs, capped at 500 entries.
- **Startup skip** — Emails received before the channel connected are marked read and skipped, preventing a flood on first start.
- **Rate limit backoff** — On HTTP 429, doubles the poll interval for 60 seconds then resets.
- **Outbound replies** — `sendMessage(jid, text)` sends a properly threaded reply using `In-Reply-To` and `References` headers, based on per-group thread metadata stored during polling.
- **OAuth token refresh** — The `googleapis` client emits `tokens` events when credentials are refreshed; the channel writes the updated tokens back to disk.

### Self-registration

`src/channels/gmail.ts` calls `discoverGmailAccounts()` at module load time, then calls `registerChannel('gmail_{label}', factory)` for each discovered account. This follows the same self-registration pattern as other channels (WhatsApp, Telegram, etc.). The channel is imported via `src/channels/index.ts`.

## Data Model

| Location | Contents |
|---|---|
| `~/.gmail-mcp/gcp-oauth.keys.json` | GCP OAuth app credentials (client ID + secret) |
| `~/.gmail-mcp/tokens/{email}.json` | Per-account OAuth token (access + refresh) |
| `~/.gmail-mcp/channel-config.json` | Per-account polling config (`pollInterval`, `filter`) |
| `groups/{name}/.mcp.json` | MCP server entries (`mcpServers`) + channel mode config (`gmailChannel`) |
| `store/messages.db` — `registered_groups` | `container_config` column holds `additionalMounts`; channel-mode rows have JID `gm:{label}:{group_folder}` |

### `registered_groups` rows

Each group has one row with `folder` as the primary identifier. For channel mode, there is an additional row per account:

- **Group row** — `jid` is the messaging channel JID (e.g., WhatsApp group ID). `container_config` holds `additionalMounts` for all Gmail accounts assigned to that group.
- **Gmail channel row** — `jid` = `gm:{label}:{group_folder}`, `folder` = `{group_folder}`, `trigger_pattern` = `.*`, `requires_trigger` = `0`. This tells the orchestrator to route inbound Gmail messages to the group's agent without a trigger prefix.

## Developer Guide

### JID format

Gmail channel JIDs follow the pattern `gm:{label}:{group_folder}`:

- `label` — the short identifier chosen during setup (e.g., `consulting`)
- `group_folder` — the group's folder name under `groups/` (e.g., `work_consulting`)

Example: `gm:consulting:work_consulting`

`GmailChannel.ownsJid(jid)` matches JIDs by checking `jid.startsWith('gm:{label}:')`.

### Channel registration

`discoverGmailAccounts(projectRoot)` scans all group `.mcp.json` files for `gmailChannel.{label}.enabled === true`, extracts the email from `GMAIL_CREDENTIALS_PATH`, and returns a `GmailAccountConfig[]`. At module load, one `GmailChannel` is registered per discovered account via `registerChannel('gmail_{label}', factory)`.

To add a new Gmail account programmatically:

1. Write the token to `~/.gmail-mcp/tokens/{email}.json`.
2. Add the MCP server entry to `groups/{name}/.mcp.json`.
3. Add `gmailChannel.{label}.enabled = true` to `groups/{name}/.mcp.json`.
4. Add the credential mounts to `container_config` in `registered_groups`.
5. Insert the channel JID row into `registered_groups`.
6. Rebuild and restart.

### Extending

- **Custom poll filter** — Set `filter` in `~/.gmail-mcp/channel-config.json` for the account label (e.g., `is:unread label:support` to only process support-labeled threads).
- **Custom poll interval** — Set `pollInterval` (seconds) in the same config file.
- **Multiple accounts per group** — Add additional `gmail_{label}` entries to the group's `.mcp.json` and corresponding mounts. Each account gets its own `GmailChannel` instance.
- **New channel types** — Follow the same pattern: implement `Channel`, call `registerChannel` at module load, import from `src/channels/index.ts`.
