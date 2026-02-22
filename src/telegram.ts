import { request as httpsRequest } from 'node:https';
import { readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { sendToSession, startNewSession, killSession } from './chat.js';
import { findActiveSessions } from './sessions.js';
import { platform } from './platform.js';
import type { SessionCache } from './sessions.js';
import type { ActiveSession } from './types.js';

// ---- Config ----

interface TelegramConfig {
  botToken: string;
  chatId: number;
  skipPermissions?: boolean;
}

let config: TelegramConfig | null = null;
let claudeDir = '';
let sessionCache: SessionCache = new Map();
let lastUpdateId = 0;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

// ---- HTML escaping (safe for all dynamic content) ----

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

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
    req.on('timeout', () => {
      req.destroy(new Error('Telegram API request timed out'));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function sendReply(html: string): void {
  if (!config) return;
  telegramApi('sendMessage', {
    chat_id: config.chatId,
    text: html,
    parse_mode: 'HTML',
  }).catch((err) => {
    // Fallback: send as plain text if HTML fails
    telegramApi('sendMessage', {
      chat_id: config!.chatId,
      text: html.replace(/<[^>]+>/g, ''),
    }).catch(() => {});
  });
}

// ---- Session helpers ----

function getSessions(): ActiveSession[] {
  return findActiveSessions(claudeDir, sessionCache);
}

function sessionLabel(s: ActiveSession): string {
  if (s.cwd) {
    return basename(s.cwd) || s.cwd;
  }
  return s.project || s.sessionId.slice(0, 7);
}

/** Resolve a session by 1-based index or project name (case-insensitive substring). */
function findSession(query: string): { session: ActiveSession; index: number; sessions: ActiveSession[] } | { error: string; sessions: ActiveSession[] } {
  const sessions = getSessions();
  if (sessions.length === 0) {
    return { error: 'No active sessions.', sessions };
  }

  // Try numeric index first
  const num = parseInt(query, 10);
  if (!isNaN(num) && String(num) === query.trim()) {
    const idx = num - 1;
    if (idx < 0 || idx >= sessions.length) {
      return { error: `Invalid index ${num}. Run /sessions to see available (1-${sessions.length}).`, sessions };
    }
    return { session: sessions[idx]!, index: idx, sessions };
  }

  // Name-based matching (case-insensitive)
  const q = query.toLowerCase();
  const matches: Array<{ session: ActiveSession; index: number }> = [];
  for (let i = 0; i < sessions.length; i++) {
    const label = sessionLabel(sessions[i]!).toLowerCase();
    if (label === q) {
      // Exact match — return immediately
      return { session: sessions[i]!, index: i, sessions };
    }
    if (label.includes(q)) {
      matches.push({ session: sessions[i]!, index: i });
    }
  }

  if (matches.length === 1) {
    return { session: matches[0]!.session, index: matches[0]!.index, sessions };
  }
  if (matches.length > 1) {
    const list = matches.map(m => `  ${m.index + 1}. ${esc(sessionLabel(m.session))}`).join('\n');
    return { error: `Multiple sessions match "${esc(query)}":\n${list}\nBe more specific or use the number.`, sessions };
  }

  return { error: `No session matching "${esc(query)}". Run /sessions to see available.`, sessions };
}

function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function sessionStatus(s: ActiveSession): { emoji: string; label: string } {
  const age = Date.now() - s.lastActivityMs;
  if (age < 60_000) return { emoji: '🟢', label: 'working' };
  if (age < 180_000) {
    const last = s.entries[s.entries.length - 1];
    if (last?.type === 'tool_use') return { emoji: '🟢', label: 'working' };
  }
  return { emoji: '🟡', label: 'idle' };
}

function lastActivity(s: ActiveSession): string {
  const last = s.entries[s.entries.length - 1];
  if (!last) return 'no activity';

  if (last.type === 'tool_use') {
    return `🔧 ${esc(last.text.slice(0, 100))}`;
  }
  if (last.type === 'assistant') {
    const firstLine = last.text.split('\n')[0] ?? '';
    return esc(firstLine.slice(0, 120));
  }
  if (last.type === 'user') {
    return `👤 ${esc(last.text.slice(0, 100))}`;
  }
  return 'no activity';
}

// ---- Command handlers ----

function handleSessions(): void {
  const sessions = getSessions();
  if (sessions.length === 0) {
    sendReply('No active sessions.');
    return;
  }

  const working = sessions.filter(s => sessionStatus(s).label === 'working').length;
  const idle = sessions.length - working;

  const lines = sessions.map((s, i) => {
    const status = sessionStatus(s);
    const label = sessionLabel(s);
    const model = s.model?.replace('claude-', '').split('-202')[0] ?? '';
    const activity = lastActivity(s);

    return (
      `${status.emoji} <b>${i + 1}. ${esc(label)}</b>  <i>${status.label} · ${timeAgo(s.lastActivityMs)}</i>` +
      (model ? `  [${esc(model)}]` : '') +
      `\n   ${activity}`
    );
  });

  const header = `<b>Sessions (${sessions.length})</b>  🟢 ${working} working  🟡 ${idle} idle\n`;
  sendReply(header + '\n' + lines.join('\n\n'));
}

function handleSend(args: string): void {
  // Parse: first token is session identifier (number or name), rest is the message
  const match = args.match(/^(\S+)\s+(.+)/s);
  if (!match) {
    sendReply('Usage: <code>/send orchestra fix the bug</code>\nor: <code>/send 1 fix the bug</code>');
    return;
  }

  const query = match[1]!;
  const message = match[2]!.trim();

  const result = findSession(query);
  if ('error' in result) {
    sendReply(result.error);
    return;
  }

  const { session, index } = result;
  const label = sessionLabel(session);

  if (!session.cwd) {
    sendReply(`Session ${index + 1} (${esc(label)}) has no CWD — cannot send.`);
    return;
  }

  const sendResult = sendToSession(session.cwd, message);
  if (sendResult.success) {
    sendReply(`✅ Sent to <b>${index + 1}. ${esc(label)}</b>:\n<code>${esc(message)}</code>`);
  } else {
    platform.invalidateLivenessCache();
    sendReply(`❌ Failed sending to ${esc(label)}: ${esc(sendResult.error ?? 'unknown error')}\nRun /sessions to refresh.`);
  }
}

function expandHome(p: string): string {
  const home = process.env['HOME'] ?? '';
  if (p.startsWith('~/')) return home + p.slice(1);
  if (p === '~') return home;
  return p;
}

function parseCwdAndPrompt(input: string): { cwd: string; prompt?: string } {
  const trimmed = input.trim();

  const quoteMatch = trimmed.match(/^(['"])(.*?)\1\s*(.*)?$/);
  if (quoteMatch) {
    const cwd = expandHome(quoteMatch[2]!);
    const prompt = quoteMatch[3]?.trim() || undefined;
    return { cwd, prompt };
  }

  const words = trimmed.split(/\s+/);
  for (let i = words.length; i >= 1; i--) {
    const raw = words.slice(0, i).join(' ').replace(/^['"]|['"]$/g, '');
    const candidate = expandHome(raw);
    if (existsSync(candidate)) {
      const prompt = words.slice(i).join(' ') || undefined;
      return { cwd: candidate, prompt };
    }
  }
  const raw = words[0]!.replace(/^['"]|['"]$/g, '');
  return { cwd: expandHome(raw), prompt: words.slice(1).join(' ') || undefined };
}

function handleNew(args: string): void {
  if (!args.trim()) {
    sendReply('Usage: <code>/new ~/my-project fix the login bug</code>');
    return;
  }

  const { cwd, prompt } = parseCwdAndPrompt(args.trim());

  const result = startNewSession(cwd, prompt, config?.skipPermissions);
  if (result.success) {
    const label = basename(cwd) || cwd;
    const desc = prompt ? `\nPrompt: <i>${esc(prompt)}</i>` : '';
    sendReply(`🚀 Started session in <b>${esc(label)}</b>${desc}`);
  } else {
    sendReply(`❌ Failed: ${esc(result.error ?? 'unknown error')}`);
  }
}

function handleKill(args: string): void {
  const query = args.trim();
  if (!query) {
    sendReply('Usage: <code>/kill orchestra</code> or <code>/kill 2</code>\nRun /sessions to see available sessions.');
    return;
  }

  const result = findSession(query);
  if ('error' in result) {
    sendReply(result.error);
    return;
  }

  const { session, index } = result;
  const label = sessionLabel(session);

  if (!session.cwd) {
    sendReply(`Session ${index + 1} (${esc(label)}) has no CWD — cannot kill.`);
    return;
  }

  const killResult = killSession(session.cwd);
  if (killResult.success) {
    platform.invalidateLivenessCache();
    sendReply(`🔴 Killed <b>${index + 1}. ${esc(label)}</b>`);
  } else {
    sendReply(`❌ Failed to kill ${esc(label)}: ${esc(killResult.error ?? 'unknown error')}`);
  }
}

function handleHelp(): void {
  sendReply(
    '<b>Claude Orchestra</b>\n\n' +
    '<code>/sessions</code> — List sessions with status and activity\n' +
    '<code>/send name msg</code> — Send message to session by name or number\n' +
    '<code>/kill name</code> — Kill session by name or number\n' +
    '<code>/new path [prompt]</code> — Start new Claude session\n' +
    '<code>/help</code> — Show this help\n\n' +
    'Sessions can be targeted by project name or index:\n' +
    '<code>/send orchestra fix the bug</code>\n' +
    '<code>/send 1 fix the bug</code>\n' +
    '<code>orchestra fix the bug</code> (shorthand)'
  );
}

function handleMessage(text: string): void {
  const trimmed = text.trim();

  if (trimmed === '/sessions' || trimmed === '/s' || trimmed === '/status') {
    handleSessions();
  } else if (trimmed === '/help' || trimmed === '/start') {
    handleHelp();
  } else if (trimmed.startsWith('/kill ')) {
    handleKill(trimmed.slice(6));
  } else if (trimmed.startsWith('/new ')) {
    handleNew(trimmed.slice(5));
  } else if (trimmed.startsWith('/send ') || trimmed.startsWith('/s ')) {
    const args = trimmed.startsWith('/send ') ? trimmed.slice(6) : trimmed.slice(3);
    handleSend(args);
  } else if (/^\d+\s+/.test(trimmed)) {
    // Numeric shorthand: "1 fix the bug" → /send 1 fix the bug
    handleSend(trimmed);
  } else if (/^\S+\s+\S/.test(trimmed) && !trimmed.startsWith('/')) {
    // Name shorthand: "orchestra fix the bug" → /send orchestra fix the bug
    // Only if it matches a known session name (to avoid false positives)
    const firstWord = trimmed.split(/\s+/)[0]!;
    const result = findSession(firstWord);
    if (!('error' in result)) {
      handleSend(trimmed);
      return;
    }
    sendReply('Unknown command. Send /help for available commands.');
  } else {
    sendReply('Unknown command. Send /help for available commands.');
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

        const chat = msg['chat'] as Record<string, unknown> | undefined;
        if (chat?.['id'] !== config.chatId) continue;

        const text = msg['text'] as string | undefined;
        if (text) {
          try {
            handleMessage(text);
          } catch {
            // Don't let a single message crash the poll loop
          }
        }
      }
    }
  } catch {
    // Network error — will retry on next poll
  }

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
        skipPermissions: raw.skipPermissions === true,
      };
    }
  } catch {
    return;
  }

  if (!config) return;
  poll();
}

export function stopTelegramBot(): void {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}
