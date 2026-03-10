# Cloudflare 部署指南

> 日期：2026-03-08
> 涵蓋：官網 (Pages) + API Worker

---

## 1. 官網 — kiroku.orz99.com

### 1.1 專案結構

```
kiroku-v15/site/
├── package.json      # wrangler devDependency
├── _worker.js        # Pages Advanced Mode worker（robots.txt, sitemap, security headers）
└── index.html        # 單頁官網（暗色主題，響應式）
```

### 1.2 Cloudflare 帳號

- 帳號：Twampd@gmail.com
- Account ID：`fb1c0985dd271b5636145f18350ff0ff`
- Pages 專案名：`kiroku-site`
- Pages.dev URL：https://kiroku-site.pages.dev
- Custom domain：`kiroku.orz99.com`（需手動設定）

### 1.3 部署指令

```bash
cd kiroku-v15/site

# 本機預覽
npx wrangler pages dev . --port 8790

# 部署到 Cloudflare Pages
CLOUDFLARE_ACCOUNT_ID=fb1c0985dd271b5636145f18350ff0ff \
  npx wrangler pages deploy . --project-name kiroku-site --commit-dirty=true
```

### 1.4 設定 Custom Domain

wrangler CLI 不支援直接加 custom domain，需在 Dashboard 操作：

1. 到 [Cloudflare Dashboard](https://dash.cloudflare.com) → 選 Twampd@gmail.com 帳號
2. 左側選單 → **Workers & Pages** → 找到 `kiroku-site`
3. 上方 tab → **Custom domains** → **Set up a custom domain**
4. 輸入 `kiroku.orz99.com`
5. 兩種情況：
   - **`orz99.com` 在同帳號下**：Cloudflare 自動設定 CNAME，直接確認即可
   - **`orz99.com` 在不同帳號或外部 DNS**：需手動加 DNS 記錄

### 1.5 手動 DNS 設定（如需要）

在 `orz99.com` 的 DNS 管理介面加：

```
Type:  CNAME
Name:  kiroku
Value: kiroku-site.pages.dev
TTL:   Auto
Proxy: ON (如在 Cloudflare) / OFF (如在外部 DNS)
```

等 SSL 證書自動核發（通常 1-5 分鐘）。

### 1.6 網站內容

- **Hero**: Terminal 動畫展示 `kiroku init` → `kiroku start` → memory search
- **How It Works**: 4 步驟（Proxy → Extraction → Vector Search → Heat/Decay）
- **Architecture**: ASCII 架構圖
- **Features**: 6 大功能卡片
- **Pricing**: Free ($0) vs Pro ($9/mo)
- **FAQ**: 6 題常見問題
- 暗色主題、紫色漸層 accent、響應式設計

### 1.7 更新網站

修改 `site/index.html` 後重新部署：

```bash
cd kiroku-v15/site
CLOUDFLARE_ACCOUNT_ID=fb1c0985dd271b5636145f18350ff0ff \
  npx wrangler pages deploy . --project-name kiroku-site --commit-dirty=true
```

---

## 2. API Worker — kiroku-api

### 2.1 專案結構

```
kiroku-v15/server/
├── package.json
├── wrangler.toml      # Worker 設定 + KV binding
└── src/
    ├── index.js       # 路由：/prompt, /webhook/ls, /prompt/update, /health
    ├── prompt.js      # GET /prompt (LS validate → KV prompt), POST /prompt/update
    └── webhook.js     # POST /webhook/ls (HMAC 簽章驗證)
```

### 2.2 端點

| Method | Path | 說明 |
|--------|------|------|
| GET | `/prompt` | 驗證 license → 回傳 premium prompt（支援 ETag 304） |
| POST | `/prompt/update` | Admin：更新 KV 中的 prompt 內容 |
| POST | `/webhook/ls` | Lemon Squeezy webhook 接收 |
| GET | `/health` | 健康檢查 |

### 2.3 首次部署

```bash
cd kiroku-v15/server
npm install

# 建立 KV namespace
CLOUDFLARE_ACCOUNT_ID=fb1c0985dd271b5636145f18350ff0ff \
  npx wrangler kv namespace create KIROKU_KV

# 將回傳的 id 填入 wrangler.toml 的 [[kv_namespaces]] id 欄位

# 設定 secrets
CLOUDFLARE_ACCOUNT_ID=fb1c0985dd271b5636145f18350ff0ff \
  npx wrangler secret put LS_API_KEY          # 貼上 LS test mode API key
CLOUDFLARE_ACCOUNT_ID=fb1c0985dd271b5636145f18350ff0ff \
  npx wrangler secret put LS_WEBHOOK_SECRET   # 貼上 LS webhook signing secret
CLOUDFLARE_ACCOUNT_ID=fb1c0985dd271b5636145f18350ff0ff \
  npx wrangler secret put PROMPT_ADMIN_KEY    # 自訂管理金鑰

# 部署
CLOUDFLARE_ACCOUNT_ID=fb1c0985dd271b5636145f18350ff0ff \
  npx wrangler deploy
```

### 2.4 上傳 Premium Prompt

```bash
# 讀取 extraction.md 並上傳
CONTENT=$(cat kiroku-v15/prompts/extraction.md | jq -Rs .)
curl -X POST https://kiroku-api.twampd.workers.dev/prompt/update \
  -H "Authorization: Bearer YOUR_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"content\":${CONTENT},\"version\":\"1.0\"}"
```

### 2.5 驗證部署

```bash
# Health check
curl https://kiroku-api.twampd.workers.dev/health

# 用 license key 測試 prompt 端點
curl https://kiroku-api.twampd.workers.dev/prompt \
  -H "Authorization: Bearer YOUR_LICENSE_KEY"

# 無 license → 應回 401
curl https://kiroku-api.twampd.workers.dev/prompt
```

### 2.6 Custom Domain（可選）

如果要用 `api.kiroku.orz99.com` 或 `kiroku-api.twampd.workers.dev`：

在 `wrangler.toml` 加上 routes 或在 Dashboard → Workers → kiroku-api → Custom Domains 設定。

### 2.7 環境變數

| 名稱 | 說明 | 設定方式 |
|------|------|---------|
| `LS_API_KEY` | Lemon Squeezy API key | `wrangler secret put` |
| `LS_WEBHOOK_SECRET` | Webhook HMAC 簽章 secret | `wrangler secret put` |
| `PROMPT_ADMIN_KEY` | 更新 prompt 用的管理金鑰 | `wrangler secret put` |
| `KV` | KV namespace binding | `wrangler.toml` |

### 2.8 KV Schema

```
Key: prompt:latest
Value: { "version": "1.0", "content": "...", "etag": "abc123", "updatedAt": "..." }

Key: license:<license-key>    (auto-expire TTL)
Value: { "valid": true, "validatedAt": 1709856000 }
```

---

## 3. 多帳號注意事項

本機 wrangler 有多個 Cloudflare 帳號，必須每次指定：

```bash
export CLOUDFLARE_ACCOUNT_ID=fb1c0985dd271b5636145f18350ff0ff
```

或在每個指令前加 `CLOUDFLARE_ACCOUNT_ID=...`。

可用帳號：

| 帳號 | Account ID |
|------|-----------|
| Ljchen52@gmail.com | `4187a30ed43d0551e02a4078a6dbfaa7` |
| Tunghua@me.com | `4340d1ba54913b70abcba8761c4e5f57` |
| **Twampd@gmail.com** (Kiroku 用) | `fb1c0985dd271b5636145f18350ff0ff` |

---

## 4. 故障排除

### Pages 部署失敗
```
Error: Project not found
```
→ 先建立專案：`npx wrangler pages project create kiroku-site --production-branch main`

### Worker 部署失敗
```
Error: Missing account_id
```
→ 加 `CLOUDFLARE_ACCOUNT_ID` 環境變數，或在 `wrangler.toml` 加 `account_id`

### Custom domain SSL 卡住
→ 確認 DNS CNAME 已設定正確 → 等幾分鐘讓 Cloudflare 核發證書

### wrangler OAuth token 過期
```
wrangler login
```
重新登入即可。Token 存放在 `~/Library/Preferences/.wrangler/config/default.toml`。
