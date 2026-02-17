import { request as httpsRequest } from 'node:https';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sendToSession } from './chat.js';
import { findActiveSessions } from './sessions.js';
import type { SessionCache } from './sessions.js';
import type { ActiveSession } from './types.js';

// ---- Config ----

interface TelegramConfig {
  botToken: string;
  chatId: number;
}

let config: TelegramConfig | null = null;
let claudeDir = '';
let sessionCache: SessionCache = new Map();
let lastUpdateId = 0;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

// ---- HTTP helpers ----

function telegramApi(method: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!config) return Promise.reject(new Error('Telegram not configured'));

  const payload = body ? JSON.stringify(body) : undefined;

  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: 'api.telegram.org',
        path: `/bot${config!.botToken}/${method}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': String(Buffer.byteLength(payload)) } : {}),
        },
        timeout: 30000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error('Invalid JSON response'));
          }
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function sendReply(text: string): void {
  if (!config) return;
  telegramApi('sendMessage', {
    chat_id: config.chatId,
    text,
    parse_mode: 'Markdown',
  }).catch(() => {});
}

// ---- Session helpers ----

function getSessions(): ActiveSession[] {
  return findActiveSessions(claudeDir, sessionCache);
}

function sessionLabel(s: ActiveSession): string {
  if (s.cwd) {
    const parts = s.cwd.split('/');
    return parts[parts.length - 1] || s.cwd;
  }
  return s.project || s.sessionId.slice(0, 7);
}

// ---- Command handlers ----

function handleSessions(): void {
  const sessions = getSessions();
  if (sessions.length === 0) {
    sendReply('No active sessions.');
    return;
  }

  const lines = sessions.map((s, i) => {
    const age = Date.now() - s.lastActivityMs;
    const status = age < 60000 ? '🟢 working' : '🟡 idle';
    const label = sessionLabel(s);
    const lastEntry = s.entries[s.entries.length - 1];
    const lastText = lastEntry ? lastEntry.text.slice(0, 80) : '';
    return `*${i + 1}.* ${label} — ${status}\n   _${lastText}_`;
  });

  sendReply(`*Active Sessions (${sessions.length}):*\n\n${lines.join('\n\n')}`);
}

function handleSend(args: string): void {
  const match = args.match(/^(\d+)\s+(.+)/s);
  if (!match) {
    sendReply('Usage: `/send <number> <message>`\nExample: `/send 1 fix the bug`');
    return;
  }

  const idx = parseInt(match[1]!, 10) - 1;
  const message = match[2]!.trim();

  const sessions = getSessions();
  if (idx < 0 || idx >= sessions.length) {
    sendReply(`Invalid session number. Use /sessions to see available sessions (1-${sessions.length}).`);
    return;
  }

  const session = sessions[idx]!;
  if (!session.cwd) {
    sendReply(`Session ${idx + 1} has no CWD — cannot send.`);
    return;
  }

  const result = sendToSession(session.cwd, message);
  if (result.success) {
    sendReply(`✅ Sent to *${sessionLabel(session)}*:\n\`${message}\``);
  } else {
    sendReply(`❌ Failed: ${result.error}`);
  }
}

function handleStatus(): void {
  const sessions = getSessions();
  const working = sessions.filter(s => Date.now() - s.lastActivityMs < 60000).length;
  const idle = sessions.length - working;
  sendReply(`*Status:* ${sessions.length} sessions\n🟢 ${working} working\n🟡 ${idle} idle`);
}

function handleHelp(): void {
  sendReply(
    '*Claude Orchestra Commands:*\n\n' +
    '`/sessions` — List active sessions\n' +
    '`/send <n> <msg>` — Send message to session n\n' +
    '`/status` — Quick overview\n' +
    '`/help` — Show this help'
  );
}

function handleMessage(text: string): void {
  const trimmed = text.trim();

  if (trimmed === '/sessions' || trimmed === '/s') {
    handleSessions();
  } else if (trimmed === '/status') {
    handleStatus();
  } else if (trimmed === '/help' || trimmed === '/start') {
    handleHelp();
  } else if (trimmed.startsWith('/send ') || trimmed.startsWith('/s ')) {
    const args = trimmed.startsWith('/send ') ? trimmed.slice(6) : trimmed.slice(3);
    handleSend(args);
  } else if (/^\/?\d+\s+/.test(trimmed)) {
    // Shorthand: "1 fix the bug" or "/1 fix the bug"
    const cleaned = trimmed.replace(/^\//, '');
    handleSend(cleaned);
  } else {
    // Unknown command — show help hint
    sendReply('Unknown command. Send `/help` for available commands.');
  }
}

// ---- Polling loop ----

async function poll(): Promise<void> {
  if (!config) return;

  try {
    const response = await telegramApi('getUpdates', {
      offset: lastUpdateId + 1,
      timeout: 10,
      allowed_updates: ['message'],
    });

    const results = (response as { result?: Array<Record<string, unknown>> }).result;
    if (Array.isArray(results)) {
      for (const update of results) {
        const updateId = update['update_id'] as number;
        if (updateId > lastUpdateId) lastUpdateId = updateId;

        const msg = update['message'] as Record<string, unknown> | undefined;
        if (!msg) continue;

        // Only handle messages from the configured chat
        const chat = msg['chat'] as Record<string, unknown> | undefined;
        if (chat?.['id'] !== config.chatId) continue;

        const text = msg['text'] as string | undefined;
        if (text) handleMessage(text);
      }
    }
  } catch {
    // Network error — will retry on next poll
  }

  // Schedule next poll
  pollTimer = setTimeout(() => { poll(); }, 1000);
}

// ---- Public API ----

export function startTelegramBot(configDir: string, claudeDirPath: string): void {
  claudeDir = claudeDirPath;

  try {
    const configPath = join(configDir, 'config.json');
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (raw?.telegram?.botToken && raw?.telegram?.chatId) {
      config = {
        botToken: String(raw.telegram.botToken),
        chatId: Number(raw.telegram.chatId),
      };
    }
  } catch {
    return; // No config — don't start
  }

  if (!config) return;

  // Start polling
  poll();
}

export function stopTelegramBot(): void {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}
