import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { URL } from 'node:url';
import { loadConfig } from '../shared/config.js';
import { createLogger } from '../shared/logger.js';
import { PROXY_STATE_PATH } from '../shared/paths.js';
import { classify } from './classifier.js';
import { createSseRecorder } from './sse-recorder.js';
import { writeQueueEvent } from './queue-writer.js';
import { redact } from '../shared/redact.js';
import { resolveSessionId, getProjectSlug } from '../shared/session-resolver.js';
import { eventId } from '../shared/ids.js';
import { logTurnToMarkdown } from './md-logger.js';
import { join } from 'node:path';
import { RUN_DIR } from '../shared/paths.js';

const log = createLogger('proxy');

const _upstreamCache = new Map();

function resolveUpstream(projectId, config) {
  if (projectId) {
    const cached = _upstreamCache.get(projectId);
    if (cached && Date.now() - cached.ts < 30_000) return cached.url;

    const filePath = join(RUN_DIR, 'upstream', `${projectId}.txt`);
    try {
      if (existsSync(filePath)) {
        const url = readFileSync(filePath, 'utf8').trim();
        if (url) {
          _upstreamCache.set(projectId, { url, ts: Date.now() });
          log.info({ projectId, upstream: url }, 'upstream override');
          return url;
        }
      }
    } catch (e) { log.warn({ projectId, err: e.message }, 'upstream file read error'); }
  }
  return config.proxy.upstream;
}

export function startProxy(opts = {}) {
  const config = loadConfig();
  const secret = crypto.randomBytes(16).toString('hex');
  let lastActivity = Date.now();
  const idleShutdownMs = (config.proxy.keepAlive.idleShutdownSeconds || 3600) * 1000;

  const server = http.createServer((req, res) => {
    lastActivity = Date.now();

    // Health/control endpoints
    if (req.method === 'GET') {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const qs = url.searchParams.get('secret');

      if (url.pathname === '/suicide' && qs === secret) {
        res.writeHead(200); res.end('BYE');
        cleanup();
        setTimeout(() => process.exit(0), 100);
        return;
      }
      if (url.pathname === '/health' && qs === secret) {
        res.writeHead(200); res.end('KIROKU_OK');
        return;
      }
      if (url.pathname === '/heartbeat' && qs === secret) {
        lastActivity = Date.now();
        res.writeHead(200); res.end('ALIVE');
        return;
      }
      if (url.pathname === '/health') {
        res.writeHead(403); res.end('Forbidden');
        return;
      }
    }

    // Parse project ID from URL path
    let reqUrl = req.url;
    let projectId = null;
    const urlMatch = reqUrl.match(/^\/project\/([^/]+)(\/.*)?$/);
    if (urlMatch) {
      projectId = decodeURIComponent(urlMatch[1]);
      reqUrl = urlMatch[2] || '/';
    }

    // Telemetry blocking
    if (config.proxy.telemetryBlock.enabled) {
      for (const target of config.proxy.telemetryBlock.targets) {
        if (reqUrl.startsWith(target)) {
          res.writeHead(204); res.end();
          log.debug({ path: reqUrl }, 'telemetry blocked');
          return;
        }
      }
    }

    // Collect request body
    const bodyChunks = [];
    req.on('data', chunk => bodyChunks.push(chunk));
    req.on('end', () => {
      const reqBody = Buffer.concat(bodyChunks);
      if (reqBody.length === 0 && req.method === 'POST') {
        res.writeHead(400); res.end('Empty body');
        return;
      }

      // Auth mode detection
      const authMode = req.headers['x-api-key'] ? 'api_key'
        : req.headers['authorization'] ? 'session'
        : 'unknown';

      // Parse JSON payload for classification
      let json = null;
      let payloadStr = '';
      if (reqBody.length > 0) {
        payloadStr = reqBody.toString('utf8');
        try { json = JSON.parse(payloadStr); } catch { /* not JSON */ }
      }

      const isMessagesEndpoint = req.method === 'POST' && reqUrl.includes('/v1/messages');
      const isStream = !!(json && json.stream);

      // Classify request (for logging, not interception)
      const classification = isMessagesEndpoint ? classify(json) : { intent: 'non-messages' };
      log.info({ projectId, authMode, intent: classification.intent, stream: isStream }, 'request');

      // Extract user text and tool_results from request
      let userText = '';
      let toolResults = [];
      if (json?.messages?.length > 0) {
        const lastUser = [...json.messages].reverse().find(m => m.role === 'user');
        if (lastUser) {
          const blocks = Array.isArray(lastUser.content) ? lastUser.content : [];
          const textBlocks = blocks.filter(c => c.type === 'text');
          const trBlocks = blocks.filter(c => c.type === 'tool_result');

          if (textBlocks.length > 0) {
            userText = typeof lastUser.content === 'string'
              ? lastUser.content
              : textBlocks.map(c => c.text).join('\n');
          } else if (typeof lastUser.content === 'string') {
            userText = lastUser.content;
          } else {
            // Last user message has only tool_results — look back for text
            const prevUser = [...json.messages].reverse().find(
              m => m.role === 'user' && m !== lastUser && (
                typeof m.content === 'string' ||
                (Array.isArray(m.content) && m.content.some(c => c.type === 'text'))
              )
            );
            if (prevUser) {
              userText = typeof prevUser.content === 'string'
                ? prevUser.content
                : prevUser.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
            }
          }

          toolResults = trBlocks.map(tr => ({
            tool_use_id: tr.tool_use_id,
            content: tr.content,
          }));
        }
      }

      // Forward to upstream (per-project override or default)
      const upstreamUrl = resolveUpstream(projectId, config);
      const upstream = new URL(upstreamUrl);
      if (upstreamUrl !== config.proxy.upstream) {
        log.info({ projectId, upstream: upstreamUrl, ua: req.headers['user-agent'], auth: authMode, beta: req.headers['anthropic-beta'] || 'none' }, 'upstream forwarding');
      }
      const headers = { ...req.headers };
      delete headers['host'];
      delete headers['accept-encoding'];
      if (reqBody.length > 0) headers['content-length'] = Buffer.byteLength(reqBody);

      const proxyReq = https.request({
        hostname: upstream.hostname,
        port: upstream.port || 443,
        path: reqUrl,
        method: req.method,
        headers,
      }, proxyRes => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);

        // SSE side-recording for messages endpoint
        if (isMessagesEndpoint && config.proxy.sseCaptureEnabled && isStream && proxyRes.statusCode === 200) {
          const recorder = createSseRecorder();

          proxyRes.on('data', chunk => {
            res.write(chunk); // Zero-delay passthrough
            recorder.feed(chunk);
          });

          proxyRes.on('end', () => {
            res.end();
            const result = recorder.finalize();
            if (result) {
              const convId = projectId ? resolveSessionId(projectId) : null;
              const evtId = eventId();

              // Apply DLP redaction
              const userRedaction = redact(userText);
              const assistantRedaction = redact(result.assistantText || '');

              const event = {
                event_id: evtId,
                project_id: projectId || 'default',
                conversation_id: convId,
                turn_index: 0,
                captured_at: new Date().toISOString(),
                auth_mode: authMode,
                request: {
                  model: json?.model || 'unknown',
                  system_hash: json?.system ? crypto.createHash('sha256').update(
                    typeof json.system === 'string' ? json.system : JSON.stringify(json.system)
                  ).digest('hex').substring(0, 16) : null,
                  user_text: userRedaction.text,
                  tool_results: toolResults,
                  tool_schema_names: json?.tools?.map(t => t.name) || [],
                },
                response: {
                  assistant_text: assistantRedaction.text,
                  tool_uses: result.toolUses || [],
                  stop_reason: result.stopReason || 'unknown',
                },
                redaction: {
                  applied: userRedaction.applied || assistantRedaction.applied,
                  rules_triggered: [...new Set([...userRedaction.rulesTriggered, ...assistantRedaction.rulesTriggered])],
                },
                usage: result.usage || {},
              };

              writeQueueEvent(event);

              if (config.proxy.markdownLog.enabled) {
                try { logTurnToMarkdown(event, config.proxy.markdownLog); }
                catch (err) { log.warn({ err: err.message }, 'md-logger failed'); }
              }

              log.info({ eventId: evtId, projectId }, 'turn captured');
            }
          });
        } else {
          // Non-streaming or non-messages: simple pipe
          proxyRes.pipe(res);
        }
      });

      proxyReq.on('error', (err) => {
        log.error({ err: err.message }, 'upstream error');
        if (!res.headersSent) { res.writeHead(502); res.end('Upstream error'); }
      });

      if (reqBody.length > 0) proxyReq.write(reqBody);
      proxyReq.end();
    });
  });

  const port = opts.port || config.proxy.port || 0;
  server.listen(port, '127.0.0.1', () => {
    const assignedPort = server.address().port;
    const state = { port: assignedPort, secret, pid: process.pid, startedAt: new Date().toISOString() };
    writeFileSync(PROXY_STATE_PATH, JSON.stringify(state));
    log.info({ port: assignedPort }, 'proxy started');

    if (opts.onReady) opts.onReady(state);
  });

  // Idle auto-shutdown timer
  const idleTimer = setInterval(() => {
    if (Date.now() - lastActivity > idleShutdownMs) {
      log.info('idle timeout, shutting down');
      cleanup();
      process.exit(0);
    }
  }, 30000);

  function cleanup() {
    clearInterval(idleTimer);
    try { if (existsSync(PROXY_STATE_PATH)) unlinkSync(PROXY_STATE_PATH); } catch {}
    server.close();
  }

  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  process.on('SIGINT', () => { cleanup(); process.exit(0); });

  return { server, secret, cleanup };
}

// Auto-start when spawned as daemon
if (process.env.KIROKU_DAEMON === '1') {
  import('../shared/paths.js').then(({ ensureDirs }) => {
    ensureDirs();
    startProxy();
  });
}
