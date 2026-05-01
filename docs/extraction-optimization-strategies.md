# Extraction Worker Optimization Strategies

> 2026-04-30 — 針對 extraction worker 的 token 消耗、訂閱配額衝突、以及多種優化策略的分析與建議。

## 背景

當前 worker 設計：每個 conversation turn → 1 次 LLM API 呼叫提取 entities + facts。在以下情境下會撞牆：

- 使用者互動 session + worker 並行（同一 Max 訂閱配額）
- 一次性消化大量積壓（10k+ dead-letter）
- 多 session 並行使用 kiroku

本文記錄各種減壓策略的分析與組合評估，作為後續實作優先序的依據。

## Part 1：個別優化策略分析

### 1.1 OAuth Long-Life Token + Sonnet Medium Effort

**OAuth token 啟動 worker**：✅ 已實作於 v1.5.0。`anthropic-auth.js` 的優先序 1 = `CLAUDE_CODE_OAUTH_TOKEN` env，可在 `~/.kiroku/.env` 設定。

**Sonnet medium effort**：✅ 完全可行。

`effort-2025-11-24` beta header 接受四個值：

| Effort | 相對 token 用量 | 適合 extraction？ |
|--------|---------------|-----------------|
| `low` | ~50% | 太簡單可能漏 fact |
| `medium` | ~70% | **最佳平衡**（推薦）|
| `high` | 100% | 過度，無增益 |
| `xhigh` | 130%+ | 完全沒必要 |

extraction 是結構化 JSON 任務，不需要 high effort。Medium effort 估計減少 **~30% output cost**。

實作方式：在 `callAnthropic()` 的 request body 加：
```js
metadata: { effort: 'medium' }
// 或 header: anthropic-beta: effort-2025-11-24,...
```

### 1.2 Batch（多 turn 合一次 API call）

#### 數學模型（每 turn 平均 ~2k input + ~1k output）

| Batch size | API 呼叫數（per 100 turns） | Total input tokens | vs N=1 節省 |
|-----------|----------------------------|-------------------|------------|
| N=1（現狀） | 100 | 530,000 | — |
| N=5 | 20 | 386,000 | -27% |
| N=10 | 10 | 353,000 | -33% |
| N=20 | 5 | 336,000 | -37% |
| N=50 | 2 | 327,000 | -38% |

**最佳 sweet spot：N=10**。再往上邊際效益遞減（system prompt 已被攤提到很低），但風險倍增。

#### 副作用（深度分析）

1. **Latency 增加**：
   - 等齊 N=10 筆 + flush timeout = 即時記憶延遲約 30s
   - 對「session 結束才用」場景無影響
   - 對「希望即時更新」會打折

2. **Output token 暴增**：
   - 單筆 `maxOutputTokens: 2048` → batch N=10 需要 **15,000+**
   - Sonnet 預設 8k 上限，要 `extended-output-2025-02-19` beta header
   - 若超出，整個 batch 截斷重做

3. **錯誤放大**：
   - 1 筆解析錯誤 = 整批 10 筆要 retry
   - 需 split-retry 機制：N=10 失敗 → 拆成 2×N=5 → 再失敗拆成 1×1
   - 平均「一次成功率」下降，總 latency 反而增加

4. **跨 turn 污染**：
   - 模型可能把 Turn 3 的 entity 當成 Turn 1 的 fact subject
   - 需 prompt 明確要求「每個 turn 獨立處理」+ 範例

5. **Source event 追蹤**：
   - 每個 entity/fact 必須對回原始 turn 的 `event_id`（用於 embeddings 和 audit）
   - Output schema 要加 `turn_index` 欄位
   - Worker 寫入時要 split 成 N 個 source 寫入

#### 實作工作量

需要新增的元件：
1. **Aggregator**：累積到 N 筆或 timeout flush
2. **新 prompt 結構**：能處理 turn 陣列
3. **新 output 解析**：array of `{turn_index, entities, facts}`
4. **錯誤切分**：失敗時 split 成更小 batch 重試
5. **Turn 邊界標記**：避免跨 turn 串連
6. **Source tracking**：每個 fact 要對回原始 `event_id`

預估 **5-7 天**。

### 1.3 Filter 瑣碎 Turn

**低影響的可安全跳過**：
- 純工具回應（assistant 只說 "OK"、"好的"、"已完成"）
- 純 tool_result 沒 text content 的 turn
- Echo turn（assistant 重複 user 的話）
- Length < 50 字 + 沒任何專有名詞/路徑/email

**有風險的（不建議跳過）**：
- Length 50-200 字的短決策（"用 bun 不用 npm" 才 12 字但是重要 preference）
- 含具體人名/工具名/email 的短 turn

**保守規則**：
```
跳過 if (turn 純 tool_result 無 text)
       OR (turn 長度 < 30 字 AND 不含 [@\w]+ 樣式 token)
       OR (assistant_text in 黑名單："OK", "好的", "了解", "收到", ...)
```

預估減少 **20-30% turn 數**，extraction 品質損失 < 2%（因為跳過的本來就無料）。

### 1.4 Throttle（每分鐘最多 N 筆）

**重要場景**：
- 多 session 並行（互動 session + extraction worker 同時跑）
- 短期突發大量 turn（一次貼很長對話、import 舊 session）

**不 throttle 會怎樣**：
- 撞 rate limit → worker 全 retry → 退避延長（exponential backoff）
- 最壞情況：5h 內所有 retry 都失敗 → 全部進 dead-letter
- 不會 OOM 或 crash，只是浪費呼叫額度

**建議閾值**：
| Provider/方案 | 建議 rate |
|---------------|----------|
| Anthropic Max 訂閱 | **3-5 筆/min** |
| Anthropic API key | 10-20 筆/min |
| OpenRouter Gemini Flash | 60+ 筆/min |
| 中轉站 | 視合約 |

實作方式：token bucket 或固定間隔 sleep。

### 1.5 Defer 到 Session 結束

**省 token？不會**——一樣處理 N 個 turn，總 token 量不變。

**真正好處**：
- 不跟互動 session 競爭 5h 配額（**這才是關鍵**）
- 可以一次 batch 好幾個 turn（與 batch 結合最強）
- 失敗重跑時不影響當前互動

**負面**：記憶要等到下次 session start 才注入。但反正 SessionStart hook 是 session 開始時跑的，當前 session 內不會即時用到——所以**沒實質損失**。

**已經部分實作**：worker 收到 `SIGUSR1`（kiroku stop hook）時會立即輪詢。可以加強為「session 活躍時暫停輪詢」（檢查 `~/.claude/projects/<slug>/sessions/*.json` 的 mtime）。

### 1.6 其他減量策略

| 策略 | 預期減量 | 實作難度 |
|------|---------|---------|
| **Hash dedup**（同 turn text 不重複 extract） | 視重複率，5-15% | 低 |
| **Skip pure tool output**（bash stdout、file read 結果）| 30-50% | 低 |
| **Compressed output schema**（JSON minify、去掉 detail/aliases）| -20% output | 低 |
| **Cheaper model + escalation**（Haiku 抽，遇到複雜 turn 升 Sonnet）| 50-70% | 中 |
| **Token budget tracker**（追蹤 5h 配額，剩 20% 自動 throttle）| 防爆 | 中 |
| **Local Ollama for trivial**（明顯簡單的 turn 走本地）| 看比例 | 中 |

## Part 2：組合策略評估

### 2.1 各組合的協同效應

組合計算（100 個 turn 為基準）：

| 組合 | API 呼叫數 | Input tokens | Output tokens | 相對成本 |
|------|----------|-------------|--------------|---------|
| 無優化 | 100 | 530k | 100k | 100% |
| 只 Cache | 100 | 228k（-57%）| 100k | ~58% |
| 只 Batch N=10 | 10 | 233k（-56%）| 100k | ~58% |
| **Cache + Batch** | 10 | **205k（-61%）** | 100k | ~55% |
| Cache + Batch + medium | 10 | 205k | 70k | ~48% |
| **+ Filter（-30%）** | 7 | **144k** | **49k** | **~33%** |

**重要發現**：Cache 跟 Batch **有部分重疊效益**（都是攤提 system prompt）。單獨用任一都省 ~56-57%，**合併用只多省 4%**。

### 2.2 各優化的相容性

| 組合 | 相容性 | 說明 |
|------|--------|------|
| Filter + Batch | ✅ 完全相容 | 進 batch 前先濾掉瑣碎 turn |
| Medium effort + Batch | ✅ 完全相容 | effort 是 per-call 設定 |
| Cache + Batch | ⚠️ 效益重疊 | 都攤提 system prompt，邊際遞減 |
| Throttle + Batch | ✅ 互補 | Batch 後再 throttle 更實際（10 倍少的呼叫數）|
| Filter + Cache | ✅ 完全相容 | 各管各的 |
| Defer + Throttle | ✅ 完全相容 | 處理時間錯開 |
| 全部 5 個組合 | ✅ 可行 | 但實作複雜度倍增 |

### 2.3 工作量懸殊

| 項目 | 工作量 | 風險 | 邊際效益 |
|------|--------|------|---------|
| Filter 瑣碎 turn | 半天 | 低 | -20~30% turn |
| Medium effort | 1 行 config | 極低 | -30% output |
| Throttle | 1 天 | 低 | 防爆，間接省成本 |
| Cache（已完成）| — | — | -57% input |
| Batch | **5-7 天** | **中-高** | **+4% over cache** |

**Batch 的真正價值不在省 token，而在「省 API 呼叫數」**——對「per-minute call limit」型限制（如部分中轉站、自架 gateway）最有用。

## Part 3：分階段實作建議

### Phase 1（3-4 天，低風險，預期累積 -50%）

實作項目：
- ✅ Filter + Skip pure tool（半天）
- ✅ Medium effort（1 行 config）
- ✅ Throttle（1 天）
- ✅ Cache（已完成於 v1.5.0）

預期效果：
- Token 減少 **~55%**
- API 呼叫數減少 **~30%**
- 解決「互動 session + worker 並行撞牆」的常見場景

### Phase 2（5-7 天，中風險，再加 -10~15%）

實作項目：
- Batch N=10 extraction
- Split-retry 容錯
- 跨 turn 邊界 prompt 設計

預期效果：
- Token 額外減少 **-10~15%**
- API 呼叫數減少 **-90%**（從 100 → 10）
- 對 rate-limited provider 的友好度大幅提升

### 為什麼建議先做 Phase 1

1. **Phase 1 的減量已大幅解決 rate limit 問題**——對日常使用足夠
2. **Cache 已經完成 system prompt 攤提**，batch 邊際效益只剩 4%
3. Batch 的**真正價值在減少 API 呼叫數**（不是省 token），這對「rate limit per minute」型限制最有用——但訂閱主要受限於 5h token quota，per-call quota 不是瓶頸
4. Phase 1 跑一陣子後**有實際數據**，再判斷 Phase 2 是否值得

### 例外：什麼時候 Phase 2 必須做

- 訂閱方案有 **per-minute call limit**（不只 token limit）
- 處理大量積壓（10k+ dead-letter 一次性消化）
- 多 session 並行（每 session 都產生 turn，總 call 數倍增）
- 用 OpenRouter 等有 per-call latency 開銷的服務

## Part 4：實作優先序總覽

| 優先序 | 方案 | 預期累積減量 | 實作工時 | 風險 |
|--------|------|------------|---------|------|
| 1 | Filter 瑣碎 + Skip pure tool | -30~40% | 半天 | 低 |
| 2 | Medium effort（config 切換）| 累積 -40~50% | 1 行 | 極低 |
| 3 | Throttle | 累積 -45~55% | 1 天 | 低 |
| 4 | Prompt caching（已實作）| 累積 -75% | 已完成 | 已驗證 |
| 5 | Batch N=10 | 累積 -80~85% | 5-7 天 | 中 |
| 6 | Defer + 互動 session 暫停 | 解決並行衝突 | 2 天 | 中 |
| 7 | Token budget tracker | 安全網 | 1-2 天 | 低 |

## Part 5：Batch Output Token 暴增問題與解法

Part 1.2 提到 Batch N=10 會導致 output tokens 暴增到 15k+，超過 Sonnet 預設 8k 上限。本節探討 5 種**設計層面**的避免方法。

### 5.1 五個解法

#### 方案 A：Adaptive Batch Size（自適應批量）

根據 input 長度動態決定 N，控制預期 output 在安全範圍。

```
每 turn 估計 output ≈ 1k tokens
保留 buffer 到 6k（25% 安全邊界）
N = floor(6000 / avg_output_per_turn)

短 turn（< 500 input）→ N=15-20
中 turn（500-2k input）→ N=8-10
長 turn（> 2k input）→ N=3-5
```

| 優點 | 缺點 |
|------|------|
| 可預期、無需 beta header | 需估算邏輯，初期可能不準 |
| 相容性好 | 需追蹤 input 長度分佈 |

#### 方案 B：Delimiter + Streaming Recovery（分隔符串流恢復）

用 SSE 串流接收 output，每個 turn 結尾有明確標記，截斷時保留已完成的部分。

Prompt 設計：
```
為每個 TURN 輸出獨立 JSON，用 ===TURN_N_END=== 標記結束。
範例：
{"turn_index": 0, "entities": [...], "facts": [...]}
===TURN_0_END===
{"turn_index": 1, "entities": [...], "facts": [...]}
===TURN_1_END===
```

Worker 解析流程：
1. 串流讀取 chunks
2. 每收到 `===TURN_N_END===` 就解析該 turn 並寫入 DB
3. 若截斷，**只有最後一個未完成的 turn 失敗**，前面 N-1 個已落地
4. 失敗的 1 個 turn 單獨重試

| 優點 | 缺點 |
|------|------|
| 截斷只損失 1 筆而非整批 | 實作較複雜（SSE parser）|
| Progressive write | Worker 要支援串流 |

#### 方案 C：Minified Output Schema（壓縮輸出 schema）

短 key + 省略可選欄位，讓每 turn 的 output 縮水 30-50%。

```diff
- {"canonical_name":"PostgreSQL","entity_type":"topic","aliases":[]}
+ {"n":"PostgreSQL","t":"topic"}

- {"subject":"PostgreSQL","predicate":"is used as","object":"database","fact_type":"semantic","confidence":1.0,"scope":"project"}
+ {"s":"PostgreSQL","p":"is used as","o":"database","ft":"semantic","c":1,"sc":"p"}
```

Worker 收到後 post-process 還原成完整格式存 DB。

| 優點 | 缺點 |
|------|------|
| 每 turn output 從 ~1k → ~600 tokens | 需訓練模型用短 key |
| 結合 batch 後 N=10 從 15k → 9k | 可能降低 JSON 成功率 |

#### 方案 D：Tool Use 模式（最穩健）

用 Anthropic tool calling，每個 turn 的結果是一次 tool call。

Prompt 設計：
```
你有 store_extraction(turn_index, entities, facts) tool。
依序處理每個 turn，每個都呼叫一次 tool 儲存結果。
```

執行流程：
1. 模型輸出 tool_use block 1（turn 0 結果）
2. 假裝執行（tool_result: ok），繼續
3. 模型輸出 tool_use block 2（turn 1 結果）
4. ...直到全部完成

| 優點 | 缺點 |
|------|------|
| 每 turn 獨立 tool call，截斷只損失最後一個 | Output tokens 略增（tool call overhead）|
| Tool 結構化輸出比 raw JSON 穩定 | 需 multi-turn tool use 設計 |
| 可串流即時 parse 每個 tool_use | Prompt 設計更複雜 |
| Anthropic 對 tool calling 解析最佳 | — |

#### 方案 E：Extended Output Beta（最簡單）

加 `anthropic-beta: extended-output-2025-02-19` header，Sonnet output 上限從 8k → 64k。

```js
headers: {
  'anthropic-beta': 'prompt-caching-2024-07-31,extended-output-2025-02-19,...'
}
```

| 優點 | 缺點 |
|------|------|
| 1 行改動就解決 | 治標不治本 |
| 解決 99% 截斷問題 | 大 batch 失敗仍整批重試 |

### 5.2 推薦組合（從最務實到最穩健）

| Level | 組合 | 工時 | 適用場景 |
|-------|------|------|---------|
| **Level 1：Quick Win** | E（extended output）| 1 行 | 試水溫，先看效果 |
| **Level 2：Production** | A + E | 1-2 天 | 一般生產環境 |
| **Level 3：Robust** | A + B + E | 3-5 天 | 高量級積壓處理 |
| **Level 4：Bulletproof** | A + D | 5-7 天 | 關鍵任務，零容忍丟失 |

### 5.3 Phase 2 推薦設計

若決定做 Batch（Phase 2），建議走 **Level 3（A+B+E）**：

| 元件 | 實作策略 |
|------|---------|
| Adaptive sizing | 根據 input tokens 估算，N=3-15 動態 |
| Streaming parser | SSE chunks 即時解析，分隔符切分 |
| Recovery | 每完成一個 turn 立刻寫 DB，失敗只重試最後一個 |
| Beta header | `extended-output-2025-02-19`（雙保險）|

這個組合的 batch **失敗代價接近單筆 retry**——不會放大錯誤，也維持 batch 的攤提效益。

### 5.4 為什麼不直接用方案 D（Tool Use）

Tool Use 雖然最穩健，但對 worker 架構改動較大：
- 需要 multi-turn 對話流（每個 tool_use 後要 reply tool_result）
- 增加 ~3 倍 message 數量（user → tool_use → tool_result → tool_use → ...）
- 需要 tool schema 定義 + validation

對 v15 worker 的單一 request-response 設計來說，Level 3 是更合適的折衷。Tool Use 適合未來重構為「agent-style worker」時採用。

## 相關文件

- [extraction-cost-and-extensibility.md](./extraction-cost-and-extensibility.md) — Worker 成本基線、provider 選擇、多 client 擴展可行性
- [worker-retry-mechanism.md](./worker-retry-mechanism.md) — Worker retry 機制
- [extraction-model-research-2026-03-07.md](./extraction-model-research-2026-03-07.md) — 早期模型選型研究
- [CHANGELOG.md](../CHANGELOG.md) — v1.5.0 prompt caching 實作紀錄
