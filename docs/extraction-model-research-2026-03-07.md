# Extraction Model Research

Date: 2026-03-07
Test input: 中文混合（偏好 + 個人資訊 + 技術選型）

## Context

M2 整合測試發現 LLM 萃取品質問題（email 遺漏、entity 命名太籠統、entity_type 錯誤）。
改進 `prompts/extraction.md` 後，在 OpenRouter 上測試多個模型的萃取品質與成本效益。

### Prompt 改動摘要

1. 移除 markdown code fences（`` ```json ``），避免模型混淆（Haiku 會只輸出前言就停止）
2. 開頭加「Respond with ONLY the JSON object」
3. 新增 Rules 10-12（user entity、subject 匹配、topic vs project）
4. 新增 2 組 few-shot 範例（INPUT/OUTPUT 格式，JSON 不換行）
5. Scope 區段補充 personal info 類型列表

---

## Scoring Criteria

### Basic (9 pts)

| Check | Points | Description |
|-------|--------|-------------|
| Email extracted | 2 | `test@example.com` 出現在某個 fact |
| Email scope=global | 1 | Email fact 的 scope 為 global |
| "user" entity (person) | 2 | 存在 canonical_name="user", entity_type="person" |
| bun entity_type=topic | 1 | bun 不是 "project" |
| PostgreSQL entity_type=topic | 1 | PostgreSQL 不是 "project" |
| Subjects are specific | 1 | fact.subject 不全是 "project" |
| subject matches entity | 1 | 每個 fact.subject 都對應某個 entity 的 canonical_name |

### Advanced (7 pts)

| Check | Points | Description |
|-------|--------|-------------|
| bun preference scope=global | 1 | 使用者偏好應為 global |
| All fact_types correct | 1 | email→preference, preference→preference, tech→semantic |
| Entity count 3-5 (no bloat) | 1 | 不過度建立冗餘 entity |
| npm entity=topic | 1 | 被否定的工具也應提取為 entity |
| PostgreSQL fact scope=project | 1 | 專案技術選型應為 project |
| Email fact_type=preference | 1 | 個人資訊的 fact_type |
| Fact count 2-4 | 1 | 不過多不過少 |

**Total: 16 pts**

---

## Round 1: Free Models

| Model | Score | Latency | Cost | Notes |
|-------|-------|---------|------|-------|
| mistralai/mistral-small-3.1-24b-instruct:free | 9/9* | 2.3s | $0 | bun scope=project ❌ |
| qwen/qwen3-next-80b-a3b-instruct:free | 9/9* | 6.1s | $0 | 品質=Haiku |
| nousresearch/hermes-3-llama-3.1-405b:free | 9/9* | 10.6s | $0 | 品質好但慢 |
| nvidia/nemotron-nano-9b-v2:free | 9/9* | 12.3s | $0 | 多冗餘 fact |
| z-ai/glm-4.5-air:free | 9/9* | 42s | $0 | 太慢 |
| qwen/qwen3-coder:free | — | — | $0 | 429 rate-limited |
| meta-llama/llama-3.3-70b-instruct:free | — | — | $0 | 429 rate-limited |
| google/gemma-3-27b-it:free | — | — | $0 | 429 rate-limited |

*Round 1 使用 basic scoring (max 9)

**Free tier 限制**: 50 req/day, 20 req/min（無餘額），不適合生產用途。

---

## Round 2: Paid Models (cheaper than Haiku, basic scoring)

| Model | Score | Latency | $/call | vs Haiku | Notes |
|-------|-------|---------|--------|----------|-------|
| google/gemini-2.0-flash-001 | 9/9 | 1.8s | $0.00020 | 8.8x cheaper | 4 clean entities |
| openai/gpt-4.1-nano | 9/9 | 1.7s | $0.00017 | 10x cheaper | email 多建 entity |
| google/gemini-2.5-flash-lite | 9/9 | 2.7s | $0.00025 | 7.2x cheaper | fact_type: task ❌ |
| google/gemma-3-27b-it | 9/9 | 4.6s | $0.00017 | 10.7x cheaper | 便宜但慢 |
| openai/gpt-4o-mini | 9/9 | 3.0s | $0.00027 | 6.6x cheaper | |
| meta-llama/llama-4-scout | 8/9 | 4.4s | $0.00018 | 9.7x cheaper | subject match ❌ |
| deepseek/deepseek-chat-v3.1 | 9/9 | 14.4s | $0.00038 | 4.6x cheaper | 太慢 |

---

## Round 3: Cross-Tier Enhanced Scoring (16 pts)

**Key finding: prompt 品質決定一切。** 從 $0.00017 到 $0.00881 的模型，只要 prompt 夠好，品質幾乎一樣。

### Full Ranking

| Rank | Model | Score | Latency | $/call | vs Haiku | Notes |
|------|-------|-------|---------|--------|----------|-------|
| 1 | **openai/gpt-4.1-nano** | **16/16** | **1.6s** | **$0.00017** | **10x cheaper** | ★ Best value |
| 2 | **google/gemini-2.0-flash-001** | **16/16** | **1.9s** | **$0.00020** | **8.8x cheaper** | ★ Cleanest output |
| 3 | google/gemini-2.5-flash | 16/16 | 1.9s | $0.00074 | 2.4x cheaper | |
| 4 | google/gemini-3.1-flash-lite-preview | 16/16 | 2.3s | $0.00078 | 2.3x cheaper | preview |
| 5 | google/gemini-3-flash-preview | 16/16 | 3.6s | $0.00157 | 1.1x cheaper | preview |
| 6 | anthropic/claude-3.5-haiku | 16/16 | 3.8s | $0.00172 | baseline | 現行 |
| 7 | openai/gpt-5-mini | 16/16 | **19.9s** | $0.00247 | 1.4x 貴 | 太慢 |
| 8 | anthropic/claude-haiku-4.5 | 16/16 | 2.5s | $0.00296 | 1.7x 貴 | 無額外優勢 |
| 9 | openai/gpt-4.1 | 16/16 | 2.2s | $0.00359 | 2.0x 貴 | 大材小用 |
| 10 | anthropic/claude-sonnet-4.6 | 16/16 | 4.4s | $0.00881 | 5.1x 貴 | 大材小用 |
| 11 | deepcogito/cogito-v2.1-671b | 15/16 | 5.0s | $0.00174 | ≈同價 | bun scope ❌ |
| 12 | qwen/qwen3-max | 15/16 | 11.0s | $0.00321 | 1.9x 貴 | bun 拆成兩個 fact |
| 13 | openai/o4-mini | 15/16 | 8.0s | $0.00509 | 3.0x 貴 | reasoning 模型反而差 |
| 14 | google/gemini-2.5-pro | **0/16** | 13.2s | $0.01331 | 7.7x 貴 | parse fail |

### Output Samples (16/16 models)

**gpt-4.1-nano ($0.00017)** — 最便宜滿分
```
entities: user(person), bun(topic), npm(topic), PostgreSQL(topic), test@example.com(file)
facts:
  user prefers package manager → bun over npm [global/preference]
  user uses database → PostgreSQL [project/semantic]
  user has email → test@example.com [global/preference]
```
Note: email 多建一個 file entity（無害）

**gemini-2.0-flash ($0.00020)** — 最乾淨
```
entities: user(person), bun(topic), npm(topic), PostgreSQL(topic)
facts:
  user prefers package manager → bun over npm [global/preference]
  PostgreSQL is used as → database [project/semantic]
  user has email → test@example.com [global/preference]
```
完美 4 entities, 3 facts，無冗餘。

**claude-sonnet-4.6 ($0.00881)** — 最貴滿分，品質相同
```
entities: user(person), bun(topic), npm(topic), PostgreSQL(topic)
facts:
  user prefers package manager → bun over npm [global/preference]
  user has email → test@example.com [global/preference]
  PostgreSQL is used as → project database [project/semantic]
```

---

## Key Insights

### 1. Prompt > Model

改進後的 prompt 讓 $0.00017 的模型達到 16/16 滿分——和 $0.00881 的 Sonnet 4.6 完全一樣。
**花 50 倍的錢不會得到更好的萃取品質。**

### 2. 更貴不一定更好

| Model | Price | Score | 觀察 |
|-------|-------|-------|------|
| o4-mini (reasoning) | $0.00509 | 15/16 | reasoning token 浪費在簡單任務上，scope 反而出錯 |
| gemini-2.5-pro | $0.01331 | 0/16 | 完全失敗，可能回傳 thinking 格式 |
| qwen3-max | $0.00321 | 15/16 | 把 bun preference 拆成 task 而非 preference |

### 3. 速度與成本的 Pareto 前沿

```
                    Cost $/call
        $0        $0.001      $0.002      $0.005      $0.01
  16 ── ●nano     ●flash ●2.5f ●haiku ●4.1  ●gpt5m  ●4.5h  ●son4.6
        $0.00017  $0.00020     $0.00172         $0.00881
  15 ──                        ●cogito        ●o4m ●qwen-max
   0 ──                                              ●gem2.5pro
```

Pareto optimal: **gpt-4.1-nano → gemini-2.0-flash → gemini-2.5-flash**
超過 $0.00074 之後，花更多錢完全無收益。

---

## Recommendations

### Primary: `google/gemini-2.0-flash-001`

- **8.8x cheaper**, **2x faster**, 品質完全一致
- 最乾淨的輸出（4 entities, 3 facts, 無冗餘）
- 1M context, 非 preview, 穩定
- 為何選它而非 gpt-4.1-nano: nano 會多建一個冗餘 email entity

### Runner-up: `openai/gpt-4.1-nano`

- **10x cheaper**, **最快** (1.6s)
- 唯一瑕疵: email 多建為 file entity（不影響功能但不夠乾淨）
- 適合 cost-sensitive 場景

### Free fallback: `qwen/qwen3-next-80b-a3b-instruct:free`

- $0/call, 品質與 Haiku 一致
- Free tier 限制嚴格，僅作備用

### 不建議升級到更貴的模型

- Claude Haiku 4.5 ($0.0030): 1.7x 貴，品質無提升
- GPT-4.1 ($0.0036): 2x 貴，品質無提升
- O4-mini ($0.0051): 3x 貴，品質反而下降
- Sonnet 4.6 ($0.0088): 5x 貴，品質無提升

---

## Config Change Suggestion

```jsonc
// ~/.kiroku/config.json → worker.extraction
{
  "provider": "openrouter",
  "model": "google/gemini-2.0-flash-001",   // was: anthropic/claude-3.5-haiku
  "apiKeyEnv": "OPENROUTER_API_KEY",
  "temperature": 0,
  "maxOutputTokens": 1200,
  "fallback": {
    "provider": "ollama",
    "model": "qwen2.5:14b-instruct-q4_K_M",
    "baseUrl": "http://127.0.0.1:11434"
  }
}
```

Expected savings: **~88% reduction** in extraction API cost ($0.00172 → $0.00020 per call).

---

## Automated Testing

**Decision: No CI automation.** Reasons:

1. LLM output is non-deterministic — same prompt may yield slightly different JSON
2. Free models have unstable rate limits → flaky CI
3. Testing prompt quality, not code logic
4. Each call has real API cost

**Recommendation**: Keep a manual verification script for prompt iteration.
