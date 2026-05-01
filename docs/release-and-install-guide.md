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

### 抽取品質 A/B 實測（2026-05，OAuth Max Pro）

5 個代表性 turn × 2 model（Haiku 4.5 vs Sonnet 4.6），sequential 同 system prompt（`prompts/extraction.md`）。完整 dump：[`/tmp/extraction-ab-result.md`](https://github.com/yelban/kiroku-cli)（tip：本機重跑：`python3 /tmp/extraction-ab.py`）。

#### Summary

| Model | Parse OK | Total ent | Total facts | Total in | Cache read | Total out | Avg latency |
|---|---|---|---|---|---|---|---|
| Haiku 4.5 | 5/5 | 10 | 8 | 17,333 | **0**（無效） | 1,084 | 1.8s |
| Sonnet 4.6 | 5/5 | 11 | 8 | 303 | **13,628**（4/5 hit） | 647 | 3.6s |

#### 兩個重要發現

1. **品質相當**：兩家 5/5 parse OK，無 hallucination、無 schema drift。Sonnet 偶爾 over-extract（多抓一個沒必要的 concept entity，如 turn 3 的 "token refresh"）；Haiku 略 simpler。trivial turn (`User: 繼續`) 兩家都正確返回 `[]`。

2. **Haiku 4.5 prompt caching 在 OAuth 跟 API Key 路徑都完全失效（platform-wide）**：

   先後實測 OAuth Max 跟 sk-ant-api03 兩條路徑、3 次連發同一 system prompt：
   ```
   Haiku 4.5    OAuth+API Key 都一樣：
     call 1-3: input=3414 cache_create=0 cache_read=0   ← 全部 fresh charge

   Sonnet 4.6   兩條路徑都正常：
     call 1: input=22 cache_create=3393 cache_read=0    ← creation
     call 2: input=22 cache_create=0    cache_read=3393 ← hit
     call 3: input=22 cache_create=0    cache_read=3393 ← hit
   ```

   結論：Haiku 4.5 在 Anthropic 平台層級不支援 prompt caching（不論 auth 方式）。可能是 backend 還沒部署、或 model snapshot ID 不在 cache list。值得向 Anthropic support 確認。

   **這顛覆「Haiku 比 Sonnet 便宜」的直覺**——cache 攤銷後 Sonnet 4.6 反而更便宜：

   | 100 turn/day × 30 天 | 計算 | 月費 |
   |---|---|---|
   | Haiku 4.5（無 cache） | 10.5M input × $0.80 + 0.6M out × $4 | **$10.8** |
   | Sonnet 4.6（cache 命中） | 3000 × 3400 cache_read × $0.30/M + 3000 × 22 input × $3/M + 3000 × 100 out × $15/M | **$7.8** |

#### Per-turn 微差

| Turn | Haiku | Sonnet | 觀察 |
|---|---|---|---|
| pref + email + nickname | 3 ent / 3 facts | 3 ent / 3 facts | 一致 |
| tech stack | 3 ent / 3 facts | 3 ent / 3 facts | 一致 |
| bug state | 1 ent / 1 fact | 2 ent / 1 fact | Sonnet 多抓 "token refresh" 概念（過度） |
| episodic | 3 ent / 1 fact | 3 ent / 1 fact | Haiku 用 `kiroku-cli` 為 subject、Sonnet 用 `team` |
| trivial | 0 / 0 | 0 / 0 | 一致 |

#### 對 mode 選擇的真實影響（2026-05 實證後修訂）

| 情境 | 推薦 | 為什麼 |
|---|---|---|
| 單 session worker（_batchFlushing single-flight） | **`mode subscription` + 手改 model 為 `claude-sonnet-4-6`** | Sonnet cache 命中、~$7.8/月、quality 微優、single-flight 不撞 burst |
| 多 session 並用（OAuth Max） | **`mode subscription`（default Haiku 4.5）** | Haiku no-cache 但 burst ≥ 5；Sonnet ≤ 2 burst 在多並發場景吃 429 |
| API Key + 任何 session 數 | **改用 Sonnet 4.6** | Haiku 沒 cache 反而貴；API Key burst 限制比 OAuth 寬，多 session 也安全 |
| 省錢極致（不在乎 batch+cache） | **`mode api`**（OpenRouter Qwen 3.6） | $1.5/月、Anthropic 之外完全不踩 burst/quota 雷 |

> 測試 Anthropic 帳戶：API key 走獨立 credit pool，跟訂閱的 Extra usage credit 不互通。要 API key 能用須去 [console / Plans & Billing](https://console.anthropic.com/settings/billing) 加 API credits（不是 spending limit）。

> 後續 follow-up：worker 應該偵測 model 是否實際 cache hit，連續幾次 cache_read=0 時自動降 cache_control（避免 cache_creation 浪費）。目前未實作。

### 一鍵切換 mode（1.7.5+，1.7.7 改 Sonnet default、1.7.9 改 Qwen Flash default）

```bash
kiroku mode subscription   # OAuth/API + Sonnet 4.6 + batch + cache
kiroku mode api            # OpenRouter + Qwen 3.6 Flash, batch & cache off
kiroku mode show           # 顯示當前設定
kiroku stop && kiroku start  # 套用
```

`kiroku mode` 會 merge 進 `~/.kiroku/config.json`，只覆寫 `worker.extraction.{provider,model,effort,batch,...}`，保留 fallback config 跟其他自訂欄位。

### Sonnet 4.6 + batch + cache 三件套（mode subscription 預設）

#### 三件各自貢獻

| 元件 | 做什麼 | 貢獻 |
|---|---|---|
| **Sonnet 4.6** | Claude 4.x 中等成本、品質強的 mid-tier model | 比 Haiku 4.5 quality 微優、且 cache 真實工作（Haiku platform-wide cache fail） |
| **Phase 2 batch** | 5 turn 一個 streaming SSE call、share system prompt、`===TURN_N_END===` delimiter | 截斷 / parse error 時其他 turn 仍落地、整批共用一份 system prompt |
| **prompt caching** | `cache_control: ephemeral` 把 ~3.3k tokens system prompt 5 分鐘 TTL cache | 第二次起 cache_read 只算 10% input cost ($3 → $0.30/M) |

#### 累積攤銷實證（2026-05，Sonnet 4.6 OAuth 連續 7 輪）

```
23:05:39  cache_create=2522  cache_read=    0   ← 首次寫入 cache (一次性)
23:06:58  cache_create=    0  cache_read=2522
23:08:24  cache_create=    0  cache_read=2522
23:08:55  cache_create=    0  cache_read=2522
23:09:31  cache_create=    0  cache_read=2522
23:10:20  cache_create=    0  cache_read=2522
23:11:14  cache_create=    0  cache_read=2522
23:12:17  cache_create=    0  cache_read=2522
total cache_read = 17,654 tokens（攤銷後 ~10% 原成本）
```

#### 月費對照（100 turn/day × 30 天 = 3000 turns）

| 配置 | input cost | output cost | 月費 |
|---|---|---|---|
| 純單筆 + 無 cache | 3000 × 3500 × $3/M = $31.5 | 3000 × 200 × $15/M = $9 | **$40.5** |
| Phase 2 batch + 無 cache | 600 × 3500 × $3/M = $6.3 | 600 × 1000 × $15/M = $9 | **$15.3** |
| **Phase 2 batch + cache（推薦）** | 600 × (50 × $3 + 2522 × $0.30) ≈ $0.55 | 600 × 1000 × $15/M = $9 | **~$10**（input 攤銷 90%） |
| OAuth Max 訂閱 + 三件套 | 訂閱已付（吃 5h window） | — | **$0** |

實際月費還會更低，因為 output 平均比 1000 token 少（一個 batch 5 turn 但很多 turn 是 trivial / 短 response）。

#### 適合場景

- ✅ 中重度開發 / 對話頻率 > 50 turn/day
- ✅ 訂閱 Claude Pro/Max + 單 session 用（worker single-flight=1，不撞 Sonnet burst ≤ 2）
- ✅ 想保留高品質 entity / fact extraction（Haiku 略弱、Qwen 略弱於 Anthropic）
- ✅ 用量穩定能觸發 cache 5 分鐘 TTL（連續對話、不長時間 idle）

#### 不適合場景（改 `mode api` 反而省）

- ❌ 用量極低（< 30 turn/day）：cache 5 分鐘 TTL 來不及命中、付了 cache_create 沒攤銷到、不如走 Qwen Flash $1/月
- ❌ 多 Claude Code session 並用 + 重 batch：Sonnet 4.6 OAuth burst ≤ 2、容易撞 429。要嘛切 API Key（脫離 OAuth burst limit）、要嘛改 Haiku 4.5（burst ≥ 5 但 cache 失效）
- ❌ 不在意 entity/fact extraction quality 微差：Qwen 3.6 Flash 對純 JSON 抽取夠用 + 月費 $1-3

#### 限制與雷

| 限制 | 說明 |
|---|---|
| 只 anthropic provider 支援 | 其他 provider 走單筆 `extract()`（filter / throttle 仍生效，但無 batch + cache） |
| **Haiku 4.5 cache 失效** | platform-wide：OAuth + API key 都不 cache。**不要用 Haiku + cache_control**，反而花 cache_creation 開銷沒攤銷。1.7.8+ 自動偵測降級（連續 3 次 creation 沒 read → 拿掉 cache_control 24h）|
| Cache TTL 5 分鐘 | worker idle 5+ 分鐘後 cache 過期、下次 batch 重新 cache_creation。對中重度對話頻率不影響 |
| OAuth Sonnet 並發 ≤ 2 | single worker（_batchFlushing=1）OK；user 對話 + worker batch 同送可能瞬間 ≥ 2 撞 burst |
| Batch 截斷的部分恢復 | `stop_reason: max_tokens` 時前面已完整 turn 落地、後面進 `truncatedTail` 重新排回 incoming |
| JSON parse error 1 個 turn 一定 dead-letter | 整批仍其他 turn 落地、不影響其他人；Sonnet 約 ~10% 機率、Haiku ~12% |

### 三條 Provider 配置（按 use case）

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

8. **OpenRouter / OpenAI-compatible: thinking models 會回 `content=null`**
   `callOpenAICompatible` 讀 `choices[0].message.content`，但 reasoning-only 模型把答案放 `message.reasoning`，content 留 null。worker 直接 throw `Empty extraction response`、永遠 retry。
   實證（2026-05）：
   - `qwen/qwen3.6-35b-a3b` ❌ reasoning only（content=null）
   - `qwen/qwen3.6-flash` ✅ content 正常
   - `qwen/qwen3.6-plus` ✅ content 正常
   `mode api` preset 預設 Qwen 3.6 Flash 避開這個雷。要用其他 OpenRouter 模型先 `curl` 測一下 `message.content` 不為 null 才能用。
   要支援 reasoning-only 模型需擴 `callOpenAICompatible` 在 OpenRouter 路徑加 `reasoning: { exclude: true }` 參數（OpenRouter-specific），目前 worker 沒做。

9. **API key 必須放 `ANTHROPIC_API_KEY`，不可放 `ANTHROPIC_AUTH_TOKEN`**
   `anthropic-auth.js` priority 跟 header 對應：
   ```
   priority 1  CLAUDE_CODE_OAUTH_TOKEN  →  Authorization: Bearer ...        OAuth Max only (sk-ant-oat-...)
   priority 2  ANTHROPIC_AUTH_TOKEN     →  Authorization: Bearer ...        relay/gateway, 不適合 sk-ant-api03
   priority 3  ANTHROPIC_API_KEY        →  x-api-key: ...                   API key (sk-ant-api03-...)
   ```
   實測：把 `sk-ant-api03-...` 放進 `ANTHROPIC_AUTH_TOKEN` → server 回 `HTTP 401 Invalid bearer token`，因為 Anthropic 嚴格區分兩種 auth header。**API key 一定要放 `ANTHROPIC_API_KEY`**。
   ```bash
   echo 'ANTHROPIC_API_KEY=sk-ant-api03-...' >> ~/.kiroku/.env  # ← 對
   echo 'ANTHROPIC_AUTH_TOKEN=sk-ant-api03-...' >> ~/.kiroku/.env  # ← 錯，會 401
   ```
   另外，API key 用之前要先在 [console.anthropic.com / Plans & Billing](https://console.anthropic.com/settings/billing) 儲值，否則 server 回 `HTTP 400 credit balance is too low`。

9. **Stuck `processing/` 檔案不會自動回收（已修，commit `f7a88ff`）**
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
