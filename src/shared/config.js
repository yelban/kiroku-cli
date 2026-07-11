import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { z } from 'zod';
import { CONFIG_PATH, ensureDirs } from './paths.js';

const ConfigSchema = z.object({
  version: z.number().default(15),
  proxy: z.object({
    port: z.number().default(0),
    upstream: z.string().default('https://api.anthropic.com'),
    projectIdStrategy: z.string().default('cwd_slug'),
    dlp: z.object({
      enabled: z.boolean().default(true),
      rules: z.record(z.boolean()).default({
        awsAccessKey: true,
        anthropicApiKey: true,
        openaiApiKey: true,
        githubPat: true,
        slackToken: true,
      }),
    }).default({}),
    keepAlive: z.object({
      enabled: z.boolean().default(false),
      apiKeyOnly: z.boolean().default(true),
      intervalSeconds: z.number().default(240),
      idleShutdownSeconds: z.number().default(3600),
      maxLifetimeMinutes: z.number().default(30),
      onlyWithCacheControl: z.boolean().default(true),
    }).default({}),
    telemetryBlock: z.object({
      enabled: z.boolean().default(true),
      targets: z.array(z.string()).default(['/telemetry', '/metrics', '/stats']),
    }).default({}),
    sseCaptureEnabled: z.boolean().default(true),
    storeThinkingBlocks: z.boolean().default(false),
    markdownLog: z.object({
      enabled: z.boolean().default(true),
      maxToolInputLength: z.number().default(50000),
      maxFileSizeKB: z.number().default(512),
    }).default({}),
  }).default({}),
  worker: z.object({
    enabled: z.boolean().default(true),
    pollIntervalMs: z.number().default(2000),
    maxConcurrentJobs: z.number().default(2),
    retry: z.object({
      maxAttempts: z.number().default(5),
      baseDelayMs: z.number().default(2000),
      maxDelayMs: z.number().default(60000),
    }).default({}),
    filter: z.object({
      enabled: z.boolean().default(true),
      minTextLength: z.number().default(50),
      skipPureToolTurns: z.boolean().default(true),
      trivialAssistantPhrases: z.array(z.string()).default([
        'OK', '好的', '了解', '收到', '已完成', 'Done', '完成', '可以',
      ]),
    }).default({}),
    throttle: z.object({
      enabled: z.boolean().default(true),
      maxCallsPerMinute: z.number().default(20),
      adaptive: z.boolean().default(true),
    }).default({}),
    extraction: z.object({
      provider: z.string().default('openrouter'),
      model: z.string().default('google/gemini-2.0-flash-001'),
      baseUrl: z.string().optional(),
      apiKeyEnv: z.string().default('OPENROUTER_API_KEY'),
      temperature: z.number().default(0),
      maxOutputTokens: z.number().default(1200),
      effort: z.enum(['low', 'medium', 'high', 'max']).default('medium'),
      batch: z.object({
        enabled: z.boolean().default(false),
        maxTurnsPerCall: z.number().default(10),
        minTurnsPerCall: z.number().default(3),
        flushTimeoutMs: z.number().default(30000),
        outputTokenBudget: z.number().default(6000),
        estimateOutputPerTurn: z.number().default(800),
      }).default({}),
      fallback: z.object({
        provider: z.string().default('ollama'),
        model: z.string().default('qwen2.5:14b-instruct-q4_K_M'),
        baseUrl: z.string().default('http://127.0.0.1:11434'),
      }).default({}),
    }).default({}),
    embedding: z.object({
      model: z.string().default('Xenova/bge-m3'),
      dtype: z.string().default('q8'),
      dimensions: z.number().default(1024),
      batchSize: z.number().default(16),
    }).default({}),
    supersede: z.object({
      enabled: z.boolean().default(true),
      semanticThreshold: z.number().default(0.58),
      stateTaskThreshold: z.number().default(0.8),
    }).default({}),
    decay: z.object({
      enabled: z.boolean().default(true),
      sweepIntervalMs: z.number().default(21600000), // 6h
      halfLifeHours: z.number().default(168),         // 7d
      accessBoost: z.number().default(0.05),
      extractedBaseHeat: z.number().default(0.7),
      halfLifeByType: z.record(z.number().nullable()).default({
        state: 168,       // 7d
        episodic: 336,    // 14d
        task: 504,        // 21d
        semantic: 1440,   // 60d
        preference: null, // never
      }),
      floorByType: z.record(z.number()).default({
        state: 0.05,
        episodic: 0.1,
        task: 0.15,
        semantic: 0.3,
        preference: 0.7,
      }),
      freezeAfterInactiveDays: z.number().default(7),
    }).default({}),
    repoGrounding: z.object({
      enabled: z.boolean().default(true),
      confirmHours: z.number().default(6),
    }).default({}),
  }).default({}),
  mcp: z.object({
    serverName: z.string().default('kiroku-memory'),
    serverVersion: z.string().default('15.0.0'),
    tools: z.array(z.string()).default(['memory_search', 'sql_readonly', 'memory_save', 'memory_forget']),
    sqlSandbox: z.object({
      maxRows: z.number().default(200),
      maxCellBytes: z.number().default(2048),
      timeoutMs: z.number().default(3000),
    }).default({}),
    projectBrief: z.object({
      enabled: z.boolean().default(true),
      maxFacts: z.number().default(50),
      maxTokens: z.number().default(4000), // 0 = unlimited
    }).default({}),
    search: z.object({
      ranking: z.object({
        simWeight: z.number().default(0.65),
        heatWeight: z.number().default(0.15),
        recencyWeight: z.number().default(0.20),
        halfLifeDays: z.number().default(30),
      }).default({}),
    }).default({}),
  }).default({}),
  license: z.object({
    enabled: z.boolean().default(true),
    freemium: z.object({
      factLimit: z.number().default(500),
      dailyExtractLimit: z.number().default(50),
      embeddingEnabled: z.boolean().default(false),
    }).default({}),
  }).default({}),
}).default({});

let _config = null;

export function loadConfig() {
  if (_config) return _config;
  ensureDirs();
  let raw = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    } catch {
      // use defaults
    }
  }
  _config = ConfigSchema.parse(raw);
  return _config;
}

export function saveDefaultConfig() {
  ensureDirs();
  if (!existsSync(CONFIG_PATH)) {
    const defaults = ConfigSchema.parse({});
    writeFileSync(CONFIG_PATH, JSON.stringify(defaults, null, 2) + '\n', 'utf8');
  }
}

export function resetConfigCache() {
  _config = null;
}
