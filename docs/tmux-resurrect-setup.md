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

## tmux + iTerm2 最佳化（Claude Code 場景）

Claude Code 在 tmux 裡會有三個常見問題：畫面閃爍、滑鼠複製失敗、滾動卡頓。
以下是針對 iTerm2 + tmux 環境的完整設定。

### 問題與對策

| 問題 | 原因 | 修法 |
|------|------|------|
| 畫面閃爍 | `set-titles on` 在高頻輸出時不斷送 escape sequence 更新 title bar | `set-titles off` |
| 滑鼠選取複製不到、反白不消失 | tmux 攔截滑鼠進入 copy-mode，但沒接到系統剪貼簿 | `copy-pipe-and-cancel "pbcopy"` |
| 滾動卡頓 | tmux 預設每個 wheel tick 跳 5 行 | 改成 2 行 + iTerm2 關閉 arrow key 模式 |

### 完整 tmux.conf 設定

```tmux
# --- 防閃爍 ---
set -g allow-passthrough on        # 讓 DEC 2026 synchronized output 穿透
set -g set-titles off              # 關掉！高頻輸出時 title escape 會造成閃爍
set -g default-terminal "tmux-256color"
set -ga terminal-overrides ",xterm-256color:RGB"
set -g status-interval 30          # status bar 更新頻率降低（預設 15）
set -g history-limit 250000        # Claude Code 高吞吐量需要更大 scrollback

# --- 剪貼簿 + 滑鼠複製 ---
set -g mouse on
set -g set-clipboard on
set -as terminal-features ',xterm-256color:clipboard'
setw -g mode-keys vi

# 滑鼠拖選放開 → 自動複製到系統剪貼簿 + 清除反白 + 退出 copy-mode
bind-key -T copy-mode-vi MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel "pbcopy"
bind-key -T copy-mode-vi y send-keys -X copy-pipe-and-cancel "pbcopy"
bind-key -T copy-mode-vi Enter send-keys -X copy-pipe-and-cancel "pbcopy"

# --- 滾動優化 ---
bind-key -T copy-mode-vi WheelUpPane send-keys -X -N 2 scroll-up
bind-key -T copy-mode-vi WheelDownPane send-keys -X -N 2 scroll-down
```

### iTerm2 設定（GUI）

| 位置 | 設定 | 值 |
|------|------|----|
| General > Selection | Applications in terminal may access clipboard | 勾選 |
| General > Selection | Allow sending of clipboard contents | Ask Each Time |
| Advanced > Mouse | Scroll wheel sends arrow keys when in alternate screen mode | **No** |

> **提示：** 改完 tmux.conf 後需要 `tmux kill-server` 完全重啟，
> 不能只用 `tmux source`，因為 `terminal-overrides` 等設定需要重新初始化。
>
> 臨時 workaround：按住 **Option** 鍵再拖選，iTerm2 會繞過 tmux 直接處理複製。

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
