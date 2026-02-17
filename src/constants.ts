import { homedir } from 'node:os';
import { join } from 'node:path';

// ---- Paths ----

export const DEFAULT_CLAUDE_DIR = join(homedir(), '.claude');

// ---- Staleness thresholds ----

export const ACTIVE_THRESHOLD_MS = 2 * 60 * 1000;   // 2 minutes
export const STALE_THRESHOLD_MS = 10 * 60 * 1000;    // 10 minutes

// ---- File watching ----

export const DEBOUNCE_MS = 500;
export const AWAIT_WRITE_STABILITY_MS = 300;
export const AWAIT_WRITE_POLL_MS = 100;

export const AUTO_REFRESH_MS = 30_000;             // 30 seconds — safety net for missed watcher events

// ---- Notifications ----

export const NOTIFICATION_DEDUP_MS = 30_000;   // 30 seconds
export const MAX_NOTIFICATION_LENGTH = 200;

// ---- Display ----

export const MAX_MESSAGES_DISPLAYED = 50;
export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;  // 10MB
export const MIN_TERMINAL_WIDTH = 80;
export const MIN_TERMINAL_HEIGHT = 24;
