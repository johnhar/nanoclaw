# Gmail Integration

## Overview

NanoClaw's Gmail integration gives agent groups access to Gmail via MCP tools. Each group can have one or more Gmail accounts assigned to it, and the same account can be shared across multiple groups.

There are two modes:

- **Tool-only** — The agent can read, search, and send email when asked. No inbox monitoring.
- **Channel mode** — `GmailChannel` polls the inbox on an interval and delivers new messages to the group automatically. The agent can also reply.

Setup and ongoing management are handled by three skills: `/add-multi-gmail` (initial setup), `/manage-multi-gmail` (ongoing operations), and `/convert-gmail` (migrating from the old single-account integration).

## Benefits

- **Multi-account support** — A group can have multiple Gmail accounts (each with its own label and MCP server entry). Accounts can be shared across groups.
- **No secret leakage between groups** — Each container only receives the token (mounts) for its own group. Other groups' credentials are never injected.
- **Flexible assignment** — Accounts can be associated, disassociated, and re-assigned at any time without re-authorizing.
- **Channel mode** — Groups that need proactive email delivery (e.g., a work inbox that should route support threads to an agent) can enable inbox polling without any additional infrastructure.

## Comparing With Previous Gmail Skill

The upstream `/add-gmail` skill supported a single Gmail account with credentials and MCP server hardcoded into the container runner. Our version replaces it entirely:

| | Previous | Current |
|---|---|---|
| Accounts | Single account (`credentials.json`) | Multiple accounts, each with a label |
| Credential isolation | Single credential mounted to all containers | Per-group mounts via `additionalMounts` — each container only sees its own tokens |
| Channel code | Merged from a separate repo (`nanoclaw-gmail.git`) | Part of the `skill/gmail` branch |
| Channel mode | All-or-nothing, chosen at setup time | Toggleable per account-per-group via `/manage-multi-gmail` |
| Dependency | `googleapis` (full Google API bundle) | `@googleapis/gmail` (Gmail-only, lightweight) |
| Management | Manual file/config edits to change anything | `/manage-multi-gmail` skill for associate, disassociate, toggle, remove |
| MCP server config | Hardcoded in agent-runner source | Per-group `.mcp.json` files, automatically added by the skills |

**What stayed the same:** GCP OAuth setup flow, `@gongrzhe/server-gmail-autoauth-mcp` as the MCP server, the basic channel architecture (polling, fan-out, threaded replies), and the two-mode concept (tool-only vs channel).

## User Experience

### `/add-multi-gmail` — Initial setup

1. **GCP OAuth setup** — If this is the first Gmail account, the skill walks you through creating a Google Cloud project, enabling the Gmail API, and downloading OAuth credentials.
Then, steps 2 - 4 are repeated for each email you want to add:
2. **Account authorization** — Opens Google's consent screen in your browser. Sign in and grant access. 
3. **Group assignment** — Pick which group(s) the account belongs to and give it a short label (e.g., `consulting`). The label identifies the account in tools and logs.
4. **Channel mode** — Choose whether the account should just provide email tools (tool-only) or also monitor the inbox and deliver new emails to the group automatically (channel mode).  This is selectable per account-group pair.
5. **Build and restart** — NanoClaw rebuilds and restarts to pick up the new configuration.

### `/manage-multi-gmail` — Ongoing operations

Shows a summary table of all authorized accounts, their group assignments, and current mode (tool-only or channel). From there you can:

- **Associate** — Add an existing account to another group.
- **Disassociate** — Remove an account from a group without deleting it.
- **Toggle channel mode** — Switch between tool-only and channel mode for any account-group pair.
- **Remove account** — Delete an account entirely and disassociate it from all groups.

Operations that change channel registration require a restart (the skill warns you). Tool-only changes take effect on the next agent invocation.

### Troubleshooting

If something isn't working — Gmail tools not loading, credentials not found, emails not being detected — use `/debug` to diagnose the issue.

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
      "hostPath": "data/gmail/tokens/{email}.json",
      "containerPath": "gmail/{email}/token.json",
      "readonly": true
    },
    {
      "hostPath": "data/gmail/gcp-oauth.keys.json",
      "containerPath": "gmail/gcp-oauth.keys.json",
      "readonly": true
    }
  ]
}
```

`containerPath` values are relative and are mounted at `/workspace/extra/<containerPath>` inside the container — matching what `.mcp.json` references. The mount system validates all host paths against `~/.config/nanoclaw/mount-allowlist.json` before mounting.

### `GmailChannel` — inbox polling

`GmailChannel` (`src/channels/multi-gmail.ts`) implements the `Channel` interface and handles inbox polling for a single Gmail account. Key behaviors:

- **One instance per account, not per group** — A single `GmailChannel` fans out new messages to all groups that have channel mode enabled for that account.
- **Poll loop** — `setInterval` at `pollInterval` seconds (default: 30). Fetches messages matching `filter` (default: `is:unread category:primary`), processes new ones, marks them read.
- **Dedup** — In-memory set of processed Gmail message IDs, capped at 500 entries.
- **Startup skip** — Emails received before the channel connected are marked read and skipped, preventing a flood on first start.
- **Rate limit backoff** — On HTTP 429, doubles the poll interval for 60 seconds then resets.
- **Outbound replies** — `sendMessage(jid, text)` sends a properly threaded reply using `In-Reply-To` and `References` headers, based on per-group thread metadata stored during polling.
- **OAuth token refresh** — The `googleapis` client emits `tokens` events when credentials are refreshed; the channel writes the updated tokens back to disk.

### Self-registration

`src/channels/multi-gmail.ts` calls `discoverGmailAccounts()` at module load time, then calls `registerChannel('gmail_{label}', factory)` for each discovered account. This follows the same self-registration pattern as other channels (WhatsApp, Telegram, etc.). The channel is imported via `src/channels/index.ts`.

## Data Model

| Location | Contents |
|---|---|
| `data/gmail/gcp-oauth.keys.json` | GCP OAuth app credentials (client ID + secret) |
| `data/gmail/tokens/{email}.json` | Per-account OAuth token (access + refresh) |
| `data/gmail/channel-config.json` | Per-account polling config (`pollInterval`, `filter`) |
| `groups/{name}/.mcp.json` | MCP server entries (`mcpServers`) + channel mode config (`gmailChannel`) |
| `store/messages.db` — `registered_groups` | `container_config` column holds `additionalMounts`; channel-mode rows have JID `gm:{label}:{group_folder}` |

### `registered_groups` rows

Each group has one row with `folder` as the primary identifier. For channel mode, there is an additional row per account:

- **Group row** — `jid` is the messaging channel JID (e.g., WhatsApp group ID). `container_config` holds `additionalMounts` for all Gmail accounts assigned to that group.
- **Gmail channel row** — `jid` = `gm:{label}:{group_folder}`, `folder` = `{group_folder}`, `trigger_pattern` = `.*`, `requires_trigger` = `0`. This tells the orchestrator to route inbound Gmail messages to the group's agent without a trigger prefix.

## Migrating From the Old Gmail Integration

If you previously set up Gmail using the old `/add-gmail` skill (which merged code from the `nanoclaw-gmail` remote), use `/convert-gmail` to migrate to the new multi-account system.

### What `/convert-gmail` does

1. **Detects** old artifacts — hardcoded Gmail mount in `container-runner.ts`, Gmail MCP server in `agent-runner`, `credentials.json`, `googleapis` dependency, `gmail` git remote
2. **Preserves** your GCP OAuth credentials by renaming `credentials.json` to `gcp-oauth.keys.json`
3. **Removes** old hardcoded changes from `container-runner.ts` and `agent-runner/src/index.ts`
4. **Cleans up** the `googleapis` dependency, email handling instructions in group `CLAUDE.md` files, the `gmail` git remote, and stale agent-runner caches
5. **Hands off** to `/add-multi-gmail`, which detects the preserved GCP credentials and skips straight to account authorization

### What you'll need to do

- Re-authorize via browser OAuth (~30 seconds) — the old system managed tokens internally; the new system stores per-account tokens at `data/gmail/tokens/{email}.json`
- Choose which groups to associate the account with and whether to enable channel mode

### Why not just re-run `/add-multi-gmail`?

The old skill hardcoded Gmail support into `container-runner.ts` and `agent-runner/src/index.ts`. The new system doesn't use either file. If you skip `/convert-gmail`, those stale hardcoded entries remain and may conflict with the per-group MCP approach.

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

1. Write the token to `data/gmail/tokens/{email}.json`.
2. Add the MCP server entry to `groups/{name}/.mcp.json`.
3. Add `gmailChannel.{label}.enabled = true` to `groups/{name}/.mcp.json`.
4. Add the credential mounts to `container_config` in `registered_groups`.
5. Insert the channel JID row into `registered_groups`.
6. Rebuild and restart.

### Possible Future Enhancements

- **Custom poll filter** — Set `filter` in `data/gmail/channel-config.json` for the account label (e.g., `is:unread label:support` to only process support-labeled threads).
- **Custom poll interval** — Set `pollInterval` (seconds) in the same config file.
