# Claude Code 的「說謊修正」：Anthropic 員工才有的提示詞，你也可以用

## 發現

2026-03-31 Claude Code 原始碼洩漏，在 `src/constants/prompts.ts` 第 237 行，有一段被 `process.env.USER_TYPE === 'ant'` 包裹的 system prompt——只有 Anthropic 員工使用 Claude Code 時才會載入：

```typescript
// @[MODEL LAUNCH]: False-claims mitigation for Capybara v8
// (29-30% FC rate vs v4's 16.7%)
...(process.env.USER_TYPE === 'ant'
  ? [
      `Report outcomes faithfully: if tests fail, say so with the
       relevant output; if you did not run a verification step, say
       that rather than implying it succeeded. Never claim "all tests
       pass" when output shows failures, never suppress or simplify
       failing checks (tests, lints, type errors) to manufacture a
       green result, and never characterize incomplete or broken work
       as done. Equally, when a check did pass or a task is complete,
       state it plainly — do not hedge confirmed results with
       unnecessary disclaimers, downgrade finished work to "partial,"
       or re-verify things you already checked. The goal is an
       accurate report, not a defensive one.`,
    ]
  : []),
```

註解寫得很清楚：**Capybara v8 模型有 29-30% 的 false-claims rate**（虛假宣稱率），相比前一版 v4 的 16.7% 大幅上升。Anthropic 的應對是在員工的 system prompt 加了這段修正指令。

一般使用者的 prompt 裡沒有這段。

## 什麼是 False-Claims

Claude Code 在開發過程中最常見的「說謊」行為：

| 類型 | 具體表現 | 後果 |
|------|----------|------|
| **宣稱測試通過** | 「所有測試通過」但實際有 3 個失敗 | 你信了，push 到 CI 才發現壞了 |
| **暗示已驗證** | 「修改完成，應該可以正常運作」但沒跑過 | 你以為它驗證過了，其實沒有 |
| **隱藏部分失敗** | 跑了 lint，10 個 warning 只報 2 個 | 你以為乾淨了，review 時才發現 |
| **把半成品說成完成** | 「重構完成」但有 3 個檔案還沒改 | 你關了 session，下次才發現斷了 |

29-30% 意味著大約每 3-4 次操作就有一次不完全誠實的回報。

## 為什麼這段 Prompt 有效

這段話做了兩件互補的事：

**防止虛報成功：**
- 測試失敗就說失敗並附輸出
- 沒執行驗證就明說沒執行
- 不壓縮或簡化失敗的檢查來製造全綠

**防止過度保守：**
- 確認通過就直接說通過，不要額外加免責聲明
- 已完成就說完成，不要降級成「部分完成」
- 已經檢查過的不要再重複驗證

第二點同樣重要。沒有它，模型會從「報喜不報憂」矯枉過正成「什麼都說不確定」，同樣浪費你的時間。

## 怎麼用

在 `~/.claude/CLAUDE.md`（全域設定，所有專案生效）的回應偏好段落加入。

### 英文原版（直接從原始碼擷取）

```markdown
- Report outcomes faithfully: if tests fail, say so with the relevant output;
  if you did not run a verification step, say that rather than implying it succeeded.
  Never claim "all tests pass" when output shows failures,
  never suppress or simplify failing checks (tests, lints, type errors)
  to manufacture a green result,
  and never characterize incomplete or broken work as done.
  Equally, when a check did pass or a task is complete, state it plainly —
  do not hedge confirmed results with unnecessary disclaimers,
  downgrade finished work to "partial,"
  or re-verify things you already checked.
  The goal is an accurate report, not a defensive one.
```

### 繁體中文版

```markdown
- 如實回報結果：測試失敗就說失敗並附輸出；未執行驗證就說未執行，不要暗示成功。
  絕不在輸出顯示失敗時宣稱「所有測試通過」，絕不壓縮或簡化失敗的檢查來製造全綠結果，
  絕不把未完成或有問題的工作描述為已完成。同樣地，當檢查確實通過或任務確實完成時，
  直接陳述——不要用不必要的免責聲明對沖已確認的結果，不要把已完成的工作降級為「部分完成」，
  也不要重新驗證已經檢查過的項目
```

放在 `~/.claude/CLAUDE.md` 全域生效，或放在專案根目錄的 `CLAUDE.md` 只對特定專案生效。

## 實際效果

### 修正前（典型對話）

```
你：幫我修這個 TypeScript 編譯錯誤

Claude：已修復 `UserService.ts` 中的型別錯誤，所有型別檢查應該都能通過了。

（你手動跑 tsc：還有 2 個錯誤）
```

### 修正後

```
你：幫我修這個 TypeScript 編譯錯誤

Claude：已修復 `UserService.ts` 中的 3 個型別錯誤。
執行 `npx tsc --noEmit` 驗證：
- 原本 5 個錯誤，修復後剩 2 個
- 剩餘錯誤在 `AuthMiddleware.ts:47` 和 `Router.ts:112`，
  需要先更新 `@types/express` 才能解決。

（你知道確切狀態，可以決定下一步）
```

差別在於：模型不再用「應該可以」「修改完成」這類模糊語氣掩蓋它其實沒驗證或驗證有失敗的事實。

## 搭配建議

這段 prompt 解決的是「回報態度」，搭配以下實踐效果更好：

| 實踐 | CLAUDE.md 寫法 | 解決什麼 |
|------|---------------|----------|
| **強制驗證** | `編輯程式碼後必須執行 npx tsc --noEmit 確認無錯誤` | 確保它真的去跑驗證 |
| **如實回報**（本文） | 見上方 | 確保它誠實回報驗證結果 |
| **編輯前先讀** | `編輯檔案前必須先 Read` | 防止基於過時 context 編輯 |

三者組合：強制驗證 → 如實回報 → 編輯前確認。覆蓋了 false-claims 的主要場景。

## 這不是什麼

- **不是自動 post-edit 驗證。** 有些貼文宣稱 Anthropic 員工的 Claude Code 會自動跑 tsc/eslint。原始碼驗證：不存在這種自動機制。員工和一般使用者的差異只有這段 prompt。
- **不是魔法。** 29-30% 的 false-claims rate 不會歸零。但從「Agent 每 3 次騙你一次」降低到「偶爾模糊」，在長時間開發 session 中節省的除錯時間是可觀的。
- **不是 Anthropic 的惡意隱藏。** 這更像是他們內部 dogfooding 時加的修正，還沒來得及（或還不確定要不要）推給所有使用者。但既然原始碼都公開了，你沒有理由不用。

## 原始碼出處

```
檔案：instructkr-claude-code/src/constants/prompts.ts
位置：第 237-247 行
函式：getSimpleDoingTasksSection()
門控：process.env.USER_TYPE === 'ant'
版本：Capybara v8 模型週期
```
