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

  // Read logo for the success page
  const logoPath = path.join(__dirname, '..', 'assets', 'nanoclaw-logo.png');
  let logoDataUri = '';
  try {
    const logoData = fs.readFileSync(logoPath);
    logoDataUri = `data:image/png;base64,${logoData.toString('base64')}`;
  } catch {
    // Logo not found — page will render without it
  }

  console.log(`\nAuthorizing: ${email}`);
  console.log('Opening browser for Google consent screen...');
  console.log('If browser does not open, visit:', authUrl);
  console.log('\nWaiting for authorization...');

  const server = http.createServer();
  server.listen(3000);

  await new Promise<void>((resolve, reject) => {
    server.on('request', async (req, res) => {
      if (!req.url?.startsWith('/oauth2callback')) return;

      const url = new URL(req.url, 'http://localhost:3000');
      const code = url.searchParams.get('code');

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
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

        const logoHtml = logoDataUri
          ? `<img src="${logoDataUri}" alt="NanoClaw" style="width:200px;height:auto;margin-bottom:24px;">`
          : '';

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>NanoClaw — Gmail Authorized</title></head>
<body style="display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f8f9fa;">
<div style="text-align:center;padding:48px;">
${logoHtml}
<h1 style="font-size:28px;color:#1a1a1a;margin:0 0 12px;">Gmail Connected</h1>
<p style="font-size:20px;color:#555;margin:0;">${email} authorized successfully.</p>
<p style="font-size:18px;color:#888;margin:24px 0 0;">You can close this window.</p>
</div>
</body></html>`);
        server.close();

        console.log(`\nToken saved to: ${tokenPath}`);
        resolve();
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
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
