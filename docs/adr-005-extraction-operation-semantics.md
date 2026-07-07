# ADR-005: Extraction 操作語意（operation: add|update|delete|move）

## 背景

M2 的寫入時語意 supersede（ADR 級決策見 issue #8）實測揭露兩個結構性極限：移除類事實與被否定事實**共享 object**（「object 不同」前提抓不到，實測 cosine 0.842）；檔案搬移**改變 subject entity**（同 subject gate 擋下，實測 cosine 0.867）。語意相似度無法區分「換個說法」與「宣告失效」——mini-FAMA 的 FAA 卡在 0.667。唯一的出路是讓 extraction 在來源處標注**變異意圖**。

## 決策

1. **四操作詞彙表**：`add`（缺省）/ `update` / `delete` / `move`。不採三操作（move 拆成 delete+add 會丟失新舊實體同一性）；不採更細分（complete/resolve 在處置端與 delete 同路，徒增 LLM 誤標面——M1 謂詞教訓）。
2. **目標定位採混合式**：add/update/delete 只帶 `operation` 標籤、事實本身即載荷，目標由 store 端以 M2 resolver 解析（操作標籤放寬守門：免除 same-object 擋板、標籤即 replacement signal）；**唯 `move` 帶 `{from, to}`**（同一性資訊不存在於單條事實內）。不採完整目標描述子（表達力溢價換 LLM 誤填風險）。
3. **處置對應**：`update` → `superseded`（有新版本）；`delete` → `archived`（失效是終結）；`move` → from 實體路徑事實 `superseded` ＋ alias 併入 to 實體。
4. **信心閘**：delete/move 的連動處置要求 confidence ≥ 0.8；低於閘值只存事實不觸動既有事實（audit 記 skipped）。永不硬刪——處置一律是可逆的 status 變更。
5. **部署採加法 schema、免版本閘**：已實證雙向容忍（parseExtractionResult 透傳、storeFacts 只讀已知鍵）。順序：CLI 先行（容忍 parser＋新本地 prompt）→ 手動更新遠端 slot 啟動。不採 slot 版本閘（為不存在的不相容問題付維護成本）；不採 flag-day（無謂耦合兩個部署面）。
6. **三份 prompt 全同步**（batch／單 turn／basic）：免費層無 embedding 時目標解析自然降級為精確匹配（漏殺不誤殺），schema 不分岔。
7. **硬驗收**：操作是確定性機制（非 M2 的經驗性 cosine），考題④⑤必須翻綠——FAA → 1.0、FAMA → 1.0。**考卷就此飽和**：M4 起頭需擴考卷，滿分不得誤讀為「記憶品質做完了」。

（2026-07-07 grill-with-docs session 定案；術語見 CONTEXT.md「記憶操作」節。）
