# Multi-Account Gmail MCP Server

**Issue:** https://github.com/johnhar/nanoclaw/issues/1
**Date:** 2026-03-25
**Status:** Design

## Problem

NanoClaw needs to process emails across multiple Gmail accounts (personal + multiple work accounts). The current `/add-gmail` skill uses `@gongrzhe/server-gmail-autoauth-mcp`, which is single-account (hardcoded to `~/.gmail-mcp/`) and downloaded via `npx` at runtime. There is no way to give different groups access to different Gmail accounts.

## Goals

1. Support N Gmail accounts, each authorized via OAuth2 against a single GCP project
2. Per-group Gmail access — each group's agent gets only the Gmail account(s) assigned to it
3. Credentials never exposed to the AI agent (only accessible through MCP tool calls)
4. Delivered as a new `/add-gmail-multi` skill; existing `/add-gmail` untouched

## Non-Goals

- Gmail channel mode (inbox polling that triggers agents on new emails) — future work
- Host-side MCP server (like OneCLI) — future work; start with in-container stdio
- Per-group tool restrictions (e.g. read-only for some groups) — future work

## Architecture

### Credential Layout

```
~/.gmail-mcp/
  gcp-oauth.keys.json              # Shared OAuth2 client_id + client_secret
  tokens/
    personal@gmail.com.json        # { refresh_token, access_token, expiry_date }
    work@consulting.co.json
    work@acme.com.json
```

One GCP project provides the OAuth2 client credentials. Each Gmail account authorizes independently through the consent screen, producing a separate refresh token. The `googleapis` npm package creates one `OAuth2` client per account, all sharing the same `client_id`/`client_secret`.

### Gmail MCP Server

Fork `@gongrzhe/server-gmail-autoauth-mcp` source into `container/agent-runner/src/gmail-mcp-server.ts`.

**Key change:** The server already supports `GMAIL_CREDENTIALS_PATH` env var (falls back to `~/.gmail-mcp/`). It also already supports `GMAIL_OAUTH_PATH` for the client credentials file. Token refreshes are handled in-memory by the `googleapis` OAuth2 client — no disk writes during normal operation. The only disk write happens during the one-time OAuth auth flow, which runs on the host during setup.

The credentials directory must contain `gcp-oauth.keys.json` (client credentials) and `credentials.json` (account refresh token).

The server is a stdio MCP server — spawned as a child process by the Claude Code SDK when an agent session starts, communicates over stdin/stdout, dies when the session ends. No HTTP server, no persistent process.

**Tools exposed** (~15, inherited from @gongrzhe):

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

### Per-Group Configuration

Each group specifies which Gmail account it uses via a config file:

```
groups/work_consulting/gmail.json
```

```json
{
  "account": "work@consulting.co"
}
```

One account per group. If a group needs multiple accounts, create separate groups (e.g. `consulting_gmail`, `consulting_acme_gmail`). Multi-account-per-group is a future extension.

If the file doesn't exist, the group gets no Gmail MCP server.

### Agent-Runner Changes

`container/agent-runner/src/index.ts` currently statically defines MCP servers. Change to dynamically build the `mcpServers` object:

1. On startup, read `/workspace/group/gmail.json` (if present)
2. If an account is configured, register a Gmail MCP server instance:
   ```typescript
   mcpServers[`gmail_${accountLabel}`] = {
     command: 'node',
     args: [gmailMcpPath],
     env: { GMAIL_CREDENTIALS_PATH: `/workspace/gmail/${accountEmail}` },
   };
   ```
3. Add `mcp__gmail_*` to `allowedTools`

The agent sees tools like `mcp__gmail_consulting__search_emails`.

### Container-Runner Changes

`src/container-runner.ts` mounts credentials into the container based on the group's gmail config:

1. Read `groups/<name>/gmail.json`
2. Mount `~/.gmail-mcp/gcp-oauth.keys.json` → `/workspace/gmail/<email>/gcp-oauth.keys.json` (ro)
3. Mount `~/.gmail-mcp/tokens/<email>.json` → `/workspace/gmail/<email>/credentials.json` (ro)

The MCP server expects two files in `GMAIL_CREDENTIALS_PATH`: `gcp-oauth.keys.json` (OAuth client) and `credentials.json` (account token).

Groups without `gmail.json` get no Gmail mounts.

### OAuth Setup Flow

The `/add-gmail-multi` skill walks the user through:

1. **GCP project setup** — Create project, enable Gmail API, download OAuth2 client JSON
2. **Store client credentials** — Save to `~/.gmail-mcp/gcp-oauth.keys.json`
3. **Per-account authorization** — For each account:
   - Run auth script that opens browser for OAuth consent
   - User signs into the specific Gmail account
   - Script stores refresh token in `~/.gmail-mcp/tokens/<email>.json`
4. **Assign accounts to groups** — Create `groups/<name>/gmail.json` for each group
5. **Build and restart** — Clear stale agent-runner copies, rebuild container, restart NanoClaw

### Data Flow

```
Scheduled task fires for work_consulting group
  │
  ├─ container-runner reads groups/work_consulting/gmail.json
  │  → account: "work@consulting.co"
  │
  ├─ Mounts ~/.gmail-mcp/gcp-oauth.keys.json (ro)
  │  Mounts ~/.gmail-mcp/tokens/work@consulting.co.json (ro)
  │  → into /workspace/gmail/work@consulting.co/
  │
  ├─ Agent container starts
  │  agent-runner reads /workspace/group/gmail.json
  │  → registers gmail_consulting MCP server (stdio)
  │  → env: GMAIL_CREDENTIALS_PATH=/workspace/gmail/work@consulting.co
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
| `container/agent-runner/src/gmail-mcp-server.ts` | **New.** Forked Gmail MCP server with `GMAIL_CREDENTIALS_PATH` support |
| `container/agent-runner/src/index.ts` | Dynamic MCP server registration based on group gmail config |
| `src/container-runner.ts` | Mount Gmail credentials per-group based on `gmail.json` |
| `.claude/skills/add-gmail-multi/SKILL.md` | **New.** Skill for multi-account Gmail setup |
| `scripts/gmail-oauth.ts` | **New.** OAuth authorization script for adding accounts |

## Testing

1. Set up GCP project with OAuth2 credentials
2. Authorize 2 Gmail accounts (personal + work)
3. Create 2 groups with different `gmail.json` configs
4. Verify each group's agent only sees its assigned account's tools
5. Verify tools work: search, read, send, archive
6. Verify scheduled tasks can process emails autonomously

## Future Work

- **Extract to separate GitHub fork** — Once stable, move Gmail MCP server to its own repo for reuse
- **Host-side MCP server** — Run on host like OneCLI for stronger credential isolation
- **Multi-account channel mode** — Extend `/add-gmail` channel mode to poll multiple inboxes
- **Per-group access control** — Restrict tool operations per group (e.g. read-only)
