# Multi-Account Gmail MCP Server

**Issue:** https://github.com/johnhar/nanoclaw/issues/1
**Date:** 2026-03-25
**Status:** Design

## Problem

NanoClaw needs to process emails across multiple Gmail accounts (personal + multiple work accounts). The current `/add-gmail` skill uses `@gongrzhe/server-gmail-autoauth-mcp`, which is single-account (hardcoded to `~/.gmail-mcp/`) and downloaded via `npx` at runtime. There is no way to give different groups access to different Gmail accounts.

Additionally, NanoClaw has no general mechanism for per-group MCP server configuration — MCP servers are hardcoded in the agent-runner and identical for all groups.

## Goals

1. Support N Gmail accounts, each authorized via OAuth2 against a single GCP project
2. Per-group Gmail access — each group's agent gets only the Gmail account assigned to it
3. Credentials never exposed to the AI agent (only accessible through MCP tool calls)
4. **General-purpose per-group MCP server configuration** — not Gmail-specific; any MCP server can be added to any group via a config file
5. Delivered as a new `/add-gmail-multi` skill; existing `/add-gmail` untouched

## Non-Goals

- Gmail channel mode (inbox polling that triggers agents on new emails) — future work
- Host-side MCP server (like OneCLI) — future work; start with in-container stdio
- Per-group tool restrictions (e.g. read-only for some groups) — future work

## Architecture

### Per-Group MCP Server Configuration (General)

Groups can define additional MCP servers via an optional config file:

```
groups/<name>/mcp-servers.json
```

```json
{
  "gmail_consulting": {
    "command": "npx",
    "args": ["-y", "@gongrzhe/server-gmail-autoauth-mcp"],
    "env": {
      "GMAIL_CREDENTIALS_PATH": "/workspace/gmail/work@consulting.co",
      "GMAIL_OAUTH_PATH": "/workspace/gmail/gcp-oauth.keys.json"
    }
  }
}
```

This is a general-purpose mechanism. Any MCP server can be configured per-group — Gmail, calendar, Notion, etc. The format matches the Claude Code SDK's `mcpServers` config exactly.

**Backward compatible:** If `mcp-servers.json` doesn't exist, the agent-runner uses only the default nanoclaw MCP server, identical to today's behavior.

### Agent-Runner Changes

`container/agent-runner/src/index.ts` currently hardcodes MCP servers. Change to merge in per-group servers:

1. On startup, read `/workspace/group/mcp-servers.json` (if present)
2. Merge entries into the `mcpServers` object alongside the nanoclaw server
3. Add `mcp__<name>__*` to `allowedTools` for each entry

```typescript
const groupMcpPath = '/workspace/group/mcp-servers.json';
let groupMcpServers = {};
if (fs.existsSync(groupMcpPath)) {
  groupMcpServers = JSON.parse(fs.readFileSync(groupMcpPath, 'utf8'));
}

// In query():
mcpServers: {
  nanoclaw: { ... },
  ...groupMcpServers,
},
allowedTools: [
  ...,
  'mcp__nanoclaw__*',
  ...Object.keys(groupMcpServers).map(name => `mcp__${name}__*`),
],
```

Groups without the file behave exactly as today.

### Credential Layout (Gmail-Specific)

```
~/.gmail-mcp/
  gcp-oauth.keys.json              # Shared OAuth2 client_id + client_secret
  tokens/
    personal@gmail.com.json        # { refresh_token, access_token, expiry_date }
    work@consulting.co.json
    work@acme.com.json
```

One GCP project provides the OAuth2 client credentials. Each Gmail account authorizes independently through the consent screen, producing a separate refresh token.

### Gmail MCP Server

Use `@gongrzhe/server-gmail-autoauth-mcp` as-is via `npx`. No fork needed.

The server already supports two env vars that enable multi-account:
- `GMAIL_CREDENTIALS_PATH` — path to the directory containing `credentials.json` (account token)
- `GMAIL_OAUTH_PATH` — path to `gcp-oauth.keys.json` (client credentials)

Token refreshes are handled in-memory by the `googleapis` OAuth2 client — no disk writes during normal operation. The only disk write happens during the one-time OAuth auth flow, which runs on the host during setup.

The server is a stdio MCP server — spawned as a child process by the Claude Code SDK when an agent session starts, communicates over stdin/stdout, dies when the session ends.

Future: may migrate to a custom long-lived multi-account MCP server, which would also eliminate the `npx` startup cost.

**Tools exposed** (~15):

| Tool | Purpose |
|------|---------|
| `send_email` | Send with subject, body, attachments, recipients |
| `read_email` | Read by ID with MIME handling |
| `search_emails` | Search with Gmail query syntax |
| `list_emails` | List by label (inbox, sent, custom) |
| `list_labels` | List all Gmail labels |
| `modify_labels` | Add/remove labels (archive, categorize) |
| `mark_read` | Mark email as read |
| `mark_unread` | Mark email as unread |
| `delete_email` | Delete email |
| `batch_modify` | Bulk label/read operations |

### Container-Runner Changes

`src/container-runner.ts` mounts credentials into the container based on the group's `mcp-servers.json`. For Gmail accounts:

1. Read `groups/<name>/mcp-servers.json`
2. For entries with `GMAIL_CREDENTIALS_PATH` env vars, extract the account email and mount:
   - `~/.gmail-mcp/gcp-oauth.keys.json` → `/workspace/gmail/gcp-oauth.keys.json` (ro)
   - `~/.gmail-mcp/tokens/<email>.json` → `/workspace/gmail/<email>/credentials.json` (ro)

Groups without `mcp-servers.json` get no extra mounts.

### OAuth Setup Flow

The `/add-gmail-multi` skill walks the user through:

1. **GCP project setup** — Create project, enable Gmail API, download OAuth2 client JSON
2. **Store client credentials** — Save to `~/.gmail-mcp/gcp-oauth.keys.json`
3. **Per-account authorization** — For each account:
   - Run auth script that opens browser for OAuth consent
   - User signs into the specific Gmail account
   - Script stores refresh token in `~/.gmail-mcp/tokens/<email>.json`
4. **Assign accounts to groups** — Create `groups/<name>/mcp-servers.json` with Gmail config
5. **Build and restart** — Clear stale agent-runner copies, rebuild container, restart NanoClaw

### Data Flow

```
Scheduled task fires for work_consulting group
  │
  ├─ container-runner reads groups/work_consulting/mcp-servers.json
  │  → finds gmail_consulting entry with GMAIL_CREDENTIALS_PATH
  │
  ├─ Mounts ~/.gmail-mcp/gcp-oauth.keys.json (ro)
  │  Mounts ~/.gmail-mcp/tokens/work@consulting.co.json (ro)
  │  → into /workspace/gmail/
  │
  ├─ Agent container starts
  │  agent-runner reads /workspace/group/mcp-servers.json
  │  → registers gmail_consulting MCP server (stdio, via npx)
  │  → adds mcp__gmail_consulting__* to allowedTools
  │
  ├─ Agent calls mcp__gmail_consulting__search_emails(query: "is:unread")
  │  → MCP server loads credentials from GMAIL_CREDENTIALS_PATH
  │  → Calls Gmail API, returns results
  │
  └─ Agent processes emails, calls more tools as needed
     Container dies when done
```

## Files Changed

| File | Change |
|------|--------|
| `container/agent-runner/src/index.ts` | Read `mcp-servers.json`, merge into mcpServers and allowedTools |
| `src/container-runner.ts` | Parse `mcp-servers.json` to determine credential mounts per group |
| `.claude/skills/add-gmail-multi/SKILL.md` | **New.** Skill for multi-account Gmail setup |
| `scripts/gmail-oauth.ts` | **New.** OAuth authorization script for adding accounts |

## Testing

1. Verify groups without `mcp-servers.json` behave identically to today
2. Set up GCP project with OAuth2 credentials
3. Authorize 2 Gmail accounts (personal + work)
4. Create 2 groups with different `mcp-servers.json` configs
5. Verify each group's agent only sees its assigned account's tools
6. Verify tools work: search, read, send, archive
7. Verify scheduled tasks can process emails autonomously

## Future Work

- **Custom long-lived MCP server** — Replace `@gongrzhe` with a custom multi-account MCP server (single process, `account` parameter per tool call). Eliminates per-session `npx` startup cost and simplifies credential management. Could run host-side like OneCLI for stronger credential isolation.
- **Multi-account channel mode** — Extend `/add-gmail` channel mode to poll multiple inboxes
- **Per-group access control** — Restrict tool operations per group (e.g. read-only)
