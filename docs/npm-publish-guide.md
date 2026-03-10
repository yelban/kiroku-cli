# Kiroku npm 發布指南

完整記錄從套件命名、npm org 建立、token 設定到發布的全流程。

---

## 1. 套件命名策略

### 理想名稱：`kiroku`

npm 上 `kiroku` 已被佔用（v0.0.4，"javascript logger for minimalist"，超過一年未更新，無下載量）。

### 替代方案

| 名稱 | 安裝指令 | 狀態 |
|------|---------|------|
| `kiroku` | `npx kiroku` | 被佔用，已提交 dispute |
| `@kiroku/cli` | `npx @kiroku/cli` | **已發布 v1.0.0** |
| `kiroku-memory` | `npx kiroku-memory` | 可用（備選） |
| `kiroku-ai` | `npx kiroku-ai` | 可用（備選） |

**策略：** 先用 `@kiroku/cli` 發布，同時申請 `kiroku`，拿到後再發一版改名。

---

## 2. 申請 `kiroku` 套件名（npm Dispute）

### 2.1 提交 Ticket

到 https://npmjs.com/support → 選 **"There is a problem with the npm registry"**

**Subject:**
```
Request to transfer abandoned npm package name: "kiroku"
```

**Body:**
```
Hi npm team,

I'd like to request a transfer of the npm package name "kiroku".

Current package status:
- Package: https://www.npmjs.com/package/kiroku
- Current version: 0.0.4
- Last published: over 1 year ago
- Weekly downloads: near zero
- Description: "javascript logger for minimalist" — minimal functionality, no active maintenance

My project:
- Name: Kiroku (記録) — AI-powered memory system for Claude Code
- npm username: dawdle
- Website: https://kiroku.orz99.com
- The package is ready to publish with active development and real users

I believe the current package meets npm's definition of "squatting" under the Terms of Use,
as it appears to be abandoned with no genuine ongoing function.

I've attempted to contact the current maintainer (kumabook) but there is no active contact
method available.

I'd appreciate your help transferring this package name. Thank you!

Best regards,
Yelban Hsu
sweet168@gmail.com
GitHub: https://github.com/yelban
```

### 2.2 等待審核

- 通常 **1-4 週**回覆
- npm（GitHub）審核後會轉移套件名
- 成功率高（符合 squatting 條件：長期無更新、無下載、功能空殼）

### 2.3 拿到後的操作

```bash
# 1. 更新 package.json
#    "name": "kiroku"  (從 "@kiroku/cli" 改)

# 2. 發布新版本
npm publish --access public

# 3. @kiroku/cli 可以保留或 deprecate
npm deprecate @kiroku/cli "Moved to 'kiroku'. Please use: npm install -g kiroku"
```

### 2.4 參考政策

- [npm Disputes Policy](https://docs.npmjs.com/policies/disputes/)
- [npm feedback: dispute process timeline](https://github.com/npm/feedback/discussions/534)

**實測記錄：** Ticket 已於 2026-03-08 提交，狀態等待中。

---

## 3. 建立 npm Organization

發布 scoped package（`@kiroku/cli`）需要先建 npm org。

### 步驟

1. 到 https://www.npmjs.com/org/create
2. **Name:** `kiroku`
3. **Plan:** Free（Unlimited public packages）
4. 點 Create

### 建立後

- Org 頁面：https://www.npmjs.com/org/kiroku
- 自動建立 `Developers` team
- Owner: dawdle（Lis Alisa）
- 所有 `@kiroku/*` scope 的 package 都歸屬此 org

---

## 4. npm 帳號設定

### 4.1 npm 登入

```bash
npm login
# 輸入：
# Username: dawdle
# Password: ********
# Email: sweet168@gmail.com
# OTP（如有開 2FA）: 123456

# 驗證登入
npm whoami
# → dawdle
```

### 4.2 建立 Granular Access Token

npm 強制要求 2FA 或 granular token 才能 publish。

1. 到 https://www.npmjs.com/settings/dawdle/tokens
2. 點 **Generate New Token** → 選 **Granular Access Token**
3. 設定：

| 欄位 | 填寫 |
|------|------|
| **Token name** | `publish` |
| **Expiration** | 30 days（或更長） |
| **Packages** | Read and write |
| **Organizations** | `kiroku` |
| **Bypass 2FA** | **勾選**（重要！否則 CLI publish 會被拒絕） |

4. 建立後複製 token（格式：`npm_CkZt...PQfW`，只顯示一次）

### 4.3 使用 Token 發布

Token 需寫入專案的 `.npmrc`（發布後刪除）：

```bash
# 寫入 .npmrc
echo "//registry.npmjs.org/:_authToken=npm_YOUR_TOKEN_HERE" > .npmrc

# 發布
npm publish --access public

# 發布後立即刪除（避免 commit token）
rm .npmrc
```

**重要：** `.npmrc` 包含 token，絕對不能 commit。已加入 `.gitignore`。

### 4.4 2FA 設定（選用）

npm 支援兩種 2FA：

| 類型 | 用途 | CLI publish 支援 |
|------|------|-----------------|
| **Security Key**（WebAuthn） | 網頁登入 | 不支援 CLI |
| **Authenticator App**（TOTP） | 網頁 + CLI | 支援（輸入 6 位碼） |

目前帳號只設了 Security Key。如需 CLI 直接 publish（不用 token）：

1. 到 https://www.npmjs.com/settings/dawdle/tfa
2. 加 **Authenticator App** → 掃 QR code
3. `npm publish` 時會要求輸入 OTP

**目前方案：** 用 granular token + bypass 2FA，不需要 TOTP。

---

## 5. package.json 設定

發布前確認以下欄位：

```json
{
  "name": "@kiroku/cli",
  "version": "1.0.0",
  "description": "AI-powered memory system for Claude Code — MCP Server & Proxy",
  "type": "module",
  "main": "bin/kiroku.js",
  "bin": {
    "kiroku": "bin/kiroku.js"
  },
  "files": [
    "bin/",
    "dist/",
    "migrations/"
  ],
  "license": "UNLICENSED",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/yelban/kiroku.git"
  },
  "engines": {
    "node": ">=20.0.0"
  },
  "scripts": {
    "build": "node build.mjs",
    "prepublishOnly": "npm run build"
  }
}
```

### 關鍵欄位說明

| 欄位 | 用途 |
|------|------|
| `name` | `@kiroku/cli`（scoped package） |
| `bin.kiroku` | 安裝後可用 `kiroku` 指令 |
| `files` | **只包含 `bin/`、`dist/`、`migrations/`** — 原始碼不外洩 |
| `prepublishOnly` | 發布前自動 build（`src/` → `dist/*.cjs`） |
| `license` | `UNLICENSED`（商業軟體） |

### 原始碼保護確認

```bash
npm pack --dry-run
```

預期輸出（12 files, ~82 KB）：

```
📦  @kiroku/cli@1.0.0
Tarball Contents
 5.4kB  README.md
 29.6kB bin/kiroku.js
 93.0kB dist/mcp.cjs
 76.1kB dist/proxy.cjs
 88.5kB dist/worker.cjs
 3.3kB  migrations/001_init.sql
 170B   migrations/002_vec.sql
 380B   migrations/003_scope.sql
 400B   migrations/004_scope_vec.sql
 823B   migrations/005_heat_decay.sql
 326B   migrations/006_audit_log.sql
 1.1kB  package.json
```

**不含：** `src/`、`test/`、`server/`、`site/`、`prompts/extraction.md`、`docs/`

---

## 6. 完整發布流程

### 6.1 首次發布

```bash
cd kiroku-v15

# 1. 確認登入
npm whoami  # → dawdle

# 2. Build
npm run build
# → dist/proxy.cjs, dist/worker.cjs, dist/mcp.cjs

# 3. 預覽 tarball
npm pack --dry-run
# → 確認只有 12 files，不含 src/

# 4. 寫入 token
echo "//registry.npmjs.org/:_authToken=npm_YOUR_TOKEN" > .npmrc

# 5. 發布（scoped package 預設 private，必須加 --access public）
npm publish --access public
# → + @kiroku/cli@1.0.0

# 6. 清除 token
rm .npmrc

# 7. 驗證
npm view @kiroku/cli
```

### 6.2 發布新版本

```bash
# 1. 改版本號
npm version patch  # 1.0.0 → 1.0.1
# 或
npm version minor  # 1.0.0 → 1.1.0

# 2. 寫入 token + 發布
echo "//registry.npmjs.org/:_authToken=npm_YOUR_TOKEN" > .npmrc
npm publish --access public
rm .npmrc
```

### 6.3 Deprecate 舊版本（拿到 `kiroku` 名稱後）

```bash
npm deprecate @kiroku/cli "Moved to 'kiroku'. Please use: npm install -g kiroku"
```

---

## 7. 使用者安裝方式

### 全域安裝

```bash
npm install -g @kiroku/cli

# 安裝後直接使用 kiroku 指令
kiroku init
kiroku start
kiroku activate <license-key>
kiroku license
kiroku stop
```

### npx（不安裝）

```bash
npx @kiroku/cli init
npx @kiroku/cli start
```

### 確認安裝

```bash
kiroku --help
kiroku status
```

---

## 8. 不需要 GitHub

**npm publish 完全不依賴 GitHub。** tarball 直接上傳到 npm registry。

可選的 GitHub 策略：

| 策略 | 說明 |
|------|------|
| **不推 GitHub** | 最安全，原始碼完全不公開 |
| **Private repo** | 備份用，只有自己看得到 |
| **Public repo（不含 src/）** | 只放 README + docs，npm install 指向 registry |

`package.json` 的 `repository` 欄位只是 metadata，npm 不會從 GitHub 拉程式碼。

---

## 9. 實測記錄（2026-03-08）

| 步驟 | 結果 |
|------|------|
| npm org `kiroku` 建立 | 成功 |
| `kiroku` 名稱 dispute 提交 | 已送出，等待回覆 |
| Granular token + bypass 2FA | 成功建立 |
| `npm run build` | 3 CJS bundles 產生 |
| `npm pack --dry-run` | 12 files, 82.6 KB，不含 src/ |
| `npm publish --access public` | `+ @kiroku/cli@1.0.0` 成功 |
| npm registry 查詢 | 傳播完成，可查到 |
| 套件頁面 | https://www.npmjs.com/package/@kiroku/cli |

### 注意事項

1. **Token 有效期 30 天**（到 2026-04-07），屆時需重新建立
2. **`.npmrc` 絕不 commit**（已加入 `.gitignore`）
3. **`prepublishOnly` 自動 build**，但建議先手動 `npm run build` 確認無誤
4. **Registry 傳播延遲**：新 org 第一個 package 可能需要 1-3 分鐘才能 `npm view` 到
5. **`--access public` 必須**：scoped package（`@scope/name`）預設 private，免費帳號不能發 private package
