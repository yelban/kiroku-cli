# Memory Injection at Session Start — Research (2026-03-12)

Claude Code session 啟動時自動注入專案記憶的所有可能方式比較。

## 結論

**SessionStart hook + sqlite3 直接注入**（方案 4）為最佳解。

## 所有方案

### 1. CLAUDE.md 靜態指令

在 CLAUDE.md 加「請呼叫 project_context」。

- 保證注入：✗（模型可能跳過）
- compact 後存活：✓（CLAUDE.md 重新載入，指令還在，但模型仍可能不呼叫）
- Token：每輪 ~30 tokens（指令文字）
- 複雜度：低

### 2. UserPromptSubmit → 提示模型呼叫工具

Hook 注入 `additionalContext` 提示呼叫 `project_context` MCP tool。

- 保證注入：✗（實測確認模型會跳過）
- compact 後存活：✗（不重新注入）
- Token：第一條訊息 ~20 tokens
- 複雜度：中

### 3. UserPromptSubmit → 直接注入資料

Hook 用 `sqlite3` CLI 查 DB，把 facts 當 `additionalContext` 注入。

- 保證注入：✓（資料直接在上下文）
- compact 後存活：✗（不重新注入）
- Token：~500-1000 tokens（30-50 facts）
- 複雜度：中

### 4. SessionStart → 直接注入資料 ★ 採用

同方案 3，但用 `SessionStart` hook。

- 保證注入：✓
- compact 後存活：✓（source=compact 時重新觸發）
- resume 時注入：✓（source=resume）
- Token：啟動時 + compact 後自動注入
- 複雜度：中

### 5. `.claude/rules/*.md` 動態寫入

SessionStart hook 寫 rules 檔案，Claude Code 載入。

- 保證注入：有 race condition（hook 寫完時 rules 可能已載入）
- compact 後存活：✓（rules 重新載入）
- 缺點：寫入專案目錄，可能被 git 追蹤
- 複雜度：高

### 6. MCP Resource 自動載入

`kiroku://context/project-brief` 已存在。

- 保證注入：✗（無法自動載入，需模型主動請求）
- 結論：不可行

### 7. 動態修改 CLAUDE.md

把 facts 寫入 CLAUDE.md。

- 保證注入：✓
- 缺點：破壞手動維護的內容，違反 Red Line R2
- 結論：不可行

## 比較表

| 方式 | 保證注入 | compact 後 | 不依賴模型 | 複雜度 |
|------|---------|-----------|-----------|--------|
| 1. CLAUDE.md 指令 | ✗ | ✓（指令在） | ✗ | 低 |
| 2. Hook→提示呼叫 | ✗ | ✗ | ✗ | 中 |
| 3. Hook→直接注入 | ✓ | ✗ | ✓ | 中 |
| **4. SessionStart→注入** | **✓** | **✓** | **✓** | **中** |
| 5. rules 檔案 | race | ✓ | ✓ | 高 |
| 6. MCP Resource | ✗ | - | ✗ | - |
| 7. 改 CLAUDE.md | ✓ | ✓ | ✓ | 違規 |

## Claude Code Hook 事件參考

### SessionStart

- 觸發：session 開始或恢復
- Matcher：`startup`, `resume`, `clear`, `compact`
- stdin：`{"session_id", "cwd", "source", "model", "hook_event_name"}`
- stdout：直接加入 Claude context
- additionalContext：支援

### UserPromptSubmit

- 觸發：使用者送出訊息（每次）
- Matcher：無
- stdin：`{"session_id", "prompt", "hook_event_name"}`
- stdout：加入 Claude context
- additionalContext：支援

### InstructionsLoaded

- 觸發：CLAUDE.md 或 rules 檔案載入
- 用途：僅 audit/observability，**無法注入 context**

### PreCompact

- 觸發：context compaction 前
- 用途：僅 observability，**無法注入 context**

### Stop

- 觸發：Claude 回應完成
- 用途：side effects（如 kiroku 的 worker SIGUSR1 通知）

## 實作細節（方案 4）

- 腳本位置：`~/.kiroku/hooks/on-session-start.sh`
- 由 `kiroku start` 自動建立並註冊至 `.claude/settings.local.json`
- 使用 macOS 內建 `sqlite3` CLI 直接查詢 `~/.kiroku/data/memory.sqlite`
- 查詢邏輯與 `project_context` MCP tool 相同（type 優先序 + heat × access_count 排序）
- 預設 LIMIT 30 facts
- 無 DB / 無 sqlite3 → 靜默 exit 0，不影響 Claude Code
- compact 後自動重新注入，長對話不會丟失記憶
