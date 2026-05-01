# Extraction Cost Analysis & Multi-Client Extensibility

> 2026-04-30 — 分析 extraction worker 的 API 用量、模型選擇邏輯、以及擴展到其他 AI agent CLI 的可行性。

## 1. Worker 輪詢頻率與訂閱配額影響

### 輪詢機制

Worker 每 `pollIntervalMs`（預設 **2000ms**）掃描一次 `~/.kiroku/data/queue/incoming/`：

- **輪詢本身不打 API**——只是檔案系統 `readdir` 操作，成本可忽略。
- 真正的 API 呼叫是「**每個 conversation turn 都觸發一次 extraction**」。
- Proxy 在 SSE side-recording 完成後寫入一個 `.jsonl` 檔案，worker 讀到就送 LLM。

問題不在輪詢頻率，在於 **1 turn = 1 API call** 的設計，沒有合併。

### 訂閱配額消耗模型

Claude Max subscription 的 rate limit 是 5 小時滾動視窗。實測量級：

| 項目 | 數量 |
|------|------|
| 每筆 extraction 的 input tokens | ~2,000（system prompt + turn 內容） |
| 每筆 extraction 的 output tokens | ~500-1,500（JSON entities + facts） |
| Max 訂閱每 5h 大致上限 | 200-400k output tokens |
| **每 5h 可消化的 turn 數** | **約 200-400 筆** |

### 為什麼會撞到 session limit

實測發現：使用者**自己的 Claude Code session** 也消耗 Max 配額。當以下三者並行時，配額會被快速耗盡：

1. 使用者的當前 Claude Code session（互動式對話）
2. Extraction worker（背景處理 turn）
3. 開發或測試呼叫（驗證新功能）

特別是 xhigh effort 模式下，互動 session 本身單個 turn 的 token 用量就很高。

### 減壓方案（按效益排序）

| 方案 | 預期減量 | 實作難度 |
|------|---------|---------|
| **Batch extraction**（5-10 turns 合一次 API call） | -80% 呼叫 | 中 |
| **Prompt caching**（system prompt 快取） | -90% input tokens | 低（已實作於 v1.5.0） |
| **Filter trivial turns**（跳過短於 200 字、純工具回應） | -30~50% 呼叫 | 低 |
| **Throttle**（每分鐘最多 N 筆） | 控制爆量 | 低 |
| **延後處理**（只在 session 結束批次跑） | 平滑配額消耗 | 低 |

當前已實作：**Prompt caching**（v1.5.0）。其他方案待評估。

## 2. Extraction Provider 選項與選擇邏輯

`~/.kiroku/config.json` 的 `worker.extraction.provider` 欄位決定使用哪個 provider。

### 支援的 Provider

| Provider | 適用場景 | 認證來源 |
|----------|---------|---------|
| `anthropic` | Claude 模型（訂閱 OAuth 或 API key） | **自動偵測 4 種**（見下） |
| `openrouter` | 任何 OpenRouter 模型 | `OPENROUTER_API_KEY` env |
| `gemini` | Google Gemini | `GEMINI_API_KEY` env |
| `openai-compatible` | 任何 OpenAI 相容端點（含中轉站） | 自訂 `apiKeyEnv` 與 `baseUrl` |
| `ollama` | 本地 Ollama（免費離線） | 無 |

### Provider 選擇方式

- **手動配置**：使用者在 `~/.kiroku/config.json` 設 `provider` 和 `model`。
- **無自動 fallback**：除非缺 API key，否則不切換。
- **降級規則**：當 `apiKeyEnv` 未設時，降級到 `config.worker.extraction.fallback`（預設為 ollama）。

範例：
```json
{
  "worker": {
    "extraction": {
      "provider": "anthropic",
      "model": "claude-sonnet-4-6",
      "temperature": 0,
      "maxOutputTokens": 2048
    }
  }
}
```

### Anthropic Provider 的認證優先序

`src/worker/anthropic-auth.js` 的 `resolveAnthropicAuth()` 依序嘗試：

| 優先序 | 來源 | 用途 | Header 行為 |
|--------|------|------|-----------|
| 1 | `CLAUDE_CODE_OAUTH_TOKEN` env | 訂閱長效 OAuth token（`claude setup-token`） | Bearer + OAuth beta headers |
| 2 | `ANTHROPIC_AUTH_TOKEN` env | Bearer token（常見於中轉站） | Bearer + Claude Code 標識（若 baseUrl 非官方） |
| 3 | `ANTHROPIC_API_KEY` env（或 `apiKeyEnv` 自訂） | 標準 API key | x-api-key |
| 4 | macOS Keychain `Claude Code-credentials` | 訂閱 OAuth + 自動 refresh | Bearer + OAuth beta headers |

OAuth token 偵測（`isOAuthToken()`）：`sk-ant-oat*`、`eyJ*`（JWT）、`cc-*` prefix → OAuth。

## 3. 擴展到其他 AI Agent CLI 的可行性

當前 kiroku 設計緊密耦合 Claude Code。要擴展到 Codex CLI 或其他 agent，需考慮以下差異與改動。

### 架構差異對照

| 元件 | Claude Code | Codex CLI | OpenAI Codex (legacy) |
|------|-------------|-----------|----------------------|
| **API protocol** | Anthropic Messages（`/v1/messages`） | OpenAI Responses API（`/v1/responses`） | OpenAI Chat Completions（`/v1/chat/completions`） |
| **SSE 格式** | `event: message_delta` 等 typed events | OpenAI streaming chunks | `data: {...}` chunks |
| **Auth header** | `x-api-key` 或 `Authorization: Bearer` | `Authorization: Bearer` | `Authorization: Bearer` |
| **Base URL 覆蓋** | `ANTHROPIC_BASE_URL` | `OPENAI_BASE_URL` 或 config | `OPENAI_BASE_URL` |
| **MCP 支援** | 原生 | 透過 plugin / codex-orchestrator | 部分（需特定版本） |
| **Session start hook** | 原生 hook 系統 | 配置檔 / 環境變數 | 無標準機制 |

### 改動範圍評估

要支援 Codex CLI，需要的改動：

#### 必改（核心）

1. **Proxy 多協定路由**（`src/proxy/server.js`）
   - 偵測 request path：`/v1/messages`（Anthropic）vs `/v1/responses` 或 `/v1/chat/completions`（OpenAI）
   - 為每種 protocol 寫一個 SSE recorder（目前只支援 Anthropic 格式）

2. **Turn 抽取通用化**（`src/proxy/server.js` line 104-140）
   - 目前 parse `messages[]` 是 Anthropic 結構（`role`、`content` blocks 含 `text`/`tool_use`/`tool_result` 等）
   - OpenAI 結構不同：`role`、`content` string 或 array of `text`/`image_url` 等
   - 需要 abstract 成「conversation turn」中介格式，再對接到 queue writer

3. **記憶注入機制**
   - Claude Code 用 `SessionStart` hook 跑 bash + sqlite3 query 注入 facts 到 system prompt
   - Codex 沒有等同 hook，可能路徑：
     - 透過 MCP server 提供 `project_context` tool（Codex 若支援 MCP）
     - 預先寫入 `~/.codex/instructions.md` 或類似檔案
     - 用 wrapper script 在啟動時注入

4. **CLI 整合**（`bin/kiroku.js`）
   - `kiroku start` 目前 spawn `claude`，需新增 `kiroku start --client codex` 之類
   - 多 client 的 project slug 解析（不同 CLI 的 cwd 處理可能不同）

#### 可選（增強）

5. **MCP 工具相容性**：Claude Code MCP tool 名稱前綴是 `mcp__kiroku-memory__*`，Codex 可能用不同格式
6. **設定檔抽象**：把 Anthropic-specific 的 `proxy.upstream` 改成 per-client 設定

### 工作量估計

- **Anthropic + Codex 雙協定**：~1-2 週（一個熟手）
- **任意 OpenAI 相容 client**：~3-4 週（需要更通用的協定 abstraction）

### 主要風險

1. **Codex 的記憶注入點**：MCP 是最乾淨的路徑，但需要 Codex 端正確配置 MCP server。若 Codex 版本不支援 MCP，要用 system prompt 預先注入，UX 會變差（無法動態更新）。
2. **OpenAI Responses API 仍在 beta**：規格可能變動。
3. **多 protocol proxy 增加維護成本**：每個新增的 client 都要寫一份 SSE parser。

### 建議

若要做擴展，建議分階段：

1. **Phase 1**：抽取 protocol 層成介面（`src/proxy/protocols/anthropic.js`、`openai.js`），現有 Claude Code 流程跑在 anthropic protocol 上。
2. **Phase 2**：實作 OpenAI protocol，先用 Codex 驗證。
3. **Phase 3**：通用化 CLI launcher 和 hook 注入機制。

但**短期內不必做**——Claude Code 仍是主力，先把 Claude Code 體驗打磨到位（batch、filter、throttle 等減壓功能）更實際。

## 相關文件

- [kiroku-features-and-design.md](./kiroku-features-and-design.md) — 整體架構
- [extraction-model-research-2026-03-07.md](./extraction-model-research-2026-03-07.md) — 早期模型選型研究
- [worker-retry-mechanism.md](./worker-retry-mechanism.md) — Worker 重試機制
- [kiroku-v15-prd.md](./kiroku-v15-prd.md) — v15 PRD
