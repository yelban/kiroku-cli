import { readdirSync, readFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { QUEUE_INCOMING, QUEUE_PROCESSING, QUEUE_DONE, QUEUE_DEAD, WORKER_STATE_PATH } from '../shared/paths.js';
import { writeFileSync, unlinkSync } from 'node:fs';
import { loadConfig } from '../shared/config.js';
import { createLogger } from '../shared/logger.js';
import { initDb, runMigrations, closeDb } from '../shared/db.js';
import { jobId } from '../shared/ids.js';
import { extract, extractBatch, setPromptProvider } from './extractor.js';
import { embedTexts, initEmbedder } from './embedder.js';
import { initPromptLoader, getPrompt, stopPromptLoader } from './prompt-loader.js';
import { setDb, storeTurn, storeEntities, storeFacts, storeEmbeddings, createExtractionJob, updateExtractionJob, runDecaySweep, runCompactionSweep } from './store.js';
import { getLicenseState } from '../license/license-state.js';
import { shouldSkipTurn } from './filter.js';
import { createThrottle } from './throttle.js';

const log = createLogger('worker');

let running = false;
let pollTimer = null;
let decayTimer = null;
let _licenseState = null;
let _dailyExtractCount = 0;
let _dailyExtractDate = '';
const _retryAttempts = new Map(); // filename -> { count, nextAttemptAfter }
const _throttle = createThrottle();

// Batch pipeline state (Phase 2)
const _batchBuffer = []; // [{ filename, event, processingPath, jid, assistantTurnId }]
let _batchTimer = null;
let _batchFlushing = false;

export async function startWorker() {
  const config = loadConfig();
  if (!config.worker.enabled) {
    log.info('worker disabled in config');
    return;
  }

  log.info('initializing worker');

  // Initialize DB
  const db = await initDb();
  runMigrations();
  setDb(db);

  // Load license state
  _licenseState = await getLicenseState();
  log.info({ licensed: _licenseState.licensed, tier: _licenseState.tier }, 'license state loaded');

  // Initialize prompt loader (3-layer: memory → disk cache → remote)
  await initPromptLoader();
  setPromptProvider(getPrompt);
  log.info('prompt loader initialized');

  // Pre-warm embedding model (skip if free tier with embedding disabled)
  if (_licenseState.embeddingEnabled) {
    log.info('loading embedding model (first run may download ~600MB)');
    await initEmbedder(config.worker.embedding);
    log.info('embedding model ready');
  } else {
    log.info('embedding disabled (free tier)');
  }

  running = true;
  writeFileSync(WORKER_STATE_PATH, JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
  }));

  // Run initial decay + compaction sweep
  if (config.worker.decay.enabled) {
    try { runDecaySweep(config); } catch (err) { log.warn({ err: err.message }, 'initial decay sweep failed'); }
    try { runCompactionSweep(db); } catch (err) { log.warn({ err: err.message }, 'initial compaction sweep failed'); }
    decayTimer = setInterval(() => {
      try { runDecaySweep(config); } catch (err) { log.warn({ err: err.message }, 'decay sweep failed'); }
      try { runCompactionSweep(db); } catch (err) { log.warn({ err: err.message }, 'compaction sweep failed'); }
    }, config.worker.decay.sweepIntervalMs);
  }

  // Start polling
  const pollInterval = config.worker.pollIntervalMs;
  pollTimer = setInterval(() => pollQueue(config), pollInterval);
  log.info({ pollInterval }, 'worker started');

  // Also poll immediately
  pollQueue(config);
}

async function pollQueue(config) {
  if (!running) return;

  // Reset daily counter at midnight
  const today = new Date().toISOString().slice(0, 10);
  if (today !== _dailyExtractDate) {
    _dailyExtractCount = 0;
    _dailyExtractDate = today;
  }

  // Check daily extract limit (free tier)
  if (_licenseState && !_licenseState.licensed && _dailyExtractCount >= _licenseState.dailyExtractLimit) {
    log.debug({ count: _dailyExtractCount, limit: _licenseState.dailyExtractLimit }, 'daily extract limit reached');
    return;
  }

  try {
    const files = readdirSync(QUEUE_INCOMING)
      .filter(f => f.endsWith('.jsonl') && !f.startsWith('.'))
      .sort(); // Process in order

    const now = Date.now();
    for (const file of files.slice(0, config.worker.maxConcurrentJobs)) {
      // Re-check limit before each file
      if (_licenseState && !_licenseState.licensed && _dailyExtractCount >= _licenseState.dailyExtractLimit) {
        log.warn({ count: _dailyExtractCount }, 'daily extract limit reached, skipping remaining');
        break;
      }
      // Skip files still in backoff window
      const retry = _retryAttempts.get(file);
      if (retry && now < retry.nextAttemptAfter) continue;
      // Throttle by per-minute call budget
      if (!_throttle.check(config.worker.throttle)) {
        log.debug({ window: _throttle.size() }, 'throttled, will retry next poll');
        break;
      }
      await processFile(file, config);
      _dailyExtractCount++;
    }
  } catch (err) {
    log.error({ err: err.message }, 'poll error');
  }
}

async function processFile(filename, config) {
  const srcPath = join(QUEUE_INCOMING, filename);
  const processingPath = join(QUEUE_PROCESSING, filename);
  const donePath = join(QUEUE_DONE, filename);
  const deadPath = join(QUEUE_DEAD, filename);

  try {
    // Atomic move to processing
    renameSync(srcPath, processingPath);
  } catch (err) {
    // File already being processed or gone
    return;
  }

  let event;
  try {
    const content = readFileSync(processingPath, 'utf8').trim();
    event = JSON.parse(content);
  } catch (err) {
    log.error({ filename, err: err.message }, 'failed to parse queue file');
    renameSync(processingPath, deadPath);
    return;
  }

  const jid = jobId();
  createExtractionJob(jid, filename, event.event_id);

  try {
    updateExtractionJob(jid, { status: 'processing', startedAt: new Date().toISOString() });

    // 1. Store the turn
    const turnData = storeTurn(event);

    // 2. Filter trivial turns (skip LLM call but keep turn history)
    const skipReason = shouldSkipTurn(event, config.worker.filter);
    if (skipReason) {
      updateExtractionJob(jid, { status: 'done', finishedAt: new Date().toISOString() });
      renameSync(processingPath, donePath);
      log.info({ jid, eventId: event.event_id, skipReason }, 'turn skipped by filter');
      return;
    }

    // 3. Extract entities and facts via LLM
    const combinedText = [event.request?.user_text, event.response?.assistant_text]
      .filter(Boolean).join('\n\n---\n\n');

    if (!combinedText.trim()) {
      updateExtractionJob(jid, { status: 'done', finishedAt: new Date().toISOString() });
      renameSync(processingPath, donePath);
      log.info({ jid, eventId: event.event_id }, 'skipped (no text)');
      return;
    }

    // 4. If batch mode is enabled (anthropic provider only), hand off to batch pipeline.
    const batchCfg = config.worker.extraction.batch;
    if (batchCfg?.enabled && config.worker.extraction.provider === 'anthropic') {
      bufferEvent({
        filename,
        event,
        processingPath,
        jid,
        assistantTurnId: turnData.assistantTurnId,
        combinedText,
      }, config);
      return;
    }

    const extraction = await extractWithRetry(combinedText, config);

    // 5. Store entities and facts
    const entityMap = storeEntities(extraction.entities, event.project_id);
    const factResults = storeFacts(extraction.facts, entityMap, event.project_id, turnData.assistantTurnId, _licenseState);

    // 6. Generate embeddings only for actually inserted facts (filter out deduped nulls)
    const inserted = factResults
      .map((fid, i) => fid ? { fid, fact: extraction.facts[i] } : null)
      .filter(Boolean);

    if (inserted.length > 0 && (!_licenseState || _licenseState.embeddingEnabled)) {
      const factTexts = inserted.map(p => `${p.fact.subject} ${p.fact.predicate} ${p.fact.object}`);
      const embeddings = await embedTexts(factTexts);
      storeEmbeddings(
        inserted.map(p => p.fid),
        embeddings,
        event.project_id,
        inserted.map(p => p.fact),
      );
    }

    updateExtractionJob(jid, {
      status: 'done',
      provider: config.worker.extraction.provider,
      model: config.worker.extraction.model,
      finishedAt: new Date().toISOString(),
    });

    renameSync(processingPath, donePath);
    log.info({ jid, eventId: event.event_id, entities: extraction.entities.length, facts: extraction.facts.length, inserted: inserted.length }, 'processed');

  } catch (err) {
    const retry = _retryAttempts.get(filename) || { count: 0 };
    const attempt = retry.count + 1;
    const maxAttempts = config.worker.retry.maxAttempts;

    log.error({ jid, attempt, maxAttempts, err: err.message }, 'processing failed');
    updateExtractionJob(jid, {
      status: attempt >= maxAttempts ? 'failed' : 'retrying',
      lastError: err.message,
      attempts: attempt,
    });

    if (attempt >= maxAttempts) {
      renameSync(processingPath, deadPath);
      _retryAttempts.delete(filename);
      log.warn({ jid, filename, attempts: attempt }, 'moved to dead-letter after max retries');
    } else {
      // Move back to incoming with exponential backoff delay
      renameSync(processingPath, srcPath);
      const delay = Math.min(
        config.worker.retry.baseDelayMs * Math.pow(2, attempt - 1),
        config.worker.retry.maxDelayMs,
      );
      _retryAttempts.set(filename, { count: attempt, nextAttemptAfter: Date.now() + delay });
      log.info({ jid, filename, attempt, delay }, 'scheduled retry');
    }
  }
}

async function extractWithRetry(text, config) {
  const maxAttempts = config.worker.retry.maxAttempts;
  let lastErr;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await extract(text, config.worker.extraction);
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        const delay = Math.min(
          config.worker.retry.baseDelayMs * Math.pow(2, attempt - 1),
          config.worker.retry.maxDelayMs,
        );
        log.warn({ attempt, delay, err: err.message }, 'extraction retry');
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  throw lastErr;
}

// --- Batch pipeline (Phase 2) ---

function estimateInputTokens(event) {
  const text = (event?.request?.user_text || '') + (event?.response?.assistant_text || '');
  return Math.ceil(text.length / 3);
}

function computeBatchTakeCount(buffer, batchCfg) {
  const max = batchCfg.maxTurnsPerCall || 10;
  const budget = (batchCfg.outputTokenBudget || 6000) * 4;
  let total = 0;
  let count = 0;
  for (const item of buffer) {
    const t = estimateInputTokens(item.event);
    if (count > 0 && total + t > budget) break;
    total += t;
    count++;
    if (count >= max) break;
  }
  return Math.max(1, count);
}

function bufferEvent(item, config) {
  _batchBuffer.push(item);
  const batchCfg = config.worker.extraction.batch;
  if (_batchBuffer.length >= (batchCfg.maxTurnsPerCall || 10)) {
    flushBatch(config).catch(err => log.error({ err: err.message }, 'flushBatch (size trigger) failed'));
    return;
  }
  scheduleBatchFlush(config);
}

function scheduleBatchFlush(config) {
  if (_batchTimer) return;
  const ms = config.worker.extraction.batch.flushTimeoutMs || 30_000;
  _batchTimer = setTimeout(() => {
    _batchTimer = null;
    flushBatch(config, { force: true }).catch(err => log.error({ err: err.message }, 'flushBatch (timer) failed'));
  }, ms);
}

async function flushBatch(config, opts = {}) {
  if (_batchFlushing) return;
  if (_batchBuffer.length === 0) return;
  const batchCfg = config.worker.extraction.batch;
  const minTurns = batchCfg.minTurnsPerCall || 1;
  if (!opts.force && _batchBuffer.length < minTurns) {
    scheduleBatchFlush(config);
    return;
  }
  if (_batchTimer) {
    clearTimeout(_batchTimer);
    _batchTimer = null;
  }
  const take = computeBatchTakeCount(_batchBuffer, batchCfg);
  const items = _batchBuffer.splice(0, take);
  _batchFlushing = true;
  try {
    await processBatch(items, config);
  } catch (err) {
    log.error({ err: err.message, batchSize: items.length }, 'processBatch threw');
  } finally {
    _batchFlushing = false;
    if (_batchBuffer.length > 0) scheduleBatchFlush(config);
  }
}

async function processBatch(items, config) {
  const turns = items.map(item => ({ text: item.combinedText }));

  let result;
  try {
    result = await extractBatch(turns, config.worker.extraction);
  } catch (err) {
    log.error({ err: err.message, batchSize: items.length }, 'batch extraction failed, requeueing all');
    for (const item of items) retryItem(item, config, err);
    return;
  }

  const completedByIndex = new Map();
  for (const t of result.completedTurns || []) completedByIndex.set(t.turn_index, t);

  const errorsByIndex = new Map();
  for (const e of result.errors || []) {
    if (e.kind === 'json_parse_error' && typeof e.turn_index === 'number') {
      errorsByIndex.set(e.turn_index, e);
    }
  }

  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    const turn = completedByIndex.get(idx);
    const parseErr = errorsByIndex.get(idx);

    if (turn) {
      try {
        await persistBatchTurn(item, turn, config);
      } catch (err) {
        log.error({ jid: item.jid, idx, err: err.message }, 'batch turn persist failed, requeueing');
        retryItem(item, config, err);
      }
    } else if (parseErr) {
      log.error({ jid: item.jid, idx, parseErr }, 'batch turn JSON parse failed, dead-lettering');
      updateExtractionJob(item.jid, {
        status: 'failed',
        lastError: `batch json parse: ${parseErr.message || 'invalid JSON'}`,
      });
      try { renameSync(item.processingPath, join(QUEUE_DEAD, item.filename)); } catch { /* already moved */ }
      _retryAttempts.delete(item.filename);
    } else {
      log.warn({ jid: item.jid, idx, stopReason: result.stopReason }, 'batch turn truncated, requeueing');
      retryItem(item, config, new Error(`batch turn ${idx} truncated (stop=${result.stopReason || 'unknown'})`));
    }
  }
}

async function persistBatchTurn(item, turn, config) {
  const projectId = item.event.project_id;
  const entityMap = storeEntities(turn.entities || [], projectId);
  const factResults = storeFacts(turn.facts || [], entityMap, projectId, item.assistantTurnId, _licenseState);

  const facts = turn.facts || [];
  const inserted = factResults
    .map((fid, i) => fid ? { fid, fact: facts[i] } : null)
    .filter(Boolean);

  if (inserted.length > 0 && (!_licenseState || _licenseState.embeddingEnabled)) {
    const factTexts = inserted.map(p => `${p.fact.subject} ${p.fact.predicate} ${p.fact.object}`);
    const embeddings = await embedTexts(factTexts);
    storeEmbeddings(
      inserted.map(p => p.fid),
      embeddings,
      projectId,
      inserted.map(p => p.fact),
    );
  }

  updateExtractionJob(item.jid, {
    status: 'done',
    provider: config.worker.extraction.provider,
    model: config.worker.extraction.model,
    finishedAt: new Date().toISOString(),
  });
  renameSync(item.processingPath, join(QUEUE_DONE, item.filename));
  _retryAttempts.delete(item.filename);
  log.info({
    jid: item.jid,
    eventId: item.event.event_id,
    entities: (turn.entities || []).length,
    facts: facts.length,
    inserted: inserted.length,
  }, 'batch turn processed');
}

function retryItem(item, config, err) {
  const retry = _retryAttempts.get(item.filename) || { count: 0 };
  const attempt = retry.count + 1;
  const maxAttempts = config.worker.retry.maxAttempts;

  updateExtractionJob(item.jid, {
    status: attempt >= maxAttempts ? 'failed' : 'retrying',
    lastError: err.message,
    attempts: attempt,
  });

  if (attempt >= maxAttempts) {
    try { renameSync(item.processingPath, join(QUEUE_DEAD, item.filename)); } catch { /* already moved */ }
    _retryAttempts.delete(item.filename);
    log.warn({ jid: item.jid, filename: item.filename, attempts: attempt }, 'batch item moved to dead-letter');
    return;
  }

  try { renameSync(item.processingPath, join(QUEUE_INCOMING, item.filename)); }
  catch (e) { log.warn({ filename: item.filename, err: e.message }, 'failed to requeue batch item'); }

  const delay = Math.min(
    config.worker.retry.baseDelayMs * Math.pow(2, attempt - 1),
    config.worker.retry.maxDelayMs,
  );
  _retryAttempts.set(item.filename, { count: attempt, nextAttemptAfter: Date.now() + delay });
  log.info({ jid: item.jid, filename: item.filename, attempt, delay }, 'batch item scheduled retry');
}

function rescueBatchBuffer() {
  if (_batchBuffer.length === 0) return;
  for (const item of _batchBuffer) {
    try {
      renameSync(item.processingPath, join(QUEUE_INCOMING, item.filename));
      log.info({ filename: item.filename }, 'batch buffer rescued back to incoming');
    } catch (err) {
      log.warn({ filename: item.filename, err: err.message }, 'failed to rescue batch buffer item');
    }
  }
  _batchBuffer.length = 0;
}

export function stopWorker() {
  running = false;
  stopPromptLoader();
  if (decayTimer) {
    clearInterval(decayTimer);
    decayTimer = null;
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (_batchTimer) {
    clearTimeout(_batchTimer);
    _batchTimer = null;
  }
  rescueBatchBuffer();
  closeDb();
  try { if (existsSync(WORKER_STATE_PATH)) unlinkSync(WORKER_STATE_PATH); } catch {}
  log.info('worker stopped');
}

process.on('SIGTERM', () => { stopWorker(); process.exit(0); });
process.on('SIGINT', () => { stopWorker(); process.exit(0); });
process.on('SIGUSR1', () => {
  log.info('SIGUSR1 received, immediate poll');
  const config = loadConfig();
  pollQueue(config);
});

// Auto-start when spawned as daemon or run directly
if (process.env.KIROKU_DAEMON === '1' || process.argv[1]?.endsWith('worker.js')) {
  startWorker().catch(err => {
    console.error('Worker fatal:', err);
    process.exit(1);
  });
}
