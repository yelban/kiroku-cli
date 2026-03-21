# Kiroku + tmux-resurrect 自動恢復

## 問題

在 tmux 裡同時開多個視窗跑 `kiroku start --dangerously-skip-permissions -c` 等指令，
重開機或 tmux server 重啟後，tmux-resurrect 能恢復視窗和工作目錄，
但不知道每個視窗原本跑的 kiroku 指令是什麼。

## 解決方案

兩個機制配合：

1. **Session state file** — kiroku 啟動時寫、退出時刪
2. **Resurrect hook script** — tmux 恢復後自動重跑 kiroku

### Session state file

`kiroku start` 啟動後會寫入：

```
~/.kiroku/run/sessions/<cwd-slug>.json
```

內容範例：

```json
{
  "cwd": "/Users/you/zoo/my-project",
  "argv": ["--dangerously-skip-permissions", "-c"],
  "command": "kiroku --dangerously-skip-permissions -c",
  "startedAt": "2026-03-21T10:00:00.000Z"
}
```

**生命週期：**

| 事件 | 動作 |
|------|------|
| `kiroku start` | 建立 session file |
| Claude 正常退出 | 刪除 session file |
| `kiroku stop` | 刪除 session file |
| 系統重開 / tmux 被殺 | session file 留存 → 可恢復 |

### Startup lock（防並發）

多個 kiroku 同時啟動時（例如 tmux-resurrect 同時恢復 5 個視窗），
用 `O_EXCL` 原子建檔（`proxy.lock` / `worker.lock`）做 double-checked locking，
確保只有一個 proxy 和一個 worker 被啟動。

## 安裝

### 前置條件

tmux + 以下插件（透過 TPM 安裝）：

- [tmux-resurrect](https://github.com/tmux-plugins/tmux-resurrect)
- [tmux-continuum](https://github.com/tmux-plugins/tmux-continuum)（選用，自動存/還原）

### 步驟

1. 複製 resurrect hook 腳本：

```bash
mkdir -p ~/.local/bin
cp extras/tmux/kiroku-resurrect ~/.local/bin/
chmod +x ~/.local/bin/kiroku-resurrect
```

2. 在 `~/.tmux.conf` 加入以下設定（放在 `run '~/.tmux/plugins/tpm/tpm'` 之前）：

```tmux
# ==================== Kiroku 自動恢復 ====================
# kiroku start 時寫 ~/.kiroku/run/sessions/<slug>.json (cwd + args)
# resurrect 還原後自動在對應 pane 重跑 kiroku
set -g @resurrect-hook-post-restore-all 'run-shell "~/.local/bin/kiroku-resurrect"'
```

或直接參考 `extras/tmux/tmux.conf.snippet`。

3. Reload tmux 設定：

```bash
tmux source ~/.tmux.conf
```

## 恢復流程

```
重開機 → tmux 啟動
  → tmux-continuum 自動恢復（或手動 prefix + Ctrl-r）
  → tmux-resurrect 還原所有 session/window/pane 及其工作目錄
  → @resurrect-hook-post-restore-all 觸發
  → kiroku-resurrect 腳本：
      遍歷 ~/.kiroku/run/sessions/*.json
      → 比對 pane 的 cwd + 確認是 idle shell
      → tmux send-keys 送出原始 kiroku 指令
  → 每個 kiroku 視窗自動恢復運作
```

## Claude Code sandbox 設定

搭配 `--dangerously-skip-permissions` 使用時，需要在 `~/.claude/settings.json` 的
sandbox allowWrite 加入 `~/.kiroku`，否則 kiroku 寫入 session state、log 等會被 sandbox 阻擋。

> **注意：`~/.claude/settings.json` 必須是嚴格 JSON 格式，不支援 `//` 或 `/* */` 註解。**
> 加了註解會導致解析失敗、設定不生效。

建議的 sandbox filesystem 設定：

```json
{
  "sandbox": {
    "filesystem": {
      "allowWrite": [
        "//tmp",
        "//private/tmp",
        "~/.kiroku",
        "~/.local",
        "~/.claude",
        "~/.cache",
        "~/.config",
        "~/.npm"
      ]
    }
  }
}
```

各路徑用途：

| 路徑 | 用途 |
|------|------|
| `~/.kiroku` | session state、proxy state、logs、DB、queue |
| `~/.local` | `~/.local/bin/kiroku-resurrect` 腳本 |
| `~/.claude` | 計畫檔、memory、debug log（settings.json 受 denyWithinAllow 硬保護） |
| `~/.cache` | uv、bun、deno 等工具快取 |
| `~/.config` | gh、git 等工具設定 |
| `~/.npm` | npm cache、publish 時需要 |

### denyWithinAllow（Claude Code 內建，無法關閉）

即使 `~/.claude` 在 allowWrite 中，以下路徑仍被 Claude Code 硬編碼保護：

- `~/.claude/settings.json`
- `.claude/settings.json`（專案層級）
- `.claude/settings.local.json`
- `.claude/skills/`
- `~/.bashrc`、`~/.zshrc`

## 檔案清單

| 檔案 | 用途 |
|------|------|
| `extras/tmux/kiroku-resurrect` | Hook 腳本，安裝到 `~/.local/bin/` |
| `extras/tmux/tmux.conf.snippet` | tmux.conf 設定片段 |
| `src/shared/paths.js` | `SESSIONS_DIR` 定義 |
| `bin/kiroku.js` | session state 寫入/刪除 + startup lock |
