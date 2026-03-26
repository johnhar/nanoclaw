# Multi-Account Gmail MCP Server

**Issue:** https://github.com/johnhar/nanoclaw/issues/1
**Date:** 2026-03-25
**Status:** Design

## Problem

NanoClaw needs to process emails across multiple Gmail accounts (personal + multiple work accounts). The current `/add-gmail` skill uses `@gongrzhe/server-gmail-autoauth-mcp`, which is single-account (hardcoded to `~/.gmail-mcp/`) and downloaded via `npx` at runtime. There is no way to give different groups access to different Gmail accounts.

## Goals

1. Support N Gmail accounts, each authorized via OAuth2 against a single GCP project
2. Per-group Gmail access — each group's agent gets only the Gmail account assigned to it
3. Credentials never exposed to the AI agent (only accessible through MCP tool calls)
4. Delivered as a new `/add-gmail` skill; existing `/add-gmail` untouched

## Non-Goals

- Gmail channel mode (inbox polling that triggers agents on new emails) — future work
- Host-side MCP server (like OneCLI) — future work; start with in-container stdio
- Per-group tool restrictions (e.g. read-only for some groups) — future work
- Modifying group registration to accept MCP config — future work

## Architecture

### Per-Group MCP Server Configuration

Each group can have additional MCP servers configured via `.mcp.json` in its group folder:

```
groups/work_consulting/.mcp.json
```

```json
{
  "mcpServers": {
    "gmail_consulting": {
      "command": "npx",
      "args": ["-y", "@gongrzhe/server-gmail-autoauth-mcp"],
      "env": {
        "GMAIL_CREDENTIALS_PATH": "/workspace/gmail/work@consulting.co",
        "GMAIL_OAUTH_PATH": "/workspace/gmail/gcp-oauth.keys.json"
      }
    }
  }
}
```

This uses the **standard Claude Code `.mcp.json` mechanism**. The agent-runner already sets `cwd: '/workspace/group'` and `settingSources: ['project', 'user']`, which tells the Claude Code SDK to load `.mcp.json` from the working directory. MCP servers defined in `.mcp.json` are merged with those passed programmatically (the nanoclaw MCP server).

**No agent-runner code changes needed** for MCP server registration. The SDK handles it.

**`allowedTools`:** The agent-runner uses `permissionMode: 'bypassPermissions'`, which auto-approves MCP tools. If testing reveals that `.mcp.json` tools also need explicit `allowedTools` entries, one line is added to the agent-runner: `'mcp__gmail_*'`. This is the only potential agent-runner change.

**Backward compatible:** Groups without `.mcp.json` behave identically to today.

### How `.mcp.json` gets created

The `.mcp.json` file is **not** created during group registration. Groups are created first (via `@Andy add group "consulting"` in the main channel), then `/add-gmail` assigns Gmail accounts to existing groups by writing `.mcp.json` into their folders.

The workflow is two separate steps:
1. **Create the group** — `@Andy add group "consulting"` (registers the group, creates the folder)
2. **Assign Gmail** — Run `/add-gmail`, which asks "which group?" and writes the `.mcp.json`

### Credential Layout

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

`src/container-runner.ts` mounts Gmail credentials into the container based on the group's `.mcp.json`:

1. Read `groups/<name>/.mcp.json` (if present)
2. For MCP server entries with `GMAIL_CREDENTIALS_PATH` or `GMAIL_OAUTH_PATH` env vars, mount the referenced credential files:
   - `~/.gmail-mcp/gcp-oauth.keys.json` → `/workspace/gmail/gcp-oauth.keys.json` (ro)
   - `~/.gmail-mcp/tokens/<email>.json` → `/workspace/gmail/<email>/credentials.json` (ro)

Groups without `.mcp.json` get no extra mounts.

### `/add-gmail` Skill Flow

The skill guides the user through setup and group assignment:

**Phase 1: OAuth setup (one-time)**
1. **GCP project setup** — Create project, enable Gmail API, download OAuth2 client JSON
2. **Store client credentials** — Save to `~/.gmail-mcp/gcp-oauth.keys.json`
3. **Per-account authorization** — For each Gmail account:
   - Run auth script that opens browser for OAuth consent
   - User signs into the specific Gmail account
   - Script stores refresh token in `~/.gmail-mcp/tokens/<email>.json`

**Phase 2: Assign accounts to groups**
4. **Ask which group** — "Which group should `work@consulting.co` be assigned to?"
5. **Write `.mcp.json`** — Create/update `groups/<name>/.mcp.json` with the Gmail MCP server config
6. **Build and restart** — Clear stale agent-runner copies, rebuild container, restart NanoClaw

The skill can be re-run to add more accounts or assign accounts to additional groups.

### Data Flow

```
Scheduled task fires for work_consulting group
  │
  ├─ container-runner reads groups/work_consulting/.mcp.json
  │  → finds gmail_consulting entry with GMAIL_CREDENTIALS_PATH
  │
  ├─ Mounts ~/.gmail-mcp/gcp-oauth.keys.json (ro)
  │  Mounts ~/.gmail-mcp/tokens/work@consulting.co.json (ro)
  │  → into /workspace/gmail/
  │
  ├─ Agent container starts
  │  Claude Code SDK loads /workspace/group/.mcp.json automatically
  │  → registers gmail_consulting MCP server (stdio, via npx)
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
| `src/container-runner.ts` | Parse group `.mcp.json` to determine credential mounts |
| `.claude/skills/add-gmail/SKILL.md` | **New.** Skill for multi-account Gmail setup and group assignment |
| `scripts/gmail-oauth.ts` | **New.** OAuth authorization script for adding accounts |
| `container/agent-runner/src/index.ts` | Possibly one line: add `'mcp__gmail_*'` to allowedTools (only if needed after testing) |

## Testing

1. Verify groups without `.mcp.json` behave identically to today
2. Set up GCP project with OAuth2 credentials
3. Authorize 2 Gmail accounts (personal + work)
4. Create 2 groups, run `/add-gmail` to assign different accounts
5. Verify each group's agent only sees its assigned account's tools
6. Verify tools work: search, read, send, archive
7. Verify scheduled tasks can process emails autonomously
8. Verify `.mcp.json` MCP tools are usable (test whether `allowedTools` change is needed)

## Future Work

- **Custom long-lived MCP server** — Replace `@gongrzhe` with a custom multi-account MCP server (single process, `account` parameter per tool call). Eliminates per-session `npx` startup cost and simplifies credential management. Could run host-side like OneCLI for stronger credential isolation.
- **Multi-account channel mode** — Extend `/add-gmail` channel mode to poll multiple inboxes
- **Per-group access control** — Restrict tool operations per group (e.g. read-only)
- **MCP config at group registration** — Extend `register_group` to accept MCP server config, so groups can be created with Gmail (or other MCP servers) in one step
