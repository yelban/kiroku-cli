# Kiroku 記憶域

Kiroku 為 Claude Code 提供跨 session 的長期記憶：從對話中抽取事實、管理其生命週期（含遺忘）、並在檢索與注入時反映「現在的」專案狀態。

## Language

### 記憶單元

**Fact（事實）**:
一條 SPO 三元組（subject–predicate–object）形式的記憶單元，帶 fact_type（semantic/episodic/preference/task/state）、scope（project/global）與生命週期狀態。
_Avoid_: memory、record、知識條目

**Entity（實體）**:
事實的主詞所指向的具名對象（人、專案、工具、檔案、概念），具 canonical name 與 aliases。

### 生命週期

**Supersede（讓位）**:
新事實使同主題的舊事實退出「現行狀態」但保留於歷史。適用於被新版本取代的決策與資訊。
_Avoid_: 覆蓋、刪除

**Archive（結案）**:
事實被終結而非被取代——修掉的 bug、完成的 task。與 Supersede 的差異在語意：結案沒有「新版本」。

**Semantic Supersede（語意讓位）**:
以 embedding 相似度而非字串精確匹配判定新舊事實同主題的讓位機制。

**Replacement Signal（取代信號）**:
放行語意讓位的守門條件：目標為易變型別、謂詞相同、或文字帶取代線索（含中英文 cue）。缺少信號時高相似度也不讓位——防止互補事實被誤殺。

**Heat（熱度）**:
事實的活性分數，隨存取增溫、隨時間依型別半衰期衰減；影響檢索排序與注入選取。

### 記憶操作（M3 定案）

**Memory Operation（記憶操作）**:
Extraction 對每條事實標注的變異意圖，詞彙表固定四種：`add`（新知，缺省）、`update`（修訂既有認知）、`delete`（宣告失效：移除、修復、不再成立）、`move`（實體遷移：檔案搬移、改名）。
_Avoid_: mutation、action、verb

**Move Operation（遷移操作）**:
攜帶 from/to 的記憶操作——不可用 delete+add 替代，因為它保存新舊實體的同一性（alias 連結與讓位鏈依賴它）。

**Confidence Gate（信心閘）**:
失效類操作（delete/move）連動處置的執行門檻：低於閘值的失效宣告仍存為事實，但不觸動既有事實。寧漏殺不誤殺。

**操作與生命週期的對應**:
`update` 使目標讓位（Supersede——有新版本）；`delete` 使目標結案（Archive——失效是終結）；`move` 使舊實體路徑事實讓位並將身分併入新實體。

### 品質量尺

**mini-FAMA（記憶品質考卷）**:
內建的確定性迴歸測驗，依 Memora 論文指標計分：MPA（該出現的有出現）、FAA（該忘的有忘掉）、FAMA（綜合，罰用舊）。
_Avoid_: benchmark（泛稱時）
