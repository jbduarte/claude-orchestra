#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { withFullScreen } from 'fullscreen-ink';
import App from './app.js';
import { DEFAULT_CLAUDE_DIR } from './constants.js';
import { loadTelegramConfig } from './notify.js';
import { startTelegramBot, stopTelegramBot } from './telegram.js';

const HELP = `Claude Orchestra — Terminal dashboard for Claude Code sessions

Usage: claude-orchestra [dir]

Arguments:
  dir    Path to .claude directory (default: ~/.claude)

Keyboard shortcuts:
  Tab / Shift+Tab   Switch sessions
  1-9                Jump to session by number
  Enter              Focus session window
  i                  Send message to session
  s                  Start new session
  k                  Kill session
  ↑ / ↓              Scroll conversation
  n                  Toggle notifications
  r                  Force refresh
  q                  Quit`;

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(HELP);
  process.exit(0);
}

const claudeDir = args[0] ?? DEFAULT_CLAUDE_DIR;

if (!existsSync(claudeDir)) {
  console.error(`Error: directory not found: ${claudeDir}`);
  process.exit(1);
}

if (!process.stdin.isTTY) {
  console.error('Error: claude-orchestra requires an interactive terminal (TTY).');
  process.exit(1);
}

// Maximize terminal window (macOS only — not fullscreen, just fill the screen)
if (process.platform === 'darwin') {
  try {
    execSync(`osascript -e '
      tell application "System Events"
        set frontApp to name of first application process whose frontmost is true
      end tell
      tell application frontApp
        if (count of windows) > 0 then
          tell application "Finder" to set {_, _, screenW, screenH} to bounds of window of desktop
          set bounds of front window to {0, 25, screenW, screenH}
        end if
      end tell
    '`, { timeout: 3000, stdio: 'ignore' });
  } catch { /* ignore — non-critical */ }
}

// Load Telegram config from project root (config.json)
const configDir = new URL('..', import.meta.url).pathname;
loadTelegramConfig(configDir);
startTelegramBot(configDir, claudeDir);

const { start, waitUntilExit } = withFullScreen(<App claudeDir={claudeDir} />);

process.on('SIGINT', () => { stopTelegramBot(); process.exit(0); });
process.on('SIGTERM', () => { stopTelegramBot(); process.exit(0); });

await start();
await waitUntilExit();
stopTelegramBot();
process.exit(0);
