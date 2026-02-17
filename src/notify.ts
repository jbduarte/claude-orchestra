import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { request } from 'node:https';
import { MAX_NOTIFICATION_LENGTH, NOTIFICATION_DEDUP_MS } from './constants.js';
import type { NotificationEvent } from './types.js';

// ---- Telegram config ----

interface TelegramConfig {
  botToken: string;
  chatId: number;
}

let telegramConfig: TelegramConfig | null = null;

export function loadTelegramConfig(configDir: string): void {
  try {
    const configPath = join(configDir, 'config.json');
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (raw?.telegram?.botToken && raw?.telegram?.chatId) {
      telegramConfig = {
        botToken: String(raw.telegram.botToken),
        chatId: Number(raw.telegram.chatId),
      };
    }
  } catch {
    // No config file or invalid — Telegram disabled
  }
}

// ---- Sanitization (CRITICAL: prevents osascript command injection) ----

function sanitizeForAppleScript(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, ' ')
    .replace(/\r/g, '')
    .slice(0, MAX_NOTIFICATION_LENGTH);
}

// ---- Telegram sender ----

function sendTelegram(title: string, body: string): void {
  if (!telegramConfig) return;

  const text = `*${title}*\n${body}`;
  const payload = JSON.stringify({
    chat_id: telegramConfig.chatId,
    text,
    parse_mode: 'Markdown',
  });

  const req = request(
    {
      hostname: 'api.telegram.org',
      path: `/bot${telegramConfig.botToken}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 10000,
    },
    () => {} // fire and forget
  );

  req.on('error', () => {}); // silently ignore errors
  req.write(payload);
  req.end();
}

// ---- Deduplication ----

const recentNotifications = new Map<string, number>();

function isDuplicate(key: string): boolean {
  const now = Date.now();
  const last = recentNotifications.get(key);
  if (last && (now - last) < NOTIFICATION_DEDUP_MS) return true;

  // Clean old entries
  for (const [k, t] of recentNotifications) {
    if (now - t > NOTIFICATION_DEDUP_MS * 2) recentNotifications.delete(k);
  }

  recentNotifications.set(key, now);
  return false;
}

// ---- Serialized dispatch (max 1 notification process at a time) ----

let pending = false;
const queue: Array<{ title: string; body: string; sound: boolean }> = [];

function processQueue(): void {
  if (pending || queue.length === 0) return;
  pending = true;

  const item = queue.shift()!;
  const done = () => {
    pending = false;
    processQueue();
  };

  // Always send to Telegram (async, non-blocking)
  sendTelegram(item.title, item.body);

  // macOS notification
  if (process.platform === 'darwin') {
    const safeTitle = sanitizeForAppleScript(item.title);
    const safeBody = sanitizeForAppleScript(item.body);
    const sound = item.sound ? ' sound name "Glass"' : '';
    const script = `display notification "${safeBody}" with title "${safeTitle}"${sound}`;
    execFile('osascript', ['-e', script], { timeout: 5000 }, done);
  } else if (process.platform === 'linux') {
    execFile(
      'notify-send',
      [item.title.slice(0, MAX_NOTIFICATION_LENGTH), item.body.slice(0, MAX_NOTIFICATION_LENGTH)],
      { timeout: 5000 },
      done,
    );
  } else {
    done();
  }
}

// ---- Public API ----

let enabled = true;

export function setNotificationsEnabled(value: boolean): void {
  enabled = value;
}

export function isNotificationsEnabled(): boolean {
  return enabled;
}

export function sendNotification(event: NotificationEvent): void {
  if (!enabled) return;
  if (isDuplicate(event.dedupeKey)) return;
  const sound = event.type === 'agent_idle' || event.type === 'needs_input';
  queue.push({ title: event.title, body: event.body, sound });
  processQueue();
}
