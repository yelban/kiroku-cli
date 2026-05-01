# Kiroku V15

Compliant AI memory gateway for Claude Code. Side-records conversations, extracts knowledge via LLM, and serves it back through MCP tools.

```
Claude Code ──req──▶ Proxy ──passthrough──▶ upstream (api.anthropic.com or custom)
                       │ (SSE side-recording)
                       └──▶ .jsonl queue ──▶ Worker ──▶ SQLite + vec0
                                                           ▲
Claude Code ◀── MCP stdio ◀── MCP Gateway ────────────────┘
```

## Features

- **Zero-latency proxy** — Transparent passthrough with SSE side-recording, no added latency
- **Automatic knowledge extraction** — Background LLM extraction of entities and facts from every conversation
- **Local vector search** — bge-m3 embeddings (1024 dims, q8) stored in sqlite-vec for semantic retrieval
- **5 MCP tools** — `memory_search`, `memory_save`, `memory_forget`, `sql_readonly`, `health_status`
- **DLP redaction** — Strips AWS keys, API tokens, GitHub PATs before storage
- **Multi-project isolation** — Facts and entities scoped by project ID
- **API-key prompt cache keep-alive** — Optional Anthropic prompt-cache ping for long-context API sessions, never used in subscription/session mode
- **One-command launch** — `kiroku start` spawns proxy + worker + MCP + Claude Code

## Quick Start

```bash
# Install globally
npm install -g @kiroku/cli

# Configure extraction provider (choose one)
# Option A: Claude Code OAuth (Max/Pro subscription)
export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...   # from `claude setup-token`
# Option B: Anthropic API key
export ANTHROPIC_API_KEY=sk-ant-api03-...
# Option C: OpenRouter
export OPENROUTER_API_KEY=sk-or-v1-...

# Launch (auto-initializes on first run)
cd your-project-directory
kiroku start
```

First run auto-creates `~/.kiroku/` and downloads the embedding model (~600MB). Subsequent starts take <3 seconds.

See [docs/quickstart.md](docs/quickstart.md) for the full setup guide.

## Architecture

Three independent Node.js ESM modules:

| Module | Path | Role |
|--------|------|------|
| **kiroku-aegis-proxy** | `src/proxy/` | HTTP passthrough with per-bearer-token dynamic upstream, optional API-key prompt-cache keep-alive, DLP redaction, SSE side-recording → .jsonl queue |
| **kiroku-memory-worker** | `src/worker/` | Queue polling, LLM extraction (Anthropic/OpenRouter/Gemini/Ollama), bge-m3 embedding, SQLite write |
| **kiroku-mcp-gateway** | `src/mcp/` | MCP stdio server with 4 tools + 1 resource |

### Source Files

```
bin/kiroku.js              CLI: init/start/stop/status/doctor/export/reindex/transcript/activate/deactivate/license
build.mjs                  esbuild: src/ → dist/ (4 CJS bundles: proxy, worker, mcp, cli)
src/shared/   (10 files)   config, db, logger, paths, ids, redact, session-resolver, constants, health, audit
src/proxy/    (6 files)    server, keepalive, classifier, sse-recorder, queue-writer, md-logger
src/worker/   (7 files)    worker, extractor, anthropic-auth, embedder, store, prompt-loader, prompt-crypto
src/mcp/      (5 files)    server, memory-search, memory-write, sql-sandbox, health-status
src/cli/      (1 file)     transcript-converter
src/license/  (3 files)    Ed25519 verify, machine-id, license-state (LS validate + offline grace)
server/       (CF Worker)  prompt API, LS webhook, prompt admin
```

## CLI

```bash
kiroku init                # Create ~/.kiroku/ directory tree, config, and database
kiroku start               # Start proxy + worker + MCP, launch Claude Code
kiroku stop                # Stop all background daemons
kiroku status              # Report component states, DB stats, queue counts
kiroku doctor              # Health check: config, DB, sqlite-vec, model, API keys, license
kiroku export              # Export memory data to markdown
kiroku reindex             # Rebuild missing embeddings
kiroku activate <key>      # Activate a Kiroku Pro license
kiroku deactivate          # Deactivate current license
kiroku license             # Show license status
```

All `claude` CLI flags pass through: `kiroku start -c`, `kiroku start --resume`, etc.

### Transcript Viewer & Search

```bash
kiroku transcript --view [<id>]      # ANSI colorized terminal replay (piped to less)
kiroku transcript --view              # Interactive browser → pick session → view
kiroku transcript --search <query>   # Full-text search across all sessions
kiroku transcript --search <q> --project <slug>  # Search within a project
kiroku transcript --list             # List sessions (current project)
kiroku transcript --list-all         # Browse all projects (interactive TUI)
kiroku transcript <id>               # Convert session to markdown file
```

AskUserQuestion interactions are rendered with `●`/`○` markers showing which options the user selected.

### Session Recording

```bash
kiroku rec                 # Launch Claude Code with terminal recording
kiroku play <file>         # Replay a recording
kiroku recs                # List all recordings
```

Auto-detects asciinema (if installed) for animated replay; falls back to macOS `script` (zero dependencies).

## MCP Tools

| Tool | Description |
|------|-------------|
| `memory_search` | Semantic vector search (KNN) with text search fallback |
| `memory_save` | Save a fact with immediate embedding generation |
| `memory_forget` | Archive facts by ID or subject+predicate |
| `sql_readonly` | Sandboxed read-only SQL against the memory database |
| `health_status` | System health: DB stats, queue depth, embedding coverage, license tier |

## Storage

All runtime data lives in `~/.kiroku/`:

```
~/.kiroku/
├── config.json              # User configuration (Zod-validated)
├── data/
│   ├── memory.sqlite        # SQLite + WAL + sqlite-vec
│   └── queue/{incoming,processing,done,dead-letter}/
├── logs/{proxy,keepalive,worker,mcp}.log
└── run/{proxy,worker}.state.json
```

**Database schema:** 7 tables (`projects`, `conversations`, `turns`, `entities`, `facts`, `extraction_jobs`, `audit_logs`) + `fact_embeddings` vec0 virtual table.

## Security

Five red lines enforced:

| # | Rule |
|---|------|
| R1 | No keepalive in session mode (Pro/Max subscription protection) |
| R2 | No dynamic CLAUDE.md modification (one-time `init` append only) |
| R3 | No fake MCP tool results |
| R4 | No request interception or mock SSE |
| R5 | Private keys never in repository |

DLP redaction applied before queue storage. SQL sandbox blocks all write operations. Thinking blocks excluded by default.

## API-Key Prompt Cache Keep-Alive

The proxy can optionally keep Anthropic prompt cache warm for long-context API-key sessions. This is useful for 1M-context API workflows where a cached prefix would otherwise expire after a short idle period.

It is disabled by default and only activates after the proxy observes a real `/v1/messages` request using `x-api-key` auth with at least one `cache_control` marker. Subscription/session traffic (`Authorization: Bearer`) is never pinged.

```json
{
  "proxy": {
    "keepAlive": {
      "enabled": true,
      "apiKeyOnly": true,
      "intervalSeconds": 240,
      "idleShutdownSeconds": 3600,
      "maxLifetimeMinutes": 30,
      "onlyWithCacheControl": true
    }
  }
}
```

The ping replays the latest cacheable request in memory with `max_tokens: 1` and `stream: false`, logs cache usage to `~/.kiroku/logs/keepalive.log`, and drops the snapshot after `maxLifetimeMinutes` without real user traffic. It does not update proxy activity, so it will not prevent idle shutdown.

## Extraction Providers

The worker supports multiple extraction providers (configured in `~/.kiroku/config.json`):

| Provider | Config `provider` | Auth | Notes |
|----------|------------------|------|-------|
| **Anthropic** | `anthropic` | Auto-detect (see below) | Recommended. Haiku 4.5 for cost, Sonnet 4.6 for quality |
| **OpenRouter** | `openrouter` | `OPENROUTER_API_KEY` | Multi-model gateway |
| **Gemini** | `gemini` | `GEMINI_API_KEY` | Google AI Studio |
| **OpenAI-compatible** | `openai-compatible` | `apiKeyEnv` config | Any OpenAI-compatible endpoint |
| **Ollama** | `ollama` | None | Local, free, offline fallback |

### Anthropic Auth Resolution (priority order)

| # | Source | Header |
|---|--------|--------|
| 1 | `CLAUDE_CODE_OAUTH_TOKEN` env | `Authorization: Bearer` + OAuth betas |
| 2 | `ANTHROPIC_AUTH_TOKEN` env | `Authorization: Bearer` |
| 3 | `ANTHROPIC_API_KEY` env | `x-api-key` |
| 4 | macOS Keychain (`Claude Code-credentials`) | `Authorization: Bearer` + auto-refresh |

### Proxy Dynamic Upstream (per bearer token)

The proxy decides per request which upstream to forward to, keyed on the request's bearer token. This lets multiple terminals share one kiroku proxy daemon while routing to different upstreams independently.

```bash
# Terminal A (subscription, no env vars) → proxy routes to api.anthropic.com
kiroku start

# Terminal B (relay API) — both vars are required
export ANTHROPIC_BASE_URL=https://my-relay.example.com
export ANTHROPIC_AUTH_TOKEN=sk-my-relay-key
kiroku start   # registers route: bearer-<hash> → my-relay.example.com
```

How resolution works:

- `kiroku start` reads `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` from `process.env`, project `.env`, then `~/.kiroku/.env`.
- When **both** are set, kiroku writes `~/.kiroku/run/routes/<sha256(token)[:32]>.json` with `{ upstream, projectSlug, registeredAt }`. The token itself is never written to disk; only its hash.
- When only `ANTHROPIC_BASE_URL` is set (no token), kiroku prints a warning and does not register a route — the request will fall back to subscription mode and likely 401 against the relay.
- When neither is set, the request goes to the configured `proxy.upstream` (default `api.anthropic.com`).

The proxy looks up the bearer of every incoming request in this routing table. Stale entries are harmless: a token that never reappears never gets matched. To force re-registration, run `kiroku start` again with the desired env. Upgrading from older versions automatically removes the legacy `~/.kiroku/run/upstream/` directory.

Because routing is keyed on the credential the request actually carries, **multiple terminals — including in the same project directory — can share one kiroku daemon and use different upstreams independently**. No per-terminal session ID is needed; as long as each terminal uses a different `ANTHROPIC_AUTH_TOKEN` (or the default subscription falls through), the proxy dispatches correctly per request.

## Requirements

- Node.js >= 20.0.0
- macOS or Linux
- Claude Code CLI
- Extraction API key (Anthropic, OpenRouter, Gemini, or local Ollama)

## Dependencies

| Package | Purpose |
|---------|---------|
| `better-sqlite3` | SQLite driver with WAL |
| `sqlite-vec` | Vector search (vec0 virtual table) |
| `@huggingface/transformers` | Local bge-m3 embedding |
| `@modelcontextprotocol/sdk` | MCP server + stdio transport |
| `eventsource-parser` | SSE stream parser |
| `zod` | Config + schema validation |
| `pino` | Structured JSON logging |
| `nanoid` | Short ID generation |

## Documentation

- [Quickstart Guide](docs/quickstart.md) — Full installation and usage instructions
- [Conversation Logging](docs/conversation-logging.md) — Real-time markdown logging + transcript converter
- [Extraction Cost & Extensibility](docs/extraction-cost-and-extensibility.md) — Worker cost model, provider selection, multi-client extension feasibility
- [PRD](docs/kiroku-v15-prd.md) — Product requirements document
- [CHANGELOG](CHANGELOG.md) — Detailed change log
- [ADR-001: CJK Text Search](docs/adr-001-cjk-text-search.md) — Chinese word segmentation strategy
- [ADR-002: Tool Description vs CLAUDE.md](docs/adr-002-tool-description-vs-claude-md.md) — MCP tool trigger design
- [ADR-003: License System](docs/adr-003-license-system-design.md) — Ed25519 + Lemon Squeezy integration
- [ADR-004: Memory Scope System](docs/adr-004-memory-scope-system.md) — Cross-project global memory

## License

Dual tier: Free (500 facts, text search only) / Pro (unlimited, vector search, premium extraction prompt). Lemon Squeezy license validation with 7-day offline grace period.
