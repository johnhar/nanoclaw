import fs from 'fs';
import path from 'path';
import os from 'os';

import { logger } from '../logger.js';

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
      channelConfig = JSON.parse(
        fs.readFileSync(CHANNEL_CONFIG_PATH, 'utf8'),
      );
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
        f !== 'global' &&
        fs.statSync(path.join(groupsDir, f)).isDirectory(),
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
      oauthKeysPath: path.join(GMAIL_MCP_DIR, 'gcp-oauth.keys.json'),
    });
  }

  return accounts;
}
