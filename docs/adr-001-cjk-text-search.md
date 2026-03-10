# ADR-001: CJK Text Search 分詞策略

Date: 2026-03-06
Status: Accepted

## Context

`memory_search` 有兩條搜尋路徑：

1. **向量搜尋**（主路徑）— bge-m3 embedding + sqlite-vec KNN，原生支援多語言語意
2. **文字搜尋**（fallback）— SQL LIKE 關鍵字匹配，sqlite-vec 不可用時啟用

文字搜尋的 query 需要拆成 keywords 做 LIKE 匹配。英文靠空格自然分詞，但中文沒有空格分隔，例如「吹吹的偏好」是一整個字串。

## Problem

原始實作用 `query.split(/\s+/)` 拆分，中文 query 變成單一 keyword：
```
"吹吹的偏好" → ["%吹吹的偏好%"]  // 完全不匹配任何 fact
```

## Options Considered

### Option 1: 拆字元（最初修復）

```js
[...query] → ["吹", "吹", "的", "偏"]
```

- 優點：零依賴，簡單
- 缺點：「的」匹配幾乎所有中文文字，結果充滿噪音；單字匹配粒度太細

### Option 2: Intl.Segmenter（採用）

```js
new Intl.Segmenter('zh-TW', { granularity: 'word' })
→ ["吹", "吹", "偏好"]  // 「的」被停用詞過濾
```

- 優點：Node 16+ 內建（V8 ICU），零依賴，辨識詞邊界 + 停用詞過濾
- 缺點：ICU 詞典不認專有名詞（「吹吹」拆成兩個「吹」）和部分技術詞（「套件」拆開）
- 實測結果：

| Query | 分詞結果 |
|-------|----------|
| 吹吹的偏好 | `["吹", "吹", "偏好"]` |
| 機器學習模型 | `["機器", "學習", "模型"]` |
| 資料庫設定 | `["資料庫", "設定"]` |
| 套件管理偏好 | `["套", "件", "管理", "偏好"]` |
| 這個專案用什麼模型 | `["這個", "專案", "用", "什麼", "模型"]` |

### Option 3: nodejieba（不採用）

- 優點：詞頻詞典品質最佳，支援自訂詞典，複合詞辨識好（「機器學習」不拆開）
- 缺點：C++ native addon，需編譯（加上 better-sqlite3 + sqlite-vec 已有兩個 native addon）；~20MB 詞典

### Option 4: jieba-wasm（不採用）

- 優點：同 nodejieba 品質，WASM 免編譯
- 缺點：~5MB 額外依賴；分詞品質與 Intl.Segmenter 差距不大

## Decision

採用 **Option 2: Intl.Segmenter + 停用詞過濾**。

理由：
1. **文字搜尋是 fallback 路徑** — 正常情況下走向量搜尋（bge-m3 原生支援中文語意），文字搜尋只在 sqlite-vec 不可用時啟用
2. **零依賴** — 不增加安裝體積和編譯負擔
3. **品質足夠** — 配合 OR 匹配邏輯，即使分詞不完美也能找到相關結果
4. **向量搜尋覆蓋 99% 場景** — 不值得為 1% fallback 增加重依賴

## Implementation

```js
// memory-search.js textSearch()
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f]/;
const STOP_WORDS = new Set(['的', '了', '在', '是', '我', '有', '和', ...]);

let keywords = query.split(/\s+/).filter(Boolean);
if (keywords.length === 1 && CJK_RE.test(keywords[0])) {
  const segmenter = new Intl.Segmenter('zh-TW', { granularity: 'word' });
  keywords = [...segmenter.segment(keywords[0])]
    .filter(s => s.isWordLike && !STOP_WORDS.has(s.segment))
    .map(s => s.segment);
}
```

Keywords 之間用 OR 邏輯連接（任一 keyword 匹配即可），避免分詞不完美導致 AND 條件過嚴。

## Consequences

- 中文 fallback 文字搜尋從完全不可用 → 堪用
- 不需要安裝額外套件
- 如果未來 fallback 路徑使用頻率增加，可升級到 jieba-wasm 而不影響 API
