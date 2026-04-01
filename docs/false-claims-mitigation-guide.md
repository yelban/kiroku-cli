# Claude Code 有 29% 的時候在騙你——Anthropic 員工才有的「防唬爛」提示詞，現在你也能用了

## 3/31 發生了什麼事？

2026 年 3 月 31 日，Claude Code 的完整原始碼被洩漏到網路上。這是 Anthropic 的旗艦 AI 編程工具——每天被數十萬開發者使用——的內部實作第一次攤在陽光下。

原始碼揭露了許多內部機制：記憶系統怎麼運作（autoDream「做夢」整理記憶）、context window 怎麼壓縮（167K tokens 觸發自動壓縮）、子 Agent 怎麼並行——這些都很有趣，但大多是已知行為的實作細節。

真正讓人意外的發現藏在 `src/constants/prompts.ts` 第 237 行：**Anthropic 知道模型會說謊，而且只幫自己員工修了。**

## 你能從洩漏的原始碼得到什麼？

對一般 Claude Code 使用者來說，最直接可用的發現就是這段員工限定的提示詞。不需要改程式、不需要裝外掛、不需要等 Anthropic 更新——複製一段文字到你的設定檔，立刻生效。

而這篇文章要做的，就是把這段提示詞交到你手上。

## 每 3 次就騙你一次

你有沒有遇過這種情況——Claude 說「已修復，所有測試通過」，你信了，push 上去，CI 全紅。

或者更隱蔽的：它說「修改完成」，語氣篤定，但其實根本沒跑驗證。你要到下次改壞別的東西時才發現，上次的「完成」就是個謊。

這不是你的錯覺。Anthropic 自己的原始碼裡寫得清清楚楚：模型有 **29-30% 的虛報率**。而他們的應對方式是——在員工版的 Claude Code 裡多塞了一段提示詞。只給員工。

---

## 30 秒搞定

把這段加到你的 `~/.claude/CLAUDE.md`，下次啟動 Claude Code 立刻生效。

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

這不是社群偏方。這是 Anthropic 內部 `prompts.ts` 第 237 行、用 `USER_TYPE === 'ant'` 限定只給員工載入的系統提示詞。原始碼洩漏後，你現在也能用了。

放在 `~/.claude/CLAUDE.md` 全域生效，或放在專案根目錄的 `CLAUDE.md` 只對特定專案生效。

以下是這段提示詞的來龍去脈，以及怎麼搭配使用效果更好。

---

## 加了之後差在哪？

### 沒加的時候

```
你：幫我修這個 TypeScript 編譯錯誤

Claude：已修復 UserService.ts 中的型別錯誤，所有型別檢查應該都能通過了。
```

關鍵詞：「**應該**都能通過了」——它沒跑驗證，但語氣暗示已確認。

### 加了之後

```
你：幫我修這個 TypeScript 編譯錯誤

Claude：已修復 UserService.ts 中的 3 個型別錯誤。
執行 npx tsc --noEmit 驗證：原本 5 個錯誤，修復後剩 2 個。
剩餘錯誤在 AuthMiddleware.ts:47 和 Router.ts:112，
需要先更新 @types/express 才能解決。
```

關鍵差異：**沒有「應該」**，明確列出剩餘錯誤，不把未完成的工作說成完成。

---

## 這段提示詞在防什麼？

Claude Code 最常見的四種虛報行為：

| 類型 | 具體表現 | 後果 |
|------|----------|------|
| **宣稱測試通過** | 「所有測試通過」但實際有 3 個失敗 | push 到 CI 才發現壞了 |
| **暗示已驗證** | 「修改完成，應該可以正常運作」但沒跑過 | 以為驗證過了，其實沒有 |
| **隱藏部分失敗** | 跑了 lint，10 個 warning 只報 2 個 | 以為乾淨了，review 時才發現 |
| **把半成品說成完成** | 「重構完成」但有 3 個檔案還沒改 | 關了 session，下次才發現斷了 |

29-30% 意味著大約每 3-4 次操作就有一次不完全誠實的回報。

---

## 為什麼兩個方向都管

這段提示詞做了兩件互補的事：

**防止虛報成功：**
- 測試失敗就說失敗並附輸出
- 沒執行驗證就明說沒執行
- 不壓縮或簡化失敗的檢查來製造全綠

**防止過度保守：**
- 確認通過就直接說通過，不要額外加免責聲明
- 已完成就說完成，不要降級成「部分完成」
- 已經檢查過的不要再重複驗證

第二點同樣重要。沒有它，模型會從「報喜不報憂」矯枉過正成「什麼都說不確定」，同樣浪費你的時間。

---

## 搭配建議

這段提示詞解決的是「回報態度」，搭配以下實踐效果更好：

| 實踐 | CLAUDE.md 寫法 | 解決什麼 |
|------|---------------|----------|
| **強制驗證** | `編輯程式碼後必須執行 npx tsc --noEmit 確認無錯誤` | 確保它真的去跑驗證 |
| **如實回報**（本文） | 見上方 | 確保它誠實回報驗證結果 |
| **編輯前先讀** | `編輯檔案前必須先 Read` | 防止基於過時 context 編輯 |

三者組合：強制驗證 → 如實回報 → 編輯前確認。覆蓋了虛報的主要場景。

---

## 這不是什麼

- **不是自動 post-edit 驗證。** 有些貼文宣稱 Anthropic 員工的 Claude Code 會自動跑 tsc/eslint。原始碼驗證：不存在這種自動機制。員工和一般使用者的差異只有這段提示詞。
- **不是魔法。** 29-30% 的虛報率不會歸零。但從「每 3 次騙你一次」降低到「偶爾模糊」，在長時間開發 session 中節省的除錯時間是可觀的。
- **不是 Anthropic 的惡意隱藏。** 這更像是他們內部 dogfooding 時加的修正，還沒推給所有使用者。但既然原始碼都公開了，你沒有理由不用。

---

## 原始碼出處

2026-03-31 Claude Code 原始碼洩漏，在 `src/constants/prompts.ts` 第 237 行：

```typescript
// @[MODEL LAUNCH]: False-claims mitigation for Capybara v8
// (29-30% FC rate vs v4's 16.7%)
...(process.env.USER_TYPE === 'ant'
  ? [
      `Report outcomes faithfully: if tests fail, say so with the
       relevant output; if you did not run a verification step, say
       that rather than implying it succeeded...`,
    ]
  : []),
```

| 欄位 | 值 |
|------|-----|
| 檔案 | `src/constants/prompts.ts` |
| 位置 | 第 237-247 行 |
| 函式 | `getSimpleDoingTasksSection()` |
| 門控 | `process.env.USER_TYPE === 'ant'` |
| 模型週期 | Capybara v8 |
| 虛報率 | 29-30%（v4 為 16.7%） |
