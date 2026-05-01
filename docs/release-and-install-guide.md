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

3. **`~/.kiroku/.env` 的 token 跟 Keychain 不一致**
   `resolveAnthropicAuth` 優先序：env > Keychain。換帳號或 Claude Code session 重登後，`.env` 不會自動跟 Keychain 同步，會持續用舊 token 撞 quota。重灌時記得把 .env 重抓一次（場景 C 步驟 4）。

4. **首次重啟 worker 要等 ~110 秒**
   啟動序列含 initial decay + compaction sweep，掃 22k+ done 紀錄。`worker started` log 出現後才會 poll incoming。

5. **`extractBatch` 只支援 `provider=anthropic`**
   其他 provider 自動 fallback 到單筆 `extract()` 路徑。要 OpenRouter / Gemini 也走 batch 需擴充 `extractor.js`。

---

## 相關 commit

| Commit | 內容 |
|---|---|
| `75f62de` | Phase 1 — filter + throttle + medium effort |
| `6470147` | Phase 2 — adaptive batch + streaming recovery |
| `b9bef84` | Hotfix — drop invalid `extended-output-2025-02-19` beta |
| `ce993c2` | Hotfix — Claude Code identifier block under OAuth |
