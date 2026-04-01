# Claude Code 洩漏原始碼驗證報告

> 2026-04-01 — 基於 `instructkr-claude-code/src/` 原始碼逐點驗證

## 背景

2026-03-31 Claude Code 原始碼洩漏後，多篇貼文分析其內部機制。
本文針對三篇具代表性的貼文，用原始碼逐點驗證。

### 資料來源

- [fakeguru: 7 個「洩漏發現」+ CLAUDE.md 範本](https://x.com/iamfakeguru/status/2038965567269249484)
- [艾略特: CC Memory 機制批評 + EverMind MSA 推廣](https://x.com/elliotchen100/status/2038989750984687818)
- [Yan: Claude Code 記憶系統深度解讀](https://x.com/xzensh/status/2039012574000480371)

---

## 一、fakeguru 的 7 個宣稱 — 原始碼驗證

### 1. 員工專屬驗證（`USER_TYPE === 'ant'`）

**宣稱：** 員工有 post-edit 自動驗證（tsc + eslint），一般使用者沒有。29-30% false-claims rate。

**原始碼事實：**

`prompts.ts:237-247`：

```typescript
// @[MODEL LAUNCH]: False-claims mitigation for Capybara v8
// (29-30% FC rate vs v4's 16.7%)
...(process.env.USER_TYPE === 'ant'
  ? [`Report outcomes faithfully: if tests fail, say so with the
      relevant output; if you did not run a verification step, say
      that rather than implying it succeeded. Never claim "all tests
      pass" when output shows failures...`]
  : []),
```

- **29-30% false-claims rate：真。** 註解明確寫明
- **員工有自動 post-edit 跑 tsc/eslint：假。** 沒有任何自動驗證 hook
- **員工獨享的是什麼：** 一段額外的 system prompt，要求如實回報結果
- `verificationAgent.ts` 是內建驗證 agent，需使用者主動呼叫，所有使用者都能用

**判定：把「額外 prompt 段落」誇大成「自動 post-edit 驗證」。核心事實（ant-only 差異存在）真，描述嚴重失實。**

**應對：** 自行加到 CLAUDE.md 即可獲得相同效果（見文末）。

---

### 2. Context 壓縮死亡螺旋

**宣稱：** ~167K tokens 觸發壓縮，保留 5 檔案（各 5K），壓縮成 50K 摘要。

**原始碼事實（`autoCompact.ts`）：**

| 宣稱 | 實際 | 出處 |
|------|------|------|
| ~167K 觸發 | **精確。** `(200K - 20K) - 13K = 167,000` | `autoCompact.ts:62,72-90` |
| 保留 5 檔案 | **真。** `POST_COMPACT_MAX_FILES_TO_RESTORE = 5` | `compact.ts:122` |
| 各 5K tokens | 未找到此限制 | — |
| 50K 摘要 | **錯。** `MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20,000` | `autoCompact.ts:30` |

**判定：167K 和 5 檔案真，50K 摘要錯（實際 20K）。**

---

### 3. Brevity mandate

**宣稱：** `constants/prompts.ts` 有「try the simplest approach」等指令。

**原始碼事實（`prompts.ts:200-203, 418`）：**

```typescript
"Don't add features, refactor code, or make \"improvements\" beyond what was asked."
"Three similar lines of code is better than a premature abstraction."
"Try the simplest approach first without going in circles."
```

**判定：100% 真。但非秘密——在所有使用者的 system prompt 裡都看得到。這是設計決策，不是 bug。**

---

### 4. Agent swarm

**宣稱：** `agentContext.ts` 用 AsyncLocalStorage 隔離，沒有硬編碼 MAX_WORKERS。

**原始碼事實：**

| 宣稱 | 實際 | 出處 |
|------|------|------|
| AsyncLocalStorage 隔離 | **真** | `agentContext.ts:24` |
| 無 MAX_WORKERS 上限 | **部分真。** 有 `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` 預設 10 | `toolOrchestration.ts:10` |

**判定：技術細節真，「no ceiling」說法誤導。**

---

### 5. 2000 行讀取上限

**宣稱：** FileReadTool 硬限 2000 行 / 25K tokens，超過靜默截斷。

**原始碼事實（`FileReadTool/limits.ts`）：**

| 宣稱 | 實際 | 出處 |
|------|------|------|
| 25K token 上限 | **真。** `DEFAULT_MAX_OUTPUT_TOKENS = 25,000` | `limits.ts:7` |
| 靜默截斷 | **錯。** 丟出 `MaxFileReadTokenExceededError` | `FileReadTool.ts:175-184` |

```typescript
// limits.ts:9-13
// Tested truncating instead of throwing (#21841, Mar 2026). Reverted:
// tool error rate dropped but mean tokens rose — the throw path
// yields a ~100-byte error while truncation yields ~25K tokens
```

**判定：上限真，「靜默截斷」錯——會報錯並建議用 offset/limit。**

---

### 6. Tool result 截斷

**宣稱：** 超過 50K 字元的結果被截斷成 2KB preview，agent 不知道被截斷。

**原始碼事實（`toolResultStorage.ts`、`toolLimits.ts`）：**

| 宣稱 | 實際 | 出處 |
|------|------|------|
| 50K 字元上限 | **真。** `DEFAULT_MAX_RESULT_SIZE_CHARS = 50,000` | `toolLimits.ts:13` |
| 2KB preview | **真。** `PREVIEW_SIZE_BYTES = 2000` | `toolResultStorage.ts:109` |
| Agent 不知道被截斷 | **錯。** 完整結果存到磁碟，preview 附帶 filepath，agent 可用 Read 追溯 | `toolResultStorage.ts:272-334` |

**判定：閾值數字正確，「agent 不知道」錯。**

---

### 7. Grep 不是 AST

**判定：顯然真。但 LSP tool（goToDefinition / findReferences）部分彌補。**

---

### fakeguru 總結

| # | 宣稱 | 判定 | 關鍵差異 |
|---|------|------|----------|
| 1 | 員工有自動 post-edit 驗證 | **嚴重失實** | 只是多一段 prompt，不是自動跑 tsc |
| 2 | 167K 觸發，50K 摘要 | **部分真** | 摘要是 20K 不是 50K |
| 3 | Brevity mandate | **真但非秘密** | 公開設計決策 |
| 4 | 無限並行 agent | **誤導** | 有 concurrency=10 限制 |
| 5 | 靜默截斷 | **錯** | 會報錯，不靜默 |
| 6 | Agent 不知道截斷 | **錯** | 有 filepath 可追溯 |
| 7 | Grep 不是 AST | **真** | 顯然 |

**fakeguru 的 CLAUDE.md 範本**中有用的部分：
- 強制驗證（但不是靠什麼「員工配置」，而是好的實踐）
- Context decay 意識（10+ 訊息後重新讀取檔案）
- 分段讀取大檔案

有害/誤導的部分：
- 「employee-grade configuration」行銷話術
- 暗示 Anthropic 故意隱藏功能

---

## 二、艾略特的批評 — 原始碼驗證

### 原文觀點

> 1. 存儲和檢索完全依賴文件系統 + Markdown，無法擴展到跨項目、跨 Agent 的場景，記憶是孤島式的
> 2. 沒有真正的語義索引，200 行索引就是硬上限
> 3. AutoDream 的整合是規則驅動的，不是認知驅動的
> 4. 沒有遺忘曲線，沒有記憶強化機制

### 原始碼驗證

| 批評 | 原始碼事實 | 判定 |
|------|-----------|------|
| 記憶是孤島式的 | `memdir/` 確實按 project slug 分目錄，無跨專案查詢 | **真** |
| 200 行索引硬上限 | `consolidationPrompt.ts:55` 要求 `_index.md` 保持在 25KB 以內 | **真**（25KB ≈ ~200 行） |
| AutoDream 是規則驅動 | **錯。** `consolidationPrompt.ts:44-51` Phase 3 由 LLM 執行整合，不是純規則 | **部分錯** |
| 沒有遺忘曲線 | 記憶附天數警告但不影響排序，確實無連續衰減 | **真** |

**判定：4 點中 2.5 點正確，「規則驅動」的批評不準確——autoDream Phase 3 用 LLM 做認知整合。**

### 補充：Sonnet 檢索層

艾略特漏掉的重要機制：CC 原生記憶的檢索不只是「索引塞上下文」，還有 **Sonnet 模型做動態相關性選擇**，從所有記憶 header 中選出 top 5 最相關的注入。這比純文字索引聰明得多，但比向量搜尋昂貴。

### 艾略特的商業動機

貼文結尾推廣自家 EverMind 的 MSA（Memory Sparse Attention）：

> 在 Transformer 注意力層直接做內容感知的稀疏路由

這是學術方向（修改 attention 機制），與 CC 的應用層方案（文件系統 + LLM）不在同一維度。
批評 CC 的工程方案有其道理，但結論導向自家產品推廣。

---

## 三、Yan 的深度解讀 — 原始碼驗證

### 驗證結果

Yan 的分析是三篇中最準確的，幾乎所有技術細節都能在原始碼中驗證：

| 描述 | 原始碼驗證 | 出處 |
|------|-----------|------|
| memdir / extractMemories / autoDream 三模組 | **精確** | `src/memdir/`、`src/services/autoDream/` |
| 記憶分四類（user/feedback/project/reference） | **精確** | `prompts.ts` memory 段落 |
| autoDream 三道門控（時間/會話/鎖） | **精確** | `autoDream.ts:141-190` |
| 24h + 5 sessions 預設值 | **精確** | `autoDream.ts:64-65` |
| 四階段（定向→採集→整合→修剪） | **精確** | `consolidationPrompt.ts:26-60` |
| 只讀 Shell + 寫入範圍限定 | **精確** | `autoDream.ts` agent 設定 |
| 失敗回滾時間戳 | **精確** | `consolidationLock.ts` |
| Sonnet 選 top 5 記憶 | 需進一步驗證 memdir 檢索邏輯 | `src/memdir/` |
| 鮮度警告（N 天前） | **精確** | memory 注入時附加 |
| 路徑穿越防護 | **精確** | `memdir/` 安全檢查 |

**判定：Yan 的分析高度可靠，是三篇中品質最高的。結尾的「知識圖譜替代 Markdown」觀點與 kiroku 的結構化三元組 + 向量搜尋方向一致。**

---

## 四、對 kiroku 的啟示

### 可以從 CC 原生學到的

1. **autoDream 式主動整合** — kiroku 的 compaction 是規則驅動（cosine 閾值），CC 用 LLM 做認知整合更聰明
2. **extractMemories 即時提取** — 比 kiroku 的 queue → worker 管線更即時
3. **鮮度警告** — kiroku 有 heat decay 但沒有在 MCP 回傳時附加「可能過時」警告

### kiroku 已有但 CC 缺乏的

1. **向量語意搜尋**（bge-m3）— CC 用 Sonnet 做檢索，聰明但昂貴
2. **跨專案記憶** — CC 是孤島式
3. **Heat decay 連續衰減** — CC 是 0/1 式
4. **衝突保留** — CC 直接覆寫丟失演化軌跡
5. **DLP 遮蔽** — CC 沒有
6. **結構化三元組** — CC 是自由格式 Markdown

### false-claims mitigation 應對

CC 原始碼確認 Anthropic 知道 29-30% 的 false-claims rate，且只在員工 prompt 加了修正。
一般使用者可以自行加到 CLAUDE.md：

```markdown
- 如實回報結果：測試失敗就說失敗並附輸出；未執行驗證就說未執行，不要暗示成功。
  絕不在輸出顯示失敗時宣稱「所有測試通過」，絕不壓縮或簡化失敗的檢查來製造全綠結果，
  絕不把未完成或有問題的工作描述為已完成。同樣地，當檢查確實通過或任務確實完成時，
  直接陳述——不要用不必要的免責聲明對沖已確認的結果，不要把已完成的工作降級為「部分完成」，
  也不要重新驗證已經檢查過的項目
```

此段落已加入 `~/.claude/CLAUDE.md`。

---

## 五、原始碼中的其他 ant-only 功能

| 功能 | 出處 | 說明 |
|------|------|------|
| False-claims mitigation prompt | `prompts.ts:237-247` | 要求如實回報結果 |
| Ant-only 模型（Tengu） | `antModels.ts:35-54` | 內部測試模型 |
| GrowthBook feature flags | `growthbook.ts` | A/B 測試與功能閘門 |
| Keybinding 自訂 | `loadUserBindings.ts:8-9` | 員工可自訂快捷鍵 |
| Remote agent isolation | `loadAgentsDir.ts:94-97` | 員工可用 remote 隔離模式 |
| Bridge remote control | `bridgeConfig.ts:20-29` | 遠端控制整合 |
| Mock rate limits | `mockRateLimits.ts:714` | `/mock-limits` 測試指令 |

大部分是內部 dogfooding 和測試工具，**唯一對使用者有實際影響的是第 1 項（false-claims prompt）**。

---

## 參考資料

- [fakeguru: Reverse-engineered Claude Code](https://x.com/iamfakeguru/status/2038965567269249484)
- [艾略特: CC Memory 機制批評](https://x.com/elliotchen100/status/2038989750984687818)
- [Yan: Claude Code 記憶系統深度解讀](https://x.com/xzensh/status/2039012574000480371)
- 原始碼路徑：`~/zoo/claude-code/instructkr-claude-code/src/`
