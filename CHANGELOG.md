# Changelog

All notable changes to Kiroku are documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/).

## [1.3.0] - 2026-03-14

### Added

#### Memory Intelligence — Semantic Dedup, Retrieval Diversity & Conflict Detection
- **Retrieval diversity filter**: `project_context` and `memory_search` now apply word-level Jaccard similarity (threshold 0.5) to filter near-duplicate facts with the same subject, reducing context token waste
- **Token budget**: `mcp.projectBrief.maxTokens` config (default 4000, 0 = unlimited) caps `project_context` output size via token estimation (CJK-aware)
- **Compaction sweep**: New `runCompactionSweep()` runs alongside decay sweep (every 6h), merging semantically near-identical facts (cosine > 0.92) within the same subject entity — lower-heat fact is archived as `compacted`, survivor gets heat boost
- **Conflict detection**: During compaction sweep, facts with cosine 0.75–0.92, same predicate but different object are logged as potential conflicts

### Fixed
- **Embedding misalignment bug**: `storeFacts()` now returns an aligned array (same length as input) with `null` for deduped facts; `processFile()` filters nulls before embedding, fixing factId↔embedding index mismatch introduced by content-level dedup in v1.2.7

### Changed
- **`storeFacts()` return type**: `string[]` → `(string|null)[]` — callers must filter nulls for actual inserted fact IDs
- **Over-fetch for diversity**: `project_context` fetches 3× candidates before filtering; `memory_search` similarly over-fetches for diversity filtering

---

## [15.1.0] - 2026-03-07

### Added

#### Heat/Decay System
- **Time-based decay**: Facts lose heat over time using half-life formula: `heat = base_heat × 0.5^(hours / 168)` (7-day half-life)
- **Access boost**: Search hits update `last_accessed_at`, increment `access_count`, and boost `base_heat` by +0.05 (capped at 1.0)
- **Automatic bucket transitions**: `hot` (≥0.7) → `warm` (≥0.3) → `cold` (<0.3) based on decayed heat
- **Periodic sweep**: Worker runs decay sweep on startup + every 6 hours, updating heat and bucket in a single transaction
- **LRU-like eviction**: Freemium eviction now prefers genuinely cold (unused) facts over recently accessed ones
- **New columns**: `last_accessed_at`, `access_count`, `base_heat` on `facts` table (migration `005_heat_decay.sql`)
- **Config**: `worker.decay.{enabled, sweepIntervalMs, halfLifeHours, accessBoost, extractedBaseHeat}` with sensible defaults

#### Cross-Project Memory Scope (ADR-004)
- **Dual-layer scope**: `project` (default) and `global` for cross-project fact sharing
- **Preference facts**: `fact_type=preference` defaults to `global` scope
- **Scope-aware search**: `memory_search` accepts `scope` param (`project`, `global`, `all`)
- **Scope-aware supersede**: Same subject+predicate only supersedes within the same scope
- **Migrations**: `003_scope.sql` (add scope column + backfill) and `004_scope_vec.sql` (rebuild vec0 with scope filter)

#### License System — ADR-003 Phase 1
- **Freemium tier**: 500 fact limit (evict coldest), 50 daily extractions, embedding disabled
- **Machine ID**: OS-native hardware ID (macOS ioreg serial, Linux product_uuid, Windows MachineGuid) with 4-layer fallback
- **Ed25519 verification**: Public key embedded in source, offline license validation
- **Dual fingerprint**: Accepts both new hardware ID and legacy MAC-based ID
- **CLI integration**: `kiroku doctor` shows machine-id + tier + expiry; `kiroku start` shows gentle free tier reminder
- **License state**: Cached module queried by worker, store, MCP, and CLI

### Changed

- **Extracted fact initial heat**: 0.5/warm → 0.7/hot (new facts start hot, decay naturally)
- **Manual fact initial values**: Now includes `base_heat=1.0`, `last_accessed_at=now`, `access_count=0`
- **Default extraction model**: `claude-3.5-haiku` → `google/gemini-2.0-flash-001` (8.8x cheaper, 2x faster, same quality)
- **Extraction prompt**: Removed markdown code fences (caused some models to output preamble only), switched to INPUT/OUTPUT plain text format with "Respond with ONLY the JSON object"

### Fixed

- **File-level retry with exponential backoff**: Failed queue files now move back to `incoming/` with backoff delay (base 2s, 2x factor, max 60s, up to 5 attempts) instead of immediately going to dead-letter. Only moves to `dead-letter/` after all retries exhausted. Extraction job status tracked as `retrying` between attempts.
- **fact_embeddings status sync**: Archiving a fact now also sets `fact_embeddings.status = 'archived'`, preventing stale vector search results

---

## [15.0.0] - 2026-03-06

Complete rewrite from V14 (god-mode proxy) to V15 (enterprise-grade AI memory gateway).
Three independent modules replace the monolithic V14 script.

### Architecture

Kiroku V15 consists of three independent Node.js ESM modules:

1. **kiroku-aegis-proxy** (`src/proxy/`) — Transparent HTTP proxy with DLP redaction and SSE side-recording
2. **kiroku-memory-worker** (`src/worker/`) — Background queue processor with LLM extraction and local embedding
3. **kiroku-mcp-gateway** (`src/mcp/`) — MCP stdio server exposing memory read/write tools to Claude

### Added

#### CLI (`bin/kiroku.js`)
- `kiroku init` — Initialize `~/.kiroku/` directory tree, config.json, and SQLite database
- `kiroku start` — One-command launch: proxy daemon + worker daemon + MCP registration + Claude Code
- `kiroku stop` — Graceful shutdown of all background processes
- `kiroku status` — Report proxy/worker/MCP state, DB stats, and queue counts
- `kiroku doctor` — Health check: config validation, sqlite-vec, model cache, API keys, license
- `kiroku export` — Export memory data

#### Proxy (`src/proxy/`)
- Transparent HTTP passthrough to `api.anthropic.com` with zero-delay response streaming
- Auth mode sniffing: `x-api-key` header -> `api_key` mode, `authorization` header -> `session` mode
- SSE side-recording using line-by-line parser for `text_delta`, `tool_use`, `thinking`, `usage`, `stop_reason`
- DLP regex redaction engine with 5 built-in rules: AWS access keys, Anthropic API keys, OpenAI API keys, GitHub PATs, Slack tokens
- Telemetry blocking for configurable path prefixes (`/telemetry`, `/metrics`, `/stats`)
- Queue writer with atomic file operations (tmp + rename) to `~/.kiroku/data/queue/incoming/`
- Project ID routing via `/project/<id>/` URL prefix
- Health, heartbeat, and suicide endpoints with secret-based authentication
- Configurable idle auto-shutdown timer (default 1 hour)
- Random port assignment with state file (`~/.kiroku/run/proxy.state.json`)

#### Worker (`src/worker/`)
- Filesystem-based queue polling with configurable interval (default 2s)
- Atomic file state transitions: `incoming/` -> `processing/` -> `done/` or `dead-letter/`
- LLM entity/fact extraction via OpenRouter (primary) with Ollama fallback
- Structured extraction prompt producing `{ entities[], facts[] }` JSON
- JSON parsing with markdown code block unwrapping and regex fallback
- Local embedding with `@huggingface/transformers` v3, model `Xenova/bge-m3`, q8 quantization, 1024 dimensions
- Exponential backoff retry: base 2s, factor 2x, max 60s, up to 5 attempts
- Entity deduplication by `canonical_name` with `last_seen_at` tracking
- Fact supersede logic: new fact with same subject+predicate marks old as `superseded`
- Embedding storage in sqlite-vec `vec0` virtual table

#### MCP Gateway (`src/mcp/`)
- `memory_search` tool — Semantic vector search (vec0 KNN) with text search fallback, returns compact markdown table
- `sql_readonly` tool — Read-only SQL sandbox with prefix whitelist (`SELECT`/`WITH`/`EXPLAIN`) + regex deny list (INSERT/UPDATE/DELETE/ALTER/DROP/ATTACH/PRAGMA/...) + auto LIMIT + 3s timeout
- `memory_save` tool — Manual fact storage with entity auto-creation, supersede logic, confidence=1.0, decay_bucket='hot'
- `memory_forget` tool — Archive facts by ID or subject+predicate fuzzy match (sets status='archived')
- `kiroku://schema/memory` resource — Full DDL + column descriptions for AI-assisted SQL writing
- McpServer + StdioServerTransport from `@modelcontextprotocol/sdk`

#### Shared (`src/shared/`)
- `config.js` — Zod schema validation with sensible defaults, `loadConfig()` + `saveDefaultConfig()`
- `db.js` — `better-sqlite3` with `sqlite-vec` extension (graceful fallback if unavailable), WAL mode, migration runner
- `logger.js` — `pino` structured JSON logger factory with per-module names
- `paths.js` — All `~/.kiroku/` path constants + `ensureDirs()` for directory tree creation
- `ids.js` — `nanoid` prefixed ID generators: `evt_`, `turn_`, `fact_`, `ent_`, `job_`, `conv_`
- `redact.js` — DLP regex engine driven by config rules
- `session-resolver.js` — Reads `~/.claude/projects/<escaped-path>/*.jsonl` to resolve current Claude Code session UUID (5s mtime cache)
- `constants.js` — Security constants: SQL deny patterns, DLP regex, SQLite pragmas, allowed SQL prefixes

#### License (`src/license/`)
- Ed25519 signature verification from `~/.kiroku/license/public.pem`
- Machine-bound ID: SHA256(MAC + arch + platform) -> 16-char hex
- `scripts/gen-keypair.js` — Offline keypair generation (not shipped in install package)
- `scripts/sign-license.js` — Offline license signing (not shipped in install package)

#### Database
- 6 core tables: `projects`, `conversations`, `turns`, `entities`, `facts`, `extraction_jobs`
- 8 indexes for common query patterns
- `fact_embeddings` vec0 virtual table with `float[1024]` embedding column
- WAL journal mode, `synchronous=NORMAL`, `foreign_keys=ON`

#### Configuration
- `~/.kiroku/config.json` — User-editable config (~70 fields) with Zod validation
- `.env` — Provider API keys (OPENROUTER_API_KEY, etc.)
- `.mcp.json` — Auto-generated MCP server registration for Claude Code

### Removed (from V14)

- **Ghost keepalive ping** (`fireSinglePing()`, max_tokens=1) — Violated Red Line R1 (Pro/Max session mode drains message limits)
- **Request interception** (title generation, prediction interception -> mock SSE) — Violated Red Lines R3/R4
- **Intent-based request blocking** — Proxy no longer has interception capability; classifier is logging-only
- **Inline .md log files** — Replaced by structured .jsonl queue + pino JSON logs
- **`delete process.env.ANTHROPIC_API_KEY`** — V15 does not manipulate environment variables
- **Emoji log rendering** (`processLogLine()`) — Replaced by `pino` structured JSON
- **`god-mode` naming** — All references removed per decision D6
- **Monolithic single-file architecture** — Split into 22 focused source files

### Changed (from V14)

- `Buffer.concat` full-response parsing -> line-by-line SSE streaming parser
- Hardcoded public key in source -> read from `~/.kiroku/license/public.pem`
- `LOG_DIR = os.tmpdir()` -> `~/.kiroku/logs/` + `~/.kiroku/data/queue/`
- Private key in source (`keygen.js`) -> offline scripts not shipped in package
- Port strategy preserved: random port + state file
- Daemon spawn pattern preserved: detached process with `KIROKU_DAEMON=1`
- Session/conversation ID: heuristic time-gap -> direct `~/.claude/projects/` directory reading

### Fixed

- **storeTurn FK constraint** — `storeTurn()` returned a generated turn ID even when no row was inserted (empty assistant text from tool_use-only responses). `storeFacts()` then referenced a non-existent `source_turn_id`, causing FOREIGN KEY violation. Fixed by returning `null` when no row is inserted.
- **sqlite-vec KNN with JOIN** — vec0 virtual table does not recognize SQL `LIMIT` as a valid k constraint inside JOIN queries. Refactored `memory_search` to use a subquery with explicit `k = ?` parameter for the KNN portion, then JOIN for metadata enrichment.
- **memory_search vector search in MCP** — MCP gateway never called `initEmbedder()`, causing all vector searches to throw and silently fall back to text search. Fixed by auto-initializing embedder on first vector search call (cached after first load).
- **memory_save missing embedding** — Facts saved via `memory_save` MCP tool had no embedding, making them invisible to vector search until Worker's next poll. Fixed by generating embedding inline immediately after save. First call incurs ~2-3s model load; subsequent calls add ~50ms.
- **CJK text search** — Chinese queries without spaces were treated as a single keyword, causing LIKE match failures. Replaced character splitting with `Intl.Segmenter` (Node 16+ built-in) + stop word filtering + OR logic. See `docs/adr-001-cjk-text-search.md`.

### Security

- 5 Red Lines enforced:
  - R1: No keepalive in session mode (Pro/Max subscription)
  - R2: No dynamic CLAUDE.md modification (only one-time `kiroku init` append)
  - R3: No fake MCP tool results
  - R4: No request interception or mock SSE responses
  - R5: Private keys never in repository or install package
- DLP redaction applied to both user input and assistant output before queue storage
- `thinking` blocks not stored by default (`storeThinkingBlocks: false`)
- SQL sandbox with dual guard: statement prefix whitelist + regex deny patterns
- MCP write tools restricted to `facts`/`entities` tables only

### Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@modelcontextprotocol/sdk` | ^1.12.0 | MCP server + stdio transport |
| `zod` | ^3.24.0 | Config + MCP schema validation |
| `better-sqlite3` | ^11.8.0 | Synchronous SQLite driver with WAL |
| `sqlite-vec` | ^0.1.6 | vec0 vector virtual table (version pinned, pre-v1) |
| `@huggingface/transformers` | ^3.4.0 | Local bge-m3 embedding (replaces @xenova/transformers v2) |
| `eventsource-parser` | ^3.0.1 | Zero-dependency SSE parser |
| `pino` | ^9.6.0 | Structured JSON logging |
| `nanoid` | ^5.1.0 | Short ID generation |

### Deliberately Not Used

| Package | Reason |
|---------|--------|
| `undici` | Raw `node:http/https` sufficient, proven in V14 |
| `http-proxy` | 7 years without major update, SSE handling needs extra config |
| `yargs` | Only 6 subcommands, `process.argv` parsing sufficient |
| `dotenv` | Node 20+ `--env-file` built-in |
| `chokidar` | `setInterval` polling more stable (macOS fs.watch rename event issues) |

### Milestones

- **M0 (PRD + structure):** Complete
- **M1 (Proxy + queue):** Complete — passthrough, DLP, side-recording, queue dump verified
- **M2 (Worker):** Complete — extraction, embedding, SQLite write, retry, dead-letter all verified
- **M3 (MCP gateway):** Complete — 4 tools + 1 resource, vector KNN search verified
- **M4 (License + ops):** Complete — Ed25519 verify, machine ID, doctor, export

### Known Issues

1. **sqlite-vec 0.1.x stability** — Pre-v1 alpha. `db.js` includes graceful fallback to text search when vec extension fails to load.
2. **DLP false positives** — AWS key pattern (`AKIA[0-9A-Z]{16}`) may match some base64 strings.
3. **Cross-platform session path** — `~/.claude/projects/` path escaping (separator -> `-`) untested on Windows.
