# 雙 Repo 架構 — 原始碼保護 + 公開分發

> 狀態：**已完成** (2026-03-10)

## 架構

```
yelban/kiroku-cli  (PRIVATE)              yelban/kiroku-public  (PUBLIC)
├── src/  bin/  build.mjs  test/          ├── README.md  LICENSE
├── server/  site/  prompts/              └── GitHub Releases only
├── migrations/  scripts/                      v1.1.0/
├── .github/workflows/build-jsc.yml             ├── kiroku-v1.1.0-node20.tar.gz
├── package.json                                ├── kiroku-v1.1.0-node22.tar.gz
└── keys/ .env (.gitignore'd)                   └── kiroku-v1.1.0-node24.tar.gz
```

| 角色 | Repo | 用途 |
|------|------|------|
| 原始碼 + CI | `yelban/kiroku-cli` (private) | 開發、測試、build pipeline |
| Release 分發站 | `yelban/kiroku-public` (public) | 託管 .jsc bytecode tarball |
| npm 套件 | `@kiroku/cli` on npmjs | loaders + postinstall（7 KB） |

**不用 submodule** — public repo 沒有程式碼，純粹是 Release artifact host。

---

## Build Pipeline

```
node build.mjs --jsc

Stage 1: esbuild → dist/*.raw.cjs      (4 CJS bundles)
Stage 2: patch dynamic imports          (import() → __import() shim)
Stage 3: javascript-obfuscator          → dist/*.obf.cjs
Stage 4: bytenode compile               → dist/*.jsc
Stage 5: generate loaders               → dist/*.cjs (thin wrappers)
Cleanup: delete *.raw.cjs, *.obf.cjs
```

不帶 `--jsc` 時只跑 Stage 1（dev mode，同舊行為）。

### npm pack 內容（7 KB）

```
@kiroku/cli-1.1.0.tgz
├── dist/cli.cjs        (~63B loader: require('bytenode'); require('./cli.jsc'))
├── dist/proxy.cjs      (~45B)
├── dist/worker.cjs     (~46B)
├── dist/mcp.cjs        (~43B)
├── scripts/postinstall.cjs
├── migrations/*.sql
└── package.json
```

無 .jsc、無原始碼、無可讀 JS。

---

## CI Workflow

檔案：`.github/workflows/build-jsc.yml`

觸發：tag push (`v*`) 或 `workflow_dispatch`

```
build-jsc (matrix: Node 20/22/24)
  ├── checkout
  ├── npm ci --ignore-scripts     ← 跳過 postinstall（.jsc 還沒建）
  ├── node build.mjs --jsc
  ├── tar czf kiroku-vX.Y.Z-nodeNN.tar.gz
  └── upload-artifact

publish-release (needs: build-jsc)
  ├── download-artifact (merge all 3)
  └── gh release create --repo yelban/kiroku-public
```

跨 repo 發佈用 `PUBLIC_REPO_TOKEN` (Fine-Grained PAT，scope: `yelban/kiroku-public` Contents R+W)。

### 踩過的坑

1. **checkout ref 問題** — `workflow_dispatch` 傳入 tag 名稱作為 `ref`，但 tag 不存在於 repo → 移除 `ref` 參數，直接 checkout 預設 branch
2. **npm ci 觸發 postinstall** — postinstall 嘗試下載尚不存在的 .jsc → 用 `--ignore-scripts` 跳過
3. **shebang 破壞 obfuscator** — cli.cjs 的 `#!/usr/bin/env node` 被 import patch 插到中間 → Stage 2 先剝離 shebang
4. **ESM 專案中 CJS postinstall** — `package.json` 有 `"type": "module"`，`require()` 不可用 → 改名 `postinstall.cjs`

---

## 發版流程

```bash
# 1. 在 kiroku-cli (private) 操作
npm version patch                # bump version + create tag

# 2. 推送觸發 CI
git push && git push --tags      # CI → build .jsc → upload to kiroku-public

# 3. 等 CI 完成（~1 分鐘）
gh run list --repo yelban/kiroku-cli --limit 1

# 4. 發佈到 npm
npm publish                      # 只包含 loaders + postinstall
```

使用者體驗：
```bash
npm install -g @kiroku/cli
# postinstall 自動從 kiroku-public 下載 .jsc（~1.7 MB）
kiroku help
```

### 手動測試 CI（不建 tag）

```bash
gh workflow run build-jsc.yml --repo yelban/kiroku-cli --field tag=v1.1.0
```

---

## Secrets & Tokens

| Secret | 位置 | 用途 | 過期 |
|--------|------|------|------|
| `PUBLIC_REPO_TOKEN` | kiroku-cli repo secret | 跨 repo 建 release | Fine-Grained PAT，最長 1 年 |
| npm token | `~/.npmrc` | npm publish | bypass 2FA token |

**注意**：Fine-Grained PAT 最長 1 年，需設提醒續約。

---

## 本地開發目錄

```
~/zoo/kiroku-cli/        ← git clone git@github.com:yelban/kiroku-cli.git
  ├── 日常開發在此
  ├── npm run build      (dev mode，不需 --jsc)
  ├── npm test           (145 tests)
  └── git push           (推到 private repo)
```

開發時不需要 bytecode，`npm run build` 產生普通 CJS。
只有 CI（tag push）和手動 `npm run build:jsc` 才走完整 bytecode pipeline。

---

## 環境變數

| 變數 | 用途 |
|------|------|
| `BUILD_JSC=1` | postinstall 跳過下載（CI/本地 build 時設） |
| `KIROKU_JSC_URL` | 覆蓋 .jsc 下載 URL（企業 proxy/mirror） |
