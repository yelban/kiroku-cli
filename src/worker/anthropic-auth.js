import { spawnSync } from 'node:child_process';
import { platform } from 'node:os';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import https from 'node:https';
import { createLogger } from '../shared/logger.js';

const log = createLogger('anthropic-auth');

const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const REFRESH_ENDPOINTS = [
  'https://platform.claude.com/v1/oauth/token',
  'https://console.anthropic.com/v1/oauth/token',
];
const OAUTH_BETAS = 'claude-code-20250219,oauth-2025-04-20';

let _cached = null;
let _claudeCodeVersion = null;

function getClaudeCodeVersion() {
  if (_claudeCodeVersion) return _claudeCodeVersion;
  try {
    const r = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 3000 });
    const m = r.stdout?.match(/([\d.]+)/);
    _claudeCodeVersion = m ? m[1] : '2.1.74';
  } catch {
    _claudeCodeVersion = '2.1.74';
  }
  return _claudeCodeVersion;
}

function isOAuthToken(key) {
  if (!key) return false;
  if (key.startsWith('sk-ant-api')) return false;
  if (key.startsWith('sk-ant-')) return true;
  if (key.startsWith('eyJ')) return true;
  if (key.startsWith('cc-')) return true;
  return false;
}

function readFromKeychain() {
  if (platform() !== 'darwin') return null;
  try {
    const r = spawnSync('security', [
      'find-generic-password', '-s', 'Claude Code-credentials', '-w',
    ], { encoding: 'utf8', timeout: 5000 });
    if (r.status !== 0 || !r.stdout) return null;
    const data = JSON.parse(r.stdout.trim());
    const oauth = data?.claudeAiOauth;
    if (!oauth?.accessToken) return null;
    return {
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken || '',
      expiresAt: oauth.expiresAt || 0,
    };
  } catch {
    return null;
  }
}

function readFromFile() {
  const credPath = join(homedir(), '.claude', '.credentials.json');
  if (!existsSync(credPath)) return null;
  try {
    const data = JSON.parse(readFileSync(credPath, 'utf8'));
    const oauth = data?.claudeAiOauth;
    if (!oauth?.accessToken) return null;
    return {
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken || '',
      expiresAt: oauth.expiresAt || 0,
    };
  } catch {
    return null;
  }
}

function isValid(creds) {
  if (!creds?.accessToken) return false;
  if (!creds.expiresAt) return true;
  return Date.now() < (creds.expiresAt - 60_000);
}

function writeCredentialsFile(newCreds) {
  const credPath = join(homedir(), '.claude', '.credentials.json');
  let existing = {};
  try {
    if (existsSync(credPath)) {
      existing = JSON.parse(readFileSync(credPath, 'utf8'));
    }
  } catch { /* use empty */ }

  existing.claudeAiOauth = {
    ...(existing.claudeAiOauth || {}),
    accessToken: newCreds.accessToken,
    refreshToken: newCreds.refreshToken,
    expiresAt: newCreds.expiresAt,
  };

  const tmpPath = credPath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(existing, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmpPath, credPath);
}

function httpsPost(endpoint, body, headers) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint);
    const req = https.request({
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
        else resolve(data);
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('Refresh request timeout')));
    req.write(body);
    req.end();
  });
}

async function refreshToken(creds) {
  if (!creds.refreshToken) return null;
  const body = `grant_type=refresh_token&refresh_token=${encodeURIComponent(creds.refreshToken)}&client_id=${OAUTH_CLIENT_ID}`;
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': `claude-cli/${getClaudeCodeVersion()} (external, cli)`,
  };

  for (const endpoint of REFRESH_ENDPOINTS) {
    try {
      const data = await httpsPost(endpoint, body, headers);
      const resp = JSON.parse(data);
      if (!resp.access_token) continue;
      const newCreds = {
        accessToken: resp.access_token,
        refreshToken: resp.refresh_token || creds.refreshToken,
        expiresAt: Date.now() + (resp.expires_in || 3600) * 1000,
      };
      writeCredentialsFile(newCreds);
      log.info('OAuth token refreshed successfully');
      return newCreds;
    } catch (e) {
      log.debug('refresh failed on %s: %s', endpoint, e.message);
      continue;
    }
  }
  return null;
}

export async function resolveAnthropicAuth(extractionConfig) {
  const baseUrl = extractionConfig.baseUrl || 'https://api.anthropic.com';

  // Priority 1: CLAUDE_CODE_OAUTH_TOKEN env
  const oauthEnv = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (oauthEnv) {
    return { token: oauthEnv, authType: 'bearer', isOAuth: true, baseUrl };
  }

  // Priority 2: ANTHROPIC_AUTH_TOKEN env
  const authTokenEnv = process.env.ANTHROPIC_AUTH_TOKEN;
  if (authTokenEnv) {
    return { token: authTokenEnv, authType: 'bearer', isOAuth: isOAuthToken(authTokenEnv), baseUrl };
  }

  // Priority 3: ANTHROPIC_API_KEY env (or custom apiKeyEnv from config)
  const apiKeyEnvName = extractionConfig.apiKeyEnv || 'ANTHROPIC_API_KEY';
  const apiKey = process.env[apiKeyEnvName] || process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    if (isOAuthToken(apiKey)) {
      return { token: apiKey, authType: 'bearer', isOAuth: true, baseUrl };
    }
    return { token: apiKey, authType: 'api-key', isOAuth: false, baseUrl };
  }

  // Priority 4: macOS Keychain / credentials file (with auto-refresh)
  if (_cached && isValid(_cached)) {
    return { token: _cached.accessToken, authType: 'bearer', isOAuth: true, baseUrl };
  }

  let creds = readFromKeychain() || readFromFile();
  if (!creds) {
    throw new Error('anthropic: no credentials found — set CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_AUTH_TOKEN, or ANTHROPIC_API_KEY');
  }

  if (isValid(creds)) {
    _cached = creds;
    return { token: creds.accessToken, authType: 'bearer', isOAuth: true, baseUrl };
  }

  log.info('Keychain OAuth token expired, attempting refresh');
  const refreshed = await refreshToken(creds);
  if (!refreshed) {
    throw new Error('anthropic: OAuth token expired and refresh failed — run "claude setup-token" to re-authenticate');
  }

  _cached = refreshed;
  return { token: refreshed.accessToken, authType: 'bearer', isOAuth: true, baseUrl };
}

export function buildAuthHeaders(auth) {
  const headers = { 'anthropic-version': '2023-06-01' };
  if (auth.authType === 'bearer') {
    headers['Authorization'] = `Bearer ${auth.token}`;
  } else {
    headers['x-api-key'] = auth.token;
  }
  if (auth.isOAuth) {
    headers['anthropic-beta'] = OAUTH_BETAS;
    headers['user-agent'] = `claude-cli/${getClaudeCodeVersion()} (external, cli)`;
    headers['x-app'] = 'cli';
  }
  return headers;
}
