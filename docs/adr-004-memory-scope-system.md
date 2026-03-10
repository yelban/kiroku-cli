# ADR-004: Memory Scope System — Global vs Project-Scoped Facts

Date: 2026-03-06
Status: Implemented (2026-03-07)

---

## Context

Kiroku V15 目前所有記憶查詢都帶 `WHERE project_id = ?`，嚴格隔離不同專案的 facts。

**問題**：使用者在 Project A 說「記住：一律用 bun」，到 Project B 時這筆偏好看不到。

這類跨專案通用的記憶（個人偏好、技能、常識）需要一套 **scope 系統**區分「此專案限定」和「全域通用」。

### 現況分析

| 元件 | project_id 隔離 | 備註 |
|------|-----------------|------|
| `facts` 表 | `project_id` FK ✅ | 嚴格隔離 |
| `fact_embeddings` | `project_id` 欄位 ✅ | 向量搜尋有 `WHERE project_id = ?` |
| `entities` 表 | **無 project_id** | 已經是全域共享 |
| `turns` / `conversations` | `project_id` FK ✅ | 對話歷史應保持隔離 |
| `memory_search` | 固定查單一 project_id | 無法跨專案搜尋 |
| `memory_save` | 存入當前 project_id | 無 scope 參數 |

### 前作參考：kiroku-memory

kiroku-memory 使用命名空間架構：
- `default` — 個人全域記憶
- `project:<repo>` — 專案限定
- 讀取時 `?namespaces=project:X,default` 合併多命名空間
- 寫入時固定寫入單一命名空間

Harrison Chase 三層模型：
- **Episodic**：事件記憶（「昨天修了 auth bug」）→ 專案限定
- **Semantic**：知識事實（「bge-m3 維度 1024」）→ 看情境
- **Procedural**：偏好習慣（「commit message 用英文」）→ 全域通用

---

## Decision: 雙層 Scope — `project` + `global`

### 設計

引入 `scope` 欄位到 `facts` 和 `fact_embeddings`：

```sql
-- facts 表加欄位
ALTER TABLE facts ADD COLUMN scope TEXT NOT NULL DEFAULT 'project';
-- 值：'project' | 'global'

-- fact_embeddings 同步（vec0 不支援 ALTER，需重建）
-- 新建時直接加 scope 欄位
```

### Scope 定義

| Scope | 含義 | 典型 fact_type | 範例 |
|-------|------|---------------|------|
| `project` | 僅在建立它的專案內可見 | episodic, task, state | 「kiroku-v15 用 ESM 模組」「PR #42 修了 FK constraint」 |
| `global` | 所有專案可見 | preference, semantic | 「吹吹偏好 bun」「commit message 用英文」「GitHub: yelban」 |

### 判定規則

```
scope = 'global' 條件（滿足任一）：
1. fact_type = 'preference'（偏好天然跨專案）
2. subject 為使用者本人（人名、代稱、「I」、「user」）
3. memory_save 時明確指定 scope='global'
4. LLM 萃取時判定為通用知識（Prompt 指引）

scope = 'project'（預設）：
- 其他所有情況
```

### 查詢行為

**memory_search**（預設行為）：
```sql
-- 搜尋當前專案 + 全域
WHERE (project_id = ? AND scope = 'project')
   OR (scope = 'global')
```

**memory_search**（可選 `scope` 參數限制）：
- `scope = 'project'` → 只看當前專案
- `scope = 'global'` → 只看全域
- `scope = 'all'` 或不指定 → 合併查詢（預設）

**memory_save**：
- 新增可選 `scope` 參數
- 預設走判定規則自動決定

**memory_forget**：
- 不區分 scope，按 fact_id 或 subject+predicate 歸檔
- 全域 fact 可從任何專案歸檔

### 衝突解決

同一 subject + predicate 可能同時存在 project-scope 和 global-scope 的 fact：

```
global:  「吹吹 偏好 bun」
project: 「吹吹 偏好 npm」（某個 legacy 專案必須用 npm）
```

**規則：Project-scope 優先於 global-scope（覆寫語意）**

搜尋結果排序：
1. 向量相似度（主排序）
2. 同 subject+predicate 時，project > global（局部覆寫全域）
3. confidence 高的優先

文字搜尋結果排序：
1. project-scope 命中排前
2. global-scope 命中排後
3. 去重：同 subject+predicate 只保留 project-scope 版本

---

## Implementation Plan

### Schema 變更

```sql
-- Migration 003_scope.sql

-- 1. facts 表加 scope 欄位
ALTER TABLE facts ADD COLUMN scope TEXT NOT NULL DEFAULT 'project';

-- 2. 更新索引
CREATE INDEX IF NOT EXISTS idx_facts_scope ON facts(scope, status);
CREATE INDEX IF NOT EXISTS idx_facts_project_scope ON facts(project_id, scope, status, heat DESC);

-- 3. fact_embeddings — vec0 不支援 ALTER TABLE
--    需要：建新表 → 搬資料 → 刪舊表 → 改名
--    或：直接在 002_vec.sql 加 scope 欄位（如果是新安裝）

-- 4. 現有 facts 遷移
--    preference 類型 → scope='global'
UPDATE facts SET scope = 'global' WHERE fact_type = 'preference';
```

### 檔案變更

| 檔案 | 變更 |
|------|------|
| `migrations/003_scope.sql` | 新增 scope 欄位 + 索引 + 遷移 |
| `src/mcp/memory-search.js` | 查詢邏輯改為 `(project_id=? AND scope='project') OR scope='global'` |
| `src/mcp/memory-write.js` | `memorySave` 加 `scope` 參數 + 自動判定邏輯 |
| `src/mcp/server.js` | tool schema 加 `scope` 參數 |
| `src/worker/store.js` | `storeFacts` 和 `saveFactManually` 支援 scope |
| `src/worker/extractor.js` | 萃取 prompt 加 scope 判定指引 |
| `prompts/extraction.md` | 加入 scope 分類指引 |

### memory_search 改動

```javascript
// Before (strict isolation):
WHERE f.project_id = ? AND f.status = ?

// After (project + global merge):
WHERE f.status = ?
  AND (
    (f.project_id = ? AND f.scope = 'project')
    OR f.scope = 'global'
  )
```

向量搜尋同理：
```javascript
// Before:
WHERE project_id = ? AND status = ? AND embedding MATCH ? AND k = ?

// After:
// vec0 不支援 OR 條件，需要兩次查詢合併
// Query 1: project-scope
WHERE project_id = ? AND scope = 'project' AND status = ? AND embedding MATCH ? AND k = ?
// Query 2: global-scope
WHERE scope = 'global' AND status = ? AND embedding MATCH ? AND k = ?
// 合併 + 去重 + 排序
```

### memory_save 改動

```javascript
// Tool schema 加 scope 參數
scope: z.enum(['project', 'global']).optional()
  .describe('Memory scope: project (default) or global (cross-project)')

// 自動判定邏輯
function inferScope(params) {
  if (params.scope) return params.scope;           // 明確指定
  if (params.fact_type === 'preference') return 'global';  // 偏好
  // 可擴展：subject 為使用者名稱時也設為 global
  return 'project';                                 // 預設
}
```

### 萃取 Prompt 變更

在 `prompts/extraction.md` 加入：

```
For each extracted fact, also determine its scope:
- "global": User preferences, personal information, general knowledge that applies across all projects
  Examples: "prefers dark mode", "uses bun instead of npm", "GitHub username is X"
- "project": Project-specific decisions, architecture choices, bugs, task status
  Examples: "uses ESM modules", "auth implemented with JWT", "PR #42 fixed FK constraint"
Default to "project" if unsure.
```

---

## Rationale

### 為什麼不用完整命名空間系統？

kiroku-memory 的命名空間架構（`org:acme:cust:C001`）為 SaaS 多租戶設計，Kiroku V15 是單使用者本地工具，複雜度不匹配。

| 方案 | 複雜度 | 適合場景 |
|------|--------|---------|
| kiroku-memory 命名空間 | 高（需 ACL、wildcard、multi-namespace merge） | SaaS 多租戶 |
| **雙層 scope (project/global)** | **低（一個欄位 + OR 查詢）** | **單使用者本地工具** |
| 不做（維持現狀） | 零 | 只用單一專案 |

### 為什麼 preference 預設 global？

| fact_type | 典型 scope | 理由 |
|-----------|-----------|------|
| preference | global | 偏好跨專案不變（「用 bun」「commit 用英文」） |
| semantic | 看情境 | 「bge-m3 維度 1024」是通用知識，但「我們的 API 用 REST」是專案限定 |
| episodic | project | 事件發生在特定專案上下文 |
| task | project | 任務綁定專案 |
| state | project | 狀態是專案進展的快照 |

Semantic 型需要由 LLM 萃取時判定，無法純靠 fact_type 決定。

### 為什麼 project-scope 優先於 global？

局部覆寫全域是常見設計模式（CSS specificity、env vars、git config --local）。

使用者可能在 global 記了「偏好 bun」，但特定 legacy 專案必須用 npm。Project-scope 的「偏好 npm」應該覆寫 global 的「偏好 bun」。

### vec0 的 OR 查詢限制

sqlite-vec 的 vec0 虛擬表不支援 `WHERE scope IN ('project', 'global')` 等複合條件做 KNN。

解法：兩次查詢 + 合併排序。效能影響可接受——每次多一次 KNN 查詢（~2-5ms），總延遲仍在 <50ms。

---

## Industry Context

2025-2026 AI 記憶系統的主流做法：

1. **Hybrid Scoping** — 區分 local（agent/project 級）和 global（user/org 級）記憶，按需合併查詢（[Tribe AI](https://www.tribe.ai/applied-ai/beyond-the-bubble-how-context-aware-memory-systems-are-changing-the-game-in-2025)）

2. **Memory-Logic Separation** — 記憶基礎設施與應用邏輯解耦（[Arize](https://arize.com/ai-memory/)）

3. **Multi-Cube Composable Memory** — MemOS 的可組合記憶立方體模型，支援隔離與受控共享（[MemOS](https://github.com/MemTensor/MemOS)）

4. **Tiered Retrieval** — 摘要層 → 事實層 → 向量搜尋層，逐層展開（[Serokell](https://serokell.io/blog/design-patterns-for-long-term-memory-in-llm-powered-architectures)）

5. **Project-Scoped Boundaries** — Claude 自家的 Project Memory 也是硬隔離，但缺乏跨專案共享機制

Kiroku V15 的雙層 scope 設計取了「隔離 + 受控共享」的平衡點：
- 不像 Claude Project Memory 那樣完全隔離（無法共享偏好）
- 不像 MemOS 那樣複雜（不需要 ACL 和 multi-cube 管理）
- 接近 kiroku-memory 的 `default` + `project:X` 二級模型，但實作簡化

---

## Migration Strategy

### 新安裝

直接在 schema 建立時就有 `scope` 欄位。

### 現有安裝

1. `003_scope.sql` 用 `ALTER TABLE` 加 `scope` 欄位（default='project'）
2. 自動遷移：`UPDATE facts SET scope = 'global' WHERE fact_type = 'preference'`
3. `fact_embeddings` 需重建（vec0 限制）— 可在 `kiroku doctor` 時自動執行

### 向後相容

- 舊 MCP client 不傳 `scope` 參數 → 自動判定，行為不變
- 舊 `memory_search` 不傳 `scope` → 預設合併查詢（project + global）
- 現有 facts 預設 scope='project'，不影響已有搜尋結果

---

## Open Questions

1. **semantic 型 fact 的 scope 判定** — 靠 LLM 萃取時判定，還是提供事後 reclassify 指令？
2. **global facts 的 project_id** — 設為 `'global'` 特殊值，還是保留原始建立時的 project_id？建議後者，保留溯源能力。
3. **vec0 重建策略** — 現有安裝的 `fact_embeddings` 如何安全加 `scope` 欄位？需要 downtime 嗎？
4. **去重演算法** — project-scope 和 global-scope 同 subject+predicate 時的去重在搜尋層做（即時）還是寫入層做（持久化）？
5. **global fact 的歸檔範圍** — 在 Project A 歸檔 global fact，是否影響 Project B？建議是：影響所有專案（global 就是 global）。
6. **Tiered retrieval** — kiroku-memory 有 category summary 層（L1），V15 是否需要？目前直接查 facts，規模大後可能需要摘要層。

---

## Rejected Alternatives

### A. 完整命名空間系統

kiroku-memory 的 `org:acme:cust:C001` 命名空間 + ACL + wildcard 匹配。

拒絕原因：V15 是單使用者本地工具，不需要多租戶隔離。命名空間系統的 90% 功能（ACL、org 隔離、customer 隔離）都不會用到。

### B. 複製式共享（Cross-Project Sync）

建立 global fact 時複製到所有 project_id。

拒絕原因：
- 新建專案時需要 backfill 所有 global facts
- 更新/歸檔需要 fan-out 到所有副本
- 資料冗餘，增加 DB 大小
- 一致性難保證

### C. 三層 Scope (global / team / project)

加入 team 層，支援多人協作。

拒絕原因：V15 是單使用者工具，team 層是過度設計。未來如有需求，可從 global 擴展為 `global` + `team:<id>` + `project`，不影響現有架構。

### D. 不做（維持 project 隔離）

拒絕原因：使用者明確反饋——「一律用 bun」這類偏好在每個專案都要重新教一次，體驗差。

---

## References

- [kiroku-memory README](../../../kiroku-memory/README.md) — 前作的跨專案共享實作
- [kiroku-memory Architecture](../../../kiroku-memory/docs/architecture.md) — Harrison Chase 三層模型 + 命名空間設計
- [ADR-002: Tool Description vs CLAUDE.md](./adr-002-tool-description-vs-claude-md.md) — MCP 工具觸發機制
- [MemOS](https://github.com/MemTensor/MemOS) — Multi-Cube 可組合記憶架構
- [Serokell: Design Patterns for Long-Term Memory](https://serokell.io/blog/design-patterns-for-long-term-memory-in-llm-powered-architectures)
- [Tribe AI: Context-Aware Memory Systems](https://www.tribe.ai/applied-ai/beyond-the-bubble-how-context-aware-memory-systems-are-changing-the-game-in-2025)
