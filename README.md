# Claude Orchestra

Terminal dashboard for monitoring and managing multiple Claude Code sessions in parallel.

Watches `~/.claude/` for active sessions, teams, tasks, and agent messages — renders a live fullscreen TUI with desktop and Telegram notifications. When your sessions need attention, the Orchestra lets you know: *"Awaiting the Maestro."*

## Features

- **Live session monitoring** — Detects all running Claude Code sessions across Terminal.app, iTerm2, PyCharm, VS Code, and other terminals/IDEs
- **Working/idle status** — Shows whether each session is actively running tools or waiting for input
- **Teams and tasks** — Tracks Claude Code teams, task progress, and agent statuses
- **Messages** — Displays agent messages with highlighted action items (plan approvals, shutdown requests)
- **Desktop notifications** — macOS/Linux alerts when sessions finish, need input, or require approval
- **Telegram bot** — Monitor sessions and send messages from your phone
- **Send to session** — Type messages directly into running sessions via keystroke injection (Terminal.app, iTerm2, PyCharm, JetBrains IDEs)
- **Smart liveness detection** — Filters out closed sessions using process detection, with grace periods to avoid flickering

## Install

```sh
npm install -g claude-orchestra
```

Or run directly:

```sh
npx claude-orchestra
```

## Usage

```sh
claude-orchestra            # monitors ~/.claude/
claude-orchestra /path/dir  # monitors a custom directory
```

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Tab` / `Shift+Tab` | Cycle panels |
| `1` / `2` / `3` | Jump to Teams / Tasks / Messages |
| `q` | Quit |
| `n` | Toggle notifications |
| `r` | Force refresh |

## Dashboard Panels

**Sessions** — Active Claude Code sessions with project name, model, working/idle status, and last activity time

**Teams** — Active teams with members, roles, and status (green = active, yellow = idle, gray = stale)

**Tasks** — Task groups by team with completion counts and per-task status

**Messages** — Recent agent messages across all inboxes, with highlighted action items

## Telegram Bot (Optional)

Monitor your sessions remotely and send messages from your phone.

### Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) on Telegram and get the bot token
2. Get your chat ID (message [@userinfobot](https://t.me/userinfobot) on Telegram)
3. Create a `config.json` in the claude-orchestra directory:

```json
{
  "telegram": {
    "botToken": "YOUR_BOT_TOKEN",
    "chatId": "YOUR_CHAT_ID"
  }
}
```

4. Restart claude-orchestra — the bot starts automatically

### Telegram Commands

| Command | Description |
|---------|-------------|
| `/sessions` | List all active sessions with status |
| `/send N message` | Send a message to session N (from session list) |
| `/new /path/to/project [prompt]` | Start a new Claude session in Terminal.app |
| `/help` | Show available commands |

Shortcuts: `/s` for `/sessions`, `/s N message` for `/send`.

The bot also forwards notifications: session completions, idle alerts, and action items.

## Supported Terminals and IDEs

Session **detection** works with any terminal or IDE — it reads Claude's JSONL files and checks running processes.

Session **send** (keystroke injection) supports:

| App | Window targeting |
|-----|-----------------|
| Terminal.app | TTY-based tab matching |
| iTerm2 | TTY-based tab matching |
| PyCharm | Window title matching |
| IntelliJ IDEA | Window title matching |
| WebStorm | Window title matching |
| Other JetBrains IDEs | Window title matching |
| VS Code | Detection only (send not yet supported) |
| Cursor | Detection only (send not yet supported) |

## How It Works

- Scans `~/.claude/projects/` for JSONL session files modified in the last 4 hours
- Uses `ps` + `lsof` to detect running Claude processes and their working directories
- Filters closed sessions: 5-minute idle threshold before process check, 5-minute grace period after close
- Auto-kills orphaned child processes from closed sessions
- Watches filesystem with chokidar (500ms debounce) + periodic refresh as safety net
- Per-file mtime caching — only re-parses files that changed
- Resolves System Events process names at runtime for correct IDE window targeting

## Development

```sh
git clone https://github.com/jbduarte/claude-orchestra.git
cd claude-orchestra
npm install
npm start        # run with tsx
npm run dev      # run with tsx --watch
npm run build    # compile to dist/
```

## Requirements

- Node.js >= 20
- macOS (notifications and keystroke injection use AppleScript/System Events)
- Linux support: session detection and dashboard work; notifications use notify-send; keystroke injection not available

## License

MIT
