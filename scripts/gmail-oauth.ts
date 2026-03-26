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
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
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
    console.error(
      'Download OAuth2 client credentials from GCP Console and save them there.',
    );
    process.exit(1);
  }

  const email = process.argv[2] || (await askEmail());
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
  const oauth2Client = new OAuth2Client(
    keys.client_id,
    keys.client_secret,
    redirectUri,
  );

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
        res.end(
          `Authentication successful for ${email}! You can close this window.`,
        );
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
