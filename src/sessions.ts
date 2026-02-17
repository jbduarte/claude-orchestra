import { openSync, readSync, closeSync, statSync, fstatSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import type { ActiveSession, SessionEntry } from './types.js';

// ---- Constants ----

const MAX_TAIL_BYTES = 524288; // 512KB — enough to capture sparse user messages
const ACTIVE_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const MAX_ENTRIES_PER_SESSION = 60;

// ---- Cache ----

export type SessionCache = Map<string, { size: number; mtime: number; entries: SessionEntry[]; cwd?: string; model?: string }>;

// ---- Efficient tail reading ----

function tailFile(filePath: string, maxBytes: number): string {
  const fd = openSync(filePath, 'r');
  try {
    const stat = fstatSync(fd);
    const size = stat.size;
    const readSize = Math.min(maxBytes, size);
    const position = Math.max(0, size - readSize);
    const buffer = Buffer.alloc(readSize);
    readSync(fd, buffer, 0, readSize, position);
    return buffer.toString('utf-8');
  } finally {
    closeSync(fd);
  }
}

// ---- JSONL line parser ----

function parseLine(line: string): { entries: SessionEntry[]; cwd?: string; model?: string } {
  try {
    const raw = JSON.parse(line);
    const ts = raw.timestamp ? new Date(raw.timestamp).getTime() : 0;
    if (!ts) return { entries: [] };

    const cwd = typeof raw.cwd === 'string' ? raw.cwd : undefined;

    // User message with text prompt
    if (raw.type === 'user' && typeof raw.message?.content === 'string') {
      const text = raw.message.content;
      // Skip very short or system-looking messages
      if (text.length < 2) return { entries: [], cwd };
      return { entries: [{ type: 'user', timestamp: ts, text: text.slice(0, 500) }], cwd };
    }

    // Skip user messages that are tool results (array content)
    if (raw.type === 'user' && Array.isArray(raw.message?.content)) {
      return { entries: [], cwd };
    }

    // Assistant message — extract text and tool calls
    if (raw.type === 'assistant' && Array.isArray(raw.message?.content)) {
      const entries: SessionEntry[] = [];
      const model = typeof raw.message.model === 'string' ? raw.message.model : undefined;

      for (const block of raw.message.content) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
          entries.push({ type: 'assistant', timestamp: ts, text: block.text.slice(0, 500) });
        }
        if (block.type === 'tool_use' && typeof block.name === 'string') {
          let desc = block.name;
          const input = block.input;
          if (input?.command) desc += `: ${String(input.command).slice(0, 120)}`;
          else if (input?.file_path) desc += `: ${String(input.file_path)}`;
          else if (input?.pattern) desc += `: ${String(input.pattern)}`;
          else if (input?.query) desc += `: ${String(input.query).slice(0, 80)}`;
          else if (input?.url) desc += `: ${String(input.url).slice(0, 80)}`;
          entries.push({ type: 'tool_use', timestamp: ts, text: desc, toolName: block.name });
        }
      }
      return { entries, cwd, model };
    }

    return { entries: [], cwd };
  } catch {
    return { entries: [] };
  }
}

// ---- Project name decoding ----

const HOME = homedir();
// Claude Code encodes paths: / → - and . → -
const HOME_ENCODED = '-' + HOME.split('/').filter(Boolean).join('-').replace(/\./g, '-');

function decodeProjectName(encoded: string): string {
  if (encoded === HOME_ENCODED) return '~';
  if (encoded.startsWith(HOME_ENCODED + '-')) {
    return encoded.slice(HOME_ENCODED.length + 1);
  }
  return encoded;
}

// ---- Main: find active sessions ----

export function findActiveSessions(claudeDir: string, cache: SessionCache): ActiveSession[] {
  const projectsDir = join(claudeDir, 'projects');
  if (!existsSync(projectsDir)) return [];

  const sessions: ActiveSession[] = [];
  const now = Date.now();

  let projectEntries: string[];
  try {
    projectEntries = readdirSync(projectsDir);
  } catch {
    return [];
  }

  for (const projectEntry of projectEntries) {
    const projectDir = join(projectsDir, projectEntry);
    try {
      if (!statSync(projectDir).isDirectory()) continue;
    } catch {
      continue;
    }

    let files: string[];
    try {
      files = readdirSync(projectDir);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;

      const filePath = join(projectDir, file);
      try {
        const stat = statSync(filePath);

        // Skip files not modified recently
        if (now - stat.mtimeMs > ACTIVE_WINDOW_MS) continue;

        // Skip tiny files (< 100 bytes — probably empty or corrupt)
        if (stat.size < 100) continue;

        // Check cache — if size unchanged, reuse
        const cached = cache.get(filePath);
        if (cached && cached.size === stat.size && cached.mtime === stat.mtimeMs) {
          sessions.push({
            sessionId: basename(file, '.jsonl'),
            project: decodeProjectName(projectEntry),
            jsonlPath: filePath,
            lastActivityMs: stat.mtimeMs,
            cwd: cached.cwd,
            model: cached.model,
            entries: cached.entries,
          });
          continue;
        }

        // Read tail and parse
        const tail = tailFile(filePath, MAX_TAIL_BYTES);
        const lines = tail.split('\n');

        // If we started mid-file, discard first partial line
        if (stat.size > MAX_TAIL_BYTES) {
          lines.shift();
        }

        const allEntries: SessionEntry[] = [];
        let lastCwd: string | undefined;
        let lastModel: string | undefined;

        for (const line of lines) {
          if (!line.trim()) continue;
          const { entries, cwd, model } = parseLine(line);
          allEntries.push(...entries);
          if (cwd) lastCwd = cwd;
          if (model) lastModel = model;
        }

        const entries = allEntries.slice(-MAX_ENTRIES_PER_SESSION);

        cache.set(filePath, { size: stat.size, mtime: stat.mtimeMs, entries, cwd: lastCwd, model: lastModel });

        sessions.push({
          sessionId: basename(file, '.jsonl'),
          project: decodeProjectName(projectEntry),
          jsonlPath: filePath,
          lastActivityMs: stat.mtimeMs,
          cwd: lastCwd,
          model: lastModel,
          entries,
        });
      } catch {
        continue;
      }
    }
  }

  return sessions.sort((a, b) => b.lastActivityMs - a.lastActivityMs);
}
