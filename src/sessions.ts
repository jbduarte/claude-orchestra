import { openSync, readSync, closeSync, statSync, fstatSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { platform } from './platform.js';
import type { ActiveSession, SessionEntry } from './types.js';

// ---- Constants ----

const MAX_TAIL_BYTES = 524288; // 512KB — enough to capture sparse user messages
const ACTIVE_WINDOW_MS = 4 * 60 * 60 * 1000; // 4 hours — keep idle sessions visible
const MAX_ENTRIES_PER_SESSION = 60;

// ---- Cache ----

export type SessionCache = Map<string, { size: number; mtime: number; birthtime: number; entries: SessionEntry[]; cwd?: string; model?: string }>;

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
      return { entries: [{ type: 'user', timestamp: ts, text: text.slice(0, 2000) }], cwd };
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
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
          entries.push({ type: 'assistant', timestamp: ts, text: block.text.trim().slice(0, 2000) });
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

// ---- Read full last assistant message (untruncated, for Telegram) ----

const LAST_MSG_TAIL_BYTES = 1024 * 1024; // 1MB — enough to capture long reports

export function readLastAssistantText(jsonlPath: string): string | null {
  try {
    const tail = tailFile(jsonlPath, LAST_MSG_TAIL_BYTES);
    const lines = tail.split('\n');

    // Walk backwards to find the last assistant message with text blocks
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]?.trim();
      if (!line) continue;

      try {
        const raw = JSON.parse(line);
        if (raw.type !== 'assistant' || !Array.isArray(raw.message?.content)) continue;

        const textParts: string[] = [];
        for (const block of raw.message.content) {
          if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
            textParts.push(block.text);
          }
        }

        if (textParts.length > 0) {
          return textParts.join('\n\n');
        }
      } catch {
        continue;
      }
    }
  } catch {
    // File read error
  }

  return null;
}

// ---- Project name decoding ----

const HOME = homedir();
// Claude Code encodes paths: separators → - and . → -
const HOME_ENCODED = platform.encodeHomePath(HOME);

function decodeProjectName(encoded: string): string {
  if (encoded === HOME_ENCODED) return '~';
  if (encoded.startsWith(HOME_ENCODED + '-')) {
    return encoded.slice(HOME_ENCODED.length + 1);
  }
  return encoded;
}

// ---- Session liveness detection ----
// Process detection is delegated to platform adapters (see platform.ts).

const IDLE_CHECK_MS = 5 * 60 * 1000;   // Consider idle after 5min without JSONL writes
const CLOSED_GRACE_MS = 60 * 1000;     // Keep process-less sessions for 1min after last activity

/** Check if a session's claude process is actively using CPU (compaction, API call, etc.) */
export function isSessionProcessBusy(cwd: string): boolean {
  return platform.isSessionProcessBusy(cwd);
}

/** Match a session CWD against running process CWDs.
 * Handles CWD drift when Claude tools change the working directory —
 * the JSONL may record a subdirectory while lsof still shows the launch directory. */
function findMatchingRunningCwd(sessionCwd: string, runningCwds: Set<string>): string | null {
  if (runningCwds.has(sessionCwd)) return sessionCwd;
  for (const cwd of runningCwds) {
    if (sessionCwd.startsWith(cwd + '/') || cwd.startsWith(sessionCwd + '/')) return cwd;
  }
  return null;
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
            startedMs: cached.birthtime,
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

        cache.set(filePath, { size: stat.size, mtime: stat.mtimeMs, birthtime: stat.birthtimeMs, entries, cwd: lastCwd, model: lastModel });

        sessions.push({
          sessionId: basename(file, '.jsonl'),
          project: decodeProjectName(projectEntry),
          jsonlPath: filePath,
          lastActivityMs: stat.mtimeMs,
          startedMs: stat.birthtimeMs,
          cwd: lastCwd,
          model: lastModel,
          entries,
        });
      } catch {
        continue;
      }
    }
  }

  // Clean up orphaned child processes from closed sessions
  platform.cleanupOrphanedProcesses();

  // Filter out closed sessions
  const now2 = Date.now();
  const runningCwds = platform.getRunningClaudeCwds();
  const isWindows = platform.platformName === 'Windows';

  const alive = sessions.filter(s => {
    const idleMs = now2 - s.lastActivityMs;

    if (isWindows) {
      // Windows: can't match CWD. If any claude process exists AND session was
      // active in the last hour, consider alive. Otherwise use grace period.
      if (runningCwds.size > 0 && idleMs < 60 * 60 * 1000) return true;
    } else {
      // Unix: CWD matching — running process means alive.
      // Uses sub-path matching to handle CWD drift (when Claude tools cd into subdirectories,
      // the JSONL records the new CWD but lsof still shows the original launch directory).
      if (s.cwd && findMatchingRunningCwd(s.cwd, runningCwds) !== null) return true;
    }

    // No matching process — keep briefly for grace period, then remove.
    return idleMs < CLOSED_GRACE_MS;
  });

  // Deduplicate: if N sessions share a CWD but only M processes exist for it,
  // keep only the M most recently active sessions (others are stale JSONL files).
  // Sort most-recent-first so we keep the freshest ones.
  alive.sort((a, b) => b.lastActivityMs - a.lastActivityMs);
  const cwdCounts = platform.getRunningCwdCounts();
  const cwdSeen = new Map<string, number>();
  const deduped = alive.filter(s => {
    // Match against running CWDs (with sub-path support for drifted CWDs)
    const matchedCwd = s.cwd ? findMatchingRunningCwd(s.cwd, runningCwds) : null;
    if (!s.cwd || !matchedCwd) return true; // grace-period sessions pass through
    const seen = (cwdSeen.get(matchedCwd) ?? 0) + 1;
    cwdSeen.set(matchedCwd, seen);
    return seen <= (cwdCounts.get(matchedCwd) ?? 1);
  });

  // Sort by start time (stable). Tiebreaker: sessionId for deterministic order.
  return deduped.sort((a, b) => a.startedMs - b.startedMs || a.sessionId.localeCompare(b.sessionId));
}
