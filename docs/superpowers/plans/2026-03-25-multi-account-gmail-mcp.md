# Multi-Account Gmail MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable per-group Gmail access in NanoClaw using `.mcp.json` and `@gongrzhe/server-gmail-autoauth-mcp` with per-account credential directories.

**Architecture:** The Claude Code SDK already loads `.mcp.json` from the agent's working directory. We add Gmail credential mounts in `container-runner.ts` based on each group's `.mcp.json`, write an OAuth setup script, and create a `/add-gmail-multi` skill. No MCP server fork, no agent-runner changes (unless `allowedTools` testing reveals they're needed).

**Tech Stack:** TypeScript, `@gongrzhe/server-gmail-autoauth-mcp` (npm), `googleapis` (for OAuth script), vitest (tests)

**Spec:** `docs/superpowers/specs/2026-03-25-multi-account-gmail-mcp-design.md`

**Contributing:** This is a skill (not a source code feature). Per `CONTRIBUTING.md`, source code changes should be minimal — only what's needed to support the credential mounts. The skill itself (`/add-gmail-multi`) is an operational skill with a utility script.

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/container-runner.ts` | **Modify.** Parse group `.mcp.json` to add Gmail credential mounts |
| `src/container-runner.test.ts` | **Modify.** Test Gmail mount logic |
| `scripts/gmail-oauth.ts` | **New.** OAuth authorization script — authorizes one Gmail account at a time, stores token in `~/.gmail-mcp/tokens/<email>.json` |
| `.claude/skills/add-gmail-multi/SKILL.md` | **New.** Operational skill guiding GCP setup, OAuth per account, group assignment |

---

### Task 1: Gmail credential mount logic in container-runner

**Files:**
- Modify: `src/container-runner.ts` (in `buildVolumeMounts()`, after line 211)
- Modify: `src/container-runner.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/container-runner.test.ts`. The test verifies that when a group folder has a `.mcp.json` with Gmail env vars, the container gets credential mounts.

```typescript
describe('Gmail credential mounts', () => {
  it('mounts Gmail credentials when group has .mcp.json with GMAIL_CREDENTIALS_PATH', async () => {
    const groupDir = '/tmp/nanoclaw-test-groups/work_consulting';
    const mcpJsonPath = path.join(groupDir, '.mcp.json');

    // Mock .mcp.json exists and contains Gmail config
    const mcpConfig = {
      mcpServers: {
        gmail_consulting: {
          command: 'npx',
          args: ['-y', '@gongrzhe/server-gmail-autoauth-mcp'],
          env: {
            GMAIL_CREDENTIALS_PATH: '/workspace/gmail/work@consulting.co',
            GMAIL_OAUTH_PATH: '/workspace/gmail/gcp-oauth.keys.json',
          },
        },
      },
    };

    fs.existsSync.mockImplementation((p: string) => {
      if (p === mcpJsonPath) return true;
      if (p.includes('gcp-oauth.keys.json')) return true;
      if (p.includes('tokens/work@consulting.co.json')) return true;
      return false;
    });
    fs.readFileSync.mockImplementation((p: string) => {
      if (p === mcpJsonPath) return JSON.stringify(mcpConfig);
      return '';
    });

    // Call runContainerAgent and capture the docker args
    // Verify mounts include Gmail credential paths
    // (exact assertion depends on how the test harness captures spawn args)
  });

  it('does not mount Gmail credentials when group has no .mcp.json', async () => {
    fs.existsSync.mockReturnValue(false);
    // Verify no /workspace/gmail mounts appear
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/container-runner.test.ts --reporter=verbose`
Expected: FAIL — Gmail mount logic doesn't exist yet.

- [ ] **Step 3: Implement Gmail mount logic**

In `src/container-runner.ts`, add a helper function and call it from `buildVolumeMounts()`:

```typescript
import os from 'os';

/**
 * Parse a group's .mcp.json for Gmail credential paths and return
 * read-only mounts for the referenced credential files.
 */
function gmailCredentialMounts(groupDir: string): VolumeMount[] {
  const mcpJsonPath = path.join(groupDir, '.mcp.json');
  if (!fs.existsSync(mcpJsonPath)) return [];

  let mcpConfig: { mcpServers?: Record<string, { env?: Record<string, string> }> };
  try {
    mcpConfig = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'));
  } catch {
    logger.warn({ mcpJsonPath }, 'Failed to parse .mcp.json');
    return [];
  }

  if (!mcpConfig.mcpServers) return [];

  const mounts: VolumeMount[] = [];
  const gmailMcpDir = path.join(os.homedir(), '.gmail-mcp');

  for (const [, serverConfig] of Object.entries(mcpConfig.mcpServers)) {
    const credPath = serverConfig.env?.GMAIL_CREDENTIALS_PATH;
    const oauthPath = serverConfig.env?.GMAIL_OAUTH_PATH;

    if (credPath) {
      // Extract email from path: /workspace/gmail/user@example.com → user@example.com
      const email = path.basename(credPath);
      const hostTokenPath = path.join(gmailMcpDir, 'tokens', `${email}.json`);
      const containerCredDir = credPath; // e.g. /workspace/gmail/user@example.com

      if (fs.existsSync(hostTokenPath)) {
        // Mount the token file as credentials.json in the account directory
        mounts.push({
          hostPath: hostTokenPath,
          containerPath: path.join(containerCredDir, 'credentials.json'),
          readonly: true,
        });
      } else {
        logger.warn({ email, hostTokenPath }, 'Gmail token file not found');
      }
    }

    if (oauthPath) {
      const hostOauthPath = path.join(gmailMcpDir, 'gcp-oauth.keys.json');
      if (fs.existsSync(hostOauthPath)) {
        mounts.push({
          hostPath: hostOauthPath,
          containerPath: oauthPath,
          readonly: true,
        });
      } else {
        logger.warn({ hostOauthPath }, 'Gmail OAuth keys file not found');
      }
    }
  }

  return mounts;
}
```

Then in `buildVolumeMounts()`, after the `additionalMounts` block (line ~211), add:

```typescript
  // Gmail credential mounts based on group's .mcp.json
  const gmailMounts = gmailCredentialMounts(groupDir);
  mounts.push(...gmailMounts);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/container-runner.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run --reporter=verbose`
Expected: All existing tests still pass.

---

### Task 2: Install dependencies and create OAuth authorization script

**Prerequisites:** Task 5 (install `google-auth-library` and `open`) must be done first, or run it now before creating the script.

**Files:**
- Create: `scripts/gmail-oauth.ts`

This script authorizes one Gmail account at a time and stores the token. It reuses the same OAuth flow that `@gongrzhe` uses internally.

- [ ] **Step 1: Create the script**

```typescript
#!/usr/bin/env npx tsx
/**
 * Gmail OAuth authorization script for NanoClaw multi-account Gmail.
 *
 * Usage:
 *   npx tsx scripts/gmail-oauth.ts                  # Interactive — prompts for email
 *   npx tsx scripts/gmail-oauth.ts user@example.com  # Authorize specific account
 *
 * Prerequisites:
 *   ~/.gmail-mcp/gcp-oauth.keys.json must exist (GCP OAuth2 client credentials)
 *
 * Output:
 *   ~/.gmail-mcp/tokens/<email>.json (refresh token for the account)
 */
import fs from 'fs';
import http from 'http';
import open from 'open';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { OAuth2Client } from 'google-auth-library';

const GMAIL_MCP_DIR = path.join(os.homedir(), '.gmail-mcp');
const OAUTH_KEYS_PATH = path.join(GMAIL_MCP_DIR, 'gcp-oauth.keys.json');
const TOKENS_DIR = path.join(GMAIL_MCP_DIR, 'tokens');

async function askEmail(): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question('Gmail address to authorize: ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  // Check prerequisites
  if (!fs.existsSync(OAUTH_KEYS_PATH)) {
    console.error(`Error: ${OAUTH_KEYS_PATH} not found.`);
    console.error('Download OAuth2 client credentials from GCP Console and save them there.');
    process.exit(1);
  }

  const email = process.argv[2] || await askEmail();
  if (!email || !email.includes('@')) {
    console.error('Error: Invalid email address.');
    process.exit(1);
  }

  // Load OAuth2 client credentials
  const keysContent = JSON.parse(fs.readFileSync(OAUTH_KEYS_PATH, 'utf8'));
  const keys = keysContent.installed || keysContent.web;
  if (!keys) {
    console.error('Error: Invalid OAuth keys file format.');
    process.exit(1);
  }

  const redirectUri = 'http://localhost:3000/oauth2callback';
  const oauth2Client = new OAuth2Client(keys.client_id, keys.client_secret, redirectUri);

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/gmail.settings.basic',
    ],
    login_hint: email,
    prompt: 'consent',
  });

  console.log(`\nAuthorizing: ${email}`);
  console.log('Opening browser for Google consent screen...');
  console.log('If browser does not open, visit:', authUrl);

  const server = http.createServer();
  server.listen(3000);

  await new Promise<void>((resolve, reject) => {
    server.on('request', async (req, res) => {
      if (!req.url?.startsWith('/oauth2callback')) return;

      const url = new URL(req.url, 'http://localhost:3000');
      const code = url.searchParams.get('code');

      if (!code) {
        res.writeHead(400);
        res.end('No authorization code received.');
        reject(new Error('No code'));
        return;
      }

      try {
        const { tokens } = await oauth2Client.getToken(code);

        // Save token
        fs.mkdirSync(TOKENS_DIR, { recursive: true });
        const tokenPath = path.join(TOKENS_DIR, `${email}.json`);
        fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));

        res.writeHead(200);
        res.end(`Authentication successful for ${email}! You can close this window.`);
        server.close();

        console.log(`\nToken saved to: ${tokenPath}`);
        resolve();
      } catch (error) {
        res.writeHead(500);
        res.end('Authentication failed.');
        reject(error);
      }
    });

    open(authUrl);
  });
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
```

- [ ] **Step 2: Verify it runs (syntax check)**

Run: `npx tsx scripts/gmail-oauth.ts --help 2>&1 || true`
Expected: Should not crash with syntax errors (will fail on missing keys file, which is expected).

---

### Task 3: Create `/add-gmail-multi` skill

**Files:**
- Create: `.claude/skills/add-gmail-multi/SKILL.md`

- [ ] **Step 1: Write the skill**

```markdown
---
name: add-gmail-multi
description: Add multi-account Gmail to NanoClaw. Supports multiple Gmail accounts with per-group access. Each group gets its own Gmail MCP server via .mcp.json. Guides through GCP OAuth setup, per-account authorization, and group assignment.
---

# Add Multi-Account Gmail

This skill sets up Gmail access for multiple accounts, with each NanoClaw group accessing only its assigned Gmail account.

## Phase 1: Pre-flight

### Check prerequisites

```bash
ls ~/.gmail-mcp/gcp-oauth.keys.json 2>/dev/null || echo "NO_OAUTH_KEYS"
ls ~/.gmail-mcp/tokens/ 2>/dev/null || echo "NO_TOKENS_DIR"
ls groups/*/  2>/dev/null | head -20
```

If `gcp-oauth.keys.json` exists, skip to Phase 2 (or Phase 3 if tokens also exist).

### GCP Project Setup

Tell the user:

> I need you to set up Google Cloud OAuth credentials:
>
> 1. Open https://console.cloud.google.com — create a new project or select existing
> 2. Go to **APIs & Services > Library**, search "Gmail API", click **Enable**
> 3. Go to **APIs & Services > Credentials**, click **+ CREATE CREDENTIALS > OAuth client ID**
>    - If prompted for consent screen: choose "External", fill in app name and email, save
>    - Application type: **Desktop app**, name: anything (e.g., "NanoClaw Gmail")
> 4. Click **DOWNLOAD JSON** and save it
>
> Where did you save the file? (Give me the full path, or paste the file contents here)

If user provides a path, copy it:

```bash
mkdir -p ~/.gmail-mcp
cp "/path/user/provided" ~/.gmail-mcp/gcp-oauth.keys.json
```

If user pastes JSON content, write it to `~/.gmail-mcp/gcp-oauth.keys.json`.

## Phase 2: Authorize Gmail Accounts

Use `AskUserQuestion`:

> Which Gmail account do you want to authorize? (Enter the email address)

For each account the user provides, run:

```bash
npx tsx scripts/gmail-oauth.ts <email>
```

This opens a browser for OAuth consent. After authorization, verify:

```bash
ls ~/.gmail-mcp/tokens/<email>.json
```

Ask:

> Account authorized! Do you want to add another Gmail account? (yes/no)

Repeat until the user says no.

## Phase 3: Assign Accounts to Groups

List available groups:

```bash
ls -d groups/*/ | grep -v global
```

List authorized accounts:

```bash
ls ~/.gmail-mcp/tokens/
```

For each authorized account, ask:

> Which group should `<email>` be assigned to? (Enter the group folder name, e.g., `work_consulting`)

For the chosen group, create or update `groups/<name>/.mcp.json`:

```json
{
  "mcpServers": {
    "gmail_<label>": {
      "command": "npx",
      "args": ["-y", "@gongrzhe/server-gmail-autoauth-mcp"],
      "env": {
        "GMAIL_CREDENTIALS_PATH": "/workspace/gmail/<email>",
        "GMAIL_OAUTH_PATH": "/workspace/gmail/gcp-oauth.keys.json"
      }
    }
  }
}
```

Where `<label>` is derived from the email (e.g., `work` from `work@consulting.co`, or `personal` from `personal@gmail.com`). Use `AskUserQuestion` to confirm or customize the label.

If the group already has a `.mcp.json`, merge the new server entry into the existing `mcpServers` object.

## Phase 4: Build and Restart

```bash
# Clear stale agent-runner copies
rm -r data/sessions/*/agent-runner-src 2>/dev/null || true

# Rebuild container
cd container && ./build.sh && cd ..

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

Check mounts in container logs:

```bash
cat groups/<name>/logs/container-*.log | tail -50
```

Verify token file exists:

```bash
ls ~/.gmail-mcp/tokens/<email>.json
```

### OAuth token expired

Re-authorize:

```bash
npx tsx scripts/gmail-oauth.ts <email>
```

### Adding another account later

Re-run `/add-gmail-multi`. It detects existing setup and skips to account authorization.
```

- [ ] **Step 2: Verify skill format**

Check that frontmatter is valid and file is under 500 lines (per CONTRIBUTING.md).

---

### Task 4: Integration test — verify `.mcp.json` loading works

This task is manual testing on the live system. No automated test — it requires actual GCP credentials and a running NanoClaw instance.

- [ ] **Step 1: Set up a test group with `.mcp.json`**

Create a test `.mcp.json` in an existing group folder (e.g., `groups/discord_main/`):

```json
{
  "mcpServers": {
    "gmail_test": {
      "command": "npx",
      "args": ["-y", "@gongrzhe/server-gmail-autoauth-mcp"],
      "env": {
        "GMAIL_CREDENTIALS_PATH": "/workspace/gmail/test@gmail.com",
        "GMAIL_OAUTH_PATH": "/workspace/gmail/gcp-oauth.keys.json"
      }
    }
  }
}
```

- [ ] **Step 2: Verify backward compatibility**

Remove the `.mcp.json` and verify the group still works normally — agent spawns, nanoclaw MCP tools work, no errors.

- [ ] **Step 3: Test with real credentials**

Run `/add-gmail-multi` end-to-end:
1. Authorize a Gmail account
2. Assign it to a group
3. Rebuild and restart
4. Send `@Andy check my recent emails` in the group's channel
5. Verify the agent can use Gmail tools

- [ ] **Step 4: Test `allowedTools` behavior**

If the agent reports it cannot use Gmail tools, add `'mcp__gmail_*'` to the `allowedTools` array in `container/agent-runner/src/index.ts` line 410:

```typescript
allowedTools: [
  ...,
  'mcp__nanoclaw__*',
  'mcp__gmail_*',    // ← add this line if needed
],
```

Then rebuild container and retest.

---

### Task 5: Install `google-auth-library` dependency

The OAuth script uses `google-auth-library` for the `OAuth2Client`. This needs to be a dev dependency since it only runs on the host during setup.

- [ ] **Step 1: Check if already available**

Run: `node -e "require('google-auth-library')" 2>&1`

If it fails:

- [ ] **Step 2: Install**

Run: `npm install --save-dev google-auth-library`

Note: `open` is an npm package (not a Node.js built-in). Check if it needs installing:

Run: `node -e "import('open').then(m => console.log('ok'))" 2>&1`

If it fails: `npm install --save-dev open`
