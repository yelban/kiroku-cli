# 對話 Markdown 記錄 — 開發測試結果

Date: 2026-03-07
Environment: macOS Darwin 24.6.0, Node.js 22.21.1, Claude Opus 4.6

---

## 變更摘要

### 新增檔案

| 檔案 | 說明 |
|------|------|
| `src/shared/md-format.js` | 共用 markdown 格式化（tool use/result/thinking blocks） |
| `src/proxy/md-logger.js` | Proxy 即時 markdown logger（per-session append + 自動分段） |
| `src/cli/transcript-converter.js` | Claude Code JSONL → markdown 轉換器 |

### 修改檔案

| 檔案 | 變更 |
|------|------|
| `src/shared/paths.js` | +`CONVERSATIONS_LOG_DIR`, `TRANSCRIPTS_DIR`，加入 `ensureDirs()` |
| `src/shared/config.js` | +`proxy.markdownLog` schema（enabled, maxToolInputLength, maxFileSizeKB） |
| `src/proxy/server.js` | 修復 userText 擷取 bug + 整合 md-logger |
| `bin/kiroku.js` | +`transcript` 指令（--list, --thinking, --no-redact, --output） |

### Bug 修復

**userText 擷取遺失 tool_result blocks（server.js 行 104-140）**

- 修復前：`lastUser.content.filter(c => c.type === 'text')` 丟掉所有非 text blocks
- 修復後：
  - 分別擷取 `text` blocks 和 `tool_result` blocks
  - `tool_result` 存入 `event.request.tool_results`
  - 若最後 user message 只有 tool_result → 往前找有 text 的 user message
  - 影響：AskUserQuestion 回答、所有 tool 回傳結果

---

## 測試結果

### 1. Syntax Check

所有 7 個檔案通過 `node --check`：

```
paths OK
config OK
md-format OK
md-logger OK
server OK
transcript-converter OK
kiroku OK
```

### 2. Transcript Converter — listSessions()

```
Sessions found: 10
  5c6c13f1  2026-03-07  177 entries
  15e1da3a  2026-03-07  562 entries
  2284f3d2  2026-03-07  1182 entries
```

- resolveProjectDir() 正確解析 CWD → Claude 專案目錄
  - `/Users/orz99/zoo/claude-proxy` → `-Users-orz99-zoo-claude-proxy`
- 按 lastTimestamp 降序排列
- 正確讀取每個 session 的時間戳和條目數

### 3. Transcript Converter — convertTranscript()

測試 session：`15e1da3a-b347-4159-bde9-88aa28bf8d2a`

| 指標 | 值 |
|------|-----|
| 輸入條目數 | 562 |
| 過濾後 turns | 118 |
| 輸出檔案大小 | 200KB / 4720 行 |
| Tool Use blocks | 有（Read, Glob, TaskCreate, Edit 等） |
| Tool Result blocks | 107 個 |

#### Session ID 解析修復

初始版本有 bug：metadata 的 `sessionId` 取到了第一筆 entry（可能是 sidechain 的），導致輸出檔名錯誤。

修復：
1. 從檔名提取 `fileSessionId`
2. 過濾掉 `entry.sessionId !== fileSessionId` 的條目
3. Metadata 優先匹配 `fileSessionId`

#### 輸出格式驗證

```markdown
# Conversation Transcript

- **Session:** 15e1da3a-b347-4159-bde9-88aa28bf8d2a  ← 正確
- **CWD:** /Users/orz99/zoo/claude-proxy
- **Branch:** main
- **Claude Code:** v2.1.70
- **Date:** 2026-03-07

---

## Turn 1 — 06:11:57

**User:**
Implement the following plan: ...

## Turn 2 — 06:12:05

**Assistant:**
Let me start by reading the existing files.

#### Tool Use: `Read`
```json
{ "file_path": "..." }
```

**Tool Result:**
     1→import { homedir } from 'node:os'; ...
```

### 4. resolveProjectDir() 路徑映射

| CWD | 預期 slug | 結果 |
|-----|-----------|------|
| `/Users/orz99/zoo/claude-proxy` | `-Users-orz99-zoo-claude-proxy` | 匹配成功 |

slug 產生規則：`cwd.replace(/\//g, '-')` → `/Users/orz99/...` → `-Users-orz99-...`

### 5. Config Schema 驗證

`proxy.markdownLog` 預設值正確解析：

```json
{
  "enabled": true,
  "maxToolInputLength": 50000,
  "maxFileSizeKB": 512
}
```

---

## 未測試項目（需 live proxy）

以下功能需要啟動完整 proxy 進行 E2E 測試：

- [ ] Proxy md-logger 即時寫入到 `~/.kiroku/logs/conversations/`
- [ ] 自動分段機制（單檔 > 512KB 時建新 part）
- [ ] AskUserQuestion 回答在即時 markdown 中出現
- [ ] DLP redaction 套用到 markdown 輸出
- [ ] `kiroku transcript --list` 經由 CLI 入口執行
- [ ] `kiroku transcript <id> --thinking` 含 thinking blocks

---

## 已知限制

1. Claude Code JSONL 格式無正式文件，可能隨版本變動
2. Transcript converter 尚不支援批次轉換
3. Proxy md-logger 不記錄非 streaming / 非 200 的回應
4. 圖片 blocks 只顯示 `[image]` 佔位符
