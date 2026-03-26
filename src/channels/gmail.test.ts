import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';

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
