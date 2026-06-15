import * as http from 'http';
import * as url from 'url';
import * as fs from 'fs';
import * as path from 'path';
import type { AddressInfo } from 'net';

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // unix ms
}

const TOKENS_PATH = path.resolve(process.cwd(), 'tokens.json');
const SCOPE = 'https://www.googleapis.com/auth/photoslibrary.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export function readTokens(): Tokens | null {
  try {
    return JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf-8')) as Tokens;
  } catch {
    return null;
  }
}

function writeTokens(tokens: Tokens): void {
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2));
}

async function exchangeCode(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string
): Promise<Tokens> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  if (!res.ok) throw new Error(`Token exchange failed: ${await res.text()}`);

  const data = await res.json() as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const tokens: Tokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  writeTokens(tokens);
  return tokens;
}

async function refreshAccessToken(clientId: string, clientSecret: string, refreshToken: string): Promise<Tokens> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) throw new Error(`Token refresh failed: ${await res.text()}`);

  const data = await res.json() as {
    access_token: string;
    expires_in: number;
  };

  const tokens: Tokens = {
    accessToken: data.access_token,
    refreshToken, // refresh tokens don't rotate unless explicitly revoked
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  writeTokens(tokens);
  return tokens;
}

export async function getValidAccessToken(clientId: string, clientSecret: string): Promise<string> {
  const tokens = readTokens();
  if (!tokens) throw new Error('Not authenticated. Run `lmpg config` first.');

  // Refresh 60s before expiry
  if (Date.now() < tokens.expiresAt - 60_000) return tokens.accessToken;

  const refreshed = await refreshAccessToken(clientId, clientSecret, tokens.refreshToken);
  return refreshed.accessToken;
}

export async function doOAuthFlow(
  clientId: string,
  clientSecret: string,
  openUrl: (url: string) => Promise<void>
): Promise<Tokens> {
  return new Promise((resolve, reject) => {
    let redirectUri = '';

    const server = http.createServer(async (req, res) => {
      const parsed = url.parse(req.url ?? '/', true);
      const code = parsed.query['code'] as string | undefined;
      const error = parsed.query['error'] as string | undefined;

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if (error || !code) {
        res.end(`<h2>Authorization failed: ${error ?? 'no code returned'}</h2><p>You can close this tab.</p>`);
        server.close();
        reject(new Error(`OAuth error: ${error ?? 'no code'}`));
        return;
      }

      res.end('<h2>✅ Authorized! You can close this tab and return to the terminal.</h2>');
      server.close();

      try {
        resolve(await exchangeCode(code, clientId, clientSecret, redirectUri));
      } catch (err) {
        reject(err);
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      redirectUri = `http://localhost:${port}`;

      const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      authUrl.searchParams.set('client_id', clientId);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', SCOPE);
      authUrl.searchParams.set('access_type', 'offline');
      authUrl.searchParams.set('prompt', 'consent'); // ensures refresh_token is returned

      openUrl(authUrl.toString()).catch(reject);
    });

    server.on('error', reject);
  });
}
