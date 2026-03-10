# Kiroku V15 Integration Test Results

Date: 2026-03-06
Environment: macOS Darwin 24.6.0, Node.js 20+, Claude Opus 4.6

---

## 1. Proxy (kiroku-aegis-proxy)

### 1.1 Health Endpoints

| Endpoint | Method | Result |
|----------|--------|--------|
| `/health?secret=<s>` | GET | 200 `KIROKU_OK` |
| `/heartbeat?secret=<s>` | GET | 200 `ALIVE` |
| `/suicide?secret=<s>` | GET | 200 `BYE` (process exit) |
| `/health` (no secret) | GET | 403 `Forbidden` |

### 1.2 Telemetry Blocking

| Path | Status |
|------|--------|
| `/telemetry` | 204 (blocked) |
| `/metrics` | 204 (blocked) |
| `/v1/messages` | passthrough (not blocked) |

### 1.3 Auth Mode Sniffing

| Header | Detected Mode |
|--------|---------------|
| `x-api-key: sk-ant-...` | `api_key` |
| `authorization: Bearer sessionkey/...` | `session` |
| (none) | `unknown` |

### 1.4 DLP Redaction

| Input | Redacted Output | Rule |
|-------|-----------------|------|
| `AKIAIOSFODNN7EXAMPLE` | `[REDACTED:awsAccessKey]` | awsAccessKey |
| `sk-ant-api03-xxxx...` | `[REDACTED:anthropicApiKey]` | anthropicApiKey |
| `ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh` | `[REDACTED:githubPat]` | githubPat |
| `xoxb-1234-5678-abcdef` | `[REDACTED:slackToken]` | slackToken |
| `Hello world` | `Hello world` (unchanged) | - |

### 1.5 SSE Side-Recording

Tested with real Claude API streaming response. The `sse-recorder.js` correctly parses:

- `content_block_delta` (type: `text_delta`) -> aggregated into `assistantText`
- `content_block_start` (type: `tool_use`) -> captured in `toolUses[]`
- `message_delta` -> captured `stop_reason`
- `message_start` -> captured `usage` (input_tokens, output_tokens, cache_*)

### 1.6 Queue Writer

- Atomic write: tmp file + `renameSync` to `~/.kiroku/data/queue/incoming/`
- Filename format: `evt_<nanoid>.jsonl`
- Live test: 4 events captured from real Claude Code session

---

## 2. Worker (kiroku-memory-worker)

### 2.1 Queue Consumption

| Metric | Value |
|--------|-------|
| Total events | 4 |
| Successful | 4 (after bugfix) |
| Failed (dead-letter) | 0 |
| Initial failures (pre-fix) | 4 (OpenRouter 401) + 1 (FK constraint) |

### 2.2 OpenRouter LLM Extraction

Provider: `openrouter`, Model: `anthropic/claude-3.5-haiku`

Extracted from 4 conversation turns:

**Entities (10):**

| canonical_name | entity_type |
|----------------|-------------|
| MEMORY.md | file |
| SQLite | project |
| Kiroku Project | project |
| 吹吹 | concept |
| bun | project |
| npm | project |
| memory_save | project |
| Claude Opus 4.6 | project |
| Anthropic | org |
| Kiroku | concept |

**Active Facts (6):**

| Subject | Predicate | Object | Type |
|---------|-----------|--------|------|
| Kiroku Project | uses database | SQLite | semantic |
| SQLite | configured with | WAL mode | semantic |
| (null) | is located at | ~/.kiroku/data/memory.sqlite | semantic |
| 吹吹 | prefers | bun over npm | preference |
| Claude Opus 4.6 | is currently the most powerful model | from Anthropic | semantic |
| 吹吹 | 偏好使用 | bun 而不是 npm 作為套件管理工具 | preference |

### 2.3 bge-m3 Embedding

- Model: `Xenova/bge-m3` (q8 quantization)
- Dimensions: 1024
- Model size on disk: 561MB
- Embeddings generated: 5 (stored in vec0 virtual table)

### 2.4 Retry Mechanism

Observed exponential backoff: 2s -> 4s -> 8s -> 16s (base=2000ms, factor=2x).
After 5 failed attempts, event moved to `dead-letter/`.

---

## 3. MCP Gateway (kiroku-mcp-gateway)

### 3.1 Tool Registration

Claude Code successfully detected 4 tools + 1 resource:

| Tool | Type | Status |
|------|------|--------|
| `memory_search` | Read | registered |
| `sql_readonly` | Read | registered |
| `memory_save` | Write | registered |
| `memory_forget` | Write | registered |
| `kiroku://schema/memory` | Resource | registered |

### 3.2 memory_save (Manual Write)

```
Input:  { subject: "吹吹", predicate: "偏好使用", object: "bun 而不是 npm 作為套件管理工具", fact_type: "preference" }
Output: "Saved: 吹吹 偏好使用 bun 而不是 npm 作為套件管理工具 (fact_id: fact_t9zUGajOHf_6R2mu)"
```

Verified in DB:
- Entity `吹吹` created (ent__Ukpvxby-NodUScH)
- Fact stored with confidence=1.0, decay_bucket='hot'
- Supersede logic: second save with same subject+predicate marks old fact as `superseded`

### 3.3 memory_forget (Archive)

- Archive by fact_id: sets `status='archived'`, `decay_bucket='archived'`
- Archive by subject+predicate: LIKE match, archives all matching active facts
- Confirmed: `fact_X2b3FspjnCxHDPmg` status changed to `archived`

### 3.4 sql_readonly (SQL Sandbox)

| Query | Result |
|-------|--------|
| `SELECT * FROM facts` | allowed (auto LIMIT 200) |
| `DROP TABLE facts` | blocked (SQL_DENY_PATTERNS) |
| `INSERT INTO facts ...` | blocked |
| `PRAGMA journal_mode` | blocked |
| `ATTACH DATABASE ...` | blocked |
| `WITH cte AS (...) SELECT ...` | allowed |

### 3.5 memory_search (Vector KNN)

Tested with real bge-m3 embeddings. Results correctly ranked by cosine distance:

**Query: "套件管理偏好"**

| Rank | Subject | Predicate | Object | Distance |
|------|---------|-----------|--------|----------|
| 1 | 吹吹 | prefers | bun over npm | closest |
| 2 | SQLite | configured with | WAL mode | - |
| 3 | Kiroku Project | uses database | SQLite | - |

**Query: "what database does the project use"**

| Rank | Subject | Predicate | Object | Distance |
|------|---------|-----------|--------|----------|
| 1 | Kiroku Project | uses database | SQLite | closest |
| 2 | (null) | is located at | ~/.kiroku/data/memory.sqlite | - |
| 3 | SQLite | configured with | WAL mode | - |

**Query: "AI model"**

| Rank | Subject | Predicate | Object | Distance |
|------|---------|-----------|--------|----------|
| 1 | Claude Opus 4.6 | is currently the most powerful model | from Anthropic | closest |
| 2 | SQLite | configured with | WAL mode | - |
| 3 | Kiroku Project | uses database | SQLite | - |

All three queries return the semantically most relevant fact as rank #1.

---

## 4. CLI (bin/kiroku.js)

### 4.1 Commands Tested

| Command | Result |
|---------|--------|
| `kiroku init` | Creates ~/.kiroku/ tree, config.json, memory.sqlite (all tables + vec0) |
| `kiroku start` | Spawns proxy (random port) + worker (daemon) + writes .mcp.json + launches claude |
| `kiroku stop` | SIGTERM to proxy + worker, cleans state files |
| `kiroku status` | Reports proxy/worker/MCP state, DB stats, queue counts |
| `kiroku doctor` | Validates config, DB, sqlite-vec, model cache, API keys, license |
| `kiroku help` | Shows usage info |

### 4.2 Database Initialization

```
Tables: projects, conversations, turns, entities, facts, extraction_jobs
Vec0:   fact_embeddings (float[1024])
WAL:    journal_mode=wal, synchronous=normal, foreign_keys=on
```

### 4.3 Session Resolver

- Reads `~/.claude/projects/<escaped-path>/*.jsonl`
- Path: `/Users/orz99/zoo/claude-proxy` -> `-Users-orz99-zoo-claude-proxy`
- Resolved session: `65e99b70-11f0-4452-a3f8-4ac07494a95c`
- 5-second cache for mtime polling

### 4.4 Machine ID

- Algorithm: SHA256(MAC + arch + platform) -> first 16 hex chars
- Consistent across runs

---

## 5. Bugs Found & Fixed

### 5.1 OpenRouter 401 (Configuration)

- **Symptom:** All extraction jobs fail with `HTTP 401: User not found`
- **Cause:** API key placed in `.env.example` instead of `.env`
- **Fix:** User corrected `.env` file, worker restarted

### 5.2 FOREIGN KEY Constraint on storeFacts

- **Symptom:** `FOREIGN KEY constraint failed` when processing turns with tool_use-only responses (no assistant text)
- **Cause:** `storeTurn()` always generated a turn ID but only inserted the row when text was non-empty. `storeFacts()` then referenced a non-existent `source_turn_id`
- **Fix:** Changed `storeTurn()` to return `null` for IDs when no row is inserted (store.js lines 28-50). Schema already allows nullable `source_turn_id`

### 5.3 sqlite-vec KNN Query with JOIN

- **Symptom:** `memory_search` vector query returns 0 results
- **Cause:** vec0 virtual table does not recognize SQL `LIMIT` as a valid k constraint when used inside a JOIN. Requires explicit `k = ?` parameter
- **Fix:** Refactored query to use subquery: inner `SELECT` with `k = ?` for KNN, outer JOIN for metadata (memory-search.js lines 28-35)

---

## 6. End-to-End Pipeline Verification

```
Claude Code (live session)
  -> Proxy (port 57075, SSE side-recording)
    -> Queue (.jsonl atomic write)
      -> Worker (OpenRouter extraction + bge-m3 embedding)
        -> SQLite (entities, facts, fact_embeddings)
          -> MCP memory_search (vec0 KNN, correct semantic ranking)
```

All stages verified with real data. Pipeline fully operational.
