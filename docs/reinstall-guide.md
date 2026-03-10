# Kiroku CLI — 完整移除與重新安裝指南

## 何時需要完整重裝

- 升級到新版本後遇到不相容問題
- DB schema 有重大變更，需要乾淨狀態
- 測試/開發環境需要從零開始
- 排除疑難雜症，確認是否為殘留設定導致

---

## 步驟一：停止所有 daemon

```bash
kiroku stop
```

如果 `kiroku` 指令已損壞，手動清理 daemon：

```bash
# 從 state 檔案讀 PID 並 kill
cat ~/.kiroku/run/proxy.state.json   # 取得 proxy PID
cat ~/.kiroku/run/worker.state.json  # 取得 worker PID
kill <proxy-pid> <worker-pid>
```

---

## 步驟二：Deactivate License（有授權才需要）

> **重要**：如果你有啟用 Pro license，**必須先 deactivate 再刪 `~/.kiroku`**。
> 否則會丟失 instance ID，導致下次 activate 時報 "activation limit reached"，
> 需要透過 LS Dashboard 或 API 手動清除舊 instance。

```bash
kiroku deactivate
```

如果已經刪掉 `~/.kiroku` 而忘記 deactivate，需要手動處理：

```bash
# 1. 查詢 license 的 instance（需要 LS admin API key）
curl -s -G "https://api.lemonsqueezy.com/v1/license-key-instances" \
  --data-urlencode "filter[license_key_id]=YOUR_LICENSE_KEY_ID" \
  -H "Authorization: Bearer YOUR_LS_API_KEY" \
  -H "Accept: application/vnd.api+json"

# 2. 用 instance identifier 呼叫 deactivate
curl -s -X POST https://api.lemonsqueezy.com/v1/licenses/deactivate \
  -H 'Content-Type: application/json' \
  -d '{"license_key": "YOUR-KEY", "instance_id": "INSTANCE-IDENTIFIER"}'
```

或登入 [Lemon Squeezy Dashboard](https://app.lemonsqueezy.com) 手動管理 license instances。

---

## 步驟三：移除 runtime 資料

```bash
rm -rf ~/.kiroku
```

這會刪除：
- `config.json` — 設定檔
- `.env` — API keys
- `data/memory.sqlite` — 記憶資料庫（所有萃取的 facts/entities）
- `data/queue/` — 佇列（incoming / processing / done / dead-letter）
- `data/cache/` — embedding 模型快取 + prompt 快取
- `logs/` — 所有 log + 對話記錄 + transcript
- `run/` — daemon state 檔案
- `license/` — 授權金鑰 + 離線狀態
- `backups/` — 備份檔

> **保留記憶資料**：如果想保留舊的記憶，先備份 DB：
> ```bash
> cp ~/.kiroku/data/memory.sqlite ~/kiroku-backup.sqlite
> ```
>
> **保留 API key**：如果想保留 key，先記下來：
> ```bash
> cat ~/.kiroku/.env
> ```

---

## 步驟四：移除全域 npm 套件

```bash
npm uninstall -g @kiroku/cli
```

驗證已移除：

```bash
which kiroku   # 應該沒有輸出
kiroku --help  # 應該 command not found
```

---

## 步驟五：清理專案層級的殘留檔案（可選）

每個曾執行 `kiroku start` 的專案目錄可能有：

```bash
# 在專案目錄中
rm .mcp.json                         # MCP server 註冊（或手動移除 kiroku-memory 區塊）
rm .claude/settings.local.json       # Stop hook 註冊（或手動移除 hook 區塊）
```

> 如果 `.mcp.json` 或 `settings.local.json` 有其他工具的設定，請手動編輯移除 kiroku 相關區塊，不要整檔刪除。

---

## 步驟六：重新安裝

### 從 npm（正式版）

```bash
npm install -g @kiroku/cli
```

### 從原始碼（開發版）

```bash
cd ~/zoo/claude-proxy/kiroku-v15
npm run build
npm install -g .
```

驗證安裝：

```bash
kiroku help
```

---

## 步驟七：初始化

```bash
kiroku init
```

互動式設定會引導選擇萃取 provider 和輸入 API key：

```
── Extraction Provider Setup ──────────────────────────────

  1) OpenRouter    — cloud, 200+ models (recommended)
  2) OpenAI-compat — OpenAI, Groq, Together, etc.
  3) Google Gemini — direct Gemini API
  4) Anthropic     — direct Claude API
  5) Ollama        — local, free, no API key

Provider [1-5, default 1]:
```

完成後驗證：

```bash
cat ~/.kiroku/.env           # 確認 API key 已寫入
cat ~/.kiroku/config.json    # 確認 provider/model
ls -la ~/.kiroku/.env        # 確認權限 -rw------- (600)
```

---

## 步驟八：啟動 + 健康檢查

```bash
cd your-project-directory
kiroku start    # 啟動 proxy + worker + MCP，然後開啟 Claude Code
```

在另一個 terminal：

```bash
kiroku status   # 確認 proxy/worker 都在跑
kiroku doctor   # 完整健康檢查
```

`kiroku doctor` 應全部 `[OK]`：

```
  [OK] Config valid
  [OK] sqlite-vec extension available
  [OK] Database readable
  [--] Embedding model not downloaded        ← 首次正常，start 後會自動下載
  [OK] OPENROUTER_API_KEY set               ← 或你選的 provider 對應的 key
```

---

## 步驟九：恢復舊記憶（可選）

如果步驟三有備份 DB：

```bash
kiroku stop
cp ~/kiroku-backup.sqlite ~/.kiroku/data/memory.sqlite
kiroku start
```

> 如果 DB schema 版本不同，`kiroku init` 的 migration 會自動升級 schema。

---

## 快速指令（一行完成）

完整移除 + 重裝 + 初始化：

```bash
kiroku deactivate 2>/dev/null; kiroku stop 2>/dev/null; rm -rf ~/.kiroku; npm uninstall -g @kiroku/cli && npm install -g @kiroku/cli && kiroku init
```

從原始碼：

```bash
kiroku deactivate 2>/dev/null; kiroku stop 2>/dev/null; rm -rf ~/.kiroku; npm uninstall -g @kiroku/cli && cd ~/zoo/claude-proxy/kiroku-v15 && npm run build && npm install -g . && kiroku init
```

---

## 疑難排解

### `kiroku: command not found`

npm 全域 bin 路徑不在 PATH 中：

```bash
npm config get prefix   # 查看 npm prefix
export PATH="$(npm config get prefix)/bin:$PATH"
```

加入 `~/.zshrc` 或 `~/.bashrc` 永久生效。

### `better-sqlite3` 編譯失敗

需要 C++ 編譯工具鏈：

```bash
# macOS
xcode-select --install

# Ubuntu/Debian
sudo apt install build-essential python3
```

### `sqlite-vec` 載入失敗

確認 Node.js 版本 >= 20：

```bash
node --version
```

如果版本正確但仍失敗，嘗試清除 npm cache 後重裝：

```bash
npm cache clean --force
npm install -g @kiroku/cli
```

### 權限問題 (EACCES)

避免用 `sudo npm install -g`，改用 npm prefix：

```bash
mkdir -p ~/.npm-global
npm config set prefix '~/.npm-global'
export PATH="~/.npm-global/bin:$PATH"   # 加入 shell profile
npm install -g @kiroku/cli
```
