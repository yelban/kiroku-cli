# Plan: 雙 Repo 架構 — 原始碼保護 + 公開分發

## Context

kiroku-v15 的 bytecode build pipeline 已完成（build.mjs --jsc），但 postinstall 需從 `github.com/yelban/kiroku-public` 的 Releases 下載 .jsc。目前兩個 repo 都不存在。需規劃 repo 結構、CI 跨 repo 發佈、初始推送流程。

**不用 submodule** — 公開 repo 沒有程式碼，純粹是 Release artifact host。submodule 語義不對且增加複雜度。

---

## 架構

```
yelban/kiroku-cli  (PRIVATE)              yelban/kiroku-public  (PUBLIC)
├── src/  bin/  build.mjs  test/          ├── README.md  LICENSE
├── server/  site/  prompts/              └── GitHub Releases only
├── migrations/  scripts/                      v1.1.0/
├── .github/workflows/build-jsc.yml             ├── kiroku-v1.1.0-node20.tar.gz
├── package.json (repo→yelban/kiroku-public)     ├── kiroku-v1.1.0-node22.tar.gz
└── keys/ .env (.gitignore'd)                   └── kiroku-v1.1.0-node24.tar.gz
```

- 所有原始碼、CI 只在 private repo
- public repo 只有 README + LICENSE + Releases
- `package.json` 的 `repository.url` 指向 public repo（npm 頁面連結）
- `postinstall.cjs` 下載 URL 指向 public repo Releases（不需改）

---

## 步驟

### 1. 建公開 repo `yelban/kiroku-public`

```bash
gh repo create yelban/kiroku-public --public \
  --description "AI-powered memory system for Claude Code"
```

本地初始化推一個 README + LICENSE：

```bash
mkdir /tmp/kiroku-public && cd /tmp/kiroku-public
git init && git branch -M main
# 建 README（使用者導向：安裝方式、功能簡介）
# 建 LICENSE（proprietary / UNLICENSED）
git add -A && git commit -m "Initial commit"
git remote add origin git@github.com:yelban/kiroku-public.git
git push -u origin main
```

### 2. 建私有 repo `yelban/kiroku-cli`

```bash
gh repo create yelban/kiroku-cli --private \
  --description "Kiroku CLI source (private)"
```

把 kiroku-v15 推上去：

```bash
cd /Users/orz99/zoo/claude-proxy/kiroku-v15
# 確認 .gitignore 已涵蓋 keys/ .env dist/ 等
git remote add origin git@github.com:yelban/kiroku-cli.git
git add -A && git commit -m "Initial commit: full source"
git branch -M main && git push -u origin main
```

### 3. 設定 CI 跨 repo 發佈 Secret

GitHub Settings → Developer Settings → Fine-Grained PAT：
- Name: `kiroku-release-publisher`
- Repo access: Only `yelban/kiroku-public`
- Permissions: Contents (Read+Write)

存到私有 repo：
```bash
gh secret set PUBLIC_REPO_TOKEN --repo yelban/kiroku-cli
```

### 4. 改寫 `.github/workflows/build-jsc.yml`

現有 workflow 用 `softprops/action-gh-release` 直接在同 repo 發 release，不支援跨 repo。改為兩個 job：

```yaml
name: Build V8 Bytecode
on:
  push:
    tags: ['v*']
  workflow_dispatch:
    inputs:
      tag:
        description: 'Tag (e.g. v1.2.0)'
        required: true

jobs:
  build-jsc:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [20, 22, 24]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '${{ matrix.node }}' }
      - run: npm ci
      - run: node build.mjs --jsc
        env: { BUILD_JSC: '1' }
      - name: Package
        run: |
          TAG="${{ github.event.inputs.tag || github.ref_name }}"
          cd dist && tar czf "../kiroku-${TAG}-node${{ matrix.node }}.tar.gz" \
            cli.jsc proxy.jsc worker.jsc mcp.jsc
      - uses: actions/upload-artifact@v4
        with:
          name: jsc-node${{ matrix.node }}
          path: kiroku-*.tar.gz

  publish-release:
    needs: build-jsc
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v4
        with: { merge-multiple: true }
      - name: Publish to public repo
        env:
          GH_TOKEN: ${{ secrets.PUBLIC_REPO_TOKEN }}
        run: |
          TAG="${{ github.event.inputs.tag || github.ref_name }}"
          gh release create "$TAG" --repo yelban/kiroku-public \
            --title "$TAG" --notes "Bytecode release for $TAG" \
            kiroku-*.tar.gz 2>/dev/null || \
          gh release upload "$TAG" --repo yelban/kiroku-public \
            --clobber kiroku-*.tar.gz
```

**關鍵差異**：
- matrix build → `upload-artifact`（中繼）
- `publish-release` 等全部 build 完成 → 一次性 `gh release create --repo yelban/kiroku-public`
- 用 `PUBLIC_REPO_TOKEN` 存取公開 repo

### 5. package.json 微調

```diff
+ "bugs": { "url": "https://github.com/yelban/kiroku-public/issues" },
+ "homepage": "https://github.com/yelban/kiroku-public#readme",
```

`repository.url` 已指向 `yelban/kiroku-public`，不需改。

### 6. .gitignore 補充（推送前確認）

```
server/.wrangler/
site/node_modules/
```

---

## 發版流程（日常）

```bash
# 在 kiroku-cli (private) 操作
npm version patch              # bump + tag
git push && git push --tags    # 觸發 CI → .jsc → yelban/kiroku-public Releases
# 等 CI 完成
npm publish                    # 發佈到 npmjs @kiroku/cli
```

使用者 `npm install -g @kiroku/cli` → postinstall 自動從公開 repo 下載 .jsc。

---

## 不做

- 不用 submodule（公開 repo 無程式碼可引用）
- 不用 platform-specific npm packages（.jsc 多了 node version 維度，需 9+ 個包，太繁瑣）
- 不同步 CHANGELOG 到公開 repo（release notes 寫在 release body 即可）
- 公開 repo 暫不開 Issues（視營運需求後續決定）

## 未解決

- Fine-Grained PAT 有效期最長 1 年，需設提醒續約
- 公開 repo 的 README 內容待撰寫（安裝指南 + 功能簡介）
- server/ (CF Worker) 和 site/ 是否未來獨立 repo — 暫保持在 kiroku-cli 內
