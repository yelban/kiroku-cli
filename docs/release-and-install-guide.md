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

7. **多 Claude Code session 共用 OAuth Max quota**
   OAuth Max quota 是**帳號級**（5 小時 rolling window）。多個並行 session + kiroku worker batch extraction 全部一起算。重 batch 流量場景容易撞「rate_limit_error」（即使 token 有效）。
   緩解選項：
   - 開保守 batch：`maxTurnsPerCall=3` 而非 5、`flushTimeoutMs=30000`
   - 開 throttle 嚴一點：`worker.throttle.maxCallsPerMinute=10`
   - **徹底分離（推薦）**：worker 改走 API Key，跟 Claude Code session 完全獨立 quota：
     ```bash
     # 從 https://console.anthropic.com 拿 sk-ant-api03-... key
     echo "ANTHROPIC_API_KEY=sk-ant-api03-..." >> ~/.kiroku/.env
     # 移掉 CLAUDE_CODE_OAUTH_TOKEN 那行（讓 priority 走到 #3 API key）
     kiroku stop && kiroku start
     ```
     extraction 用量低（~330 tokens/turn 加 cache 命中）、Sonnet 4.6 input $3/M output $15/M、每天 100 turn 估 ~$0.05/day。

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
