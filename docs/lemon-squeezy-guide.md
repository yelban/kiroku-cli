# Lemon Squeezy 整合指南

> 日期：2026-03-08
> 狀態：Phase 2 ADR-003 實作參考

## 概述

Kiroku 使用 Lemon Squeezy (LS) 作為 Merchant of Record，處理付款、訂閱管理與 license key 生命週期。
CF Worker 只負責：① 驗證 license → 回傳 premium prompt ② 接收 LS webhook 同步狀態。

---

## 1. 帳號與 Store 設置

### 1.1 註冊

- 網址：https://lemonsqueezy.com
- 帳號：yelban@gmail.com
- 註冊後**預設 test mode**，不需審核即可開始開發

### 1.2 Test Mode

LS 內建 test mode，可測試完整流程：

- Checkout 付款流程
- 訂閱建立與取消
- License key 產生、啟用、驗證、停用
- Webhook 接收
- API 整合

**限制：**
- 檔案下載在 test mode 中停用
- 收據 email 只會寄給團隊成員（不管結帳時填什麼 email）
- Test mode 產品不會自動轉到 live mode（需手動 "Copy to Live Mode"）

**測試信用卡號碼：**

| 卡別 | 號碼 | 用途 |
|------|------|------|
| Visa | `4242 4242 4242 4242` | 成功付款 |
| Mastercard | `5555 5555 5555 4444` | 成功付款 |
| American Express | `3782 822463 10005` | 成功付款 |
| 餘額不足 | `4000 0000 0000 9995` | 測試失敗 |
| 過期卡 | `4000 0000 0000 0069` | 測試過期 |
| 3D Secure | `4000 0027 6000 3184` | 測試 3DS |

- 到期日：任意未來日期（如 `12/35`）
- CVC：任意三碼
- 其他欄位隨意填寫

**API Key 注意：** test mode 下建立的 API key 只能操作 test mode 資料。上線前需另建 live mode API key。

### 1.3 Store 啟用（Live Mode）

啟用 live mode 需兩步：
1. 填寫商業問卷（產品類型、客群、營運模式）
2. 身份驗證（透過 Stripe Connect）

**審核時間：** 通常 2-3 個工作天

### 1.4 Stripe 身份驗證

啟用 store 的身份驗證會導向 **Stripe Connect** 頁面。

**重要說明：**
- **不需要事先有 Stripe 帳號** — 如果沒有，系統會自動建立一個 Stripe Connect 帳號
- 畫面上「已經有 Stripe 账户？您可以使用相同的邮件地址」只是說如果有的話可以少填資料
- 需要填寫：姓名、地址、電話、銀行帳戶（收款用）
- 可能需要上傳身份證件
- 台灣地址和銀行帳戶是支援的

**不需要完成身份驗證就能使用 test mode。** 可以先跳過，用 test mode 完成所有整合開發，之後再回來完成驗證上線。

---

## 2. 產品設定

### 2.1 建立產品

Dashboard → Products → Add Product

- 產品名稱：**Kiroku Pro**
- 類型：Subscription
- Variants：
  - Monthly — $9/month
  - Yearly — $90/year（可選，打折）

### 2.2 啟用 License Key

在 Variant 設定中：
- 啟用 **License keys**
- License key format: UUID
- Activation limit: `1`（一台機器）
- 訂閱型 license：key 隨訂閱生命週期自動過期

### 2.3 License Key 狀態

| 狀態 | 說明 |
|------|------|
| `inactive` | 有效但尚未啟用 |
| `active` | 已有一個以上啟用實例 |
| `expired` | 到期或訂閱結束 |
| `disabled` | 從 Dashboard 手動停用 |

---

## 3. License API

所有請求需 HTTPS，並帶 `Accept: application/json` header。
Base URL: `https://api.lemonsqueezy.com`

### 3.1 Activate（啟用）

```bash
curl -X POST https://api.lemonsqueezy.com/v1/licenses/activate \
  -H "Accept: application/json" \
  -d "license_key=38b1460a-5104-4067-a91d-77b872934d51" \
  -d "instance_name=machine-id-here"
```

**回應：**
```json
{
  "activated": true,
  "license_key": {
    "id": 1,
    "status": "active",
    "key": "38b1460a-...",
    "activation_limit": 1,
    "activation_usage": 1,
    "created_at": "2026-01-01T00:00:00.000000Z",
    "expires_at": "2027-01-01T00:00:00.000000Z"
  },
  "instance": {
    "id": "f90ec370-fd83-46a5-8bbd-44a241e78665",
    "name": "machine-id-here",
    "created_at": "2026-03-08T00:00:00.000000Z"
  },
  "meta": {
    "store_id": 12345,
    "order_id": 67890,
    "product_id": 111,
    "product_name": "Kiroku Pro",
    "variant_id": 222,
    "variant_name": "Monthly",
    "customer_id": 333,
    "customer_name": "John Doe",
    "customer_email": "john@example.com"
  }
}
```

**重要：** 必須保存 `instance.id`，後續 validate 和 deactivate 都需要。

### 3.2 Validate（驗證）

```bash
# 只驗證 key
curl -X POST https://api.lemonsqueezy.com/v1/licenses/validate \
  -H "Accept: application/json" \
  -d "license_key=38b1460a-..."

# 驗證特定 instance
curl -X POST https://api.lemonsqueezy.com/v1/licenses/validate \
  -H "Accept: application/json" \
  -d "license_key=38b1460a-..." \
  -d "instance_id=f90ec370-..."
```

**回應：**
```json
{
  "valid": true,
  "error": null,
  "license_key": {
    "id": 1,
    "status": "active",
    "key": "38b1460a-...",
    "activation_limit": 1,
    "activation_usage": 1,
    "created_at": "...",
    "expires_at": "..."
  },
  "instance": { "id": "...", "name": "...", "created_at": "..." },
  "meta": { "store_id": 12345, "product_id": 111, ... }
}
```

### 3.3 Deactivate（停用）

```bash
curl -X POST https://api.lemonsqueezy.com/v1/licenses/deactivate \
  -H "Accept: application/json" \
  -d "license_key=38b1460a-..." \
  -d "instance_id=f90ec370-..."
```

停用後 `activation_usage` 會減 1，使用者可在另一台機器重新啟用。

### 3.4 安全驗證（重要）

LS 官方文件明確警告：**必須驗證 `store_id` 和 `product_id`。**

> "You should verify that the `store_id`, `product_id` and/or `variant_id` from this response match the IDs of your Lemon Squeezy product. If you don't do this, someone using a license key from another Lemon Squeezy product could use it to get access to your product."

建議做法：在 client 端和 CF Worker 中 hard-code `store_id` + `product_id`，每次 validate 後比對。

---

## 4. Webhook 設定

### 4.1 建立 Webhook

Dashboard → Settings → Webhooks → Add Webhook

- URL: `https://kiroku-api.twampd.workers.dev/webhook/ls`
- 勾選事件：
  - `subscription_created`
  - `subscription_updated`
  - `subscription_expired`
  - `subscription_cancelled`
  - `subscription_payment_success`
  - `license_key_created`
- 記下 **Signing secret**

### 4.2 簽章驗證

LS webhook 使用 HMAC-SHA256 簽章，放在 `X-Signature` header 中。
我們的 CF Worker (`server/src/webhook.js`) 已實作驗證。

---

## 5. 端對端測試步驟（含實測記錄 2026-03-08）

### 前置條件

- LS 帳號已建立（test mode）
- 產品 "Kiroku Pro" 已建立並啟用 license key（Activation limit: 1）
- CF Worker 已部署（見 `docs/cloudflare-deploy-guide.md`）
- Webhook 已設定指向 `https://kiroku-api.twampd.workers.dev/webhook/ls`

### Step 1: 建立產品

Dashboard → Store → Products → **+ New Product**

| 欄位 | 填寫 |
|------|------|
| **General → Name** | `Kiroku Pro` |
| **General → Description** | `AI-powered memory system for Claude Code` |
| **Pricing → Type** | Subscription |
| **Pricing → Pricing model** | Standard pricing |
| **Pricing → Price per unit** | `$9.99`（或 NT$299 等本地幣別） |
| **Pricing → Repeat payment every** | `1 Month` |
| **Usage is metered** | OFF |
| **Subscription includes a setup fee** | OFF |
| **Subscription has free trial** | OFF |
| **Tax category** | Software as a service (SaaS) - personal use |
| **Media** | 跳過（不需要） |
| **Files** | 跳過（不需要） |
| **Settings → Generate license keys** | **ON** |
| **Settings → Activation limit** | **`1`** |
| **Display product on storefront** | ON |

按 **Save** 或 **Publish**。

### Step 2: 建立 API Key

Settings → API（或 Integrations）→ **Create API Key**

- Name: `kiroku-worker`
- 複製產生的 JWT token（只顯示一次）

### Step 3: 建立 Webhook

Settings → Webhooks → **Add Webhook**

| 欄位 | 填寫 |
|------|------|
| **Callback URL** | `https://kiroku-api.twampd.workers.dev/webhook/ls` |
| **Signing secret** | 自訂（最長 40 字元），例如 `kiroku-wh-b451ab314d4a6b5082e599` |

**勾選事件：**

- `license_key_created`
- `subscription_created`
- `subscription_updated`
- `subscription_expired`
- `subscription_cancelled`
- `subscription_payment_success`

按 **Save**。

### Step 4: 部署 CF Worker

見 `docs/cloudflare-deploy-guide.md` § 2.3。需要設定三個 secrets：

```bash
export CLOUDFLARE_ACCOUNT_ID=fb1c0985dd271b5636145f18350ff0ff

# LS API Key（Step 2 取得的 JWT）
echo "YOUR_LS_API_KEY" | npx wrangler secret put LS_API_KEY

# Webhook Signing Secret（Step 3 設定的）
echo "kiroku-wh-b451ab314d4a6b5082e599" | npx wrangler secret put LS_WEBHOOK_SECRET

# 自訂 Admin Key（用於上傳 prompt）
echo "YOUR_ADMIN_KEY" | npx wrangler secret put PROMPT_ADMIN_KEY
```

### Step 5: 上傳 Premium Prompt

```bash
CONTENT=$(cat prompts/extraction-basic.md | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))")
curl -X POST https://kiroku-api.twampd.workers.dev/prompt/update \
  -H "Authorization: Bearer YOUR_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"content\":${CONTENT},\"version\":\"1.0\"}"
```

預期回應：`{"ok":true,"version":"1.0","etag":"2cfebfe9..."}`

### Step 6: 測試購買（取得 License Key）

到 LS Dashboard → Products → Kiroku Pro → 點右上 **Share** → 打開 checkout 連結

**填寫測試訂單：**

| 欄位 | 填寫 |
|------|------|
| **Email** | `yelban@gmail.com`（或任意 email） |
| **Payment method** | Pay by Card |
| **Card number** | `4242 4242 4242 4242` |
| **Expiration date** | `12/35`（任意未來日期） |
| **Security code** | `123`（任意三碼） |
| **Cardholder name** | `Yelban Hsu`（任意） |
| **Billing address → Country** | United States |
| **Address line 1** | `123 Test St` |
| **State** | 隨便選（如 California） |
| **City** | `Test` |
| **ZIP** | `10001` |
| **Tax ID number** | 留空（optional） |

其他可用的測試卡號：

| 卡別 | 號碼 | 用途 |
|------|------|------|
| Visa | `4242 4242 4242 4242` | 成功付款 |
| Mastercard | `5555 5555 5555 4444` | 成功付款 |
| American Express | `3782 822463 10005` | 成功付款 |
| 餘額不足 | `4000 0000 0000 9995` | 測試失敗 |
| 過期卡 | `4000 0000 0000 0069` | 測試過期 |
| 3D Secure | `4000 0027 6000 3184` | 測試 3DS |

按 **Pay $9.99** → 出現「Thanks for your order!」即成功。

到 Dashboard → Store → **Licenses** 找到新產生的 license key（UUID 格式）。

**實測取得：** `BEA49944-B02B-41E9-A808-C12AD3A68BA6`

### Step 7: 測試 LS License API

```bash
# Validate — 確認 key 有效
curl -s -X POST https://api.lemonsqueezy.com/v1/licenses/validate \
  -H "Accept: application/json" \
  -d "license_key=BEA49944-B02B-41E9-A808-C12AD3A68BA6"
```

預期回應（節錄）：
```json
{
  "valid": true,
  "license_key": {
    "status": "inactive",
    "activation_limit": 1,
    "activation_usage": 0
  },
  "meta": {
    "store_id": 309745,
    "product_id": 876026,
    "product_name": "Kiroku Pro"
  }
}
```

```bash
# Activate — 啟用 key 綁定機器
curl -s -X POST https://api.lemonsqueezy.com/v1/licenses/activate \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  -d '{"license_key":"BEA49944-B02B-41E9-A808-C12AD3A68BA6","instance_name":"test-machine"}'
```

預期：`"activated": true`，回傳 `instance.id`（UUID，務必保存）。

```bash
# Deactivate — 停用（需要 instance_id）
curl -s -X POST https://api.lemonsqueezy.com/v1/licenses/deactivate \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  -d '{"license_key":"BEA49944-B02B-41E9-A808-C12AD3A68BA6","instance_id":"THE_INSTANCE_ID"}'
```

預期：`"deactivated": true`，`activation_usage` 回到 0。

### Step 8: 測試 CF Worker /prompt

```bash
# 無 license → 401
curl -s https://kiroku-api.twampd.workers.dev/prompt
# → {"error":"Missing license key"}

# 有效 license → 200 + prompt 內容
curl -s https://kiroku-api.twampd.workers.dev/prompt \
  -H "Authorization: Bearer BEA49944-B02B-41E9-A808-C12AD3A68BA6"
# → {"content":"You are a knowledge extraction engine...","version":"1.0"}

# Health check
curl -s https://kiroku-api.twampd.workers.dev/health
# → {"status":"ok"}
```

### Step 9: 測試 Kiroku CLI 完整流程

```bash
cd kiroku-v15

# 啟用
node bin/kiroku.js activate BEA49944-B02B-41E9-A808-C12AD3A68BA6
# → Activating license...
# →   Machine ID: D9F96309BCCE54E5
# →   Activated: pro tier
# →   Instance ID: fac50119-811a-4151-9fba-9c436020ed53
# →   Testing premium prompt access...
# →   Prompt: OK (1097 chars)

# 查看 license 狀態
node bin/kiroku.js license
# → Tier:       pro
# → Licensed:   true
# → Machine ID: D9F96309BCCE54E5
# → Embedding:  enabled

# 停用
node bin/kiroku.js deactivate
# → Deactivating license...
# →   Deactivated, reverted to free tier

# 確認回到 free tier
node bin/kiroku.js license
# → No license key found. Run `kiroku activate <key>` to activate.
# → Machine ID: D9F96309BCCE54E5

# 重新啟用（確認 LS 端 activation_usage 已歸零，可重複使用）
node bin/kiroku.js activate BEA49944-B02B-41E9-A808-C12AD3A68BA6
# → Activated: pro tier（新 instance ID）
```

### Step 10: 測試離線 Grace Period

1. `node bin/kiroku.js activate YOUR_TEST_KEY` → 確認 pro tier
2. 斷網（關 Wi-Fi）
3. `node bin/kiroku.js license` → 應顯示 pro tier（讀離線快取，7 天內有效）
4. 重新連網

### Step 11: 測試訂閱到期

1. 到 LS Dashboard → Store → Licenses → 找到該 key → 點 **Disable**
2. `node bin/kiroku.js license` → 應顯示 free tier（或等快取過期 5 分鐘後）
3. 確認 worker 啟動時 fallback 到 basic prompt

### 安全性驗證

CF Worker `prompt.js` 和 client `license-state.js` 都驗證 LS 回傳的 `store_id` 和 `product_id`：

```
EXPECTED_STORE_ID  = 309745
EXPECTED_PRODUCT_ID = 876026
```

若有人用其他 LS 產品的 license key 呼叫 `/prompt`，即使 LS 回 `valid: true`，Worker 也會拒絕（store_id/product_id 不符）。

### 已知注意事項

1. **Activation limit = 1**：deactivate 前必須保存 `instance_id`，否則 key 會被鎖住
   - CLI 已修正：`activate` 時把 `instanceId` 寫入 `~/.kiroku/license/license-offline.json`
   - `deactivate` 讀取該檔案取得 `instanceId`，正確呼叫 LS deactivate API
2. **LS License API 使用 form data 或 JSON 皆可**：CLI 和 CF Worker 都使用 JSON 格式
3. **Test mode 限制**：收據 email 只寄給團隊成員，不管結帳時填什麼 email
4. **LS validate 快取**：CF Worker 5 分鐘、client 也 5 分鐘。訂閱狀態變更後最慢 5 分鐘生效

---

## 6. 折扣碼與免費贈送

LS 內建 Discount Code 功能，可建立 100% 折扣讓特定用戶免費訂閱。

### 6.1 建立折扣碼

Dashboard → Store → **Discounts** → **Create Discount**

| 欄位 | 填寫 | 說明 |
|------|------|------|
| **Name** | `Kiroku Free 1 Month` | 內部名稱，用戶不可見 |
| **Code** | `KIROKU-FREE` | 用戶輸入的折扣碼 |
| **Discount type** | Percentage | |
| **Amount** | `100` | 100% = 完全免費 |
| **Apply to** | Specific products → 選 **Kiroku Pro** | 限定此產品 |
| **Duration** | 見下方說明 | |
| **Limit redemptions** | 視需求（如 `10`） | 限制可使用人數 |
| **Expiry date** | 視需求 | 折扣碼的有效期限 |

### 6.2 Duration 選項

| Duration | 效果 | 適用場景 |
|----------|------|---------|
| **Once** | 只免第一期（1 個月），第二個月起正常收 $9.99 | 試用、推廣 |
| **Repeating** (N months) | 免費 N 個月，之後正常收費 | 贊助者福利 |
| **Forever** | 永久免費 | VIP、內部測試、合作夥伴 |

**建議：** 推廣用選 **Once**（免費 1 個月試用），VIP 用 **Forever**。

### 6.3 給用戶的兩種方式

**方式 1：折扣碼**

把碼 `KIROKU-FREE` 直接給對方，對方在 checkout 頁面的折扣欄位輸入。

**方式 2：帶折扣的連結（推薦）**

在 checkout URL 加上 `?checkout[discount_code]=CODE`（需 URL-encode 方括號），用戶打開即自動套用：

```
https://kiroku.lemonsqueezy.com/buy/YOUR_VARIANT_ID?checkout%5Bdiscount_code%5D=KIROKU-FREE
```

> ⚠️ 舊文件曾寫的 `?discount=CODE` 已經**不被 LS 接受**（會回 404/422），必須改用 `checkout[discount_code]` 格式。2026-04-12 實測確認。

取得 checkout URL：Dashboard → Products → Kiroku Pro → **Share** → 複製連結，再加上 `?checkout%5Bdiscount_code%5D=KIROKU-FREE`。

### 6.4 注意事項

- **仍需填信用卡**：即使 100% 折扣，LS 訂閱仍要求填卡號（Duration=Once 時第二個月會扣款）
- **License key 照常產生**：折扣不影響 license key 的產生與功能
- **可建多組碼**：例如 `KIROKU-BETA`（限 50 人）、`KIROKU-VIP`（限 5 人 forever）
- **Test mode 也能用**：折扣碼在 test mode 下完全可測試
- **用量追蹤**：Dashboard → Discounts 可看每個碼被使用幾次

### 6.5 範例：建立推廣用免費試用碼

```
Name:              Kiroku Beta Trial
Code:              KIROKU-BETA
Type:              Percentage — 100%
Apply to:          Kiroku Pro
Duration:          Once（只免第一個月）
Limit redemptions: 50
Expiry date:       2026-06-30
```

給用戶的連結：
```
https://kiroku.lemonsqueezy.com/buy/xxxxx?checkout%5Bdiscount_code%5D=KIROKU-BETA
```

用戶點連結 → 看到 $0.00 → 填卡號 → 取得 license key → `kiroku activate <key>` → 立即使用 pro tier。
第二個月起自動扣 $9.99，用戶可隨時到 LS customer portal 取消。

---

## 7. 上線清單

```
[x] LS 帳號身份驗證（Stripe Connect）已提交（2026-03-08），等待審核中
[ ] Store 審核通過（通常 2-3 工作天）
[ ] 產品 "Copy to Live Mode"
[ ] 建立 live mode API key
[ ] CF Worker 更新 secrets（LS_API_KEY 改 live key）
[ ] 更新 EXPECTED_STORE_ID / EXPECTED_PRODUCT_ID（live mode ID 可能不同）
[ ] Webhook URL 確認（live mode 可能需要新建 webhook）
[x] 加入 store_id / product_id 安全驗證（已完成 2026-03-08）
[x] 端對端測試通過（test mode，2026-03-08）
[ ] 定價確認（月 $9.99 / 年 $99？）
[ ] 測試 live mode 完整流程
```

---

## 8. 參考連結

- [LS Test Mode](https://docs.lemonsqueezy.com/help/getting-started/test-mode)
- [LS License Keys Tutorial](https://docs.lemonsqueezy.com/guides/tutorials/license-keys)
- [LS License API](https://docs.lemonsqueezy.com/api/license-api)
- [LS Validate License Key](https://docs.lemonsqueezy.com/api/license-api/validate-license-key)
- [LS Activate License Key](https://docs.lemonsqueezy.com/api/license-api/activate-license-key)
- [LS Activate Your Store](https://docs.lemonsqueezy.com/help/getting-started/activate-your-store)
- [LS Generating License Keys](https://docs.lemonsqueezy.com/help/licensing/generating-license-keys)
- [LS Creating Discount Codes](https://docs.lemonsqueezy.com/help/orders/creating-discount-codes)
- [LS Expiring Subscription Discounts](https://docs.lemonsqueezy.com/guides/tutorials/expiring-subscription-discounts)
