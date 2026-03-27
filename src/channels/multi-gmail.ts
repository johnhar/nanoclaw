import fs from 'fs';
import path from 'path';
import { gmail_v1, auth as gmailAuth } from '@googleapis/gmail';

import { GMAIL_DATA_DIR, GROUPS_DIR } from '../config.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel, NewMessage } from '../types.js';

const TOKENS_DIR = path.join(GMAIL_DATA_DIR, 'tokens');
const CHANNEL_CONFIG_PATH = path.join(GMAIL_DATA_DIR, 'channel-config.json');

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
 * Scan data/gmail/tokens/ and group .mcp.json files to discover
 * accounts that have channel mode enabled in at least one group.
 */
export function discoverGmailAccounts(
  projectRoot: string,
): GmailAccountConfig[] {
  if (!fs.existsSync(TOKENS_DIR)) return [];

  // Read channel config (per-account polling settings)
  let channelConfig: Record<
    string,
    { pollInterval?: number; filter?: string }
  > = {};
  if (fs.existsSync(CHANNEL_CONFIG_PATH)) {
    try {
      channelConfig = JSON.parse(fs.readFileSync(CHANNEL_CONFIG_PATH, 'utf8'));
    } catch {
      /* ignore parse errors */
    }
  }

  // Scan group folders for .mcp.json with gmailChannel enabled
  const groupsDir = path.join(projectRoot, 'groups');
  if (!fs.existsSync(groupsDir)) return [];

  // Map: label -> { email, groups[] }
  const accountMap = new Map<string, { email: string; groups: string[] }>();

  let groupFolders: string[];
  try {
    groupFolders = (fs.readdirSync(groupsDir) as unknown as string[]).filter(
      (f) =>
        f !== 'global' && fs.statSync(path.join(groupsDir, f)).isDirectory(),
    );
  } catch {
    return [];
  }

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
          logger.warn(
            { label, email },
            'Gmail channel: token missing, skipping',
          );
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
      oauthKeysPath: path.join(GMAIL_DATA_DIR, 'gcp-oauth.keys.json'),
    });
  }

  return accounts;
}

interface ThreadMetadata {
  from: string;
  subject: string;
  messageId: string;
  references: string[];
  threadId: string;
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
    const oauthKeys = JSON.parse(
      fs.readFileSync(this.config.oauthKeysPath, 'utf8'),
    );
    const keys = oauthKeys.installed || oauthKeys.web;
    const tokens = JSON.parse(fs.readFileSync(this.config.tokenPath, 'utf8'));

    const oauth2Client = new gmailAuth.OAuth2(
      keys.client_id,
      keys.client_secret,
    );
    oauth2Client.setCredentials(tokens);

    // Auto-refresh: save updated tokens
    oauth2Client.on('tokens', (newTokens: any) => {
      const existing = JSON.parse(
        fs.readFileSync(this.config.tokenPath, 'utf8'),
      );
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
      {
        label: this.config.label,
        email: this.config.email,
        groups: this.config.groups,
      },
      'Gmail channel connected',
    );
  }

  private async poll(): Promise<void> {
    if (!this.gmail) return;

    try {
      const res = await this.gmail.users.messages.list({
        userId: 'me',
        q: this.config.filter,
        maxResults: 10,
      });

      const messages = res.data.messages || [];
      if (messages.length === 0) return;

      const groups = this.opts.registeredGroups();

      for (const msgRef of messages) {
        if (!msgRef.id) continue;

        // Skip already-processed messages (dedup)
        if (this.processedMessageIds.has(msgRef.id)) continue;

        const msg = await this.gmail.users.messages.get({
          userId: 'me',
          id: msgRef.id,
          format: 'full',
        });

        const headers = msg.data.payload?.headers || [];
        const getHeader = (name: string) =>
          headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())
            ?.value || '';

        const from = getHeader('From');
        const subject = getHeader('Subject');
        const messageId = getHeader('Message-ID');
        const references = getHeader('References').split(/\s+/).filter(Boolean);
        const threadId = msg.data.threadId || msgRef.id;
        const internalDate = msg.data.internalDate;

        // Skip emails from before channel started
        if (
          internalDate &&
          Number(internalDate) < new Date(this.startTimestamp).getTime()
        ) {
          await this.gmail.users.messages.modify({
            userId: 'me',
            id: msgRef.id,
            requestBody: { removeLabelIds: ['UNREAD'] },
          });
          continue;
        }

        // Add to dedup set
        this.processedMessageIds.add(msgRef.id);
        if (this.processedMessageIds.size > 500) {
          const toDelete = [...this.processedMessageIds].slice(0, 250);
          toDelete.forEach((id) => this.processedMessageIds.delete(id));
        }

        const body = this.extractBody(msg.data.payload);

        // Fan out to all groups with channel mode enabled
        for (const groupFolder of this.config.groups) {
          const jid = `gm:${this.config.label}:${groupFolder}`;

          // Store per-group thread metadata for outbound replies
          this.groupThreadMetadata.set(jid, {
            from,
            subject,
            messageId,
            references,
            threadId,
          });
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
          this.opts.onChatMetadata(
            jid,
            timestamp,
            `Gmail (${this.config.label})`,
            'gmail',
            true,
          );
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
        logger.warn(
          { label: this.config.label },
          'Gmail: rate limited, backing off',
        );
        if (this.pollTimer) {
          clearInterval(this.pollTimer);
          const backoff = this.config.pollInterval * 2;
          this.pollTimer = setInterval(
            () => this.poll().catch(() => {}),
            backoff * 1000,
          );
          this.backoffTimeout = setTimeout(() => {
            this.backoffTimeout = null;
            if (this.pollTimer) {
              clearInterval(this.pollTimer);
              this.pollTimer = setInterval(
                () => this.poll().catch(() => {}),
                this.config.pollInterval * 1000,
              );
            }
          }, 60000);
        }
      } else {
        throw err;
      }
    }
  }

  private extractBody(
    payload: gmail_v1.Schema$MessagePart | undefined,
  ): string {
    if (!payload) return '';

    if (payload.mimeType === 'text/plain' && payload.body?.data) {
      return Buffer.from(payload.body.data, 'base64url').toString('utf8');
    }

    if (payload.parts) {
      for (const part of payload.parts) {
        if (part.mimeType === 'text/plain' && part.body?.data) {
          return Buffer.from(part.body.data, 'base64url').toString('utf8');
        }
      }
      for (const part of payload.parts) {
        const result = this.extractBody(part);
        if (result) return result;
      }
    }

    return '';
  }

  static formatEmailMessage(
    from: string,
    subject: string,
    body: string,
  ): string {
    return `[Email from ${from}] Subject: ${subject}\n\n${body}`;
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.gmail) return;

    const meta = this.groupThreadMetadata.get(jid);
    if (!meta) {
      logger.warn({ jid }, 'Gmail: no thread metadata for reply');
      return;
    }

    const to = meta.from;
    const subject = meta.subject.startsWith('Re:')
      ? meta.subject
      : `Re: ${meta.subject}`;
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
      requestBody: { raw, threadId: meta.threadId },
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

// --- Self-registration ---
// Discover accounts with channel mode enabled and register one factory per account.

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
