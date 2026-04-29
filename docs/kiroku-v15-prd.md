# Kiroku V15 PRD - 合規企業級 AI 記憶網關

## 0. 定位

合規 Claude/MCP 記憶側車：**自動寫入帶外，手動寫入帶內，讀取帶內，快取穩定，主對話零入侵**。

三個獨立 Node.js 模組：
1. `kiroku-aegis-proxy` — 雙模判斷、DLP 脫敏、旁路側錄、佇列落盤
2. `kiroku-memory-worker` — 萃取、向量化、SQLite 寫入
3. `kiroku-mcp-gateway` — MCP stdio 記憶讀寫 + SQL 沙盒

---

## 1. 絕對紅線

| # | 規則 | 理由 |
|---|------|------|
| R1 | Pro/Max 訂閱模式禁止保活 | 消耗 Message Limits 導致帳號鎖死 |
| R2 | 禁止動態修改 `.claude/CLAUDE.md` | System Prompt 前綴快取雪崩 |
| R3 | Proxy 層禁止偽造 MCP Tool Result | 違反合規與協議安全 |
| R4 | Proxy 禁止攔截請求回 mock SSE/JSON | V14 的標題/預測攔截全部廢止 |
| R5 | 私鑰不進 repo、不進安裝包 | 安全底線 |

---

## 2. V14 → V15 遷移判定

### 2.1 保留（概念，非程式碼）

| V14 模式 | V14 位置 | V15 保留方式 |
|----------|---------|-------------|
| Daemon state file | `DAEMON_STATE_FILE` L19 | `~/.kiroku/run/proxy.state.json` |
| Detached process spawn | `spawn(execPath, ['--daemon'], {detached:true})` L595 | CLI `kiroku start` 沿用 |
| Project ID from CWD | `cwd().replace(...)` L550 | 保留 `/project/<id>` URL 路由 |
| Health/heartbeat endpoint | `/health`, `/heartbeat` L322-323 | 保留，加 secret 驗證 |
| SSE 旁路側錄 | response chunk 收集 L420-452 | 改用 `eventsource-parser` streaming |
| Ed25519 license verify | PUBLIC_KEY verify L491-531 | 公鑰改從 `~/.kiroku/license/public.pem` 讀取 |
| Token 計費追蹤 | `cache_read_input_tokens` regex L455 | 寫入 `turns` 表欄位 |
| Idle auto-shutdown | 10min 超時 L271-279 | 保留，改為可設定 |

### 2.2 必須移除

| V14 行為 | V14 位置 | 理由 |
|----------|---------|------|
| Ghost keepalive ping (max_tokens=1) | `fireSinglePing()` L296-309, 240s interval L288 | 紅線 R1（Pro/Max）；API key mode 保留為可選 |
| 攔截標題/預測 → 回 mock SSE | `intent.includes("產生對話標題")` L372-388 | 紅線 R3/R4 |
| 請求意圖分類用於攔截決策 | `intent` 整套判斷 L345-361 | Proxy 不該有攔截能力 |
| 內聯 .md 日誌寫入 | `logToFile(projectId, ...)` L250-265 | 改為 .jsonl queue dump |
| `delete env.ANTHROPIC_API_KEY` | L552 | V15 不操控環境變數 |
| Emoji 日誌渲染 | `processLogLine()` L187-203 | 改為結構化 pino log |

### 2.3 必須修正

| V14 問題 | 修正方式 |
|----------|---------|
| `keygen.js` 私鑰硬編碼 L21-23 | 拆為 `scripts/gen-keypair.js` + `scripts/sign-license.js` |
| 公鑰硬編碼在 god-mode.js L491-493 | 從 `~/.kiroku/license/public.pem` 讀取 |
| `Buffer.concat` 全 response 後解析 L410-418 | 改用 `eventsource-parser` 逐 chunk streaming parse |
| `LOG_DIR = os.tmpdir()` L20 | 改為 `~/.kiroku/data/queue/` + `~/.kiroku/logs/` |

---

## 3. 架構流

### 寫入流（帶外無感 Push）
```
Claude/Client ──req──▶ Aegis Proxy ──passthrough──▶ api.anthropic.com
                          │ (response streaming)
                          ├─ eventsource-parser side-record
                          ├─ DLP redact
                          └─ queue-writer ──▶ ~/.kiroku/data/queue/incoming/*.jsonl

[Background]
Memory Worker ──poll──▶ incoming/*.jsonl
                          ├─ LLM extraction (OpenRouter/Ollama)
                          ├─ local embedding (bge-m3)
                          └─ write ──▶ memory.sqlite
```

### 讀取流（帶內按需 Pull）
```
Claude/Client ──MCP stdio──▶ kiroku-mcp-gateway ──read──▶ memory.sqlite
                                                     └─ compact markdown ──▶ Claude
```

### 手動寫入流（帶內顯式 Push）
```
使用者說「記住 X」
  └─ AI 呼叫 memory_save tool ──▶ kiroku-mcp-gateway ──write──▶ memory.sqlite
                                                          └─ Worker 非同步補算 embedding
```
兩條寫入管道互補：自動管道 (Proxy→Worker) 全量捕捉；手動管道 (MCP tool) 精準儲存使用者明確指示。

---

## 4. 專案資料夾結構

```
kiroku-v15/
├── package.json
├── .env.example
├── .gitignore
├── bin/
│   └── kiroku.js                   # CLI 入口 (init/start/stop/status/doctor/export)
├── src/
│   ├── shared/
│   │   ├── constants.js            # 安全常數 (SQL deny patterns, DLP regex, PRAGMA)
│   │   ├── config.js               # config loader + zod schema validation
│   │   ├── db.js                   # better-sqlite3 + sqlite-vec + WAL + migration runner
│   │   ├── logger.js               # pino 封裝
│   │   ├── paths.js                # ~/.kiroku/ + ~/.claude/ 路徑常數
│   │   ├── ids.js                  # nanoid helpers
│   │   ├── session-resolver.js     # 讀取 ~/.claude/projects/ 解析當前 session UUID
│   │   └── redact.js               # DLP regex 脫敏引擎
│   ├── proxy/
│   │   ├── server.js               # http.createServer + auth-mode 嗅探 + 路由
│   │   ├── classifier.js           # 請求分類 (僅分類，不攔截)
│   │   ├── sse-recorder.js         # eventsource-parser 旁路側錄
│   │   └── queue-writer.js         # .jsonl 落盤
│   ├── worker/
│   │   ├── worker.js               # queue polling + job lifecycle + retry
│   │   ├── extractor.js            # LLM 萃取 (provider agnostic, cloud+local)
│   │   ├── embedder.js             # @huggingface/transformers pipeline
│   │   └── store.js                # SQLite 寫入 (所有表的 INSERT/UPDATE)
│   ├── mcp/
│   │   ├── server.js               # McpServer + StdioServerTransport
│   │   ├── memory-search.js        # 語意搜尋 tool (vec0 KNN + fact filter)
│   │   ├── memory-write.js         # memory_save + memory_forget tools
│   │   └── sql-sandbox.js          # 唯讀 SQL tool + AST/regex 雙守門
│   └── license/
│       ├── verify.js               # Ed25519 驗簽
│       └── machine-id.js           # MAC+arch+platform → SHA256 → 16 char
├── migrations/
│   ├── 001_init.sql                # 核心表 (projects ~ extraction_jobs)
│   └── 002_vec.sql                 # vec0 virtual tables
├── prompts/
│   └── extraction.md               # LLM 萃取 system prompt
├── scripts/
│   ├── gen-keypair.js              # 離線金鑰生成 (不進安裝包)
│   └── sign-license.js             # 離線授權簽章 (不進安裝包)
└── test/
    └── fixtures/
        ├── sse-samples/            # SSE 串流測試資料
        └── queue-samples/          # .jsonl 測試資料
```

約 20 個 source files。

---

## 5. package.json

```json
{
  "name": "kiroku-v15",
  "version": "15.0.0",
  "description": "Enterprise AI Memory Gateway & MCP Server",
  "type": "module",
  "main": "bin/kiroku.js",
  "bin": { "kiroku": "./bin/kiroku.js" },
  "engines": { "node": ">=20.0.0" },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "zod": "^3.24.0",
    "better-sqlite3": "^11.8.0",
    "sqlite-vec": "^0.1.6",
    "@huggingface/transformers": "^3.4.0",
    "eventsource-parser": "^3.0.1",
    "pino": "^9.6.0",
    "nanoid": "^5.1.0"
  },
  "devDependencies": {
    "vitest": "^3.0.0",
    "pino-pretty": "^13.0.0"
  }
}
```

### 選型理由

| 套件 | 理由 |
|------|------|
| `@modelcontextprotocol/sdk` | Anthropic 官方 MCP SDK，含 server + stdio transport |
| `zod` | MCP SDK 要求 + config validation |
| `better-sqlite3` | 同步 C++ SQLite driver，原生 WAL 支援 |
| `sqlite-vec` ^0.1.x | vec0 向量 virtual table；pre-v1 必須鎖版 |
| `@huggingface/transformers` v3 | `@xenova/transformers` v2 的官方後繼，支援 q8 量化 |
| `eventsource-parser` | 零依賴 SSE parser，取代 V14 手動 `line.startsWith('data:')` |
| `pino` | 結構化 JSON log，稽核友好 |
| `nanoid` | 短 ID 生成 |

### 刻意不用

| 套件 | 理由 |
|------|------|
| `undici` | Proxy 用 raw `node:http/https`，V14 已驗證可行 |
| `http-proxy` | 7 年無大更新，SSE 處理需額外配置 |
| `yargs` | CLI 只有 6 個 subcommand，手寫 process.argv 即可 |
| `dotenv` | Node 20+ `--env-file` 內建 |
| `fs-extra` | Node 20+ `fs.cp` + `fs.mkdir({recursive:true})` 足夠 |
| `chokidar` | Worker 用 `setInterval` polling 更穩定 (macOS fs.watch 有 rename event 問題) |
| `jsonrepair` | 先用 regex fallback，M3 再評估 |
| `lru-cache` | M1 不需要，M3 需要再加 |

---

## 6. 執行期資料目錄

```
~/.kiroku/
├── config.json                 # 使用者可修改的設定
├── license/
│   ├── license.dat             # 授權檔
│   └── public.pem              # Ed25519 公鑰
├── data/
│   ├── memory.sqlite           # 核心記憶 DB
│   ├── memory.sqlite-wal
│   ├── memory.sqlite-shm
│   ├── queue/
│   │   ├── incoming/           # 待處理 .jsonl
│   │   ├── processing/         # 處理中 (atomic rename)
│   │   ├── done/               # 已完成
│   │   └── dead-letter/        # 失敗超限
│   ├── exports/                # kiroku export 輸出
│   └── cache/
│       └── models/             # HuggingFace 模型快取
├── logs/
│   ├── proxy.log
│   ├── worker.log
│   └── mcp.log
├── run/
│   ├── proxy.state.json        # daemon PID + port + secret
│   └── worker.state.json
└── backups/
```

---

## 7. config.json 預設結構

使用者需要改的設定 (~70 行)。安全硬編碼值 (SQL deny patterns, DLP regex, PRAGMA) 放在 `src/shared/constants.js`，不暴露給 config。

```json
{
  "version": 15,
  "proxy": {
    "port": 0,
    "upstream": "https://api.anthropic.com",
    "projectIdStrategy": "cwd_slug",
    "dlp": {
      "enabled": true,
      "rules": {
        "awsAccessKey": true,
        "anthropicApiKey": true,
        "openaiApiKey": true,
        "githubPat": true,
        "slackToken": true
      }
    },
    "keepAlive": {
      "enabled": false,
      "apiKeyOnly": true,
      "intervalSeconds": 240,
      "idleShutdownSeconds": 3600,
      "maxLifetimeMinutes": 30,
      "onlyWithCacheControl": true
    },
    "telemetryBlock": {
      "enabled": true,
      "targets": ["/telemetry", "/metrics", "/stats"]
    },
    "sseCaptureEnabled": true,
    "storeThinkingBlocks": false
  },
  "worker": {
    "enabled": true,
    "pollIntervalMs": 2000,
    "maxConcurrentJobs": 2,
    "retry": {
      "maxAttempts": 5,
      "baseDelayMs": 2000,
      "maxDelayMs": 60000
    },
    "extraction": {
      "provider": "openrouter",
      "model": "anthropic/claude-3.5-haiku",
      "apiKeyEnv": "OPENROUTER_API_KEY",
      "temperature": 0,
      "maxOutputTokens": 1200,
      "fallback": {
        "provider": "ollama",
        "model": "qwen2.5:14b-instruct-q4_K_M",
        "baseUrl": "http://127.0.0.1:11434"
      }
    },
    "embedding": {
      "model": "Xenova/bge-m3",
      "dtype": "q8",
      "dimensions": 1024,
      "batchSize": 16
    }
  },
  "mcp": {
    "serverName": "kiroku-memory",
    "serverVersion": "15.0.0",
    "tools": ["memory_search", "sql_readonly", "memory_save", "memory_forget"],
    "sqlSandbox": {
      "maxRows": 200,
      "maxCellBytes": 2048,
      "timeoutMs": 3000
    }
  },
  "license": {
    "enabled": true
  }
}
```

---

## 8. Queue .jsonl 事件格式

每個 `message_stop` 事件觸發一筆 .jsonl 寫入：

```json
{
  "event_id": "evt_xxxxxxxxxxxx",
  "project_id": "my-project",
  "conversation_id": "conv_xxxxxxxxxxxx",
  "turn_index": 0,
  "captured_at": "2026-03-06T12:00:00.000+08:00",
  "auth_mode": "api_key",
  "request": {
    "model": "claude-sonnet-4-20250514",
    "system_hash": "sha256:abcd1234...",
    "user_text": "...",
    "tool_schema_names": ["memory_search"]
  },
  "response": {
    "assistant_text": "...",
    "tool_uses": [
      { "name": "memory_search", "input": {} }
    ],
    "stop_reason": "end_turn"
  },
  "redaction": {
    "applied": true,
    "rules_triggered": ["awsAccessKey"]
  },
  "usage": {
    "input_tokens": 0,
    "output_tokens": 0,
    "cache_read_input_tokens": 0,
    "cache_creation_input_tokens": 0
  }
}
```

### conversation_id 生成策略

直接讀取 Claude Code 的 session 目錄，不做啟發式推斷。

Claude Code 將 session 存於：
```
~/.claude/projects/<escaped-path>/{sessionId}.jsonl
```

轉義規則：`/Users/orz99/zoo/claude-proxy` → `-Users-orz99-zoo-claude-proxy`

Proxy 在每次請求時：
1. 將 `project_id` (CWD slug) 轉為 escaped-path 格式
2. 讀取 `~/.claude/projects/<escaped-path>/*.jsonl`
3. 取 mtime 最新的檔案名（UUIDv4）作為 `conversation_id`
4. 快取此 mapping，直到新的 .jsonl 檔案出現

優點：
- 直接對應 Claude Code 的實際 session，零猜測
- 不依賴 system_hash（可能變動）或 time_gap（不精確）
- Subagent sessions 自動歸入父 session 的目錄

---

## 9. SQLite Schema

### 9.1 核心表 (001_init.sql)

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  auth_mode TEXT NOT NULL,           -- api_key / session / unknown
  system_hash TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  turn_index INTEGER NOT NULL,
  role TEXT NOT NULL,                -- user / assistant
  text TEXT NOT NULL,
  text_sha256 TEXT NOT NULL,
  model TEXT,
  stop_reason TEXT,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cache_read_input_tokens INTEGER DEFAULT 0,
  cache_creation_input_tokens INTEGER DEFAULT 0,
  captured_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  canonical_name TEXT NOT NULL,
  entity_type TEXT NOT NULL,         -- person / org / project / repo / topic / file / concept
  aliases_json TEXT NOT NULL DEFAULT '[]',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  subject_entity_id TEXT REFERENCES entities(id),
  predicate TEXT NOT NULL,
  object_text TEXT NOT NULL,
  object_entity_id TEXT REFERENCES entities(id),
  fact_type TEXT NOT NULL,           -- semantic / episodic / preference / task / state
  confidence REAL NOT NULL,
  heat REAL NOT NULL DEFAULT 0.5,
  decay_bucket TEXT NOT NULL DEFAULT 'warm', -- hot / warm / cold / archived
  source_turn_id TEXT REFERENCES turns(id) ON DELETE CASCADE,
  valid_from TEXT,
  valid_to TEXT,
  supersedes_fact_id TEXT REFERENCES facts(id),
  status TEXT NOT NULL DEFAULT 'active', -- active / superseded / archived
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS extraction_jobs (
  id TEXT PRIMARY KEY,
  queue_file TEXT NOT NULL,
  queue_event_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending / processing / done / failed / dead
  provider TEXT,
  model TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_conv_project ON conversations(project_id);
CREATE INDEX IF NOT EXISTS idx_turns_conv_index ON turns(conversation_id, turn_index);
CREATE INDEX IF NOT EXISTS idx_turns_project_time ON turns(project_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(canonical_name);
CREATE INDEX IF NOT EXISTS idx_facts_project_subject ON facts(project_id, subject_entity_id, predicate);
CREATE INDEX IF NOT EXISTS idx_facts_status_heat ON facts(project_id, status, heat DESC);
CREATE INDEX IF NOT EXISTS idx_facts_source ON facts(source_turn_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON extraction_jobs(status);
```

### 9.2 向量表 (002_vec.sql)

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS fact_embeddings USING vec0(
  fact_id TEXT PRIMARY KEY,
  project_id TEXT,
  fact_type TEXT,
  status TEXT,
  embedding float[1024]
);
```

M1-M2 只需一張 `fact_embeddings` 向量表。`turn_embeddings` 在 M3 需要 raw context search 時再加。

### 9.3 Schema 設計決策

| 決策 | 理由 |
|------|------|
| 不建 `triples` 表 | `facts` 已有 `subject_entity_id` + `object_entity_id`，本質就是 enriched triple |
| 不建 `memory_spans` 表 | Span-level char offset 在 LLM 萃取 JSON 中難以精確維護；M1 用 `source_turn_id` 粗粒度追溯 |
| 不建 `hot_states` 表 | 用 `facts` 的 `decay_bucket='hot'` + `fact_type='state'` 替代 |
| 不建 `audit_log` 表 | M4 再加。M1-M2 用 pino structured log 代替 |
| 單一 vec0 表 | `sqlite-vec` 仍 pre-v1，最小化暴露面。entity 查詢靠 `canonical_name` 即可 |

---

## 10. MCP 工具定義

### 設計原則

兩個目標的平衡：
1. **降低 token 使用** — 回傳 compact markdown，不回巨量 JSON；schema 用 resource 暴露
2. **讀寫皆可** — 自動管道 (Proxy→Worker) 全量捕捉，MCP write tools 補充精準手動存取

### 工具總覽

| Tool | 類型 | 用途 | 里程碑 |
|------|------|------|--------|
| `memory_search` | Read | 語意搜尋 (vec0 KNN + filter) | M3 |
| `sql_readonly` | Read | 進階 SQL 沙盒查詢 | M3 |
| `memory_save` | Write | 明確儲存事實/觀察 | M3 |
| `memory_forget` | Write | 標記事實為過時/歸檔 | M3 |
| `health_status` | Meta | 系統健康檢查 | M4 |
| schema resource | Resource | DDL + 欄位說明 (零 tool call 成本) | M3 |

### 10.1 `memory_search` (Read)

高階語意搜尋，封裝 vec0 KNN + fact filter。處理 80% 的查詢需求。

輸入：
```json
{
  "query": "string (required)",
  "project_id": "string (optional, 預設當前專案)",
  "top_k": "number (optional, 預設 10, max 50)",
  "fact_types": "string[] (optional, filter by fact_type)",
  "time_from": "string (optional, ISO 8601)",
  "time_to": "string (optional, ISO 8601)",
  "status": "string (optional, 預設 'active')"
}
```

輸出：Compact markdown table，每筆含 subject, predicate, object, fact_type, confidence, source_turn snippet, timestamp。

### 10.2 `sql_readonly` (Read)

唯讀 SQL 沙盒。處理 20% 的進階查詢（跨專案統計、複雜 JOIN、timeline 分析）。

輸入：
```json
{
  "sql": "string (required)",
  "project_id": "string (optional, 自動加 WHERE project_id = ?)"
}
```

規則：
- 僅允許 `SELECT` / `WITH` / `EXPLAIN QUERY PLAN` 開頭
- Regex deny: INSERT, UPDATE, DELETE, ALTER, DROP, ATTACH, DETACH, PRAGMA, VACUUM, REINDEX, CREATE, TRIGGER, LOAD_EXTENSION
- 自動加 `LIMIT {maxRows}`
- 執行逾時 3 秒自動中斷
- 回傳結果含 row count + truncated 標記

輸出：Markdown table + row count。

### 10.3 `memory_save` (Write)

明確儲存使用者指示的事實。與自動管道互補：自動管道被動全量捕捉，memory_save 主動精準存取。

輸入：
```json
{
  "subject": "string (required, 主體名稱)",
  "predicate": "string (required, 謂語/關係)",
  "object": "string (required, 客體/值)",
  "fact_type": "string (optional, 預設 'semantic')",
  "project_id": "string (optional, 預設當前專案)"
}
```

行為：
- 建立/查找 subject entity (canonical_name 去重)
- 建立 fact 記錄 (confidence=1.0, decay_bucket='hot', source_turn_id=null)
- Worker 非同步補算 embedding (fact 建立時 embedding 欄位為空，Worker 定期掃描補填)
- 如已有同 subject+predicate 的 active fact → 舊 fact 標記為 `superseded`

輸出：`"Saved: {subject} {predicate} {object}" + fact_id`

### 10.4 `memory_forget` (Write)

將事實標記為歸檔或過時。不物理刪除資料。

輸入：
```json
{
  "fact_id": "string (optional, 精確指定)",
  "subject": "string (optional, 模糊匹配)",
  "predicate": "string (optional, 模糊匹配)",
  "project_id": "string (optional, 預設當前專案)"
}
```

行為：
- `fact_id` 指定 → 直接 archive 該 fact
- subject+predicate 指定 → 列出匹配 facts，全部 archive
- 將 `status` 改為 `archived`，`decay_bucket` 改為 `archived`

輸出：`"Archived N facts" + fact_ids`

### 10.5 Schema Resource

MCP resource (非 tool)，暴露完整 DDL + 欄位說明。AI 可 read resource 取得 schema 後再寫 SQL，不消耗 tool call 額度。

URI: `kiroku://schema/memory`

### 10.6 Token 效率分析

| 場景 | 傳統 RAG | Kiroku V15 |
|------|---------|------------|
| 「之前怎麼處理 auth？」 | 回傳數萬字對話歷史 | memory_search → 10 行 markdown table |
| 「記住：部署用 Docker」 | 無法做到 | memory_save → 1 行確認 |
| 「上週改了哪些 API？」 | 全量對話回放 | sql_readonly → 精確 WHERE + compact table |
| 「忘掉舊的 DB 密碼」 | 無法做到 | memory_forget → 1 行確認 |

---

## 11. Claude Code 整合策略

### 11.1 三層整合架構

```
Layer 1: Proxy (透明攔截)        → 自動寫入，使用者無感
Layer 2: MCP Server (工具註冊)   → 讀寫工具，AI 按需呼叫
Layer 3: Claude Code 配置        → 指引 AI 何時用記憶工具
```

### 11.2 `kiroku start` 一鍵啟動流程

`bin/kiroku.js start` 做以下事情：

1. 啟動 Proxy daemon (background, random port → state file)
2. 啟動 Worker daemon (background)
3. **自動寫入 `.mcp.json`**：註冊 kiroku-mcp-gateway 為 MCP server
4. 設定 `ANTHROPIC_BASE_URL` 指向 proxy
5. 啟動 `claude` CLI

```json
// .mcp.json (由 kiroku start 自動寫入)
{
  "mcpServers": {
    "kiroku-memory": {
      "command": "node",
      "args": ["{kiroku-v15-path}/src/mcp/server.js"],
      "env": { "KIROKU_PROJECT_ID": "{project_slug}" }
    }
  }
}
```

### 11.3 自動儲存記憶（寫入）

**不需要 hooks/skills**。完全透明：

```
使用者照常用 Claude Code
  → 所有 API 請求經過 Proxy
  → Proxy 旁路側錄 SSE response
  → message_stop 觸發 .jsonl dump
  → Worker 背景萃取 + 向量化 + 寫入 SQLite
```

使用者不需做任何事，記憶自動累積。

### 11.4 自動查詢記憶（讀取）—— 三種策略

#### 策略 A：MCP Tool Description 引導（預設，零配置）

MCP 工具的 `description` 欄位是 AI 決定何時呼叫工具的主要依據：

```javascript
// memory_search tool description
"Search project memory for past decisions, architecture choices, bug fixes,
and development context. Use this tool AUTOMATICALLY when:
- Starting work on a topic that may have prior history
- The user references something discussed before
- You need context about project conventions or past decisions
- The user asks 'what did we decide about X' or 'how did we handle Y'"
```

Claude 看到這些 description 後，會在合適的時機主動呼叫。這是最輕量的整合方式。

#### 策略 B：CLAUDE.md 靜態指引（一次性設定，已採用）

`kiroku init` 在專案 CLAUDE.md 尾端追加記憶指引區塊（一次性靜態寫入，不違反紅線 R2）：

```markdown
## Memory (Kiroku)
- 開始新任務前，用 memory_search 檢查相關歷史上下文
- 使用者說「記住」「remember」時，用 memory_save 儲存
- 使用者說「忘記」「forget」時，用 memory_forget 歸檔
```

這段文字進入 system prompt → AI 每次都會看到 → 提高自動查詢頻率。
佔用 system prompt 約 50-80 tokens，但記憶自動化效益遠大於成本。
`kiroku init` 會檢查是否已存在此區塊，避免重複追加。

#### 策略 C：Claude Code Hooks 自動注入（進階）

利用 Claude Code 的 hook 機制在特定事件觸發時提醒 AI：

```json
// .claude/settings.local.json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "memory_search",
      "hooks": [{ "type": "command", "command": "echo ''" }]
    }],
    "Stop": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "node {kiroku-path}/bin/kiroku.js hook-on-stop"
      }]
    }]
  }
}
```

Hook 可做的事：
- `Stop` hook：對話結束時提醒 Worker 立即處理 queue
- 自定義 slash command 風格的觸發

Hook 不適合做的事：
- 不能直接呼叫 MCP tools（hooks 是 shell command，不是 MCP client）
- 不能注入 system prompt（那是 R2 紅線）

### 11.5 建議的整合方案

| 里程碑 | 整合方式 | 說明 |
|--------|---------|------|
| M1 | `kiroku start` 自動設定 ANTHROPIC_BASE_URL | Proxy 透明攔截，自動儲存 |
| M3 | `kiroku start` 自動寫入 `.mcp.json` | MCP 工具可用，策略 A (tool description) |
| M3 | `kiroku init` 追加 CLAUDE.md 記憶指引 | 策略 B (靜態指引)，一次性寫入 |
| M4 | Hooks 整合 | 策略 C (進階自動化) |

### 11.6 使用者操作流程（最終體驗）

```bash
# 首次設定（一次性）
cd my-project
kiroku init          # 建立 ~/.kiroku/ + 初始化 DB + 可選加 CLAUDE.md 指引

# 每次開發
kiroku start         # 啟動 proxy+worker+mcp → 自動進入 claude CLI
                     # 所有對話自動側錄、萃取、向量化

# Claude 對話中（自動發生）
# Claude 看到 memory_search 工具 → 在需要時主動查詢記憶
# 使用者說「記住這個決定」→ Claude 呼叫 memory_save
# 使用者說「忘掉舊的密碼」→ Claude 呼叫 memory_forget

# 管理
kiroku status        # 檢查三個模組狀態
kiroku stop          # 停止所有背景程序
kiroku doctor        # 健康檢查
kiroku export        # 匯出記憶
```

---

## 12. 非功能需求

### 效能
- Proxy 額外延遲：P95 < 20ms（只做 passthrough + side-record）
- Queue dump：`message_stop` 後 100ms 內完成落盤
- Worker 吞吐：每分鐘至少 30 turns
- SQL 沙盒預設 3 秒 timeout

### 安全
- Provider API key 走環境變數，不進 config.json
- 私鑰不進 repo/安裝包
- Log 內預設 DLP 脫敏
- `thinking` 內容預設不存
- MCP write tools 只操作 facts/entities，不碰 turns/conversations/extraction_jobs
- SQL 沙盒 regex + statement type 雙守門（sql_readonly 仍純唯讀）

### 可維運
- 每個模組獨立啟停
- `kiroku doctor` 檢查：config / vec extension / DB migration / 模型快取 / provider credentials
- WAL journal + 手動備份指令

---

## 13. 授權模組

### 保留
- Ed25519 演算法
- Machine-bound license (MAC + arch + platform → SHA256 → 16 char)
- 到期時間

### 修正
- `scripts/gen-keypair.js`：只在內部安全機器執行，不進安裝包
- `scripts/sign-license.js`：離線簽章，不進安裝包
- 安裝包只含 `public.pem` (放 `~/.kiroku/license/`)
- `license.dat` 放 `~/.kiroku/license/`

### License payload
```json
{
  "mid": "DEVICE_HASH_16CHAR",
  "exp": 1780000000000,
  "tier": "enterprise",
  "features": ["proxy", "worker", "mcp"],
  "sig_v": 1
}
```

---

## 14. 里程碑與實作順序

### M0 — PRD 定案
1. 將本 PRD 存入 `./docs/kiroku-v15-prd.md`
2. 建立 `kiroku-v15/` 專案目錄結構

### M1 — 基礎管線
1. `src/shared/*` (config, db, logger, paths, ids, redact, constants, session-resolver)
2. `migrations/*` (001_init.sql, 002_vec.sql)
3. `src/proxy/*` (server, classifier, sse-recorder, queue-writer)
4. `bin/kiroku.js` (start/stop/status)

驗收：Proxy 能 passthrough、DLP 脫敏、旁路側錄落 .jsonl queue、不改主回應

### M2 — 記憶引擎
1. `src/worker/*` (worker, extractor, embedder, store)
2. `prompts/extraction.md`

驗收：Worker 消費 queue → 萃取 entities/facts → 算 embedding → 寫入 SQLite

### M3 — MCP 讀取
1. `src/mcp/*` (server, memory-search, sql-sandbox)

驗收：Claude 可列出工具、memory_search 回結果、sql_readonly 能拒絕 DROP/UPDATE

### M4 — 營運強化
1. `bin/kiroku.js` 擴充 (doctor, export, reindex)
2. `src/license/*` (verify, machine-id)
3. `scripts/gen-keypair.js`, `scripts/sign-license.js`
4. `audit_log` 表 (如有需求)

---

## 15. 驗收標準

### Proxy
- [x] 分辨 `x-api-key` vs `authorization/sessionkey`
- [x] session 模式不會觸發保活
- [x] 能落 .jsonl queue
- [x] 不改主回應內容
- [x] DLP 遮蔽 AWS key / API key

### Worker
- [x] queue turn → entities + facts + embeddings → 寫入 SQLite
- [x] 失敗 retry (max 5 次) → dead-letter

### MCP
- [x] Claude 可列出 4 個工具 (memory_search, sql_readonly, memory_save, memory_forget)
- [x] `memory_search` 可回 compact markdown 結果
- [x] `sql_readonly` 能拒絕 DROP/UPDATE/ATTACH/PRAGMA
- [x] `memory_save` 可建立 entity + fact，Worker 非同步補算 embedding
- [x] `memory_forget` 可 archive 指定 facts
- [x] Schema resource 可讀取

### DB
- [x] WAL 生效
- [x] `vec0` extension 載入成功
- [x] 向量 KNN 查詢可跑

---

## 16. 已決定事項

| # | 決定 |
|---|------|
| D1 | Port 策略：隨機 port + state file（沿用 V14 模式）|
| D2 | MCP 工具：4 tools (memory_search, sql_readonly, memory_save, memory_forget) + 1 resource |
| D3 | Keepalive：API-key prompt cache keep-alive 已實作；只在 `x-api-key` 模式、含 `cache_control` 的 `/v1/messages` 請求後啟動，config 預設 `enabled=false` |
| D4 | `@huggingface/transformers` v3 取代 `@xenova/transformers` v2 |
| D5 | Proxy 用 raw `node:http/https`，不引入 http-proxy/undici |
| D6 | V15 主 repo 不再出現 `god-mode` 命名 |
| D7 | `sqlite-vec` 版本鎖死 ^0.1.6 |
| D8 | `Xenova/bge-m3` 維度固定 1024 |
| D9 | Dynamic upstream key = bearer token：proxy 每次請求依 `Authorization: Bearer` 或 `x-api-key` 雜湊查 `~/.kiroku/run/routes/<sha256>`，未命中走 `proxy.upstream`。`kiroku start` 必須 `ANTHROPIC_BASE_URL` 與 `ANTHROPIC_AUTH_TOKEN` 同設才會註冊路由；token 不落盤；舊 `~/.kiroku/run/upstream/` 升級時自動清除 |

## 17. 未解決問題

1. **sqlite-vec 0.1.x 穩定性**：pre-v1 alpha。`src/shared/db.js` 需加 adapter，vec extension 載入失敗時降級為純文字搜尋 (LIKE)。

2. **DLP false positive**：AWS key pattern (`AKIA[0-9A-Z]{16}`) 可能誤中一般 base64 文字。需 fixture 測試。

3. **memory_save 的 embedding 延遲**：MCP 寫入 fact 後，embedding 由 Worker 非同步補算。在補算完成前，該 fact 無法被 memory_search 的向量搜尋命中（但 sql_readonly 可查到）。需評估延遲是否可接受。

4. **Claude Code session 目錄的跨平台差異**：`~/.claude/projects/` 的轉義規則 (path separator → `-`) 需在 Windows 上驗證。

## 18. 已解決（本輪確認）

| # | 問題 | 解法 |
|---|------|------|
| Q1 | conversation_id 如何生成？ | 直接讀取 `~/.claude/projects/<escaped-path>/*.jsonl` 最新檔名 (UUIDv4) |
| Q2 | bge-m3 ~600MB 首次下載 | Worker 首次啟動時自動下載，顯示進度條。不需要 `kiroku doctor` 預下載 |
| Q3 | CLAUDE.md 是否可追加？ | `kiroku init` 一次性追加 `## Memory (Kiroku)` 區塊 |
| Q4 | Port 策略 | 隨機 port + state file (沿用 V14) |
| Q5 | MCP 工具數量 | 4 tools (search, sql, save, forget) + 1 resource |
| Q6 | Keepalive 實作時機 | 已實作 API-key prompt cache keep-alive：`max_tokens=1`、`stream=false`、保留 `cache_control`，30 分鐘無真實請求後丟棄記憶體快照 |
