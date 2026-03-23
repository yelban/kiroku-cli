# Claude Code Sandbox、Hooks 與權限設定指南

基於實際踩坑經驗整理的最佳實踐，搭配 `--dangerously-skip-permissions` 使用。

## 架構概覽：三層安全防線

```
┌─────────────────────────────────────────────┐
│  1. Permissions (deny list)                 │  ← 工具層級：擋 sudo、保護敏感檔
│  2. Hooks (PreToolUse / PostToolUse)        │  ← 指令層級：擋 rm -rf、記錄 audit log
│  3. Sandbox (OS-level)                      │  ← 系統層級：檔案/網路隔離
└─────────────────────────────────────────────┘

- deny list 和 hooks 在 --dangerously-skip-permissions 模式下仍然有效
- sandbox 用 OS 原生機制強制執行（macOS Seatbelt / Linux bubblewrap）
- denyWithinAllow 硬編碼保護 settings.json 等檔案，無法覆寫
```

## settings.json 格式注意

> **`~/.claude/settings.json` 必須是嚴格 JSON 格式，不支援 `//` 或 `/* */` 註解。**
> 加了註解會導致解析失敗、設定不生效。

## Permissions（權限規則）

### Allow list — 免確認白名單

搭配 `--dangerously-skip-permissions` 時 allow list 不影響行為（全部自動核准），
但在一般模式下可以減少確認提示。

```json
"allow": [
  "Bash(ls *)", "Bash(cat *)", "Bash(find *)", "Bash(stat *)",
  "Bash(git *)", "Bash(npm *)", "Bash(npx *)", "Bash(node *)",
  "Bash(bun *)", "Bash(deno *)", "Bash(gh *)", "Bash(go *)",
  "Bash(cargo *)", "Bash(brew *)", "Bash(uv *)",
  "Bash(python *)", "Bash(python3 *)",
  "Bash(tmux *)", "Bash(trash *)", "Bash(ffmpeg *)",
  "Bash(rclone *)", "Bash(pandoc *)"
]
```

### Deny list — 永遠拒絕

**即使在 `--dangerously-skip-permissions` 模式下，deny list 仍然有效。**

```json
"deny": [
  "Bash(sudo:*)",
  "Bash(su:*)",
  "Bash(mkfs:*)",
  "Bash(dd:*)",
  "Read(~/.aws/**)",
  "Read(~/.ssh/id_*)",
  "Read(~/.ssh/*.pem)",
  "Read(~/.gnupg/**)",
  "Read(~/.npmrc)",
  "Edit(~/.bashrc)",
  "Edit(~/.zshrc)",
  "Edit(~/.ssh/**)",
  "Edit(~/.gnupg/**)"
]
```

### SSH deny 的正確寫法（踩坑紀錄）

**問題：** `Read(~/.ssh/**)` 會把整個 `~/.ssh/` 都擋掉，包括 `known_hosts`。
Permissions deny 規則會被合併到 sandbox 的 filesystem 限制中，
導致 `git push`（SSH）無法驗證 host key 而失敗：

```
hostkeys_find_by_key_hostfile: hostkeys_foreach failed for
  /Users/you/.ssh/known_hosts: Operation not permitted
```

**原因：** sandbox 預設的 read deny 只擋私鑰：

```
denyOnly: ["~/.ssh/id_*", "~/.ssh/*.pem"]   ← 預設，known_hosts 可讀
```

但 `Read(~/.ssh/**)` 合併後變成擋整個目錄 → `known_hosts` 也被擋。

**正確做法：** 只擋私鑰，與 sandbox 預設保持一致：

```json
"Read(~/.ssh/id_*)",
"Read(~/.ssh/*.pem)"
```

**不正確：**

```json
"Read(~/.ssh/**)"     // ← 會擋 known_hosts，git push 失敗
```

## Hooks

### PreToolUse：block-dangerous-rm.sh

攔截 `rm -rf` / `rm -r`（`/tmp` 除外），在 Bash 指令執行前觸發。

```bash
#!/usr/bin/env bash
set -euo pipefail
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:$HOME/.bun/bin:$HOME/.deno/bin:$HOME/.cargo/bin:$HOME/.local/bin:$HOME/.nvm/versions/node/v22.21.1/bin:$HOME/.orbstack/bin:$PATH"

INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
[ -z "$CMD" ] && exit 0

if echo "$CMD" | grep -qE '\brm\s+[^|;]*-(r|rf|fr|Rf|fR)\b'; then
  if echo "$CMD" | grep -qE '\brm\s+[^|;]*-(r|rf|fr|Rf|fR)\s+/tmp/'; then
    exit 0
  fi
  echo "BLOCKED: 禁止使用 rm -rf / rm -r，請改用 trash 或逐一刪除" >&2
  exit 2
fi

exit 0
```

**已知限制：** 只擋 `rm -r*` 語法，以下繞得過去：
- `find / -delete`
- `perl -e 'unlink ...'`
- `> important_file`（truncate）

### PostToolUse：audit-log.sh

記錄所有 Bash 指令到 `~/.claude/logs/bash-audit.log`。

```bash
#!/usr/bin/env bash
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:$HOME/.bun/bin:$HOME/.deno/bin:$HOME/.cargo/bin:$HOME/.local/bin:$HOME/.nvm/versions/node/v22.21.1/bin:$HOME/.orbstack/bin:$PATH"

mkdir -p "${HOME}/.claude/logs"

INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
[ -z "$CMD" ] && exit 0

echo "[$(date -Iseconds)] [$(pwd)] $CMD" >> "${HOME}/.claude/logs/bash-audit.log"

exit 0
```

### Hook 設定

```json
"hooks": {
  "PreToolUse": [{
    "matcher": "Bash",
    "hooks": [{
      "type": "command",
      "command": "bash ~/.claude/hooks/block-dangerous-rm.sh"
    }]
  }],
  "PostToolUse": [{
    "matcher": "Bash",
    "hooks": [{
      "type": "command",
      "command": "bash ~/.claude/hooks/audit-log.sh"
    }]
  }]
}
```

## Sandbox

### 檔案系統：allowWrite

sandbox 預設只允許寫入當前工作目錄。以下路徑需要額外開放：

```json
"filesystem": {
  "allowWrite": [
    "//tmp",
    "//private/tmp",
    "~/.cache/uv",
    "~/Library/Caches",
    "~/.codex-agent",
    "~/.claude",
    "~/.kiroku",
    "~/.local",
    "~/.config",
    "~/.npm",
    "~/.bun",
    "~/.cargo",
    "~/.rustup",
    "~/.deno",
    "~/.tmux",
    "~/.tmux.conf",
    "~/go"
  ]
}
```

| 路徑 | 用途 |
|------|------|
| `//tmp`, `//private/tmp` | 系統暫存（POSIX / macOS） |
| `~/.cache/uv`, `~/Library/Caches` | uv、bun、deno 等工具快取 |
| `~/.claude` | 計畫檔、memory、debug log |
| `~/.kiroku` | session state、proxy state、logs、DB |
| `~/.local` | `~/.local/bin/` 自訂腳本、uv 虛擬環境 |
| `~/.config` | gh、git、rclone 等工具設定 |
| `~/.npm` | npm cache（`npm publish` 需要） |
| `~/.bun` | bun global install、cache |
| `~/.cargo`, `~/.rustup` | Rust 工具鏈 |
| `~/.deno` | Deno cache |
| `~/.tmux`, `~/.tmux.conf` | tmux 插件和設定 |
| `~/go` | Go workspace |

#### 路徑前綴語法

| 前綴 | 意義 | 範例 |
|------|------|------|
| `/` | 絕對路徑 | `/tmp/build` |
| `~/` | 相對 home 目錄 | `~/.kube` → `$HOME/.kube` |
| `./` 或無前綴 | 相對專案根目錄 | `./output` → `<project-root>/output` |
| `//` | 舊版絕對路徑語法（仍支援） | `//tmp` → `/tmp` |

#### 不該加入 allowWrite 的路徑

| 路徑 | 原因 |
|------|------|
| `~/.ssh` | SSH 金鑰 |
| `~/.aws` | AWS credentials |
| `~/.gnupg` | GPG 私鑰 |
| `~/.docker` | Docker credential store |
| `~/.nvm` | Node 版本管理，改壞影響整個環境 |

### 檔案系統：read 權限合併規則

sandbox 有四個 filesystem 設定，優先序規則**讀寫相反**：

| 設定 | 用途 | 優先序 |
|------|------|--------|
| `allowRead` | 允許讀取 | **覆寫** denyRead |
| `denyRead` | 禁止讀取 | 被 allowRead 覆寫 |
| `allowWrite` | 允許寫入 | 被 denyWrite 覆寫 |
| `denyWrite` | 禁止寫入 | **覆寫** allowWrite |

**重要：** permissions 的 `Read(...)` 和 `Edit(...)` deny 規則會被**合併**到 sandbox
的 filesystem 限制中。這就是 `Read(~/.ssh/**)` 會擋 `known_hosts` 的原因。

### denyWithinAllow（Claude Code 硬編碼，無法關閉）

即使 `~/.claude` 在 allowWrite 中，以下路徑仍被 Claude Code 硬編碼保護：

- `~/.claude/settings.json`（全域設定）
- `.claude/settings.json`（專案設定）
- `.claude/settings.local.json`（專案本地設定）
- `.claude/skills/`（技能定義檔）
- `~/.bashrc`、`~/.zshrc`（Shell 設定）

### 網路：allowedDomains

```json
"network": {
  "allowedDomains": [
    "registry.npmjs.org",
    "pypi.org",
    "files.pythonhosted.org",
    "github.com",
    "api.github.com",
    "raw.githubusercontent.com",
    "objects.githubusercontent.com",
    "crates.io",
    "static.crates.io",
    "api.openai.com",
    "arxiv.org"
  ],
  "allowAllUnixSockets": true
}
```

注意：`allowedDomains` 控制的是 HTTP/HTTPS proxy。SSH（port 22）不經過 proxy，
由 `enableWeakerNetworkIsolation: true` 控制是否放行。

### dangerouslyDisableSandbox

當 sandbox 擋住必要操作時，Claude 會自動嘗試 `dangerouslyDisableSandbox: true`
重新執行。此行為可透過 `allowUnsandboxedCommands` 控制：

```json
"allowUnsandboxedCommands": true    // 允許（預設）
"allowUnsandboxedCommands": false   // 完全禁止 unsandboxed 執行
```

### excludedCommands

完全排除在 sandbox 之外的指令（不經過 sandbox，走正常權限流程）：

```json
"excludedCommands": ["codex", "codex-agent"]
```

## 完整 settings.json 參考

基於實際系統的完整設定，可作為範本：

```json
{
  "env": {
    "ENABLE_LSP_TOOL": "1"
  },
  "permissions": {
    "allow": [
      "Bash(tail *)", "Bash(head *)", "Bash(cat *)", "Bash(ls *)",
      "Bash(find *)", "Bash(du *)", "Bash(wc *)", "Bash(stat *)",
      "Bash(ps *)", "Bash(date*)", "Bash(pgrep *)", "Bash(grep *)",
      "Bash(sleep *)", "Bash(source *)", "Bash(cd *)", "Bash(cp *)",
      "Bash(mkdir *)", "Bash(chmod *)",
      "Bash(git *)", "Bash(npm *)", "Bash(npx *)", "Bash(node *)",
      "Bash(bun *)", "Bash(deno *)", "Bash(gh *)", "Bash(go *)",
      "Bash(cargo *)", "Bash(brew *)", "Bash(tmux *)", "Bash(trash *)",
      "Bash(ffmpeg *)", "Bash(rclone *)", "Bash(pandoc *)",
      "Bash(uv *)", "Bash(python *)", "Bash(python3 *)"
    ],
    "deny": [
      "Bash(sudo:*)", "Bash(su:*)", "Bash(mkfs:*)", "Bash(dd:*)",
      "Read(~/.aws/**)",
      "Read(~/.ssh/id_*)", "Read(~/.ssh/*.pem)",
      "Read(~/.gnupg/**)", "Read(~/.npmrc)",
      "Edit(~/.bashrc)", "Edit(~/.zshrc)",
      "Edit(~/.ssh/**)", "Edit(~/.gnupg/**)"
    ]
  },
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{ "type": "command", "command": "bash ~/.claude/hooks/block-dangerous-rm.sh" }]
    }],
    "PostToolUse": [{
      "matcher": "Bash",
      "hooks": [{ "type": "command", "command": "bash ~/.claude/hooks/audit-log.sh" }]
    }]
  },
  "sandbox": {
    "enabled": true,
    "autoAllowBashIfSandboxed": true,
    "allowUnsandboxedCommands": true,
    "network": {
      "allowedDomains": [
        "registry.npmjs.org", "pypi.org", "files.pythonhosted.org",
        "github.com", "api.github.com", "raw.githubusercontent.com",
        "objects.githubusercontent.com",
        "crates.io", "static.crates.io",
        "api.openai.com", "arxiv.org"
      ],
      "allowAllUnixSockets": true
    },
    "filesystem": {
      "allowWrite": [
        "//tmp", "//private/tmp",
        "~/.cache/uv", "~/Library/Caches",
        "~/.codex-agent", "~/.claude", "~/.kiroku", "~/.local",
        "~/.config", "~/.npm", "~/.bun", "~/.cargo", "~/.rustup",
        "~/.deno", "~/.tmux", "~/.tmux.conf", "~/go"
      ]
    },
    "enableWeakerNetworkIsolation": true,
    "excludedCommands": ["codex", "codex-agent"]
  },
  "language": "zh-TW，請使用台灣標準科技詞彙（如：檔案、介面、資料）。",
  "effortLevel": "high",
  "promptSuggestionEnabled": false,
  "skipDangerousModePermissionPrompt": true
}
```

## 參考資料

- [Sandboxing - Claude Code Docs](https://code.claude.com/docs/en/sandboxing)
- [Permissions - Claude Code Docs](https://code.claude.com/docs/en/permissions)
- [Settings - Claude Code Docs](https://code.claude.com/docs/en/settings)
- [sandbox-runtime (GitHub)](https://github.com/anthropic-experimental/sandbox-runtime)
