import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import type { ChannelOpts } from './registry.js';
import type { GmailAccountConfig } from './gmail.js';

// Mock filesystem for discovery tests
vi.mock('fs');
vi.mock('os', () => ({ default: { homedir: () => '/mock-home' } }));

describe('Gmail channel discovery', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('discoverGmailAccounts returns accounts with channel mode enabled', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const s = String(p);
      if (s.includes('tokens')) return true;
      if (s.includes('channel-config.json')) return true;
      if (s.includes('.mcp.json')) return true;
      if (s.includes('groups')) return true;
      return false;
    });

    vi.mocked(fs.readdirSync).mockImplementation((p) => {
      const s = String(p);
      if (s.includes('tokens')) return ['user@gmail.com.json'] as any;
      if (s.includes('groups')) return ['work_consulting'] as any;
      return [];
    });

    vi.mocked(fs.statSync).mockImplementation(() => {
      return { isDirectory: () => true } as any;
    });

    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      const s = String(p);
      if (s.includes('.mcp.json')) {
        return JSON.stringify({
          mcpServers: {
            gmail_consulting: {
              env: {
                GMAIL_CREDENTIALS_PATH:
                  '/workspace/extra/gmail/user@gmail.com/token.json',
              },
            },
          },
          gmailChannel: { consulting: { enabled: true } },
        });
      }
      if (s.includes('channel-config.json')) {
        return JSON.stringify({
          consulting: {
            pollInterval: 30,
            filter: 'is:unread category:primary',
          },
        });
      }
      return '{}';
    });

    const { discoverGmailAccounts } = await import('./gmail.js');
    const accounts = discoverGmailAccounts('/mock-project');
    expect(accounts).toHaveLength(1);
    expect(accounts[0].label).toBe('consulting');
    expect(accounts[0].email).toBe('user@gmail.com');
    expect(accounts[0].groups).toContain('work_consulting');
    expect(accounts[0].pollInterval).toBe(30);
    expect(accounts[0].filter).toBe('is:unread category:primary');
  });

  it('returns empty array when tokens dir does not exist', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const { discoverGmailAccounts } = await import('./gmail.js');
    const accounts = discoverGmailAccounts('/mock-project');
    expect(accounts).toHaveLength(0);
  });

  it('skips accounts without enabled flag', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockImplementation((p) => {
      const s = String(p);
      if (s.includes('tokens')) return ['user@gmail.com.json'] as any;
      if (s.includes('groups')) return ['work_consulting'] as any;
      return [];
    });
    vi.mocked(fs.statSync).mockImplementation(
      () => ({ isDirectory: () => true }) as any,
    );
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      const s = String(p);
      if (s.includes('.mcp.json')) {
        return JSON.stringify({
          mcpServers: {
            gmail_consulting: {
              env: {
                GMAIL_CREDENTIALS_PATH:
                  '/workspace/extra/gmail/user@gmail.com/token.json',
              },
            },
          },
          gmailChannel: { consulting: { enabled: false } },
        });
      }
      if (s.includes('channel-config.json')) return '{}';
      return '{}';
    });

    const { discoverGmailAccounts } = await import('./gmail.js');
    const accounts = discoverGmailAccounts('/mock-project');
    expect(accounts).toHaveLength(0);
  });
});

describe('GmailChannel', () => {
  const mockConfig: GmailAccountConfig = {
    label: 'test',
    email: 'test@gmail.com',
    groups: ['work_team'],
    pollInterval: 30,
    filter: 'is:unread category:primary',
    tokenPath: '/mock-home/.gmail-mcp/tokens/test@gmail.com.json',
    oauthKeysPath: '/mock-home/.gmail-mcp/gcp-oauth.keys.json',
  };

  const mockOpts: ChannelOpts = {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({})),
  };

  it('has correct name based on label', async () => {
    const { GmailChannel } = await import('./gmail.js');
    const channel = new GmailChannel(mockConfig, mockOpts);
    expect(channel.name).toBe('gmail_test');
  });

  it('isConnected returns false before connect', async () => {
    const { GmailChannel } = await import('./gmail.js');
    const channel = new GmailChannel(mockConfig, mockOpts);
    expect(channel.isConnected()).toBe(false);
  });

  it('ownsJid matches jids with correct label prefix', async () => {
    const { GmailChannel } = await import('./gmail.js');
    const channel = new GmailChannel(mockConfig, mockOpts);
    expect(channel.ownsJid('gm:test:work_team')).toBe(true);
    expect(channel.ownsJid('gm:test:other_group')).toBe(true);
    expect(channel.ownsJid('gm:other:work_team')).toBe(false);
    expect(channel.ownsJid('wa:test:work_team')).toBe(false);
  });

  it('disconnect sets connected to false', async () => {
    const { GmailChannel } = await import('./gmail.js');
    const channel = new GmailChannel(mockConfig, mockOpts);
    // Manually set connected state to simulate post-connect
    (channel as any).connected = true;
    expect(channel.isConnected()).toBe(true);
    await channel.disconnect();
    expect(channel.isConnected()).toBe(false);
  });

  it('disconnect clears poll timer and backoff timeout', async () => {
    const { GmailChannel } = await import('./gmail.js');
    const channel = new GmailChannel(mockConfig, mockOpts);
    // Simulate active timers
    (channel as any).pollTimer = setInterval(() => {}, 10000);
    (channel as any).backoffTimeout = setTimeout(() => {}, 10000);
    (channel as any).connected = true;

    await channel.disconnect();

    expect((channel as any).pollTimer).toBeNull();
    expect((channel as any).backoffTimeout).toBeNull();
    expect(channel.isConnected()).toBe(false);
  });

  it('formatEmailMessage creates correct message format', async () => {
    const { GmailChannel } = await import('./gmail.js');
    const result = GmailChannel.formatEmailMessage(
      'sender@example.com',
      'Meeting Tomorrow',
      'Hi, can we meet at 3pm?',
    );
    expect(result).toBe(
      '[Email from sender@example.com] Subject: Meeting Tomorrow\n\nHi, can we meet at 3pm?',
    );
  });
});
