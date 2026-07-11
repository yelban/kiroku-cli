# Changelog

All notable changes to Kiroku are documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added

#### mini-FAMA Exam Expansion + Behavior Metrics (M4-1)
- The exam now runs two booklets. The saturated v1 booklet (questions 01-09) is held as a regression asset asserted at `FAMA >= 1.0`; any drop means an M1-M3 memory behavior regressed. The new M4 booklet (questions 10-20) covers quarterly-horizon timelines with decay/freeze interplay, batch refactor pressure, alias chains, full-subject completeness under mutation, and reasoning via retrieval-completeness plus real `sql_readonly` aggregation.
- Red questions (`test.fails`) price in open gaps and anchor their acceptance criteria on end states, not future API shapes: 13/14 → A1 repo grounding (a silent `git mv` or batch directory refactor leaves stale path facts active), 18 → G13 multi-valued predicate false supersede (the exact `(subject, predicate)` supersede in `storeFacts` assumes single-valued predicates, so complementary facts like multiple `requires env var` values kill each other; the semantic resolver's same-predicate replacement signal shares the assumption).
- Behavior metrics (AutoMem Figure 4 analogues) are now scored alongside FAMA: `emptySearchRate` and `dedupRate` are asserted against measured baselines (`0.066667`, `0.003731`); the supersede reason distribution and brief row/char cost are recorded in `test-results/memora-score.json` without assertions.
- Measured M4 booklet baseline at M4-1 (G9/A1/G13 unimplemented): `MPA=0.818182`, `FAA=0.545455`, `FAMA=0.666667`.

#### mini-FAMA M5 Booklet + Compaction Merge-Band Fix (M5, G14)
- Third exam booklet (questions 21-26); v1 and M4 booklets are held as saturated regression assets asserted at `FAMA >= 1.0`. Red questions price the remaining backlog with outcome-anchored criteria: 22 → G4 supersede chain/timeline (`supersedes_fact_id`/`valid_to` still unwritten), 23 → G8 preference immortalization (a differently-worded replacement below both thresholds never displaces a boost-stacked stale preference in the brief), 24 → G12 brief type quotas (a tight budget fills with preferences and starves high-heat project facts). Green questions verify generalization: 25 cross-entity SQL aggregation under mutation, 26 `memory_about` resolving the oldest name across a three-hop rename chain.
- G14 fixed in the same commit: compaction now routes same-predicate pairs whose objects genuinely differ (normalized, so paraphrase spellings like "DuckDB"/"Duck DB" still merge) to conflict handling even inside the `>0.92` merge band — a multi-valued group with near-identical embeddings is no longer compacted away, and a single-valued pair above the band is demoted instead of silently merged.
- Measured M5 booklet baseline: pre-G14 `MPA 0.6, FAA 0.666667, FAMA 0.544444` → post-G14 `FAMA 0.677778` (question 21 green; 22/23/24 remain red). Behavior baselines re-measured: `emptySearchRate 0.0625`, `dedupRate 0.003378`.
- New finding (candidate G15): `REPLACEMENT_CUES` matches substrings without word boundaries — 'prefix' contains 'fix', so a fact mentioning it can falsely supersede same-subject facts at insert time. Question 21's fixture documents and avoids the collision.

#### Multi-Valued Predicate Fix (G13)
- The single-valued assumption behind "same subject+predicate replaces the old fact" is now scoped to the fact types where it is true. `SINGLE_VALUED_FACT_TYPES` (`preference`/`state`/`task`) gates all three sites that shared the assumption:
  - `storeFacts` exact supersede only fires for single-valued types (preference → `superseded`, state/task → `archived` per the type-aware disposition convention) and now writes an `exact_supersede` audit row — this path was previously silent. Semantic/episodic facts with the same subject+predicate coexist; their mutation flows through operation/cue/compaction paths.
  - The semantic resolver's same-predicate replacement signal now only applies when the target is a `preference` (state/task remain unconditionally replaceable; explicit replacement cues are unchanged).
  - Compaction conflict demotion only fires when both facts are single-valued types; semantic same-predicate/different-object pairs are logged but no longer demoted, so complementary groups (several env vars, several dependencies) stop evaporating one sweep at a time.
- `saveFactManually` (`memory_save`) deliberately keeps replace semantics: a manual re-save of the same subject+predicate is treated as explicit intent.
- Exam question 18 flipped from red to green and now also asserts compaction leaves the group undemoted. M4 booklet baseline: `FAMA 0.92 -> 1.0` — the 20-question exam is **saturated again**; the next improvement round must open by expanding it. Known open edge: the compaction `>0.92` merge band ignores object differences and could still compact a multi-valued group with near-identical embeddings (noted in the gap analysis as a candidate).

#### Repo-Grounded Fact Validation (A1)
- The worker now validates path facts against the repository itself, on the same cadence as the decay sweep. Facts whose subject is an `entity_type='file'` repo-relative path are checked against `git ls-files` plus the filesystem: a missing path is first only marked (`facts.missing_since`, heat halved to the type floor, `repo_grounding` audit row) and archived only when a second sweep confirms it — so branch switches and stashes never kill valid memory. A path that comes back clears its mark.
- Renames detected via `git diff --find-renames` between `projects.last_swept_commit` and HEAD win over the missing flow: each rename inserts a real "moved from" fact (confidence 1.0, detail notes repo grounding) and reuses the existing move pass, so old-path facts are superseded and the old name lands in the new entity's aliases. A stale base ref resets to HEAD and skips renames for that round; the missing flow backstops.
- Projects are only swept when `projects.root_path` is recorded (migration 009, written by `kiroku start` and the MCP gateway); the sweep never guesses a path from the cwd slug, runs git strictly read-only with a timeout, and skips the project on any git failure.
- Set `worker.repoGrounding.enabled` to `false` to disable; `worker.repoGrounding.confirmHours` (default 6) controls the two-sweep confirmation interval.
- Exam questions 13/14 flipped from red to green (question 14 now also asserts the first detection does NOT kill the fact). M4 booklet baseline: `FAMA 0.774155 -> 0.92` (`MPA=0.92`, `FAA=1.0`). The last remaining red is question 18 (G13 multi-valued predicate false supersede).

#### memory_about MCP Tool (M4-2, G9)
- New `memory_about(subject)` tool returns ALL active facts about one entity, bypassing `memory_search`'s top-k cut and diversity filter — for summarizing, auditing, or reasoning across everything known about a topic. Results are grouped by fact_type with the same relative-age markers as the brief, capped at 200 facts.
- Renamed entities resolve through `entities.aliases_json`: querying a retired name (e.g. the old path after a `move` operation chain) lands on the entity that now carries it as an alias, with the resolution noted in the output.
- Exam questions 16/17 flipped from red to green. M4 booklet baseline: `FAMA 0.666667 -> 0.774155` (`MPA=0.913043`, `FAA=0.615385`); floor updated accordingly. Remaining red: 13/14 (A1), 18 (G13).

#### Memory Operation Semantics (M3)
- Extraction prompts now use a four-operation vocabulary: `add` (default new/complementary fact), `update` (new fact supersedes an older version), `delete` (target fact is archived), and `move` (same entity moved/renamed, carrying `{from,to}` identity).
- `update` and `delete` reuse the semantic supersede resolver with relaxed operation gates; `delete` archives instead of superseding. Without embeddings, operation disposal falls back to exact same-subject matching.
- `move` is handled by a dedicated pure planner: from-entity active path facts are marked `superseded`, and the from entity canonical name/aliases are merged into the to entity via existing `entities.aliases_json` storage. No schema migration is required.
- Operation side effects use an inclusive confidence gate at `worker.supersede.operationConfidenceThreshold` (default `0.8`). Below the gate, the extracted fact is still stored and a `memory_operation` audit row records `result: "skipped"`.
- All operation side effects write `memory_operation` audit rows with operation, confidence, result, action/reason, source fact id, and target fact/entity ids.
- mini-FAMA question 05 is now a normal passing test with a move fixture. The measured score is `MPA=1`, `FAA=1`, `FAMA=1`, and `BASELINE_FAMA_FLOOR=1.0`.
- Saturation warning: the nine-question mini-FAMA exam is now fully green. M4's first task should be expanding the exam; `FAMA=1.0` must not be read as memory quality being complete.

### Changed

#### Semantic Supersede
- New extracted fact embeddings now run a post-store semantic supersede pass against active facts with the same subject and scope. Matching semantic/decision/episodic facts are marked `superseded`; matching `state`/`task` facts are marked `archived`, with `fact_embeddings.status` kept in sync and a `semantic_supersede` audit row written for each action.
- Added `worker.supersede.{enabled, semanticThreshold, stateTaskThreshold, operationConfidenceThreshold}`. Defaults are calibrated from the mini-FAMA bge-m3 fixtures at `enabled=true`, `semanticThreshold=0.58`, `stateTaskThreshold=0.8`, and `operationConfidenceThreshold=0.8`.
- To restore exact-match-only supersede behavior and disable operation side effects, set `worker.supersede.enabled` to `false`.

#### Prompt Slot Activation
- The local prompts are schema-compatible additions. Release order: ship CLI/local prompts first, then manually update the remote `default` and `batch` prompt slots after validation. `prompts/extraction-basic.md` ships through npm/local files and has no remote slot today.
- Remote slot update commands are documented in `docs/release-and-install-guide.md`; this release does not auto-deploy or auto-activate prompt slots.

#### Compaction
- Compaction conflict detection now demotes both active facts in a same-subject, same-predicate, different-object conflict by halving `heat` and `base_heat` down to the configured decay floor, and writes `conflict_demote` audit rows for the affected facts.

#### Memory Freshness Metadata
- `project_context` brief lines now end with compact `created_at` age markers: `(Nd)` for facts younger than 14 days, `(Nw)` for facts younger than 70 days, and `(Nmo)` for older facts. Missing or unparseable timestamps are omitted.
- `memory_search` now labels non-active result sets with `**⚠ Historical facts (status=...) — NOT current state**` and adds a `Status` column to the table. The default `status=active` output remains byte-for-byte unchanged.

#### Memory Search Ranking
- `memory_search` now reranks over-fetched candidates with `score = w_sim * sim + w_heat * heat + w_rec * recency`, where `recency = 0.5^(age_days / halfLifeDays)` and age is computed from `created_at`.
- Default ranking weights are `simWeight=0.65`, `heatWeight=0.15`, `recencyWeight=0.20`, and `halfLifeDays=30`, so newer hot facts can outrank older facts with only slightly better vector similarity.
- Vector search derives `sim` monotonically from sqlite-vec distance; text search uses a constant `sim` and applies the same heat/recency scoring before diversity filtering.
- Set `mcp.search.ranking` to `(simWeight=1, heatWeight=0, recencyWeight=0)` to restore pure similarity ordering. `confidence` is intentionally not part of the ranking formula.

## [1.6.0] - 2026-04-29

### Changed — Dynamic Upstream now keyed by bearer token

Upstream routing was rewritten from per-project to per-bearer-token. The proxy
now decides the upstream of each request by hashing the request's bearer
token (or `x-api-key`) and looking up `~/.kiroku/run/routes/<sha256>.json`. A
single `kiroku` daemon can now serve multiple terminals simultaneously where
some go to a relay and others go to subscription `api.anthropic.com`, without
file-level conflicts between them.

- **New: `src/shared/route-store.js`** — `hashToken`, `registerRoute`,
  `lookupRoute` (with 30s in-memory cache), and `cleanupLegacyUpstreamDir`.
  Only the SHA-256 digest of the token is written to disk; the original
  token is never persisted.
- **`src/proxy/server.js`**: `resolveUpstream(req, config)` now extracts
  Bearer / x-api-key from each request and resolves through the route store;
  log entries for routed requests include `routedBy: 'token-route'`.
- **`bin/kiroku.js cmdStart`**: reads both `ANTHROPIC_BASE_URL` and
  `ANTHROPIC_AUTH_TOKEN` (process env → project `.env` → `~/.kiroku/.env`).
  Both must be set to register a route. Setting only `ANTHROPIC_BASE_URL`
  prints a warning and falls back to subscription default — this fixes the
  401 case where a keychain bearer was being misrouted to a relay.
- **Migration**: legacy `~/.kiroku/run/upstream/<slug>.txt` directory is
  removed automatically on the first `kiroku start` after upgrade.

### Tests

- **New: `test/proxy/upstream-routing.test.js`** — covers `hashToken`
  determinism, `registerRoute`/`lookupRoute` round-trip, 30s cache TTL,
  fallback to default upstream when no token is registered, legacy directory
  cleanup, and `extractBearerToken` precedence (Bearer over `x-api-key`).

## [1.5.0] - 2026-04-29

### Added

#### Multi-Provider Anthropic Auth for Extraction Worker
- **`src/worker/anthropic-auth.js`**: Unified auth resolution module supporting 4 sources (priority order): `CLAUDE_CODE_OAUTH_TOKEN` env → `ANTHROPIC_AUTH_TOKEN` env → `ANTHROPIC_API_KEY` env → macOS Keychain with auto-refresh
- OAuth tokens (`sk-ant-oat*`, `eyJ*`, `cc-*`) automatically get Claude Code beta headers (`claude-code-20250219`, `oauth-2025-04-20`) and user-agent spoofing
- Keychain token refresh via `platform.claude.com/v1/oauth/token` with atomic credential file write-back

#### Dynamic Per-Project Proxy Upstream (superseded in 1.6.0)
- Proxy routes traffic to custom upstream per project when `ANTHROPIC_BASE_URL` is set before `kiroku start`
- Stored in `~/.kiroku/run/upstream/<project-slug>.txt`, cached 30s per project
- Enables mixed sessions: subscription (→ api.anthropic.com) alongside relay/gateway (→ custom URL) on the same machine
- Reads `ANTHROPIC_BASE_URL` from env vars, project `.env`, or `~/.kiroku/.env`
- **Note (1.6.0)**: rewritten as per-bearer-token routing; legacy upstream directory is automatically removed on upgrade.

#### API-Key Prompt Cache Keep-Alive
- **`src/proxy/keepalive.js`**: Optional keep-alive for long-context Anthropic API-key sessions, replaying the latest cacheable `/v1/messages` request with `max_tokens=1` and `stream=false`
- Strictly gated to `x-api-key` auth; `Authorization: Bearer` session / Pro / Max traffic is never pinged
- Stores snapshots and API key headers in memory only; drops snapshots after `maxLifetimeMinutes` without real user traffic
- Logs `cache_read_input_tokens` and `cache_creation_input_tokens` to `~/.kiroku/logs/keepalive.log`
- Adds `/keepalive/status?secret=...` for local status inspection

### Changed
- **Extraction config**: `provider: "anthropic"` no longer requires `apiKeyEnv` — auth is auto-resolved
- **`callAnthropic()`**: Refactored to use `resolveAnthropicAuth()` + `buildAuthHeaders()`, supports both Bearer and x-api-key auth with optional custom `baseUrl`
- **Proxy port**: Fixed at 51989 (configurable) to prevent port changes on restart breaking other sessions

---

## [1.4.0] - 2026-04-22

### Added

#### Transcript Viewer & Search
- **`kiroku transcript --view [id]`**: ANSI colorized terminal replay piped to `less -R`; AskUserQuestion rendered with `●`/`○` markers showing selected/unselected options and user notes
- **`kiroku transcript --view`** (no id): interactive TUI browser to pick a session, then view it
- **`kiroku transcript --search <query>`**: full-text search across all session JSONL files with highlighted matches and context; supports `--project <slug>` filter

#### Session Recording
- **`kiroku rec`**: launch Claude Code wrapped in terminal recording; auto-detects asciinema (animated replay) with fallback to macOS `script` (zero dependencies)
- **`kiroku play <file>`**: replay a `.cast` or `.typescript` recording
- **`kiroku recs`**: list all recordings in `~/.kiroku/recordings/`

### Fixed
- Lemon Squeezy discount URL format: `?discount=CODE` → `?checkout[discount_code]=CODE` (old format returns 404/422)

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
