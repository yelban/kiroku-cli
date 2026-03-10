# Kiroku V15 — 從零開始完整安裝指南

## 概述

Kiroku V15 是 Claude Code 的 AI 記憶側車。它由三個獨立模組組成：

1. **Proxy** — 透明攔截 Claude API 請求，旁路側錄對話內容
2. **Worker** — 背景萃取實體/事實 + 本地向量化 (bge-m3)
3. **MCP Gateway** — 讓 Claude 可以搜尋/儲存/遺忘記憶

資料流：
```
Claude Code ──req──▶ Proxy ──passthrough──▶ api.anthropic.com
                       │ (SSE 旁路側錄)
                       └──▶ queue/*.jsonl ──▶ Worker ──▶ SQLite + vec0
                                                            ▲
Claude Code ◀── MCP stdio ◀── kiroku-mcp-gateway ──────────┘
```

---

## 前置需求

- macOS / Linux
- Node.js >= 20.0.0
- Claude Code CLI (`claude`) 已安裝
- OpenRouter API Key（用於 Worker 的 LLM 萃取）

可選：
- Ollama（本地 LLM fallback，不需要 API key）

---

## 第一步：安裝

```bash
npm install -g @kiroku/cli
```

首次安裝約 200 個套件。`sqlite-vec` 和 `better-sqlite3` 會編譯原生模組。

> **開發者模式**：如果你是從原始碼開發，改用 `cd kiroku-v15 && npm install`，然後用 `node bin/kiroku.js` 代替 `kiroku` 指令。

---

## 第二步：初始化 + 設定 Provider

```bash
kiroku init
```

互動式設定會引導你選擇萃取 provider 並輸入 API key：

```
── Extraction Provider Setup ──────────────────────────────

  1) OpenRouter    — cloud, 200+ models (recommended)
  2) OpenAI-compat — OpenAI, Groq, Together, etc.
  3) Google Gemini — direct Gemini API
  4) Anthropic     — direct Claude API
  5) Ollama        — local, free, no API key

Provider [1-5, default 1]: ▌
```

API key 自動存入 `~/.kiroku/.env`（權限 600），provider/model 寫入 `~/.kiroku/config.json`。

> **CI/pipe 環境**：非 TTY 會跳過互動，之後可手動設定：
> ```bash
> echo "OPENROUTER_API_KEY=sk-or-v1-xxx" > ~/.kiroku/.env && chmod 600 ~/.kiroku/.env
> ```

`kiroku init` 也會建立：
- `~/.kiroku/config.json` — 設定檔（可手動調整）
- `~/.kiroku/data/memory.sqlite` — 記憶資料庫（WAL mode + sqlite-vec）
- `~/.kiroku/data/queue/` — 佇列目錄（incoming / processing / done / dead-letter）
- `~/.kiroku/logs/` — 結構化 JSON log
- `~/.kiroku/run/` — daemon 狀態檔
- 專案 `CLAUDE.md` 追加 `## Memory (Kiroku)` 區塊（如果有 CLAUDE.md）

> 重新執行 `kiroku init` 時，會偵測已有設定並詢問是否重新設定。

---

## 第三步：在 CLAUDE.md 加入記憶指引

`kiroku init` 會自動追加，但如果你的 CLAUDE.md 已存在且沒有追加，手動加入：

```markdown
## Memory (Kiroku)
- 開始新任務前，用 memory_search 檢查相關歷史上下文
- 使用者說「記住」「remember」時，用 memory_save 儲存
- 使用者說「忘記」「forget」時，用 memory_forget 歸檔
```

這段指引讓 Claude 知道何時該主動查詢/儲存記憶。約佔 50-80 tokens。

---

## 第四步：啟動

```bash
cd your-project-directory
kiroku start
```

`kiroku start` 會自動：

1. 啟動 **Proxy daemon**（隨機 port，背景執行）
2. 啟動 **Worker daemon**（背景執行，首次會下載 ~600MB bge-m3 模型）
3. 寫入 `.mcp.json`（註冊 kiroku-memory MCP server）
4. 設定 `ANTHROPIC_BASE_URL` 指向 proxy
5. 啟動 `claude` CLI

> **重要：必須透過 `kiroku start` 啟動的 Claude Code 才會經過 proxy。**
> 直接執行 `claude` 不會走 proxy，對話不會被側錄。

---

## 運作驗證

### 檢查狀態

```bash
kiroku status
```

應顯示：
```
Proxy:  RUNNING (port XXXXX, PID XXXXX)
Worker: RUNNING (PID XXXXX)
MCP:    REGISTERED

DB Stats: N projects, N turns, N active facts, N entities
Queue:  0 incoming, 0 processing, 0 dead-letter
```

### 檢查對話記錄

對話會自動記錄為 Markdown 檔案：

```bash
# 即時記錄（proxy 每輪自動寫入）
ls ~/.kiroku/logs/conversations/

# 檢視特定對話
cat ~/.kiroku/logs/conversations/<project-id>/<date>-<session>.md
```

也可以事後轉換 Claude Code 的完整歷史：

```bash
# 列出可用 session
kiroku transcript --list

# 轉換為 markdown
kiroku transcript <session-id>

# 批次轉換所有 session
kiroku transcript --all
```

詳見 [`docs/conversation-logging.md`](conversation-logging.md)。

### 檢查 Proxy log（即時）

```bash
tail -f ~/.kiroku/logs/proxy.log | npx pino-pretty
```

每次 Claude API 請求會看到：
```
INFO (proxy): request
    projectId: "your-project"
    authMode: "session"
    intent: "mainline"
    stream: true
INFO (proxy): turn captured
    eventId: "evt_xxxx"
```

### 檢查 Worker log（即時）

```bash
tail -f ~/.kiroku/logs/worker.log | npx pino-pretty
```

Worker 萃取成功會看到：
```
INFO (worker): processed
    jid: "job_xxxx"
    entities: 3
    facts: 2
```

### 檢查記憶資料

```bash
sqlite3 ~/.kiroku/data/memory.sqlite "
  SELECT e.canonical_name, f.predicate, f.object_text
  FROM facts f
  LEFT JOIN entities e ON f.subject_entity_id = e.id
  WHERE f.status = 'active'
  ORDER BY f.created_at DESC
  LIMIT 20;
"
```

---

## 在 Claude Code 中使用記憶

### 自動（被動）

所有對話自動經 Proxy 側錄 → Worker 背景萃取實體/事實 → 向量化存入 SQLite。
使用者不需做任何事。

### 手動讀取

Claude 會根據 CLAUDE.md 指引和 tool description 自動在需要時呼叫：

```
你：之前我們怎麼處理資料庫的？
Claude：(自動呼叫 memory_search) 根據記憶，專案使用 SQLite + WAL mode...
```

也可以明確要求：
```
你：搜尋記憶，找關於 deployment 的決定
```

### 手動寫入

```
你：記住：部署環境用 Docker + nginx reverse proxy
Claude：(呼叫 memory_save) Saved: 部署環境 使用 Docker + nginx reverse proxy
```

### 手動遺忘

```
你：忘掉舊的資料庫密碼相關記錄
Claude：(呼叫 memory_forget) Archived 2 facts
```

### 進階 SQL 查詢

```
你：用 sql_readonly 查詢最近一週的對話統計
Claude：(呼叫 sql_readonly) SELECT date(captured_at), count(*) FROM turns GROUP BY 1...
```

---

## 停止

```bash
kiroku stop
```

停止 Proxy + Worker daemon。MCP server 隨 Claude Code 退出自動結束。

---

## 健康檢查

```bash
kiroku doctor
```

檢查項目：
- config.json 格式驗證
- SQLite DB 可讀寫
- sqlite-vec 擴充載入
- bge-m3 模型快取
- OpenRouter API key 可用性
- License 狀態

### MCP health_status tool

Claude 可直接呼叫 `health_status` tool 取得系統狀態（DB stats、queue depth、embedding coverage、license tier），不需離開對話。

### 稽核日誌 (audit_log)

所有 memory 操作（save / forget / extract / evict）自動寫入 `audit_logs` 表，可用 `sql_readonly` 查詢：

```
SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 20;
```

### Stop Hook 即時處理

`kiroku start` 會自動註冊 Claude Code Stop hook。當 Claude Code 對話結束時，worker 會立即處理 queue 中的待處理事件，不必等待下一次 poll。

---

## 目錄結構

### 源碼

```
~/zoo/claude-proxy/kiroku-v15/
├── bin/kiroku.js            # CLI 入口
├── src/
│   ├── shared/ (11 files)   # 共用模組（含 health, audit）
│   ├── proxy/ (5 files)     # Proxy 模組（含 md-logger）
│   ├── worker/ (4 files)    # Worker 模組
│   ├── mcp/ (5 files)       # MCP Gateway 模組（含 health-status）
│   ├── cli/ (1 file)        # CLI 子命令（transcript converter）
│   └── license/ (3 files)   # 授權模組
├── migrations/ (6 files)    # DB schema
├── prompts/extraction.md    # LLM 萃取 prompt
└── docs/                    # PRD + 測試結果 + 本指南
```

### 執行期

```
~/.kiroku/
├── config.json              # 使用者設定
├── .env                     # API keys（kiroku init 自動建立，權限 600）
├── data/
│   ├── memory.sqlite        # 記憶資料庫
│   └── queue/
│       ├── incoming/        # 待處理事件
│       ├── processing/      # 處理中
│       ├── done/            # 已完成
│       └── dead-letter/     # 失敗
├── logs/
│   ├── proxy.log            # Proxy 結構化 log
│   ├── worker.log           # Worker 結構化 log
│   ├── mcp.log              # MCP Gateway log
│   ├── conversations/       # Proxy 即時 Markdown 對話記錄
│   └── transcripts/         # Transcript converter 輸出
├── run/
│   ├── proxy.state.json     # Proxy PID + port + secret
│   └── worker.state.json    # Worker PID
└── license/                 # 授權檔（可選）
```

---

## 設定檔參考

`~/.kiroku/config.json` 的關鍵設定：

```json
{
  "proxy": {
    "port": 0,                          // 0 = 隨機 port
    "upstream": "https://api.anthropic.com",
    "sseCaptureEnabled": true,           // 側錄開關
    "storeThinkingBlocks": false,        // 不儲存 thinking 內容
    "markdownLog": {
      "enabled": true,                   // 即時 Markdown 對話記錄
      "maxToolInputLength": 50000,       // 截斷過長 tool input
      "maxFileSizeKB": 512               // 單檔上限，超過自動分段
    }
  },
  "worker": {
    "enabled": true,
    "pollIntervalMs": 2000,              // 佇列輪詢間隔
    "extraction": {
      "provider": "openrouter",          // openrouter | openai-compatible | gemini | anthropic | ollama
      "model": "google/gemini-2.0-flash-001",
      "baseUrl": "",                     // openai-compatible / ollama 需要
      "apiKeyEnv": "OPENROUTER_API_KEY"  // 對應 ~/.kiroku/.env 中的 key 名
    },
    "embedding": {
      "model": "Xenova/bge-m3",          // 本地 embedding 模型
      "dtype": "q8",                     // 量化精度
      "dimensions": 1024
    }
  }
}
```

---

## 常見問題

### Q: 為什麼當前對話沒被側錄？
A: 必須透過 `kiroku start` 啟動 Claude Code。它會設定 `ANTHROPIC_BASE_URL` 指向 proxy。直接跑 `claude` 不會走 proxy。

### Q: Worker 萃取失敗怎麼辦？
A: 檢查 `~/.kiroku/logs/worker.log`。常見原因：
- API key 無效 → 檢查 `~/.kiroku/.env`
- Ollama 沒啟動 → `ollama serve`
- 網路問題 → 檢查連線

失敗事件會進 `dead-letter/`，可手動搬回 `incoming/` 重試：
```bash
mv ~/.kiroku/data/queue/dead-letter/*.jsonl ~/.kiroku/data/queue/incoming/
```

### Q: 佔多少 token？
A: kiroku-memory 的 4 個 MCP tools 合計約 790 tokens（佔 context 的 0.4%），非常輕量。

### Q: 支援多專案嗎？
A: 支援。每個專案目錄的 CWD 會轉為 project slug，facts 和 entities 按 project_id 隔離。

### Q: 如何備份記憶？
A: 直接複製 `~/.kiroku/data/memory.sqlite`（WAL mode 下複製前建議先 checkpoint）：
```bash
sqlite3 ~/.kiroku/data/memory.sqlite "PRAGMA wal_checkpoint(TRUNCATE);"
cp ~/.kiroku/data/memory.sqlite ~/backup/
```

### Q: `memory_save` 後向量搜尋找不到？
A: 不會。`memory_save` 現在會立即產生 embedding，存入後馬上可被向量搜尋找到。首次呼叫會載入 embedding 模型（~2-3 秒），之後每次只增加約 50ms。如果 embedding 產生失敗（例如模型檔損壞），fact 仍會正常存入，只是暫時無法被向量搜尋找到（可用 `sql_readonly` 查到）。

### Q: 支援中文搜尋嗎？
A: 支援。向量搜尋（主路徑）使用 bge-m3 模型，原生支援多語言語意搜尋。文字搜尋（fallback）使用 `Intl.Segmenter` 做中文分詞 + 停用詞過濾。詳見 `docs/adr-001-cjk-text-search.md`。

### Q: 如何匯出記憶？
A: `kiroku export`

### Q: 如何查看過去的對話記錄？
A: 兩種方式：
1. **即時記錄**（Proxy 自動寫入）：`ls ~/.kiroku/logs/conversations/`
2. **事後轉換**（完整歷史）：`kiroku transcript --list` 列出可用 session，`kiroku transcript <id>` 轉換。

詳見 [`docs/conversation-logging.md`](conversation-logging.md)。

### Q: AskUserQuestion 的回答有被記錄嗎？
A: 有。v15.2.0 修復了 `tool_result` blocks 被過濾的 bug，現在 AskUserQuestion 回答、Read/Grep 等工具回傳結果都會正確記錄。
