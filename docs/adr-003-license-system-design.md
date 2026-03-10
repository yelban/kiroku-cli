# ADR-003: License System Design — Ed25519 Machine-Bound Verification

Date: 2026-03-06
Status: Phase 1 Implemented (2026-03-07)

---

## Context

Kiroku V15 需要授權機制保護商業利益。已有基礎設施：
- `src/license/verify.js` — Ed25519 簽名驗證
- `src/license/machine-id.js` — 機器指紋（目前用 MAC address）
- `scripts/gen-keypair.js` — 離線金鑰對產生
- `scripts/sign-license.js` — 離線授權簽發

本 ADR 記錄五個架構決策的分析與結論。

---

## Decision 1: 強制 vs 選擇性 → Freemium

### 分析

| 方案 | 摩擦 | 收入 | 採用率 |
|------|------|------|--------|
| 強制（啟動時檢查，無 license 不能用） | 高 | Day 1 | 低 |
| 選擇性（目前：完全不檢查） | 零 | 零 | 高 |
| **Freemium（核心可用，進階需授權）** | **低** | **漸進** | **高** |

### 決定

採用 **Freemium** 模式：

- **無 license** → 核心功能正常運作，但有限制：
  - Facts 上限 500 筆（達到後新 fact 覆寫最舊的）
  - 不產生 embedding（向量搜尋不可用，只有文字搜尋）
  - 每日萃取上限（例如 50 次）
  - 啟動時顯示 gentle reminder，不阻擋
- **有 license** → 解除所有限制

### Rationale

- 零摩擦試用讓使用者感受到價值
- 限制選在「進階功能」而非「基本功能」，不會讓試用體驗變差
- `kiroku doctor` 和啟動時顯示授權狀態和 machine-id，引導購買
- 不阻擋啟動 = 不會因為 license 過期導致使用者無法工作

### 限制的具體實作位置

| 限制 | 檢查位置 |
|------|---------|
| Facts 上限 | `store.js` — `storeFacts()` 和 `saveFactManually()` |
| Embedding 停用 | `worker.js` — 跳過 `storeEmbeddings()` |
| 每日萃取上限 | `worker.js` — 計數器 + 日期重置 |
| Gentle reminder | `bin/kiroku.js` — `cmdStart()` 開頭 |

---

## Decision 2: Public Key 發佈方式 → 嵌入 Source Code

### 選項比較

| 方案 | 優點 | 缺點 |
|------|------|------|
| 檔案：`~/.kiroku/license/public.pem` | 可替換 | 使用者可能誤刪；需要安裝腳本管理 |
| 下載：`kiroku init` 從遠端下載 | 可更新 | 離線不可用；多一個網路依賴 |
| **嵌入：常數寫在 `verify.js`** | **零管理、不可誤刪、npm install 即帶** | 更換需發新版 |

### 決定

**嵌入 source code**。Ed25519 public key 只有 4 行 PEM：

```js
// verify.js
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA...（44 chars）
-----END PUBLIC KEY-----`;
```

### Rationale

- Public key 本來就是公開的，嵌入 source 無安全疑慮
- 減少一個檔案管理點 — `~/.kiroku/license/` 只需放 `license.dat`
- Key rotation 頻率極低（可能永不更換），嵌入成本可接受
- 如果未來需要 rotation，可改為嵌入多把 key + key ID 機制

### 移除項目

- 不再需要 `~/.kiroku/license/public.pem`
- `paths.js` 中 `LICENSE_DIR` 保留（仍存放 `license.dat`）
- 安裝流程少一個步驟

---

## Decision 3: 跨平台穩定機器指紋 → OS-Provided Machine ID

### 現有問題

目前使用 `MAC address + arch + platform`：
- MAC address 因 VPN、Docker、VM 虛擬網卡而不穩定
- 網卡排序在不同 boot 可能改變
- 部分雲端 VM 無固定 MAC

### 跨平台方案

| OS | 來源 | 指令 | 穩定性 |
|----|------|------|--------|
| **macOS** | IOPlatformSerialNumber | `ioreg -rd1 -c IOPlatformExpertDevice \| awk '/IOPlatformSerialNumber/{print $4}' \| tr -d '"'` | 硬體序號，永不變 |
| **Linux** | systemd machine-id | `cat /etc/machine-id` | 重裝才變 |
| **Windows** | MachineGuid | `reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid` | 重裝才變 |
| **Fallback** | hostname + cpus[0].model + totalmem + arch | Node.js `os` module | 堪用但不穩定 |

### 決定

優先順序：
1. 嘗試 OS-specific machine ID（上表）
2. Fallback 到 `hostname + cpus[0].model + totalmem + arch`
3. 最後 fallback 到 MAC address（現有邏輯）

所有來源統一 → `SHA256 → 16 char hex uppercase`，格式不變。

### 實作

```js
// machine-id.js
async function getOsMachineId() {
  switch (platform()) {
    case 'darwin':
      return execSync('ioreg -rd1 -c IOPlatformExpertDevice')
        .match(/IOPlatformSerialNumber.*?"(.+?)"/)?.[1];
    case 'linux':
      return readFileSync('/etc/machine-id', 'utf8').trim();
    case 'win32':
      return execSync('reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid')
        .match(/MachineGuid\s+REG_SZ\s+(.+)/)?.[1]?.trim();
  }
}
```

### 遷移考量

> **重要**：改變指紋演算法 = 所有已簽發 license 失效。

遷移策略：
- `verify.js` 同時驗證新舊兩種 machine-id
- 舊 license 仍可用，新 license 用新指紋
- 設定過渡期（例如 6 個月）後移除舊指紋支援
- 或：簽發時同時簽兩種指紋（payload 含 `mid` + `mid_legacy`）

---

## Decision 4: Claude Code Slash Command → `/kiroku-id`

### 做法

在 `.claude/commands/kiroku-id.md` 放置：

```markdown
Display the Kiroku machine ID for license activation.
Run: node -e "import('/path/to/machine-id.js').then(m => console.log(m.getMachineId()))"
```

使用者在 Claude Code 內輸入 `/kiroku-id` 即可看到 machine-id。

### 考量

- `kiroku doctor` 已經顯示 machine-id，slash command 是額外入口
- `kiroku init` 可以自動建立這個 command 檔案（跟 CLAUDE.md 追加同理）
- 路徑需要是絕對路徑，或改用 `npx kiroku doctor` 方式

### 決定

在 `kiroku init` 時自動建立 `.claude/commands/kiroku-id.md`。
內容引導 Claude 執行 `kiroku doctor` 的 license 區段。

---

## Decision 5: 線上授權流程 → Cloudflare Worker + Stripe

### 架構

```
使用者                          基礎設施
──────                         ────────
1. kiroku activate
   → 顯示 machine-id
   → 開瀏覽器 ──────────────→  CF Pages（landing + pricing）
                                  │
2. Stripe Checkout ←──────────── 付款頁面
   → 完成付款                     │
                                  ↓
3.                              CF Worker 收 Stripe webhook
                                  → 用 private key 簽 license
                                  → 存入 CF KV（mid → license data）
                                  → 回傳 license URL
                                  │
4. CLI polling ←─────────────── GET /api/license?mid=XXXX
   → 下載 license.dat
   → 存到 ~/.kiroku/license/
   → 驗證 → Done ✅
```

### 技術棧

| 元件 | 用途 | 成本 |
|------|------|------|
| **CF Pages** | Landing page + 定價頁 | 免費 |
| **CF Worker** | Stripe webhook handler + license 簽發 API + license 下載 API | 免費 (100k req/day) |
| **CF KV** | License 記錄：`{mid, stripe_customer_id, tier, exp, license_dat}` | 免費 (100k reads/day) |
| **CF D1** (可選) | 進階：訂閱歷史、用量統計、多機器管理 | 免費 (5M rows) |
| **Stripe** | 付款 + 訂閱管理 + webhook | 2.9% + $0.30/筆 |

### Private Key 管理

**絕對不能放在 CF Worker 的 source code**。選項：

| 方案 | 安全性 | 複雜度 |
|------|--------|--------|
| CF Worker Environment Secret | 中（CF 員工理論上可見） | 低 |
| CF Worker + Wrangler secrets | 中 | 低 |
| 外部 KMS（AWS/GCP） | 高 | 高 |

建議：**CF Worker Secrets**（`wrangler secret put PRIVATE_KEY`）。對小規模產品夠安全，避免過度工程。

### CLI `kiroku activate` 流程

```bash
kiroku activate
# Step 1: 顯示 machine-id
#   Your Machine ID: 3A7F1B2C9E0D4F58
#
# Step 2: 開瀏覽器
#   Opening browser for activation...
#   URL: https://kiroku.dev/activate?mid=3A7F1B2C9E0D4F58
#
# Step 3: Polling（等使用者完成付款）
#   Waiting for activation... (press Ctrl+C to cancel)
#   ....
#
# Step 4: 下載 license
#   License activated! ✅
#   Tier: enterprise
#   Expires: 2027-03-06
```

### 已有 License 的續訂

```bash
kiroku activate --renew
# → 用現有 mid 去 CF Worker 查詢新 license
# → 覆寫 ~/.kiroku/license/license.dat
```

### API Endpoints (CF Worker)

```
POST /api/stripe-webhook      ← Stripe webhook（付款完成 → 簽發 license → 存 KV）
GET  /api/license?mid=XXXX    ← CLI polling（查詢 license 是否已簽發）
GET  /api/status?mid=XXXX     ← 查詢授權狀態（tier, expiry, usage）
POST /api/activate             ← 手動啟用（用 activation code 代替瀏覽器流程）
```

### 離線授權（備用）

保留 `scripts/sign-license.js` 作為離線簽發工具：
- 企業客戶可能在 air-gapped 環境
- 開發者自己測試用
- Stripe/CF 出問題時的 fallback

---

## Implementation Roadmap

建議分 4 階段：

### Phase 1: 基礎改進（本地，不需伺服器）— DONE (2026-03-07)
1. ~~改 `machine-id.js` → OS-provided machine ID + fallback~~
2. ~~嵌入 public key 到 `verify.js`~~
3. ~~加 freemium 限制邏輯（facts 上限、embedding 停用）~~
4. ~~`kiroku start` 顯示授權狀態 + gentle reminder~~
5. 加 `.claude/commands/kiroku-id.md`（deferred to Phase 2）

### Phase 2: CLI 授權指令
1. 加 `kiroku activate` 指令
2. 開瀏覽器 + polling 邏輯
3. License 下載 + 存檔 + 驗證

### Phase 3: Cloudflare Worker
1. CF Worker：Stripe webhook handler
2. CF Worker：license 簽發（用 secrets 存 private key）
3. CF KV：license 記錄存儲
4. CF Pages：landing page + pricing

### Phase 4: 進階功能
1. 訂閱續期 + 自動續約
2. 多機器管理（同一帳號多個 machine-id）
3. 用量追蹤 + analytics
4. 企業 tier：team license（不綁 machine-id，綁 org）
5. CF D1：訂閱歷史 + 用量統計

---

## Open Questions

1. **定價策略** — 月付 vs 年付 vs 一次買斷？分幾個 tier？
2. **Trial 期** — 有無試用期？多長？試用期等於 freemium 還是 full feature？
3. **Grace period** — License 過期後多久降級為 freemium？立即還是 7 天寬限？
4. **Team license** — 企業客戶是否需要不綁機器的 org-level license？
5. **Offline-first** — 驗證是否完全離線（目前是），還是加入 phone-home 檢查？
6. **Domain** — kiroku.dev？kiroku.ai？需要提前註冊
7. **Stripe 區域** — 支援哪些幣別？需不需要處理稅務（Stripe Tax）？
