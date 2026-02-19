import { openSync, readSync, closeSync, statSync, fstatSync, readdirSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import type { ActiveSession, SessionEntry } from './types.js';

// ---- Constants ----

const MAX_TAIL_BYTES = 524288; // 512KB — enough to capture sparse user messages
const ACTIVE_WINDOW_MS = 4 * 60 * 60 * 1000; // 4 hours — keep idle sessions visible
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
        if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
          entries.push({ type: 'assistant', timestamp: ts, text: block.text.slice(0, 2000) });
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
// Claude Code encodes paths: / → - and . → -
const HOME_ENCODED = '-' + HOME.split('/').filter(Boolean).join('-').replace(/\./g, '-');

function decodeProjectName(encoded: string): string {
  if (encoded === HOME_ENCODED) return '~';
  if (encoded.startsWith(HOME_ENCODED + '-')) {
    return encoded.slice(HOME_ENCODED.length + 1);
  }
  return encoded;
}

// ---- Session liveness detection ----
// Use `ps` to find running Claude processes and their CWDs.
// NOTE: `pgrep -x claude` is unreliable on macOS (misses some processes).
// `ps -eo pid=,comm=` is consistent and finds all of them.

const IDLE_CHECK_MS = 5 * 60 * 1000;   // Start checking after 5min idle
const CLOSED_GRACE_MS = 5 * 60 * 1000; // Keep closed sessions visible for 5min

interface ClaudeProcess {
  pid: number;
  cwd: string;
  cpu: number;  // %CPU — >0 means actively processing (compaction, API call, etc.)
}

let cachedProcesses: ClaudeProcess[] | null = null;
let cachedProcessesAt = 0;
const PROCESS_CACHE_MS = 15_000;        // Cache for 15s

function getRunningClaudeProcesses(): ClaudeProcess[] {
  const now = Date.now();
  if (cachedProcesses && now - cachedProcessesAt < PROCESS_CACHE_MS) return cachedProcesses;

  const procs: ClaudeProcess[] = [];
  try {
    // Use ps (not pgrep) — reliable across macOS versions
    // Also fetch %cpu to detect compaction/processing
    const psOutput = execSync(
      "ps -eo pid=,%cpu=,comm= | awk '$NF == \"claude\" {print $1, $2}'",
      { encoding: 'utf-8', timeout: 3000 }
    ).trim();

    const lines = psOutput.split('\n').filter(Boolean);

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const pid = parseInt(parts[0] ?? '', 10);
      const cpu = parseFloat(parts[1] ?? '0');
      if (isNaN(pid)) continue;

      try {
        const lsofOutput = execSync(
          `lsof -a -p ${pid} -d cwd -Fn 2>/dev/null || true`,
          { encoding: 'utf-8', timeout: 2000 }
        );
        for (const lsofLine of lsofOutput.split('\n')) {
          if (lsofLine.startsWith('n/')) {
            procs.push({ pid, cwd: lsofLine.slice(1), cpu });
            break;
          }
        }
      } catch { /* skip */ }
    }
  } catch { /* ps failed — return empty */ }

  cachedProcesses = procs;
  cachedProcessesAt = now;
  return procs;
}

function getRunningClaudeCwds(): Set<string> {
  return new Set(getRunningClaudeProcesses().map(p => p.cwd));
}

/** Check if a session's claude process is actively using CPU (compaction, API call, etc.) */
export function isSessionProcessBusy(cwd: string): boolean {
  const procs = getRunningClaudeProcesses();
  const proc = procs.find(p => p.cwd === cwd);
  return proc ? proc.cpu > 1.0 : false;
}

// ---- Orphaned process cleanup ----
// Kill child processes spawned by Claude sessions that no longer exist.
// These are identified by: command contains ".claude/shell-snapshots/" AND ppid=1
// (re-parented to launchd/init after the parent claude process exited).

let lastCleanupAt = 0;
const CLEANUP_INTERVAL_MS = 60_000; // Run cleanup at most once per minute

function cleanupOrphanedProcesses(): void {
  const now = Date.now();
  if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) return;
  lastCleanupAt = now;

  try {
    // Find processes with .claude/shell-snapshots/ in their command line
    const output = execSync(
      'ps -eo pid=,ppid=,command= 2>/dev/null || true',
      { encoding: 'utf-8', timeout: 5000 }
    );

    for (const line of output.split('\n')) {
      if (!line.includes('.claude/shell-snapshots/')) continue;

      const parts = line.trim().split(/\s+/);
      const pid = parseInt(parts[0] ?? '', 10);
      const ppid = parseInt(parts[1] ?? '', 10);

      // ppid=1 means parent died — orphaned process
      if (!isNaN(pid) && ppid === 1 && pid !== process.pid) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch { /* already dead or permission denied */ }
      }
    }
  } catch { /* ignore */ }
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

  // Clean up orphaned child processes from closed sessions
  cleanupOrphanedProcesses();

  // Filter out closed sessions
  const now2 = Date.now();
  const runningCwds = getRunningClaudeCwds();

  const alive = sessions.filter(s => {
    const idleMs = now2 - s.lastActivityMs;

    // Recently active — always show (no process check needed)
    if (idleMs < IDLE_CHECK_MS) return true;

    // Idle >5min — check if a Claude process is running with this CWD
    if (s.cwd && runningCwds.has(s.cwd)) return true;

    // No matching process — session is closed. Keep for grace period, then remove.
    return idleMs < IDLE_CHECK_MS + CLOSED_GRACE_MS;
  });

  return alive.sort((a, b) => b.lastActivityMs - a.lastActivityMs);
}
