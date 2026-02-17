# Claude Orchestra

Terminal dashboard for monitoring multiple Claude Code sessions in parallel.

Watches `~/.claude/` for teams, tasks, and agent messages — renders a live fullscreen TUI with desktop notifications.

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

## What It Shows

**Teams Panel** — Active teams with members, roles, and status (green=active, yellow=idle, gray=stale)

**Tasks Panel** — Task groups by team with completion counts and per-task status

**Messages Panel** — Recent agent messages across all inboxes, with highlighted action items (plan approvals, shutdown requests)

**Status Bar** — Session/message totals and keyboard hints

## How It Works

- Watches `~/.claude/teams/`, `~/.claude/tasks/`, and inbox files with chokidar
- Single watcher with 500ms debounce for consistent cross-panel state
- Per-file mtime caching — only re-parses files that actually changed
- macOS/Linux desktop notifications for completed tasks and action items
- All notification text is sanitized before osascript execution

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
- macOS or Linux (notifications use osascript / notify-send)

## License

MIT
