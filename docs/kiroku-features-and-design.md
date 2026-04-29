# Kiroku 功能總覽與設計分析

> 版本：v1.5.0 | 更新日期：2026-04-29

## 目錄

1. [架構總覽](#1-架構總覽)
2. [功能清單](#2-功能清單)
3. [Markdown 對話日誌](#3-markdown-對話日誌)
4. [Telemetry 阻擋](#4-telemetry-阻擋)
5. [Heat/Decay 衰減系統分析](#5-heatdecay-衰減系統分析)
6. [初始上下文注入最佳實踐](#6-初始上下文注入最佳實踐)
7. [SPO 三元組萃取 — 2026 年評估](#7-spo-三元組萃取--2026-年評估)

---

## 1. 架構總覽

Kiroku 由三個獨立 Node.js ESM 模組組成，透過檔案佇列（file queue）解耦：

```
┌─────────────────────────────────────────────────────────┐
│  Claude Code CLI                                        │
│  ANTHROPIC_BASE_URL=http://127.0.0.1:{port}             │
└──────────────┬──────────────────────────────────────────┘
               │ HTTP
┌──────────────▼──────────────────────────────────────────┐
│  kiroku-aegis-proxy (src/proxy/)                        │
│  ┌──────────┐ ┌───────────┐ ┌──────────┐ ┌──────────┐  │
│  │ Telemetry│ │SSE Recorder│ │DLP Redact│ │Keepalive │  │
│  │ Blocker  │ │(streaming) │ │(5 rules) │ │(API key) │  │
│  └──────────┘ └─────┬─────┘ └──────────┘ └──────────┘  │
│                     │                                   │
│              .jsonl queue file                           │
└──────────────┬──────────────────────────────────────────┘
               │ fs poll (2s)
┌──────────────▼──────────────────────────────────────────┐
│  kiroku-memory-worker (src/worker/)                     │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐  │
│  │Extractor │ │Embedder  │ │  Store   │ │Decay Sweep│  │
│  │(LLM API) │ │(bge-m3)  │ │(SQLite)  │ │(6h cycle) │  │
│  └──────────┘ └──────────┘ └──────────┘ └───────────┘  │
└──────────────┬──────────────────────────────────────────┘
               │ SQLite (WAL)
┌──────────────▼──────────────────────────────────────────┐
│  ~/.kiroku/data/memory.sqlite                           │
│  tables: projects, conversations, turns, entities,      │
│          facts, fact_embeddings (vec0), audit_logs       │
└──────────────┬──────────────────────────────────────────┘
               │ read/write
┌──────────────▼──────────────────────────────────────────┐
│  kiroku-mcp-gateway (src/mcp/) — stdio transport        │
│  Tools: memory_search, memory_save, memory_forget,      │
│         sql_readonly, health_status                      │
│  Resource: kiroku://schema/memory                       │
└─────────────────────────────────────────────────────────┘
```

**資料流向：**
1. Claude Code 所有 API 請求經過 Proxy
2. Proxy 攔截 streaming 回應、側錄為 `.jsonl` 事件檔，同時寫入 Markdown 日誌
3. Worker 每 2 秒輪詢佇列，透過 LLM 萃取 SPO 三元組（entities + facts）
4. 萃取結果寫入 SQLite，bge-m3 產生 1024 維向量嵌入
5. MCP Gateway 提供 Claude 即時查詢/寫入記憶的工具

**Runtime 目錄結構：**
```
~/.kiroku/
├── config.json          # Zod 驗證的設定檔
├── .env                 # API keys (0o600)
├── data/memory.sqlite   # WAL mode + sqlite-vec
├── queue/
│   ├── incoming/        # 待處理事件
│   ├── processing/      # 處理中
│   ├── done/            # 已完成
│   └── dead/            # 重試失敗
├── logs/conversations/  # Markdown 對話日誌
├── logs/keepalive.log   # API-key prompt cache keep-alive log（可選）
├── transcripts/         # 轉換後的對話紀錄
├── exports/             # 匯出的記憶快照
├── cache/               # 加密 prompt 快取
├── license/             # 授權金鑰 + 離線狀態
├── run/                 # PID 檔 + port 檔
└── backups/             # 資料庫備份
```

---

## 2. 功能清單

### 2.1 Proxy 功能

| 功能 | 說明 |
|------|------|
| **HTTP 透通代理** | 將 Claude Code 請求轉發至 `api.anthropic.com`，完全相容原生 API |
| **SSE 側錄** | 即時解析 streaming 回應，擷取 assistant text、thinking、tool_use、token 用量 |
| **DLP 脫敏** | 5 組正規表達式（AWS Key、Anthropic/OpenAI/GitHub/Slack Token），自動遮蔽敏感資訊 |
| **Telemetry 阻擋** | 攔截 `/telemetry`、`/metrics`、`/stats` 請求，回傳 204 |
| **Markdown 日誌** | 每次對話回合完成後，即時寫入可讀的 `.md` 檔案 |
| **API-key prompt cache keep-alive** | 可選功能；僅在 `x-api-key` + `cache_control` 請求後，用 `max_tokens=1` ping 保溫 Anthropic prompt cache |
| **閒置自動關機** | 預設 3600 秒無活動後自動停止（`idleShutdownSeconds`） |
| **請求分類器** | 辨識 title_generation / suggestion / tool_search / mainline 意圖（僅記錄用） |

### 2.2 Worker 功能

| 功能 | 說明 |
|------|------|
| **佇列輪詢** | 每 2 秒掃描 `queue/incoming/`，最多同時處理 2 個任務 |
| **LLM 萃取** | 支援 5 種 provider（OpenRouter/OpenAI-compat/Gemini/Anthropic/Ollama） |
| **SPO 三元組** | 萃取 entities（實體）+ facts（subject-predicate-object 三元組） |
| **向量嵌入** | bge-m3 模型，q8 量化，1024 維，批次大小 16 |
| **Heat/Decay** | 啟動時 + 每 6 小時掃描，重算所有 fact 熱度 |
| **重試機制** | 指數退避（2s → 4s → 8s → 16s → 32s），最多 5 次，失敗移入 dead queue |
| **Prompt 三層降級** | 記憶體快取 → 加密磁碟快取 → CF Worker 遠端取得 → 內建 fallback |
| **免費額度限制** | 每日萃取上限 50 次、fact 上限 500 筆、停用嵌入 |

### 2.3 MCP 工具

| 工具 | 說明 |
|------|------|
| **`memory_search`** | 混合搜尋：向量相似度（sqlite-vec）+ 全文比對（含 CJK 分詞），命中時提升 fact 熱度 |
| **`memory_save`** | 手動儲存 fact（base_heat=1.0），自動取代同 subject+predicate 的舊 fact |
| **`memory_forget`** | 依 fact_id 精確封存 或 subject/predicate 模糊比對封存 |
| **`sql_readonly`** | SQL 沙盒，僅允許 SELECT/WITH/EXPLAIN，自動加 LIMIT 200，cell 截斷 2048 bytes |
| **`health_status`** | 系統診斷：DB 計數、佇列深度、嵌入覆蓋率、授權狀態 |

**MCP Resource：**
- `kiroku://schema/memory` — DDL schema 參考，供 Claude 撰寫 SQL 查詢

### 2.4 CLI 指令

| 指令 | 說明 |
|------|------|
| `kiroku init` | 初始化：建立目錄、跑 migration、互動式設定 provider 和 API key |
| `kiroku start` | 啟動 proxy + worker daemon，設定 ANTHROPIC_BASE_URL，註冊 Stop hook |
| `kiroku stop` | 關閉 proxy（/suicide）和 worker（SIGTERM），清除狀態檔 |
| `kiroku status` | 顯示元件狀態、PID、DB 統計、佇列深度 |
| `kiroku doctor` | 健康檢查：config / sqlite-vec / DB / embedding model / API key / 授權 |
| `kiroku export [project]` | 匯出 active facts → Markdown 表格（subject / predicate / object / type） |
| `kiroku reindex` | 重建向量嵌入（找出無 embedding 的 facts，批次 32 計算） |
| `kiroku transcript <id>` | 將 Claude Code `.jsonl` 轉為可讀 Markdown（支援 `--list`/`--all`/`--thinking`） |
| `kiroku activate <key>` | LS 授權啟用：驗證 → 儲存金鑰 → 測試 premium prompt → 存 instance ID |
| `kiroku deactivate` | 撤銷授權：呼叫 LS API → 清除授權檔案 → 回復 free tier |
| `kiroku license` | 顯示目前授權層級、machine ID、到期日、嵌入功能狀態 |
| `kiroku hook-on-stop` | Claude Code Stop hook 觸發：SIGUSR1 通知 worker 立即處理佇列 |

### 2.5 授權系統

雙層驗證：
- **Phase 1（離線）**：Ed25519 多公鑰輪換簽章 + 雙重 machine fingerprint
- **Phase 2（線上）**：Lemon Squeezy API 驗證 + 7 天離線寬限期

| 層級 | Fact 上限 | 日萃取上限 | 向量嵌入 |
|------|----------|-----------|---------|
| Free | 500 | 50 | 停用 |
| Pro  | 無限制 | 無限制 | 啟用 |

---

## 3. Markdown 對話日誌

### 觸發時機

每個 streaming API 回應完成後（**per-turn**），Proxy 立即將該回合寫入 Markdown 檔案。這不是 session 結束時的批次匯出，而是即時記錄，確保即使異常中斷也不會遺失已完成的回合。

### 設定

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

- **`enabled`**：預設 `true`，無需手動開啟
- **`maxToolInputLength`**：tool input/result 超過此 byte 數時截斷（預設 50,000）
- **`maxFileSizeKB`**：單檔上限（預設 512KB）

### 儲存路徑

```
~/.kiroku/logs/conversations/{projectId}/{date}-{sessionPrefix}.md
```

- `projectId`：從 `cwd` 產生的 slug（如 `-Users-orz99-zoo-kiroku-cli`）
- `sessionPrefix`：conversation ID 前 8 字元
- `date`：`YYYY-MM-DD` 格式

### 自動分檔機制

當檔案大小達到 `maxFileSizeKB` 時，自動建立新 part：

```
2026-03-11-a1b2c3d4.md         # Part 1
2026-03-11-a1b2c3d4-part2.md   # Part 2
2026-03-11-a1b2c3d4-part3.md   # Part 3 ...
```

每個新 part 會重新寫入 header（Project、Session、Model、Date），方便獨立閱讀。

### 日誌格式

每個回合包含：
- 使用者訊息（經 DLP 脫敏）
- Tool results（截斷至 maxToolInputLength）
- Assistant 回覆（文字 + tool_use 呼叫）
- Token 用量統計

---

## 4. Telemetry 阻擋

### 被阻擋的路徑

| 路徑 | 用途 | 回應 |
|------|------|------|
| `/telemetry` | Claude Code SDK 使用分析與功能追蹤 | `204 No Content` |
| `/metrics` | 效能指標（API 延遲、token 用量統計） | `204 No Content` |
| `/stats` | 聚合使用統計 | `204 No Content` |

### 實作方式

Proxy 在處理每個請求時，以**路徑前綴比對**（`reqUrl.startsWith(target)`）檢查是否命中阻擋清單。命中時直接回傳 HTTP 204，不轉發至上游。

### 設定

```json
{
  "proxy": {
    "telemetryBlock": {
      "enabled": true,
      "targets": ["/telemetry", "/metrics", "/stats"]
    }
  }
}
```

預設啟用。可透過 `config.json` 調整目標路徑或停用。

---

## 5. Heat/Decay 衰減系統分析

### 5.1 現行設計

每筆 fact 有三個衰減相關欄位：

| 欄位 | 說明 |
|------|------|
| `base_heat` | 基礎熱度（萃取 fact: 0.7、手動儲存: 1.0） |
| `last_accessed_at` | 最後存取時間（搜尋命中時更新） |
| `access_count` | 累計存取次數 |

**衰減公式：**

```
heat = base_heat × 0.5^(hours_since_last_access / 168)
```

- 半衰期：**7 天**（168 小時）
- 全域統一，不分 fact_type

**Bucket 分級：**

| Bucket | 門檻 | 意義 |
|--------|------|------|
| `hot` | heat ≥ 0.7 | 近期高度相關 |
| `warm` | 0.3 ≤ heat < 0.7 | 仍有參考價值 |
| `cold` | heat < 0.3 | 逐漸過時 |

**搜尋命中提升：** 每次 memory_search 命中時，`access_count += 1`、`last_accessed_at = now`、`base_heat += 0.05`（上限 1.0）。

**Sweep 頻率：** Worker 啟動時 + 每 6 小時，JS 端計算新 heat 值並批次寫回。

**免費版淘汰：** 超過 500 筆 fact 時，依 heat ASC 排序，coldest 優先標記為 `status='evicted'`。

### 5.2 問題分析

**7 天半衰期對軟體開發場景太激進。**

典型衰減時間線（base_heat=0.7，無存取）：

| 天數 | Heat | Bucket |
|------|------|--------|
| 0 | 0.700 | hot |
| 7 | 0.350 | warm |
| 14 | 0.175 | cold |
| 21 | 0.088 | cold |

然而軟體開發的知識生命週期差異極大：

| 知識類型 | 典型有效期 | 範例 |
|----------|-----------|------|
| **state**（狀態） | 數小時～數天 | 「目前在 debug auth flow」 |
| **episodic**（事件） | 數天～數週 | 「昨天修了 race condition」 |
| **task**（任務） | 1 個 sprint（2-4 週） | 「重構 API 層，預計下週完成」 |
| **semantic**（架構） | 數月～數年 | 「用 SQLite WAL 模式因為單寫入者」 |
| **preference**（偏好） | 永久 | 「使用者偏好 bun 而非 npm」 |

### 5.3 競品比較

| 系統 | 衰減機制 | 說明 |
|------|---------|------|
| **Mem0** | 無時間衰減 | 僅靠 relevance score 排序，無過期概念 |
| **Zep** | 無時間衰減 | Knowledge graph，靠 edge weight 和 contradiction 處理 |
| **Letta** | 無時間衰減 | Core memory（固定 context）+ archival（永久向量庫） |
| **LangMem** | 無時間衰減 | Profile（長期）+ semantic（累積），完全不刪除 |
| **Kiroku** | 7 天半衰期 | 所有 fact_type 統一衰減 |

**結論：** 主流記憶系統都**不使用**自動時間衰減。Kiroku 是唯一採用此機制的系統。

### 5.4 改進建議

#### 方案 A：Per-type 差異化半衰期

```json
{
  "worker": {
    "decay": {
      "halfLifeByType": {
        "state": 168,
        "episodic": 336,
        "task": 504,
        "semantic": 1440,
        "preference": null
      }
    }
  }
}
```

| fact_type | 建議半衰期 | 說明 |
|-----------|-----------|------|
| state | 7 天 | 短期狀態，快速衰減合理 |
| episodic | 14 天 | 事件記憶，約 1 個 sprint |
| task | 21 天 | 任務通常跨越多個 sprint |
| semantic | 60 天 | 架構知識需長期保留 |
| preference | 不衰減（`null`） | 使用者偏好永久有效 |

#### 方案 B：專案不活躍時凍結衰減

衰減計算應改為基於**專案活躍時間**而非**絕對時間**：

- 追蹤每個 project 的 `last_active_at`（最後一次 proxy 請求時間）
- Sweep 時若專案已 N 天無活動，凍結該專案所有 fact 的衰減
- 避免放假或切換專案導致記憶大量流失

```
若 (now - project.last_active_at) > freezeThresholdDays:
    跳過該 project 的衰減計算
```

#### 方案 C：組合策略（推薦）

同時實施 A + B，額外加入「衰減地板」（floor）：

```
heat = max(floor, base_heat × 0.5^(active_hours / halfLife[type]))
```

- `floor`：每種 type 的最低 heat 值（如 semantic: 0.3、preference: 0.7）
- 防止高價值知識被完全淘汰

---

## 6. 初始上下文注入最佳實踐

### 6.1 現狀

MCP Gateway 啟動時 Claude 的上下文中**沒有任何記憶**。Claude 必須主動呼叫 `memory_search` 才能獲取相關知識。這導致：

- 對話初期的回答品質較低（尚未檢索記憶）
- 依賴 Claude 的自發性——若 Claude 不主動搜尋，記憶形同虛設
- 搜尋需要使用者輸入的上下文來構造查詢（雞生蛋問題）

### 6.2 建議方案：動態 Resource 注入

新增 MCP dynamic resource：

```
kiroku://context/project-brief
```

~~Claude Code 啟動時會自動載入所有 MCP resource，不需要任何額外呼叫。~~

**更正（v1.2）：** Claude Code **不會**自動載入 MCP resource。Resource 是被動的，需要用 `@` 提及才會讀取。因此改為註冊 `project_context` MCP tool（無參數），description 指示 Claude「每次對話開始時自動呼叫」，Claude 會主動調用。Resource 保留供手動 `@` 查詢。

**內容生成邏輯：**
1. 辨識當前 project（從 CWD slug）
2. 查詢 top N 筆 hot facts，依 fact_type 排序優先級：
   - `preference` > `semantic` > `task` > `state` > `episodic`
3. 格式化為精簡文字（每筆一行：`[type] subject predicate object`）
4. 控制在 token 預算內

### 6.3 Token 預算分析

| 系統 | 注入量 | 佔比（200K context） |
|------|--------|---------------------|
| Mem0 | ~7,000 tokens（平均） | 3.5% |
| Letta core memory | ~2,000 tokens | 1.0% |
| **Kiroku 建議** | **500–1,000 tokens** | **0.25–0.5%** |

設定保守的 500–1,000 tokens 預算：
- 約 25–50 筆 fact（每筆約 20 tokens）
- 對 200K context window 影響微乎其微
- 提供足夠的專案脈絡讓 Claude 做出更好的初始回應

### 6.4 內容優先順序

```
1. preference（使用者偏好）    — 直接影響行為，優先全數注入
2. semantic（架構知識）        — 專案理解的基礎
3. task（進行中任務）          — 接續前次工作的關鍵
4. state（當前狀態）           — hot 的 state 通常仍相關
5. episodic（近期事件）        — 填充剩餘預算
```

### 6.5 實作考量

- Resource 內容需**快取**（5-10 秒 TTL），避免每次 MCP 重連都查 DB
- 冷啟動（新專案零 facts）回傳空字串或簡短提示
- 未來可考慮 LLM 摘要壓縮（但增加延遲和成本，初期不建議）

---

## 7. SPO 三元組萃取 — 2026 年評估

### 7.1 記憶表示方式比較

| 方式 | 代表系統 | 資料模型 | 查詢能力 | 儲存成本 |
|------|---------|---------|---------|---------|
| **NL facts** | Mem0 | 自然語言句子 | 向量相似度 | 低 |
| **SPO triples** | Kiroku | (subject, predicate, object) | 結構化查詢 + 向量 | 低 |
| **Full KG** | Zep | nodes + edges + properties | 圖遍歷 | 高 |
| **Hybrid** | LangMem | profiles + semantic chunks | 混合 | 中 |
| **Chunk RAG** | 傳統 RAG | 文字片段 | 向量相似度 | 中 |

### 7.2 SPO Triples 的優勢

**為何 SPO triples 仍是 Kiroku 的最佳選擇：**

1. **SQLite 相容性**：三元組天然映射到 relational table，不需 graph DB
   - `facts` 表：`subject_entity_id` → `predicate` → `object_text` / `object_entity_id`
   - 標準 SQL JOIN 即可完成多跳查詢

2. **結構化查詢**：支援精確的 subject/predicate 過濾，NL facts 做不到
   ```sql
   -- "找出所有關於 auth 模組的架構決策"
   SELECT * FROM facts f
   JOIN entities e ON f.subject_entity_id = e.id
   WHERE e.canonical_name LIKE '%auth%'
     AND f.fact_type = 'semantic';
   ```

3. **Supersession 邏輯**：相同 subject + predicate 的新 fact 自動取代舊 fact
   - 語義明確：「A uses B」被「A uses C」取代
   - NL facts 難以判斷兩段自然語言是否描述同一件事

4. **2025 研究支持**：LLM 處理結構化 triples 的效率比處理自然語言更高
   - 更少的 token 消耗
   - 更高的檢索精確度
   - 更容易進行矛盾偵測

### 7.3 現有不足

| 問題 | 說明 | 影響 |
|------|------|------|
| **object 過度精簡** | SPO 的 object 只有一句話，丟失細節 | 複雜決策的 why/context 被截斷 |
| **entity resolution 不足** | `AuthModule` 和 `auth module` 可能被視為不同實體 | 知識分散、查詢遺漏 |
| **時間資訊流失** | 缺乏 `valid_from` / `valid_to` 自動萃取 | 難以辨識過時知識 |
| **缺乏負面範例** | extraction prompt 只有正面範例 | 模型過度萃取、產生低品質 fact |

### 7.4 改進方向

#### A. 加入 `object_detail` 欄位

在 `facts` 表新增可選的 `object_detail TEXT`，儲存 object 的補充說明（2-3 句話）。

```
subject: "kiroku-proxy"
predicate: "uses"
object: "HTTP 204 for telemetry blocking"
object_detail: "攔截 /telemetry、/metrics、/stats 三個路徑。採用前綴比對而非
  精確匹配，因為 Claude Code SDK 可能在路徑後附加版本號或查詢參數。"
```

不影響現有的 supersession 邏輯（仍以 subject + predicate 判斷），但提供檢索時更豐富的上下文。

#### B. 改善 Entity Resolution

- 萃取時進行 canonical name 正規化（全小寫、去底線/連字號）
- 寫入前查詢已有 entities，以 Levenshtein 或 token overlap 偵測近似實體
- 合併 aliases_json，保留所有歷史名稱變體

#### C. Extraction Prompt 增強

1. **負面範例**：示範不該萃取的內容（如純粹的 debug 過程、暫時性的變數值）
2. **時間萃取**：若對話中出現「昨天」「上週」「v2.0 之後」，萃取為 `valid_from` / `valid_to`
3. **confidence 校準**：提供 confidence 評分標準（0.9+ 明確陳述、0.7-0.8 推論、0.5-0.6 不確定）

#### D. 長期展望

- **Contradiction detection**：新 fact 與既有 fact 矛盾時標記（而非默默 supersede）
- **Fact clustering**：同主題的 facts 自動分群，提供 topic-level 摘要
- **Cross-project linking**：跨專案的 global scope facts 能被自動關聯

---

## 附錄：資料庫 Schema

6 個 migration 檔定義了完整 schema：

| Migration | 內容 |
|-----------|------|
| 001_init.sql | 核心表：projects, conversations, turns, entities, facts, extraction_jobs |
| 002_vec.sql | fact_embeddings（vec0 虛擬表，float[1024]） |
| 003_scope.sql | facts 加入 scope 欄位（project/global） |
| 004_scope_vec.sql | 重建 fact_embeddings 加入 scope |
| 005_heat_decay.sql | 加入 last_accessed_at, access_count, base_heat + 回填 |
| 006_audit_log.sql | audit_logs 表（action / target / detail） |
| 007_v12_enhancements.sql | projects.last_active_at, facts.object_detail, entities.normalized_name |

---

## 參考文獻

### SPO vs NL vs KG 比較 ( SPO Triples vs 自然語言：LLM 理解結構化知識更有效 )
- [Large Language Models Can Better Understand Knowledge Graphs Than We Thought](https://arxiv.org/abs/2402.11541) 
  — unordered linearized triples 比 fluent NL text 更能幫助 LLM 回答 fact-intensive 問題（Knowledge-Based Systems, 2025）
  - LLM attention 分佈分析顯示，模型對 linearized triples 投注更高注意力
- [ScienceDirect 全文](https://www.sciencedirect.com/science/article/pii/S0950705125001078)
- [Simple is Effective: Roles of Graphs and LLMs in KG-Based RAG](https://openreview.net/forum?id=JvkuZZ04O7) — ICLR 2025
  - [PDF](https://proceedings.iclr.cc/paper_files/paper/2025/file/830b1abc6d2da85f23d41169fa44d185-Paper-Conference.pdf)

### KG-RAG vs Chunk RAG 比較
- [RAG vs. GraphRAG: A Systematic Evaluation](https://arxiv.org/abs/2502.11371) — 2025 年 2 月
  - 統一評估協議比較兩種方法在 QA 和 summarization 的表現
  - GraphRAG 在結構化知識任務中持續領先

- [Knowledge Graph-Guided Retrieval Augmented Generation](https://arxiv.org/abs/2502.06864) — 2025 年 2 月
  - KG-guided chunk expansion + organization 提升檢索多樣性和連貫性

### 競品架構論文

Mem0 架構（NL facts 代表）
- [Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory](https://arxiv.org/abs/2504.19413) — NL facts + graph-enhanced (Mem0g)
  - Base Mem0：自然語言 fact 萃取
  - Mem0g：graph-enhanced 版本（nodes + edges），比 base 再提升 2%
  - 比 OpenAI 系統提升 26%，p95 延遲降低 91%
  - [官方研究頁面](https://mem0.ai/research)

Zep 架構（Full KG 代表）
- [Zep: A Temporal Knowledge Graph Architecture for Agent Memory](https://arxiv.org/abs/2501.13956) — temporal KG, DMR 94.8%
  - Graphiti 引擎：temporal-aware KG，支援 unstructured + structured data
  - DMR benchmark: 94.8% accuracy（vs MemGPT 93.4%）
  - LongMemEval: 比 baseline 提升 18.5%，延遲降低 90%
  - [官方 Blog](https://blog.getzep.com/state-of-the-art-agent-memory/)
  - [PDF](https://blog.getzep.com/content/files/2025/01/ZEP__USING_KNOWLEDGE_GRAPHS_TO_POWER_LLM_AGENT_MEMORY_2025011700.pdf)

Letta/MemGPT 架構
- [MemGPT: Towards LLMs as Operating Systems](https://arxiv.org/abs/2310.08560) — Letta core/archival memory — 原始論文 2023
  - Core memory（RAM 類比）+ Archival memory（disk 類比）
  - LLM 自我管理記憶：決定何時儲存、摘要、遺忘
  - [Letta 官方概念文件](https://docs.letta.com/concepts/memgpt/)
  - [Memory management 文件](https://docs.letta.com/advanced/memory-management/)
  - [Benchmarking AI Agent Memory](https://www.letta.com/blog/benchmarking-ai-agent-memory)

LangMem 架構（Hybrid 代表）
- [LangMem Conceptual Guide](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/) — LangChain 官方
  - 三層：Semantic Memory（事實）+ Episodic Memory（對話歷史）+ Procedural Memory（偏好）
  - Hot path 即時記錄 + Background Manager 非同步整合
  - [介紹文章](https://medium.com/the-ai-forum/long-term-memory-in-ai-agents-a-structured-approach-with-langmem-12fe9c94a5c4)

### 記憶衰減研究

- [Memory in the Age of AI Agents: A Survey](https://arxiv.org/abs/2512.13564) — 2025 年 12 月
  - 綜合調查：memory formation → evolution（consolidation & forgetting）→ retrieval
- [Human-Like Remembering and Forgetting in LLM Agents](https://dl.acm.org/doi/10.1145/3765766.3765803) — HAI 2025
  - 基於 ACT-R 認知模型的 base-level activation + temporal decay
- [The Agent's Memory Dilemma: Is Forgetting a Bug or a Feature?](https://medium.com/@tao-hpu/the-agents-memory-dilemma-is-forgetting-a-bug-or-a-feature-a7e8421793d4)
  - 結論：沒有 decay 的記憶系統會累積 noise 降低效能；問題是「多激進」和「用什麼標準」
- [From Human Memory to AI Memory](https://arxiv.org/html/2504.15965v2) — 2025 年 4 月
  - Ebbinghaus forgetting curve 在 AI agent 的應用：MemoryBank 等系統

### 綜合 Surve
- [KG-LLM-Papers](https://github.com/zjukg/KG-LLM-Papers) — 持續更新的 KG + LLM 論文列表
- [Agent Memory Paper List](https://github.com/Shichun-Liu/Agent-Memory-Paper-List) — Agent memory 相關論文彙整

