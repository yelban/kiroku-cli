# 對話 Markdown 記錄

## 概述

Kiroku 提供兩種方式保留人類可讀的對話記錄：

1. **Proxy Markdown Logger** — 即時自動記錄，隨 API 請求同步寫入
2. **Transcript Converter** — 事後轉換 Claude Code 原生 JSONL 為完整 markdown

---

## A. Proxy Markdown Logger（即時記錄）

### 運作原理

每次 Claude Code 呼叫 `/v1/messages` API，proxy 側錄完 SSE 回應後，將該輪對話同步 append 到 markdown 檔案。

```
Claude Code → POST /v1/messages → Proxy
                                    ├─ passthrough → api.anthropic.com
                                    ├─ writeQueueEvent (facts 萃取用)
                                    └─ logTurnToMarkdown (本功能)
```

### 記錄內容

每輪 turn 包含：

| 欄位 | 來源 | 說明 |
|------|------|------|
| User text | 最後一筆 user message 的 `text` blocks | 使用者輸入 |
| Tool results | 最後一筆 user message 的 `tool_result` blocks | 工具回傳結果（含 AskUserQuestion 回答） |
| Assistant text | SSE 串流側錄 | 模型回應文字 |
| Tool uses | SSE 串流側錄 | 模型呼叫的工具（完整 JSON） |

### 檔案位置

```
~/.kiroku/logs/conversations/<project_id>/<YYYY-MM-DD>-<session前8字>.md
```

範例：
```
~/.kiroku/logs/conversations/
└── -Users-orz99-zoo-claude-proxy/
    ├── 2026-03-07-15e1da3a.md
    ├── 2026-03-07-15e1da3a-part2.md   ← 自動分段
    └── 2026-03-08-a3b4c5d6.md
```

### 自動分段

單檔超過 512KB（預設）時，自動建新分段檔（-part2, -part3...）。新檔案重寫 header 並標註 `> Continued from part N`。

### 設定

`~/.kiroku/config.json`：

```json
{
  "proxy": {
    "markdownLog": {
      "enabled": true,
      "maxToolInputLength": 50000,
      "maxFileSizeKB": 512
    }
  }
}
```

| 參數 | 預設 | 說明 |
|------|------|------|
| `enabled` | `true` | 開關 |
| `maxToolInputLength` | `50000` | tool input/result 超過此長度截斷 |
| `maxFileSizeKB` | `512` | 單檔大小上限，超過自動分段 |

### 限制

- 只記錄 streaming + HTTP 200 的 `/v1/messages` 請求
- 非 streaming 回應不記錄
- 圖片 blocks 不記錄（只顯示 `[image]`）
- system prompt 不記錄（只有 hash 在 queue event 中）
- 已套用 DLP redaction（與 queue event 相同）

### 不需任何操作

只要透過 `kiroku start` 啟動 Claude Code，對話就會自動記錄。

---

## B. Transcript Converter（事後轉換）

### 運作原理

讀取 Claude Code 的原生 session 檔案（`~/.claude/projects/<path>/<session>.jsonl`），轉換為結構化 markdown。

### 記錄內容

比 Proxy Logger 更完整：

| 欄位 | 說明 |
|------|------|
| User text | 每筆 user message |
| Tool results | tool_result blocks（含 AskUserQuestion 回答） |
| Assistant text | 模型回應 |
| Tool uses | 完整 JSON（name + input） |
| Thinking blocks | `--thinking` 旗標啟用時包含 |

過濾掉的內容：`isSidechain`、`isMeta`、`progress`、`file-history-snapshot`、`system`、不同 session 的條目。

### 使用方式

```bash
# 列出當前專案可用的 session
kiroku transcript --list

# 輸出範例：
#   15e1da3a-b347-4159-bde9-88aa28bf8d2a  2026-03-07 06:11  (562 entries)
#   2284f3d2-c65d-4e53-8166-ce096513d9e2  2026-03-07 04:30  (1182 entries)

# 轉換指定 session
kiroku transcript 15e1da3a-b347-4159-bde9-88aa28bf8d2a

# 包含 thinking blocks
kiroku transcript 15e1da3a --thinking

# 跳過 DLP 遮蔽（顯示原始內容）
kiroku transcript 15e1da3a --no-redact

# 自訂輸出路徑
kiroku transcript 15e1da3a --output ~/Desktop/my-conversation.md

# 也可直接給完整 .jsonl 路徑
kiroku transcript ~/.claude/projects/-Users-orz99-zoo-claude-proxy/15e1da3a.jsonl
```

### 輸出位置

預設：`~/.kiroku/logs/transcripts/<YYYY-MM-DD>-<session前8字>.md`

### 輸出格式

```markdown
# Conversation Transcript

- **Session:** 15e1da3a-b347-4159-bde9-88aa28bf8d2a
- **CWD:** /Users/orz99/zoo/claude-proxy
- **Branch:** main
- **Claude Code:** v2.1.70
- **Date:** 2026-03-07

---

## Turn 1 — 06:11:57

**User:**

Implement the following plan: ...

**Assistant:**

Let me start by reading the existing files.

#### Tool Use: `Read`

```json
{
  "file_path": "/Users/orz99/zoo/claude-proxy/kiroku-v15/src/shared/paths.js"
}
```

**Tool Result:**

     1→import { homedir } from 'node:os';
...

---
```

### Session ID 解析

Transcript converter 支援多種輸入格式：

| 輸入 | 說明 |
|------|------|
| 完整 UUID | `15e1da3a-b347-4159-bde9-88aa28bf8d2a` |
| 完整路徑 | `~/.claude/projects/.../15e1da3a.jsonl` |

`--list` 會自動掃描 `~/.claude/projects/` 下對應當前 CWD 的目錄。

### 限制

- Claude Code JSONL 格式無正式文件，可能隨版本變動
- 遇到未知格式的 entry 會靜默跳過（防禦性解析）
- 目前不支援批次轉換（一次只能轉一個 session）

---

## 兩者比較

| | Proxy Markdown Logger | Transcript Converter |
|--|--|--|
| 觸發方式 | 自動（每次 API 呼叫） | 手動 CLI |
| 資料來源 | Proxy 攔截的 API 流量 | Claude Code 原生 .jsonl |
| 記錄範圍 | 通過 proxy 的請求 | 完整 session 歷史 |
| Thinking | 不記錄 | `--thinking` 可選 |
| Tool results | 記錄（bug 已修復） | 記錄 |
| DLP 遮蔽 | 自動套用 | 預設套用，`--no-redact` 可跳過 |
| 檔案大小控制 | 自動分段（512KB） | 無限制 |
| 適用場景 | 日常自動記錄 | 事後回顧、匯出分享 |

---

## AskUserQuestion 回答擷取

### 修復前的 Bug

`server.js` 行 111 用 `filter(c.type === 'text')` 擷取 user content，會丟掉 `tool_result` blocks。AskUserQuestion 的使用者回答以 `tool_result` 形式回傳，因此完全遺失。

### 修復後的流程

1. **Turn N**：Assistant 發出 `tool_use: AskUserQuestion` → 記錄在 `response.tool_uses`
2. **Turn N+1**：使用者回答以 `tool_result` block 回傳
   - `tool_result` blocks 擷取到 `event.request.tool_results`
   - 若最後 user message 只有 `tool_result` 沒有 text → 往前找有 text 的 user message
   - md-logger 輸出 `**Tool Result:**` 區塊

### 影響範圍

同時修復了所有 tool_result 的擷取，包括但不限於：
- AskUserQuestion 回答
- Read / Glob / Grep 等工具的回傳結果
- Bash 指令的輸出

---

## 查看對話記錄

### 直接查看檔案

```bash
# Proxy 即時記錄
ls ~/.kiroku/logs/conversations/
cat ~/.kiroku/logs/conversations/<project>/<date>-<session>.md

# Transcript 轉換結果
ls ~/.kiroku/logs/transcripts/
cat ~/.kiroku/logs/transcripts/<date>-<session>.md
```

### 搭配 Markdown 閱讀器

.md 檔案可以用任何 Markdown 閱讀器開啟：
- VS Code：直接開啟，Cmd+Shift+V 預覽
- 瀏覽器：安裝 Markdown 擴充套件
- macOS：`open -a "Marked 2" <file>.md`
