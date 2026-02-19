import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { request } from 'node:https';
import { NOTIFICATION_DEDUP_MS } from './constants.js';
import { platform } from './platform.js';
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

// ---- Telegram sender ----

const TELEGRAM_MAX_LENGTH = 4096;

function escHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function sendTelegramMessage(html: string): void {
  if (!telegramConfig) return;

  const payload = JSON.stringify({
    chat_id: telegramConfig.chatId,
    text: html,
    parse_mode: 'HTML',
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
    (res) => {
      // If HTML parse fails, retry as plain text
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const resp = JSON.parse(data);
          if (!resp.ok) {
            const plain = JSON.stringify({
              chat_id: telegramConfig!.chatId,
              text: html.replace(/<[^>]+>/g, ''),
            });
            const retry = request({
              hostname: 'api.telegram.org',
              path: `/bot${telegramConfig!.botToken}/sendMessage`,
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(plain) },
              timeout: 10000,
            }, () => {});
            retry.on('error', () => {});
            retry.write(plain);
            retry.end();
          }
        } catch { /* ignore */ }
      });
    }
  );

  req.on('error', () => {});
  req.write(payload);
  req.end();
}

function sendTelegram(title: string, body: string): void {
  if (!telegramConfig) return;

  const header = `<b>${escHtml(title)}</b>\n`;
  const maxBody = TELEGRAM_MAX_LENGTH - header.length;

  if (body.length <= maxBody) {
    sendTelegramMessage(header + body);
    return;
  }

  // Split long messages into chunks, breaking at newlines when possible
  let remaining = body;
  let partNum = 1;

  while (remaining.length > 0) {
    const partHeader = partNum === 1 ? header : `<b>${escHtml(title)} (cont.)</b>\n`;
    const chunkSize = TELEGRAM_MAX_LENGTH - partHeader.length;
    let chunk: string;

    if (remaining.length <= chunkSize) {
      chunk = remaining;
      remaining = '';
    } else {
      // Try to break at a newline within the last 20% of the chunk
      const searchStart = Math.floor(chunkSize * 0.8);
      const breakIdx = remaining.lastIndexOf('\n', chunkSize);
      if (breakIdx > searchStart) {
        chunk = remaining.slice(0, breakIdx);
        remaining = remaining.slice(breakIdx + 1);
      } else {
        chunk = remaining.slice(0, chunkSize);
        remaining = remaining.slice(chunkSize);
      }
    }

    sendTelegramMessage(partHeader + chunk);
    partNum++;
  }
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
const queue: Array<{ title: string; body: string; sound: boolean; telegramBody?: string }> = [];

function processQueue(): void {
  if (pending || queue.length === 0) return;
  pending = true;

  const item = queue.shift()!;
  const done = () => {
    pending = false;
    processQueue();
  };

  // Always send to Telegram (async, non-blocking) — use full body if available
  sendTelegram(item.title, item.telegramBody ?? item.body);

  // Platform-specific desktop notification
  platform.sendNotification(item.title, item.body, item.sound, done);
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
  queue.push({ title: event.title, body: event.body, sound, telegramBody: event.telegramBody });
  processQueue();
}
