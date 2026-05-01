# Support Ticket Draft — Haiku 4.5 prompt caching not working

> 直接複製下面 Body 段提交到 https://console.anthropic.com/support （或寄到 `support@anthropic.com`）。改成你自己的語氣、補上你的 organization id（在 console / Settings 看得到）後送出。

---

## Subject

Prompt caching `cache_control: ephemeral` has no effect on `claude-haiku-4-5-20251001` (cache_creation_input_tokens + cache_read_input_tokens both stay 0)

---

## Body

Hi Anthropic team,

I think Haiku 4.5 may have a prompt-caching regression — `cache_control: ephemeral` produces no `cache_creation_input_tokens` and no `cache_read_input_tokens` on either OAuth Max or pure API key authentication. The same exact request shape against `claude-sonnet-4-6` caches normally.

### Reproduction

3 sequential identical-prompt calls per model, single API key (`sk-ant-api03-…`), `x-api-key` header, `anthropic-version: 2023-06-01`. System prompt is ~3.4k tokens with `cache_control: { type: "ephemeral" }` on the trailing block. User message changes only by `(call #N)` to dodge full-response caching but keep the system block identical for all calls.

```http
POST https://api.anthropic.com/v1/messages
x-api-key: sk-ant-api03-…
anthropic-version: 2023-06-01
content-type: application/json

{
  "model": "<MODEL>",
  "max_tokens": 200,
  "system": [
    { "type": "text", "text": "<~3.4k token extraction prompt>",
      "cache_control": { "type": "ephemeral" } }
  ],
  "messages": [{ "role": "user", "content": "Extract: bun (call #N)" }]
}
```

### Observed (2026-05-01, sequential calls, ~1s apart)

| Model | call | request_id | input_tokens | cache_creation | cache_read |
|---|---|---|---|---|---|
| `claude-haiku-4-5-20251001` | 1 | `msg_017eXmx1bf8abCFMjwsMzFUK` | 3406 | **0** | **0** |
| `claude-haiku-4-5-20251001` | 2 | `msg_017v38JKNv1dS3WsgEtxoiTr` | 3406 | **0** | **0** |
| `claude-haiku-4-5-20251001` | 3 | `msg_01PU5KJkdccuXjsY1i3ePjhB` | 3406 | **0** | **0** |
| `claude-sonnet-4-6` | 1 | `msg_01GtE8tLiH71ZPvJJchTJsyY` | 14 | **3393** | 0 |
| `claude-sonnet-4-6` | 2 | `msg_01WsNUof4kgBq1XCQxhED3hk` | 14 | 0 | **3393** |
| `claude-sonnet-4-6` | 3 | `msg_018FajLMiionxknTURdbX5Lz` | 14 | 0 | **3393** |

Sonnet writes cache on call 1 and reads cache on calls 2 and 3, exactly as documented. Haiku 4.5 silently ignores the `cache_control` block — neither writing nor reading, every call paying full input.

We also reproduced this earlier on the OAuth Max code path (`Authorization: Bearer sk-ant-oat-…` + `claude-code-20250219,oauth-2025-04-20` beta header), with the same outcome on Haiku 4.5 and the same correct caching on Sonnet 4.6.

### Expected

`cache_creation_input_tokens` ~= 3393 on call 1 and `cache_read_input_tokens` ~= 3393 on calls 2-3 of Haiku 4.5, matching Sonnet 4.6's behavior.

### Why this matters for us

Our extraction worker batches conversation turns through both models depending on configuration. Haiku 4.5 was the cheaper-per-token choice on paper, but without caching its effective monthly cost is ~$10.8 vs Sonnet 4.6's ~$7.8 at 100 turns/day. We've had to default the worker to Sonnet 4.6 + cache as a result.

### Questions

1. Is prompt caching expected to work on `claude-haiku-4-5-20251001`? The [docs](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching) list "Haiku 4.5" as supported.
2. If it's intentionally disabled (model-specific limitation, beta gate, account tier), is there documentation we missed?
3. If it's a regression, any ETA on a fix?

Happy to share more `request_id`s, full request bodies, or a minimal reproduction script.

Thanks!

---

## 提交後追蹤事項

1. 收到 ticket id 後在這個檔案寫一行紀錄
2. 如果 Anthropic 回 by-design：把那段答覆貼進 `docs/release-and-install-guide.md` 的「已知陷阱」段
3. 如果 Anthropic 回 fixed：跑這個 script 重驗：
   ```bash
   python3 /tmp/extraction-ab-apikey.py   # 再看一次 cache_creation / cache_read
   ```
   如果 Haiku 開始 cache → 取消 1.7.7 對 Haiku 的「不要用」結論、考慮把 mode subscription 改回 Haiku 4.5 (cheaper baseline)
