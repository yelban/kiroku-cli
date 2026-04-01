# Claude Code 原生記憶系統 vs Kiroku 比較分析

> 2026-04-01 — 基於 Claude Code 洩漏原始碼的記憶系統逆向分析

## 背景

2026-03-31 Claude Code 原始碼洩漏，揭露了其完整的記憶系統架構：

- **memdir** — 記憶檔案儲存與索引
- **extractMemories** — 每輪對話後自動提取記憶
- **autoDream** — 定期「做夢」整理記憶（模擬人類睡眠記憶鞏固）

## 架構比較

### Claude Code 原生記憶

```
對話進行中
  ├── extractMemories：從對話實時提取要點 → 寫入 Markdown 檔案
  ├── memdir：存儲、索引（MEMORY.md 200行/25KB 上限）、Sonnet 選 top 5 注入
  └── autoDream：24h + 5 sessions 門控 → 4 階段整合（定向→採集→整合→修剪）
```

### Kiroku

```
對話進行中
  ├── aegis-proxy：HTTP 透傳 + DLP 遮蔽 + SSE 側錄 → .jsonl queue
  ├── memory-worker：LLM 提取 + bge-m3 embedding → SQLite + sqlite-vec
  └── mcp-gateway：memory_search（向量）、memory_save、project_context
```

## 逐項比較

| 維度 | CC 原生 | Kiroku | 勝出 |
|------|---------|--------|------|
| 儲存 | Markdown 檔案 + 200 行索引 | SQLite + sqlite-vec（無硬上限） | Kiroku |
| 檢索 | Sonnet 掃描 header → top 5 | bge-m3 向量搜尋 + Jaccard 去重 | 各有所長 |
| 提取 | extractMemories（每輪自動） | Worker 從 queue 提取（有延遲） | CC |
| 整合 | autoDream 4 階段（24h 週期） | compaction sweep + heat decay（6h 週期） | CC |
| 衰減 | 無中間態。在或不在，附「N 天前」警告 | per-type 半衰期 + floor | Kiroku |
| 跨專案 | 孤島式，每個 project 獨立 | global scope + SQL 跨專案查詢 | Kiroku |
| 結構 | 自由格式 Markdown | subject/predicate/object 三元組 | Kiroku |
| 衝突處理 | 直接覆寫（演化軌跡丟失） | cosine 偵測 + 保留雙方 + log warn | Kiroku |
| 關聯 | 檔案間無顯式關係 | entity resolution + normalized name | Kiroku |
| 成本 | 0（訂閱內含） | 需額外 API key | CC |
| 安裝 | 零（內建） | `npm install -g @kiroku/cli` | CC |
| DLP | 無 | 自動 PII 遮蔽 | Kiroku |
| 安全 | 路徑穿越防護 + symlink 檢查 + 只讀 shell | proxy 層隔離 + DLP | 平手 |

## CC 原生的殺手級功能

### autoDream（做夢整理）

模擬人類睡眠記憶鞏固，三道門控 + 四個階段：

**門控（按成本排序）：**
1. 時間門 — 距上次整理 >= 24h
2. 會話門 — 累積 >= 5 個新 sessions
3. 鎖門 — 沒有其他進程在整理

**四階段：**
1. 定向 — 讀現有記憶索引，了解全貌
2. 採集 — 掃描日誌/過時記憶/對話原文（精確關鍵詞，不通讀）
3. 整合 — 合併新資訊、相對日期→絕對日期、修正矛盾
4. 修剪 — 更新索引（200 行限制）、壓縮過長條目、解決衝突

**安全設計：**
- 只讀 Shell（ls/grep/cat，禁止寫入）
- 寫入範圍限定記憶目錄
- 失敗回滾時間戳
- 使用者可中止
- skipTranscript: true（不污染上下文）

### extractMemories（實時速記）

- 每輪問答後自動觸發（forked subagent）
- 互斥：主 AI 已寫記憶 → 跳過
- 權限最小化：只讀 + 記憶目錄寫入
- 預算控制：最多 5 個來回

### 記憶類型分類

與 kiroku 的 fact_type 幾乎一致：

| CC 原生 | Kiroku | 說明 |
|---------|--------|------|
| user | preference | 使用者角色/偏好 |
| feedback | preference/semantic | 工作方式糾正或認可 |
| project | semantic/episodic | 專案動態資訊 |
| reference | semantic | 外部系統指引 |
| — | state | 短期狀態（kiroku 獨有） |
| — | task | 任務追蹤（kiroku 獨有） |
| — | episodic | 事件記憶（kiroku 獨有） |

### 鮮度感知

CC 原生會計算記憶天數，超過 1 天附警告：

> 「這條記憶已有 47 天。記憶是某個時間點的快照⋯⋯引用前請先驗證。」

Kiroku 用 heat decay 做連續衰減，但沒有在 MCP 回傳時附加鮮度警告。

## Kiroku 的結構性優勢

### 1. 規模天花板

CC 的 200 行索引是硬上限。超過後 autoDream 會壓縮，但壓縮損失檢索精度。
Kiroku 的 SQLite + vector 可存數萬條 facts，向量搜尋不隨數量線性降級。

### 2. 真正的語意搜尋

CC 用 Sonnet 掃描 header 選 top 5 — 本質上是 LLM 做檢索，聰明但昂貴且有限。
Kiroku 用 bge-m3 embedding 做向量相似度搜尋，支持模糊語意比對，成本低且可擴展。

### 3. 衰減有中間態

CC：記憶要麼在要麼被刪，附天數警告但不影響排序。
Kiroku：per-type 半衰期（state=7d, episodic=14d, task=21d, semantic=60d, preference=never）+ floor，
heat 影響排序優先級，自然降級而非突然消失。

### 4. 跨專案記憶

CC 的記憶是孤島式的，每個 `~/.claude/projects/<slug>/memory/` 獨立。
Kiroku 的 `scope=global` facts 跨所有專案共享，SQL 可查任意專案的 facts。

### 5. 衝突保留

CC autoDream 發現矛盾直接覆寫 → 演化軌跡丟失。
「三個月前用 MySQL，上週遷到 PostgreSQL」這條時間線就不見了。
Kiroku 偵測到 cosine 0.75-0.92 + 同 predicate 不同 object → log warn，保留雙方。

### 6. DLP 遮蔽

CC 沒有任何 PII 遮蔽機制。
Kiroku proxy 層自動偵測並遮蔽敏感資訊（API key、email、電話等）。

## Kiroku 的劣勢

### 1. 不是零成本

需要額外 API key（OpenRouter/Ollama）做 LLM 提取。雖然用便宜模型（gemini-2.0-flash），
但仍有成本。CC 原生記憶用訂閱額度，使用者無感。

### 2. 沒有 autoDream 等級的主動整合

Kiroku 的 compaction sweep 是規則驅動（cosine 閾值），不是像 autoDream 那樣用 LLM
做認知層級的整合。autoDream 能「理解」兩條記憶的關係並合併，kiroku 只能偵測相似度。

### 3. 沒有即時提取

CC 的 extractMemories 在每輪對話後立即觸發。
Kiroku 要等 SSE 錄製寫入 queue → worker 輪詢 → LLM 提取，有延遲。

### 4. 安裝門檻

`npm install -g @kiroku/cli` + `kiroku init` + API key 設定。
對非技術使用者是門檻。CC 原生零設定。

## 第三方觀點的批評回應

> 「存儲和檢索完全依賴文件系統 + Markdown，無法擴展到跨項目、跨 Agent 的場景」

Kiroku 用 SQLite + vector，支持跨專案查詢。這正是 kiroku 的結構性優勢。

> 「沒有真正的語義索引，200 行索引就是硬上限」

Kiroku 有 bge-m3 向量索引，無硬上限。

> 「AutoDream 的整合是規則驅動的，不是認知驅動的」

部分正確。autoDream 實際上用 LLM 做整合（Phase 3），不是純規則。
但 kiroku 的 compaction 確實是純規則（cosine 閾值），這是 kiroku 的弱點。

> 「沒有遺忘曲線，沒有記憶強化機制」

Kiroku 有 heat decay（遺忘曲線）和 content-level dedup boost（重複出現時 heat 回升）。
CC 原生確實沒有。

## 結論：誰該用 Kiroku

**CC 原生記憶已足夠的場景（~80% 使用者）：**
- 單一專案開發
- 記憶量不大（一個專案幾十條 facts）
- 不需要跨專案知識共享
- 不在意 DLP

**Kiroku 仍有價值的場景（~20% 使用者）：**
- 同時維護多個專案，需要跨專案查詢歷史決策
- 長期重度使用，記憶量超過 200 行索引上限
- 企業/合規場景需要 DLP 遮蔽
- 需要精確的向量語意搜尋
- 需要記憶的衰減和強化有連續中間態
- 想要記憶不綁定特定 AI 工具（未來可接其他 LLM client）

## 潛在風險

如果 Anthropic 未來升級 CC 原生記憶：
- 加入向量搜尋 → kiroku 的檢索優勢消失
- 加入跨專案支援 → kiroku 最大的結構性優勢消失
- 加入 DLP → kiroku 的企業價值縮小

Kiroku 的長期護城河在於**不綁定特定 AI 工具的獨立記憶層**，但這個價值需要
實際支援多個 client（Cursor、Windsurf、Copilot 等）才能兌現。

## 參考資料

- [mac: 深挖 Claude Code 源碼 — autoDream](https://x.com/mac20777/status/2039163967243977188)
- [Yan: Claude Code 記憶系統深度解讀](https://x.com/xzensh/status/2039012574000480371)
