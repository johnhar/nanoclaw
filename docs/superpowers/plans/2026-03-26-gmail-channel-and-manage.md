# Gmail Channel Mode & /manage-gmail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Gmail inbox polling (channel mode) and a `/manage-gmail` skill for post-setup account management.

**Architecture:** One `GmailChannel` instance per authorized account, polling Gmail API and fanning out emails to groups with channel mode enabled. JID format `gm:{label}:{group_folder}`. Skills are instruction-only SKILL.md files. Uses `@googleapis/gmail` for polling, existing MCP server for agent-side tools.

**Tech Stack:** TypeScript, `@googleapis/gmail`, `google-auth-library` (already installed), Vitest for tests

**Spec:** `docs/superpowers/specs/2026-03-26-gmail-channel-and-manage-design.md`

---

## File Structure

| File | Action | Purpose |
|------|--------|---------|
| `src/channels/gmail.ts` | Create | GmailChannel class — discovery, polling, fan-out, outbound replies |
| `src/channels/gmail.test.ts` | Create | Unit tests for GmailChannel |
| `src/channels/index.ts` | Modify | Add `import './gmail.js'` |
| `package.json` | Modify | Add `@googleapis/gmail` dependency |
| `.claude/skills/add-gmail/SKILL.md` | Modify | Add channel mode question in Phase 3 |
| `.claude/skills/manage-gmail/SKILL.md` | Create | /manage-gmail skill |
| `docs/gmail.md` | Create | Integration overview doc |

---

### Task 1: Add `@googleapis/gmail` dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the dependency**

```bash
npm install @googleapis/gmail
```

- [ ] **Step 2: Verify installation**

```bash
node -e "require('@googleapis/gmail')"
```

Expected: No error (module resolves)

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "deps: add @googleapis/gmail for channel mode polling"
```

---

### Task 2: Create GmailChannel — discovery and registration

**Files:**
- Create: `src/channels/gmail.ts`
- Create: `src/channels/gmail.test.ts`

This task covers the module-level discovery logic that scans for accounts with channel mode enabled and registers one factory per account.

- [ ] **Step 1: Write failing test for discovery**

`src/channels/gmail.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Mock filesystem for discovery tests
vi.mock('fs');
vi.mock('os', () => ({ default: { homedir: () => '/mock-home' } }));

describe('Gmail channel discovery', () => {
  it('discoverGmailAccounts returns accounts with channel mode enabled', async () => {
    // Mock token files
    vi.mocked(fs.existsSync).mockImplementation((p: string) => {
      if (String(p).includes('tokens')) return true;
      if (String(p).includes('channel-config.json')) return true;
      return false;
    });
    vi.mocked(fs.readdirSync).mockImplementation((p: string) => {
      if (String(p).includes('tokens')) return ['user@gmail.com.json'] as any;
      if (String(p).includes('groups')) return ['work_consulting'] as any;
      return [];
    });
    vi.mocked(fs.readFileSync).mockImplementation((p: string) => {
      if (String(p).includes('.mcp.json')) {
        return JSON.stringify({
          mcpServers: { gmail_consulting: { env: { GMAIL_CREDENTIALS_PATH: '/workspace/extra/gmail/user@gmail.com/token.json' } } },
          gmailChannel: { consulting: { enabled: true } },
        });
      }
      if (String(p).includes('channel-config.json')) {
        return JSON.stringify({ consulting: { pollInterval: 30, filter: 'is:unread category:primary' } });
      }
      return '{}';
    });

    const { discoverGmailAccounts } = await import('./gmail.js');
    const accounts = discoverGmailAccounts('/mock-project');
    expect(accounts).toHaveLength(1);
    expect(accounts[0].label).toBe('consulting');
    expect(accounts[0].email).toBe('user@gmail.com');
    expect(accounts[0].groups).toContain('work_consulting');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/channels/gmail.test.ts -v
```

Expected: FAIL — `discoverGmailAccounts` not found

- [ ] **Step 3: Write discovery implementation**

`src/channels/gmail.ts` — initial skeleton with discovery:

```typescript
import fs from 'fs';
import path from 'path';
import os from 'os';

import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel, NewMessage, OnInboundMessage, OnChatMetadata, RegisteredGroup } from '../types.js';

const GMAIL_MCP_DIR = path.join(os.homedir(), '.gmail-mcp');
const TOKENS_DIR = path.join(GMAIL_MCP_DIR, 'tokens');
const CHANNEL_CONFIG_PATH = path.join(GMAIL_MCP_DIR, 'channel-config.json');

export interface GmailAccountConfig {
  label: string;
  email: string;
  groups: string[]; // group folders with channel mode enabled
  pollInterval: number;
  filter: string;
  tokenPath: string;
  oauthKeysPath: string;
}

/**
 * Scan ~/.gmail-mcp/tokens/ and group .mcp.json files to discover
 * accounts that have channel mode enabled in at least one group.
 */
export function discoverGmailAccounts(projectRoot: string): GmailAccountConfig[] {
  if (!fs.existsSync(TOKENS_DIR)) return [];

  // Read channel config (per-account polling settings)
  let channelConfig: Record<string, { pollInterval?: number; filter?: string }> = {};
  if (fs.existsSync(CHANNEL_CONFIG_PATH)) {
    try {
      channelConfig = JSON.parse(fs.readFileSync(CHANNEL_CONFIG_PATH, 'utf8'));
    } catch { /* ignore parse errors */ }
  }

  // Scan group folders for .mcp.json with gmailChannel enabled
  const groupsDir = path.join(projectRoot, 'groups');
  if (!fs.existsSync(groupsDir)) return [];

  // Map: label -> { email, groups[] }
  const accountMap = new Map<string, { email: string; groups: string[] }>();

  const groupFolders = fs.readdirSync(groupsDir).filter(
    (f) => f !== 'global' && fs.statSync(path.join(groupsDir, f)).isDirectory(),
  );

  for (const folder of groupFolders) {
    const mcpJsonPath = path.join(groupsDir, folder, '.mcp.json');
    if (!fs.existsSync(mcpJsonPath)) continue;

    try {
      const mcpJson = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'));
      const gmailChannel = mcpJson.gmailChannel || {};

      for (const [label, config] of Object.entries(gmailChannel)) {
        if (!(config as any)?.enabled) continue;

        // Find the matching MCP server to extract the email
        const serverKey = `gmail_${label}`;
        const server = mcpJson.mcpServers?.[serverKey];
        if (!server?.env?.GMAIL_CREDENTIALS_PATH) continue;

        // Extract email from container path: /workspace/extra/gmail/{email}/token.json
        const credPath = server.env.GMAIL_CREDENTIALS_PATH;
        const match = credPath.match(/gmail\/(.+?)\/token\.json/);
        if (!match) continue;
        const email = match[1];

        // Check token exists on host
        const tokenPath = path.join(TOKENS_DIR, `${email}.json`);
        if (!fs.existsSync(tokenPath)) {
          logger.warn({ label, email }, 'Gmail channel: token missing, skipping');
          continue;
        }

        if (!accountMap.has(label)) {
          accountMap.set(label, { email, groups: [] });
        }
        accountMap.get(label)!.groups.push(folder);
      }
    } catch {
      logger.warn({ folder }, 'Gmail channel: failed to parse .mcp.json');
    }
  }

  // Convert to config objects
  const accounts: GmailAccountConfig[] = [];
  for (const [label, { email, groups }] of accountMap) {
    const acctConfig = channelConfig[label] || {};
    accounts.push({
      label,
      email,
      groups,
      pollInterval: acctConfig.pollInterval || 30,
      filter: acctConfig.filter || 'is:unread category:primary',
      tokenPath: path.join(TOKENS_DIR, `${email}.json`),
      oauthKeysPath: path.join(GMAIL_MCP_DIR, 'gcp-oauth.keys.json'),
    });
  }

  return accounts;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/channels/gmail.test.ts -v
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/channels/gmail.ts src/channels/gmail.test.ts
git commit -m "feat(gmail): add account discovery for channel mode"
```

---

### Task 3: GmailChannel class — connect, polling, inbound

**Files:**
- Modify: `src/channels/gmail.ts`
- Modify: `src/channels/gmail.test.ts`

- [ ] **Step 1: Write failing test for GmailChannel.connect and polling**

Add to `src/channels/gmail.test.ts`:

```typescript
describe('GmailChannel', () => {
  it('connect starts polling and disconnect stops it', async () => {
    const onMessage = vi.fn();
    const onChatMetadata = vi.fn();
    const registeredGroups = vi.fn().mockReturnValue({});

    const config: GmailAccountConfig = {
      label: 'test',
      email: 'test@gmail.com',
      groups: ['main'],
      pollInterval: 1, // 1 second for test
      filter: 'is:unread',
      tokenPath: '/mock/token.json',
      oauthKeysPath: '/mock/oauth.json',
    };

    const channel = new GmailChannel(config, {
      onMessage,
      onChatMetadata,
      registeredGroups,
    });

    expect(channel.name).toBe('gmail_test');
    expect(channel.isConnected()).toBe(false);
    expect(channel.ownsJid('gm:test:main')).toBe(true);
    expect(channel.ownsJid('gm:other:main')).toBe(false);
    expect(channel.ownsJid('dc:123')).toBe(false);

    // Don't actually connect (would need real Gmail API)
    // Just verify the interface
    await channel.disconnect();
    expect(channel.isConnected()).toBe(false);
  });

  it('formatEmailMessage creates correct message format', () => {
    const result = GmailChannel.formatEmailMessage(
      'sender@example.com',
      'Meeting Tomorrow',
      'Hi, can we meet at 3pm?',
    );
    expect(result).toBe('[Email from sender@example.com] Subject: Meeting Tomorrow\n\nHi, can we meet at 3pm?');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/channels/gmail.test.ts -v
```

Expected: FAIL — GmailChannel class not defined

- [ ] **Step 3: Implement GmailChannel class**

Add to `src/channels/gmail.ts`:

```typescript
import { gmail_v1, auth as googleAuth } from '@googleapis/gmail';

interface ThreadMetadata {
  from: string;
  subject: string;
  messageId: string;
  references: string[];
}

export class GmailChannel implements Channel {
  name: string;
  private config: GmailAccountConfig;
  private opts: ChannelOpts;
  private connected = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private gmail: gmail_v1.Gmail | null = null;
  // Per-group thread metadata for outbound replies: Map<jid, ThreadMetadata>
  private groupThreadMetadata = new Map<string, ThreadMetadata>();
  // Dedup: track recently processed Gmail message IDs
  private processedMessageIds = new Set<string>();
  private backoffTimeout: ReturnType<typeof setTimeout> | null = null;
  private startTimestamp: string = '';
  private static MAX_THREAD_CACHE = 100;

  constructor(config: GmailAccountConfig, opts: ChannelOpts) {
    this.name = `gmail_${config.label}`;
    this.config = config;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    // Load OAuth credentials
    const oauthKeys = JSON.parse(fs.readFileSync(this.config.oauthKeysPath, 'utf8'));
    const keys = oauthKeys.installed || oauthKeys.web;
    const tokens = JSON.parse(fs.readFileSync(this.config.tokenPath, 'utf8'));

    const oauth2Client = new googleAuth.OAuth2Client(
      keys.client_id,
      keys.client_secret,
    );
    oauth2Client.setCredentials(tokens);

    // Auto-refresh: save updated tokens
    oauth2Client.on('tokens', (newTokens) => {
      const existing = JSON.parse(fs.readFileSync(this.config.tokenPath, 'utf8'));
      const merged = { ...existing, ...newTokens };
      fs.writeFileSync(this.config.tokenPath, JSON.stringify(merged, null, 2));
      logger.info({ label: this.config.label }, 'Gmail: refreshed OAuth token');
    });

    this.gmail = new gmail_v1.Gmail({ auth: oauth2Client });
    this.startTimestamp = new Date().toISOString();
    this.connected = true;

    // Start polling
    this.pollTimer = setInterval(() => {
      this.poll().catch((err) => {
        logger.error({ err, label: this.config.label }, 'Gmail poll error');
      });
    }, this.config.pollInterval * 1000);

    logger.info(
      { label: this.config.label, email: this.config.email, groups: this.config.groups },
      'Gmail channel connected',
    );
  }

  private async poll(): Promise<void> {
    if (!this.gmail) return;

    try {
      // List unread messages matching filter
      const res = await this.gmail.users.messages.list({
        userId: 'me',
        q: this.config.filter,
        maxResults: 10,
      });

      const messages = res.data.messages || [];
      if (messages.length === 0) return;

      // Get registered groups to check which are still active
      const groups = this.opts.registeredGroups();

      for (const msgRef of messages) {
        if (!msgRef.id) continue;

        // Fetch full message
        const msg = await this.gmail.users.messages.get({
          userId: 'me',
          id: msgRef.id,
          format: 'full',
        });

        const headers = msg.data.payload?.headers || [];
        const getHeader = (name: string) =>
          headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || '';

        const from = getHeader('From');
        const subject = getHeader('Subject');
        const messageId = getHeader('Message-ID');
        const references = getHeader('References').split(/\s+/).filter(Boolean);
        const dateStr = getHeader('Date');
        const threadId = msg.data.threadId || msgRef.id;
        const internalDate = msg.data.internalDate;

        // Skip emails from before channel started
        if (internalDate && Number(internalDate) < new Date(this.startTimestamp).getTime()) {
          // Mark as read silently
          await this.gmail.users.messages.modify({
            userId: 'me',
            id: msgRef.id,
            requestBody: { removeLabelIds: ['UNREAD'] },
          });
          continue;
        }

        // Extract body text
        const body = this.extractBody(msg.data.payload);

        // Skip already-processed messages (dedup)
        if (this.processedMessageIds.has(msgRef.id)) continue;
        this.processedMessageIds.add(msgRef.id);
        // Cap dedup set size
        if (this.processedMessageIds.size > 500) {
          const toDelete = [...this.processedMessageIds].slice(0, 250);
          toDelete.forEach((id) => this.processedMessageIds.delete(id));
        }

        // Fan out to all groups with channel mode enabled for this account
        for (const groupFolder of this.config.groups) {
          const jid = `gm:${this.config.label}:${groupFolder}`;

          // Store per-group thread metadata for outbound replies
          this.groupThreadMetadata.set(jid, { from, subject, messageId, references });
          // Cap metadata map size
          if (this.groupThreadMetadata.size > GmailChannel.MAX_THREAD_CACHE) {
            const oldest = this.groupThreadMetadata.keys().next().value;
            if (oldest) this.groupThreadMetadata.delete(oldest);
          }

          // Skip if group is no longer registered
          if (!groups[jid]) continue;

          const timestamp = internalDate
            ? new Date(Number(internalDate)).toISOString()
            : new Date().toISOString();

          const newMessage: NewMessage = {
            id: `gm:${msgRef.id}:${groupFolder}`,
            chat_jid: jid,
            sender: from,
            sender_name: from.replace(/<.*>/, '').trim() || from,
            content: GmailChannel.formatEmailMessage(from, subject, body),
            timestamp,
          };

          this.opts.onMessage(jid, newMessage);
          this.opts.onChatMetadata(jid, timestamp, `Gmail (${this.config.label})`, 'gmail', true);
        }

        // Mark as read
        await this.gmail.users.messages.modify({
          userId: 'me',
          id: msgRef.id,
          requestBody: { removeLabelIds: ['UNREAD'] },
        });
      }
    } catch (err: any) {
      if (err?.code === 429) {
        logger.warn({ label: this.config.label }, 'Gmail: rate limited, backing off');
        // Double poll interval temporarily
        if (this.pollTimer) {
          clearInterval(this.pollTimer);
          const backoff = this.config.pollInterval * 2;
          this.pollTimer = setInterval(() => this.poll().catch(() => {}), backoff * 1000);
          this.backoffTimeout = setTimeout(() => {
            this.backoffTimeout = null;
            if (this.pollTimer) {
              clearInterval(this.pollTimer);
              this.pollTimer = setInterval(() => this.poll().catch(() => {}), this.config.pollInterval * 1000);
            }
          }, 60000);
        }
      } else {
        throw err;
      }
    }
  }

  private extractBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
    if (!payload) return '';

    // Plain text part
    if (payload.mimeType === 'text/plain' && payload.body?.data) {
      return Buffer.from(payload.body.data, 'base64url').toString('utf8');
    }

    // Multipart: recurse into parts, prefer text/plain
    if (payload.parts) {
      for (const part of payload.parts) {
        if (part.mimeType === 'text/plain' && part.body?.data) {
          return Buffer.from(part.body.data, 'base64url').toString('utf8');
        }
      }
      // Fallback: try first part with data
      for (const part of payload.parts) {
        const result = this.extractBody(part);
        if (result) return result;
      }
    }

    return '';
  }

  static formatEmailMessage(from: string, subject: string, body: string): string {
    return `[Email from ${from}] Subject: ${subject}\n\n${body}`;
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.gmail) return;

    // Look up thread metadata for this specific group JID
    const meta = this.groupThreadMetadata.get(jid);
    if (!meta) {
      logger.warn({ jid }, 'Gmail: no thread metadata for reply');
      return;
    }

    // Build email
    const to = meta.from;
    const subject = meta.subject.startsWith('Re:') ? meta.subject : `Re: ${meta.subject}`;
    const refs = [...meta.references, meta.messageId].filter(Boolean).join(' ');

    const emailLines = [
      `From: ${this.config.email}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      `In-Reply-To: ${meta.messageId}`,
      `References: ${refs}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      text,
    ];

    const raw = Buffer.from(emailLines.join('\r\n')).toString('base64url');

    await this.gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw, threadId },
    });

    logger.info({ jid, to, subject }, 'Gmail: sent reply');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(`gm:${this.config.label}:`);
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.backoffTimeout) {
      clearTimeout(this.backoffTimeout);
      this.backoffTimeout = null;
    }
    this.connected = false;
    logger.info({ label: this.config.label }, 'Gmail channel disconnected');
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/channels/gmail.test.ts -v
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/channels/gmail.ts src/channels/gmail.test.ts
git commit -m "feat(gmail): add GmailChannel class with polling and reply support"
```

---

### Task 4: Register GmailChannel in the barrel and add self-registration

**Files:**
- Modify: `src/channels/gmail.ts`
- Modify: `src/channels/index.ts`

- [ ] **Step 1: Add self-registration at the bottom of `gmail.ts`**

Append to `src/channels/gmail.ts`:

```typescript
// --- Self-registration ---
// Discover accounts with channel mode enabled and register one factory per account.
import { GROUPS_DIR } from '../config.js';

// GROUPS_DIR is already exported from config.ts; pass its parent as projectRoot
const accounts = discoverGmailAccounts(path.dirname(GROUPS_DIR));
for (const account of accounts) {
  registerChannel(`gmail_${account.label}`, (opts: ChannelOpts) => {
    if (!fs.existsSync(account.tokenPath)) {
      logger.warn({ label: account.label }, 'Gmail: token missing at startup');
      return null;
    }
    return new GmailChannel(account, opts);
  });

  logger.info(
    { label: account.label, email: account.email, groups: account.groups },
    'Gmail channel registered',
  );
}

if (accounts.length === 0) {
  logger.debug('Gmail channel: no accounts with channel mode enabled');
}
```

- [ ] **Step 2: Add import to barrel file**

Modify `src/channels/index.ts` — uncomment/add the gmail import:

```typescript
import './gmail.js';
```

- [ ] **Step 3: Verify build**

```bash
npm run build
```

Expected: Clean build, no errors

- [ ] **Step 4: Run all channel tests**

```bash
npx vitest run src/channels/ -v
```

Expected: All tests pass (registry tests + gmail tests)

- [ ] **Step 5: Commit**

```bash
git add src/channels/gmail.ts src/channels/index.ts
git commit -m "feat(gmail): register Gmail channel in barrel file"
```

---

### Task 5: Update `/add-gmail` SKILL.md with channel mode question

**Files:**
- Modify: `.claude/skills/add-gmail/SKILL.md`

- [ ] **Step 1: Add channel mode question after label assignment in Phase 3**

After the label AskUserQuestion (around line 121), add:

```markdown
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

2. Create or update `~/.gmail-mcp/channel-config.json` with defaults if this account doesn't have an entry yet:

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
```

- [ ] **Step 2: Verify the SKILL.md is valid markdown**

Read the file and check formatting.

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/add-gmail/SKILL.md
git commit -m "feat(add-gmail): add channel mode question to group assignment"
```

---

### Task 6: Create `/manage-gmail` SKILL.md

**Files:**
- Create: `.claude/skills/manage-gmail/SKILL.md`

- [ ] **Step 1: Create the skill file**

Create `.claude/skills/manage-gmail/SKILL.md` with full content per the spec. Key sections:

- Frontmatter: `name: manage-gmail`, description covering associate/disassociate/toggle/remove
- Phase 1: Account & Group Summary (scan tokens, .mcp.json, SQLite, channel-config.json; show table with Mode column)
- Phase 2: Choose operation (Associate, Disassociate, Toggle channel mode, Remove account)
- Phase 3a: Associate flow (follow /add-gmail Phase 3 steps, ask about channel mode)
- Phase 3b: Disassociate flow (remove .mcp.json entry, additionalMounts, channel JID if applicable; restart if channel mode was active)
- Phase 3c: Toggle channel mode (update gmailChannel config, register/remove JID, restart)
- Phase 3d: Remove account (disassociate all groups, delete token, remove channel config, restart)
- Phase 4: Repeat or exit (show updated summary, offer all operations + Done)
- Troubleshooting: reference `/debug` skill

All user prompts must use `AskUserQuestion` with structured options. All restart operations must warn about interrupting active agents/channels. Use `store/messages.db` for all SQLite operations.

- [ ] **Step 2: Verify the SKILL.md is valid markdown and follows conventions**

Check: frontmatter present, AskUserQuestion used for all prompts, correct DB path, phase structure.

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/manage-gmail/SKILL.md
git commit -m "feat: add /manage-gmail skill for account management"
```

---

### Task 7: Write `docs/gmail.md` integration overview

**Files:**
- Create: `docs/gmail.md`

- [ ] **Step 1: Write the doc**

Content sections:
1. **Overview** — what the Gmail integration does (multi-account, per-group access)
2. **Benefits** — no secret leakage between groups, multi-account support, flexible per-group assignment, channel mode for auto-notification
3. **User Experience** — what `/add-gmail` and `/manage-gmail` feel like
4. **Architecture** — how it differs from the original (no source code merge, MCP-based, per-group config)
5. **Data Model** — where state lives (tokens, .mcp.json, SQLite, channel-config.json)
6. **Developer Guide** — JID format, channel registration, how to extend

- [ ] **Step 2: Commit**

```bash
git add docs/gmail.md
git commit -m "docs: add Gmail integration overview"
```

---

### Task 8: Integration test and final verification

**Files:**
- All files from previous tasks

- [ ] **Step 1: Run full test suite**

```bash
npx vitest run -v
```

Expected: All tests pass

- [ ] **Step 2: Run build**

```bash
npm run build
```

Expected: Clean build

- [ ] **Step 3: Verify channel discovery with no config (should be no-op)**

```bash
node -e "
  import('./dist/channels/gmail.js').then(() => console.log('Gmail channel module loaded (no accounts discovered — expected)'));
" 2>&1 | head -5
```

Expected: Module loads without errors, logs "no accounts with channel mode enabled"

- [ ] **Step 4: Push to origin**

```bash
git push origin skill/gmail
```

- [ ] **Step 5: Update local main**

```bash
git checkout main && git merge skill/gmail && git checkout skill/gmail
```
