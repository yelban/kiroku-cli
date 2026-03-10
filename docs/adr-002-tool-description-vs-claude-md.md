# ADR-002: Tool Description vs CLAUDE.md 的職責分離

Date: 2026-03-06
Status: Accepted

---

> **核心原則：Tool description 驅動自動行為，CLAUDE.md 定義使用者觸發詞。不重複。**

---

## Context

Kiroku MCP gateway 註冊了 4 個 tools。Claude Code 需要知道「何時自動呼叫」和「使用者怎麼觸發」。這些指引可以寫在兩個地方：

1. **Tool description** — MCP tool 註冊時的描述文字，每次對話載入，是 Claude 決定何時呼叫工具的**主要依據**
2. **CLAUDE.md** — 專案層級指引，補充說明專案慣例和使用者偏好

## Problem

最初的 CLAUDE.md 把所有指引都放在一起，導致：

1. **行為偏差** — Claude 把 `memory_search` 當作唯一資訊來源，找不到就停止，不再搜尋 codebase
2. **指引過多反而干擾** — 列舉「找不到時該做什麼」暗示 memory_search 是主路徑，喧賓奪主
3. **重複浪費 tokens** — CLAUDE.md 和 tool description 說同樣的事

## Decision

### Tool description 負責（寫在 `src/mcp/server.js`）

**何時自動觸發** — 這是 Claude 的工具選擇機制直接讀取的：

```
memory_search: "Use this tool AUTOMATICALLY when:
  - Starting work on a topic that may have prior history
  - The user references something discussed before
  - You need context about project conventions or past decisions
  - The user asks about their preferences, habits, or past choices
  - The user asks "what did we decide about X" or "how did we handle Y"
  - Resuming or continuing work from a previous session"

memory_save: "Use when the user says "remember this", states a decision,
  explicitly asks to store information, or reaches an important conclusion
  worth preserving."

memory_forget: "Use when the user says "forget this" or information is outdated."
```

### CLAUDE.md 負責（寫在專案 `CLAUDE.md`）

**僅定義使用者觸發詞和輕量提示**：

```markdown
## Memory (Kiroku)
- 開始新任務前，可用 memory_search 查詢歷史上下文
- 使用者說「記住」「remember」時，用 memory_save 儲存
- 使用者說「忘記」「forget」時，用 memory_forget 歸檔
```

### CLAUDE.md 不負責

- ~~何時自動觸發 memory_search~~ → tool description
- ~~找不到時該怎麼辦~~ → 不需要說，Claude 原生行為會接手
- ~~重複 tool description 的內容~~ → 浪費 tokens

## Rationale

1. **Tool description 是 Claude 選擇工具的主要輸入** — 這是 MCP 協議的設計。Claude 根據 tool description 判斷當前 context 是否匹配某個工具的使用場景
2. **CLAUDE.md 的職責是專案慣例** — 例如「我們用 bun 不用 npm」「commit message 用英文」，不是重複定義工具行為
3. **不說 fallback 行為最好** — 任何關於「memory 找不到時怎麼辦」的指引都暗示 memory 是主路徑，干擾原生行為。不說，Claude 自然會用原生的 codebase 搜尋、模型知識、或詢問使用者
4. **Token 效率** — tool description ~790 tokens 已經涵蓋觸發邏輯，CLAUDE.md 只需 ~50 tokens 補充觸發詞

## Consequences

- 修改自動觸發行為 → 改 `server.js` 的 tool description
- 修改使用者觸發詞 → 改 `CLAUDE.md`
- 新增 tool → 在 tool description 寫清楚觸發場景，CLAUDE.md 只加觸發詞（如果有的話）
- 不需要在 CLAUDE.md 寫 fallback 策略
