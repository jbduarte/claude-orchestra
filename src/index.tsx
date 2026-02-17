#!/usr/bin/env node
import { existsSync } from 'node:fs';
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
  Tab / Shift+Tab   Cycle panels
  1 / 2 / 3         Jump to Teams / Tasks / Messages
  q                  Quit
  n                  Toggle notifications
  r                  Force refresh`;

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

// Load Telegram config from project root (config.json)
const configDir = new URL('..', import.meta.url).pathname;
loadTelegramConfig(configDir);
startTelegramBot(configDir, claudeDir);

const { start, waitUntilExit } = withFullScreen(<App claudeDir={claudeDir} />);

process.on('SIGINT', () => { stopTelegramBot(); process.exit(0); });
process.on('SIGTERM', () => { stopTelegramBot(); process.exit(0); });

await start();
await waitUntilExit();
