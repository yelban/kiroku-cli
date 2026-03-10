# Worker File-Level Retry Mechanism

## Problem

Before: `processFile` 任何步驟失敗（DB write, embedding, 檔案操作），
queue file 直接進 `dead-letter/`，該筆對話紀錄永遠不會被處理。

`extractWithRetry` 只保護 LLM extraction 呼叫，其他步驟無重試。

## Solution

失敗時 move back to `incoming/`，記錄 backoff 時間（in-memory Map），
poll 時跳過仍在 backoff 窗口內的檔案。超過 maxAttempts 才進 `dead-letter/`。

## Retry Flow

```
incoming/ ──rename──▶ processing/ ──success──▶ done/
                          │
                       failure
                          │
                     attempt < max?
                      ╱         ╲
                    yes           no
                     │             │
              back to incoming/   dead-letter/
              + backoff delay     + _retryAttempts.delete()
```

## Backoff Schedule (defaults)

| Attempt | Delay | Cumulative |
|---------|-------|------------|
| 1 → 2  | 2s    | 2s         |
| 2 → 3  | 4s    | 6s         |
| 3 → 4  | 8s    | 14s        |
| 4 → 5  | 16s   | 30s        |
| 5       | —     | dead-letter |

Formula: `min(baseDelayMs × 2^(attempt-1), maxDelayMs)`
Config: `worker.retry.{maxAttempts: 5, baseDelayMs: 2000, maxDelayMs: 60000}`

## Implementation Details

- **`_retryAttempts`**: `Map<filename, { count, nextAttemptAfter }>` — in-memory, worker 重啟時歸零（合理：給檔案另一次機會）
- **Extraction job status**: 中間狀態記為 `retrying`，最終失敗記為 `failed`
- **Daily extract count**: 每次 processFile 呼叫都算一次，含重試

## Protected Failure Modes

| 步驟 | 失敗原因 | 重試有效？ |
|------|---------|-----------|
| storeTurn / storeFacts | SQLITE_BUSY, WAL checkpoint | Yes |
| embedTexts | 模型首次載入 OOM, timeout | Maybe |
| storeEmbeddings | vec0 extension 不穩定 | Maybe |
| renameSync | 檔案系統暫時性錯誤 | Yes |
| extractWithRetry 全部失敗 | LLM provider 持續故障 | 可能（provider 恢復後） |

Note: `extractWithRetry` 內部已有獨立的 5 次 LLM 重試。
File-level retry 主要保護 LLM 以外的步驟，實際觸發機率不高，屬防禦性設計。
