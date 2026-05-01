# 從提交到全新安裝的完整指南

涵蓋 Phase 1 (filter / throttle / medium effort) 與 Phase 2 (adaptive batch + streaming recovery) 上線後的三條路徑：當前機器立即生效、發布到 npm、全新機器設定。

---

## 場景 A：當前機器立即生效（最短路徑）

```bash
kiroku stop
kiroku start
```

`~/.kiroku/config.json` 已將 `worker.extraction.batch.enabled` 改成 `true`，重啟後 worker 直接走新管線。

驗證：

```bash
tail -f ~/.kiroku/logs/extractor.log | grep "batch extraction usage"
```

---

## 場景 B：發布到 npm（讓其他機器可以拉）

### 1. Bump version（Phase 1+2 屬於 minor）

```bash
cd /Users/orz99/zoo/kiroku-cli
npm version minor -m "chore: release v%s — worker filter/throttle/effort + adaptive batch"
# 1.6.0 → 1.7.0；自動 commit + 建 tag v1.7.0
```

### 2. 確認 publish access（@scope 包預設 private）

`package.json` 加上：

```json
"publishConfig": { "access": "public" }
```

### 3. 推送 commit + tag

```bash
git push origin main --follow-tags
```

### 4. 發布 npm

```bash
npm publish
# prepublishOnly 會自動 build:prod (obfuscated)
```

### 5. 驗證

```bash
npm view @kiroku/cli version   # 應為 1.7.0
```

---

## 場景 C：全新機器全新安裝設定

### 1. Prerequisites

```bash
node -v   # Node 20+
```

### 2. 全域安裝

```bash
npm install -g @kiroku/cli
kiroku --version
```

### 3. 初始化資料目錄

```bash
kiroku init
# 會建立 ~/.kiroku/{config.json, .env, data/, logs/, ...}
```

### 4. 設定 OAuth token

macOS（從 Keychain 同步）：

```bash
TOK=$(security find-generic-password -s 'Claude Code-credentials' -w \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['claudeAiOauth']['accessToken'])")
echo "CLAUDE_CODE_OAUTH_TOKEN=$TOK" >> ~/.kiroku/.env
chmod 600 ~/.kiroku/.env
```

其他平台：用 `~/.claude/.credentials.json` 內的 access token，或 `claude setup-token` 重新登入後讀取。

### 5. 開啟 batch + medium effort

編輯 `~/.kiroku/config.json` 的 `worker.extraction`：

```json
"extraction": {
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "temperature": 0,
  "maxOutputTokens": 8192,
  "effort": "medium",
  "batch": {
    "enabled": true,
    "maxTurnsPerCall": 5,
    "minTurnsPerCall": 3,
    "flushTimeoutMs": 15000,
    "outputTokenBudget": 6000
  }
}
```

> 想保守上線：先 `batch.enabled=false` 跑幾天，確認 filter / throttle / effort 三項節省效果再開 batch。

### 6. 啟動

```bash
kiroku start
kiroku status   # 確認 proxy / worker / mcp 三個 PID 都在
```

### 7. 驗證新功能

```bash
tail -f ~/.kiroku/logs/extractor.log | grep -E 'batch extraction usage|extraction usage'
tail -f ~/.kiroku/logs/worker.log    | grep -E 'turn skipped by filter|throttled|batch turn processed'
```

看到 `batch extraction usage requested=N completed=N errors=0` 表示 batch 端到端正常。

---

## 檢核：什麼時候要做哪一個

| 情境 | 動作 |
|---|---|
| 你這台、想立刻用新功能 | 場景 A |
| 別台機器也要、不想分發程式碼 | 場景 B + 場景 C |
| Fork 後私用、不發 npm | 場景 A，外加 `git pull && npm i -g .` |

---

## 已知陷阱

1. **`extended-output-2025-02-19` beta header 不存在**
   只 Claude 3.7 用 `output-128k-2025-02-19`；Claude 4.x 原生支援 64k–128k 輸出，不需要額外 beta。Phase 2 早期版本誤帶這個 header 被 HTTP 400 拒絕。已於 commit `b9bef84` 移除。

2. **OAuth Max token 必須宣告 Claude Code 身分**
   `system` 第一塊必須是字串 `"You are Claude Code, Anthropic's official CLI for Claude."`，否則 server 回 HTTP 429 偽裝成 `rate_limit_error`。`buildAnthropicSystem()`（commit `ce993c2`）已在 `auth.isOAuth=true` 時自動前置這個 block，extraction prompt 仍保留 ephemeral cache_control。

3. **`~/.kiroku/.env` 的 token 跟 Keychain 不一致（已三道防線覆蓋，1.7.3 + 1.7.4）**
   `resolveAnthropicAuth` 優先序：env > Keychain。Claude Code session 重啟 / OAuth token 1h 自動 refresh / `claude logout && claude login` 都會 rotate Keychain token，`.env` 不會跟著動。三道防線：
   - **Startup reconcile**（`ccf3f04`）：`startWorker()` 開頭比對，不一致就 promote Keychain → `process.env`
   - **401 retry**（`5b74166`）：`withOauth401Retry()` 包 `callAnthropic` + `extractBatchAnthropic`，HTTP 401 → reconcile → retry 一次
   - **Periodic reconcile**（`5b74166`）：每 5 分鐘 background timer 主動同步，避免 worker 跑數小時後撞 401
   `.env` 檔案不動，只更新 `process.env`。warning 寫到 `~/.kiroku/logs/anthropic-auth.log`：
   ```
   env OAuth token differs from Keychain — promoting Keychain
   envTail=...XXXXXXXX  keychainTail=...YYYYYYYY
   ```
   非 macOS 或 Keychain 也過期 → 維持 env 值，需手動同步（macOS Keychain 一般跟著 Claude Code 自動 refresh，幾乎不會兩邊都過期）。

4. **Initial decay + compaction sweep 阻塞 pollQueue（已修復，1.7.1 + 1.7.2）**
   早期版本同步跑 sweep，47k facts × O(N²) cosine compare + per-fact embedding SELECT 會吃 8-15 分鐘，期間 incoming 不會被處理、`SIGUSR1` 也不被回應。
   - 1.7.1（`b2c3628`）：`setImmediate` 包 initial sweep，`worker started` log 立刻出現
   - 1.7.2（`9c3f041`）：`runCompactionSweep` 改 async，三層 yield（`yieldEveryGroup=1` / `yieldEveryEmb=50` / `yieldEveryPair=200`），sweep 跑時 batch HTTP / pollTimer / signal handler 都能並行

5. **`extractBatch` 只支援 `provider=anthropic`**
   其他 provider 自動 fallback 到單筆 `extract()` 路徑。要 OpenRouter / Gemini 也走 batch 需擴充 `extractor.js`。

6. **舊 worker 在 sync block 中對 `SIGTERM` 無回應**
   1.7.0 worker 卡 sweep 時 event loop 鎖死，`kiroku stop` 發 SIGTERM 也不退。要 `kill -KILL <pid>` 才能殺。1.7.2+ 因 sweep 改 async + yield，SIGTERM handler 會在下一輪 yield 觸發、能正常退出。

7. **多 Claude Code session + 訂閱 OAuth = Sonnet burst 撞牆**
   OAuth Max 訂閱賣的是「人類對話用量」，不是 daemon 推論用量。實測（2026-05-01，Pro tier）：
   ```
   Sonnet 4.6  3 並發 → 15/15 全 429
   Haiku 4.5   5 並發 → 25/25 全 200
   ```
   ratelimit headers 揭露真實結構（用 `curl -i` 看 200 response）：
   ```
   anthropic-ratelimit-unified-5h-utilization:        0.31  ← 5h 累積 31%
   anthropic-ratelimit-unified-7d-utilization:        0.63  ← 7d 累積 63%
   anthropic-ratelimit-unified-7d_sonnet-utilization: 0.01  ← Sonnet 單獨 7d 配額
   anthropic-ratelimit-unified-representative-claim:  five_hour
   ```
   兩層 limit 同時生效：**並發 burst limit**（Sonnet ≤ 2）+ **滾動 window quota**（5h / 7d）。多 session 並用 + worker Sonnet batch 容易撞前者。

### 為什麼訂閱反而會爆、API Key 反而便宜

| 模式 | 賣什麼 | 限制設計目的 |
|---|---|---|
| Claude Pro / Max 訂閱（OAuth） | 「使用 Claude Code 工具的權利」 | 防止濫用，**為人類對話節奏設計** |
| 任何 API Key | 純 token 計費 | 商用基礎設施，**為 24h 服務設計** |

worker 是 daemon 不停跑 batch extraction——這個 use case 不在訂閱的 design intent 裡。Anthropic 對 Sonnet 4.6 把 burst limit 卡到 ≤ 2 並發，就是為了防止 $20-200 訂閱被當 24h 推論服務用。

API Key 反而便宜是因為 worker extraction 真實用量很少（每天可能 < 1M token）。換成 token-priced 模式，daemon 一個月只用幾百萬 token。

### 模型對照（2026-05 實測 / Phase 2 batch 配 anthropic-only）

| Model | Provider | input/$M | output/$M | 月費估 (100 turn/day) | batch+cache |
|---|---|---|---|---|---|
| Gemini 2.0 Flash | OpenRouter | 0.10 | 0.40 | **~$0.6** | 不支援 |
| Gemini 3 Flash | Google direct | 0.50 | 3.00 | ~$4 | 不支援 |
| GPT-5.4 Nano | OpenAI direct | 0.20 | 1.25 | **~$1.5** | 不支援 |
| GPT-5.4 Mini | OpenAI direct | 0.75 | 4.50 | ~$6 | 不支援 |
| DeepSeek V3.2 | OpenRouter | 0.25 | 0.38 | **~$1.5** | 不支援 |
| Qwen 2.5 32B | OpenRouter | 0.16 | 0.97 | ~$1.5（JSON 已知穩） | 不支援 |
| Qwen 3.6 35B A3B | OpenRouter | 0.16 | 0.97 | ~$1.5（架構新、預期略優） | 不支援 |
| Qwen 3.6 Flash | OpenRouter | 0.25 | 1.50 | ~$2.5（1M context） | 不支援 |
| Qwen 3.6 Plus | OpenRouter | 0.33 | 1.95 | ~$3.5（最高品質 Qwen） | 不支援 |
| Qwen 3.6 Plus Preview (free) | OpenRouter | 0 | 0 | $0（測試用，20 RPM / 200 day） | 不支援 |
| Claude Haiku 4.5 | Anthropic API Key | 0.80 | 4.00 | **~$3** | ✅ |
| Claude Sonnet 4.6 | Anthropic API Key | 3.00 | 15.00 | ~$8-15 | ✅ |
| Claude Sonnet 4.6 | OAuth Max 訂閱 | 訂閱 | 訂閱 | $0 | ✅ but burst ≤ 2 |
| Claude Haiku 4.5 | OAuth Max 訂閱 | 訂閱 | 訂閱 | $0 | ✅ burst ≥ 5 |

> Qwen 3.6 vs 2.5 沒有公開 JSON 抽取 head-to-head benchmark，但 3.6 是 MoE + 2026-04 釋出（vs 2.5 一年半舊），架構升級 + 訓練資料新，**推理速度 ~2x**、**同價**。worker 的 `callOpenAICompatible` 不送 `response_format` 參數，全靠 prompt-following + `parseExtractionResult` 補救，所以模型 prompt-following 能力是關鍵——Qwen 3.6 一般略優。要實證請拿 5-10 個有 ground truth 的 turn 跑兩家比對。

**重要：`extractBatch` + prompt caching 只 anthropic provider 支援。** 其他 provider 走 `extract()` 單筆 path（filter / throttle / effort 仍生效，但無法享受 ~70% input token 攤銷）。所以 batch+cache 攤銷後的 Haiku 4.5 ($3/月) 很接近單筆的 GPT-5.4 Nano ($1.5/月) 但有 batch 容錯加成。

### Provider 配置選單（按 use case 三選一）

A. **訂閱 Claude Pro/Max + 多 session 並用** — Haiku 4.5（burst 寬鬆）
```json
"extraction": {
  "provider": "anthropic",
  "model": "claude-haiku-4-5-20251001",
  "effort": "medium",
  "batch": { "enabled": true, "maxTurnsPerCall": 5 }
}
```
- 成本：$0（訂閱已付）
- 風險：5h / 7d window quota 仍跟對話共用、品質略低於 Sonnet
- token sync：1.7.4 reconcile 三道防線自動處理

B. **省錢極致 / 不在乎 batch** — 任一便宜模型走單筆 path

OpenRouter + DeepSeek V3.2：
```json
"extraction": {
  "provider": "openrouter",
  "model": "deepseek/deepseek-v3.2",
  "apiKeyEnv": "OPENROUTER_API_KEY"
}
```

OpenRouter + Qwen 2.5 32B（JSON 已知穩、保守）：
```json
"extraction": {
  "provider": "openrouter",
  "model": "qwen/qwen-2.5-32b-instruct",
  "apiKeyEnv": "OPENROUTER_API_KEY"
}
```

OpenRouter + Qwen 3.6 35B A3B（同價、架構新、推理快 ~2x、預期略優）：
```json
"extraction": {
  "provider": "openrouter",
  "model": "qwen/qwen3.6-35b-a3b",
  "apiKeyEnv": "OPENROUTER_API_KEY"
}
```

OpenRouter + Qwen 3.6 Plus Preview（**免費**、適合 dogfood）：
```json
"extraction": {
  "provider": "openrouter",
  "model": "qwen/qwen3.6-plus-preview:free",
  "apiKeyEnv": "OPENROUTER_API_KEY"
}
```
> 注意：免費 tier 有 20 RPM / 200 req/day 限制；放在 worker 重 batch 流量會撞牆，但拿來測 quality 跟原 Anthropic / Gemini 對比的 baseline 很合適。

OpenAI direct + GPT-5.4 Nano（最低單價）：
```json
"extraction": {
  "provider": "openai-compatible",
  "model": "gpt-5.4-nano",
  "baseUrl": "https://api.openai.com/v1",
  "apiKeyEnv": "OPENAI_API_KEY"
}
```

Google Gemini direct + Gemini 3 Flash：
```json
"extraction": {
  "provider": "gemini",
  "model": "gemini-3-flash-preview",
  "apiKeyEnv": "GEMINI_API_KEY"
}
```

當前預設（Gemini 2.0 Flash via OpenRouter，最便宜）：
```json
"extraction": {
  "provider": "openrouter",
  "model": "google/gemini-2.0-flash-001",
  "apiKeyEnv": "OPENROUTER_API_KEY"
}
```

- 成本：$0.5-4/月
- 風險：無 batch / 無 cache、entity-fact JSON 品質略差於 Anthropic
- 設定：把對應 API key 放進 `~/.kiroku/.env`：
  ```bash
  echo "OPENROUTER_API_KEY=sk-or-..." >> ~/.kiroku/.env
  echo "OPENAI_API_KEY=sk-..." >> ~/.kiroku/.env
  echo "GEMINI_API_KEY=..." >> ~/.kiroku/.env
  ```

C. **重 batch / 多 session / 高品質** — Anthropic API Key + Sonnet 4.6
```json
"extraction": {
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "effort": "medium",
  "apiKeyEnv": "ANTHROPIC_API_KEY",
  "batch": { "enabled": true, "maxTurnsPerCall": 5 }
}
```
```bash
# 從 https://console.anthropic.com 拿 sk-ant-api03-... key
# 編輯 ~/.kiroku/.env：
#   - 移除 CLAUDE_CODE_OAUTH_TOKEN（必須，否則 worker 仍走 OAuth）
#   - 加入 ANTHROPIC_API_KEY=sk-ant-api03-...
kiroku stop && kiroku start
```

> Claude Code session 完全不受影響——它讀的是 macOS Keychain `Claude Code-credentials`，不讀 `~/.kiroku/.env`。`.env` 只給 kiroku worker 用。
- 成本：50 turn/day ≈ $3、100 turn/day ≈ $5-8、500 turn/day ≈ $25-40
- 收益：脫離 OAuth burst limit、token sync / 401 reconcile / quota 撞牆都不再是問題
- 1.7.x 的 OAuth 自動 reconcile 在這條路徑下無感（沒設 `CLAUDE_CODE_OAUTH_TOKEN` → `reconcileOauthToken()` 直接 return false 跳過）

> 💡 `anthropic-auth.js` 的 priority：`CLAUDE_CODE_OAUTH_TOKEN` > `ANTHROPIC_AUTH_TOKEN` > `ANTHROPIC_API_KEY`。worker 走 API Key 必須**移除前兩者**，或在 config 設 `apiKeyEnv: "ANTHROPIC_API_KEY"` 並確保前兩者沒設。

### 緩解 burst（如果一定要用 OAuth Sonnet）

```json
"worker": {
  "throttle": { "enabled": true, "maxCallsPerMinute": 5 },
  "extraction": {
    "batch": { "enabled": true, "maxTurnsPerCall": 3, "flushTimeoutMs": 30000 }
  }
}
```

8. **Stuck `processing/` 檔案不會自動回收**
   worker crash 或被 SIGKILL 後，已 rename 進 `processing/` 的 file 仍留在那、但 `pollQueue` 只掃 `incoming/`，這些孤兒永遠不被處理。緊急救援：
   ```bash
   mv ~/.kiroku/data/queue/processing/*.jsonl ~/.kiroku/data/queue/incoming/
   ```
   1.7.0+ 的正常 stop（SIGTERM）會跑 `rescueBatchBuffer`，把 batch buffer 內未 flush 的 item 搬回 incoming。

---

## 相關 commit

| Commit | 版本 | 內容 |
|---|---|---|
| `75f62de` | 1.7.0 | Phase 1 — filter + throttle + medium effort |
| `6470147` | 1.7.0 | Phase 2 — adaptive batch + streaming recovery |
| `b9bef84` | 1.7.0 | Hotfix — drop invalid `extended-output-2025-02-19` beta |
| `ce993c2` | 1.7.0 | Hotfix — Claude Code identifier block under OAuth |
| `63c160c` | 1.7.0 | Fix — embed batch prompt into bundle (npm tarball 不含 prompts/) |
| `b2c3628` | 1.7.1 | Fix — defer initial sweep + yield event loop |
| `9c3f041` | 1.7.2 | Fix — finer-grained yields in compaction sweep |
| `ccf3f04` | 1.7.3 | Feat — auto-reconcile env OAuth token vs Keychain (startup) |
| `5b74166` | 1.7.4 | Feat — 401 retry + periodic 5min reconcile |
