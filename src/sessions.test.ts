import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Hoisted mocks (available to vi.mock factories) ----

const {
  mockReaddirSync,
  mockStatSync,
  mockOpenSync,
  mockReadSync,
  mockCloseSync,
  mockFstatSync,
  mockExistsSync,
  mockGetRunningClaudeCwds,
  mockCleanupOrphanedProcesses,
  mockIsSessionProcessBusy,
  mockEncodeHomePath,
} = vi.hoisted(() => ({
  mockReaddirSync: vi.fn(),
  mockStatSync: vi.fn(),
  mockOpenSync: vi.fn(),
  mockReadSync: vi.fn(),
  mockCloseSync: vi.fn(),
  mockFstatSync: vi.fn(),
  mockExistsSync: vi.fn(),
  mockGetRunningClaudeCwds: vi.fn<() => Set<string>>(),
  mockCleanupOrphanedProcesses: vi.fn(),
  mockIsSessionProcessBusy: vi.fn<(_cwd: string) => boolean>(),
  mockEncodeHomePath: vi.fn((home: string) =>
    '-' + home.split('/').filter(Boolean).join('-').replace(/\./g, '-'),
  ),
}));

// ---- Mock node:fs ----

vi.mock('node:fs', () => ({
  readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
  statSync: (...args: unknown[]) => mockStatSync(...args),
  openSync: (...args: unknown[]) => mockOpenSync(...args),
  readSync: (...args: unknown[]) => mockReadSync(...args),
  closeSync: (...args: unknown[]) => mockCloseSync(...args),
  fstatSync: (...args: unknown[]) => mockFstatSync(...args),
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
}));

// ---- Mock ./platform.js ----

vi.mock('./platform.js', () => ({
  platform: {
    getRunningClaudeCwds: (...args: unknown[]) => mockGetRunningClaudeCwds(...(args as [])),
    cleanupOrphanedProcesses: (...args: unknown[]) => mockCleanupOrphanedProcesses(...args),
    isSessionProcessBusy: (...args: unknown[]) => mockIsSessionProcessBusy(...(args as [string])),
    encodeHomePath: (...args: unknown[]) => mockEncodeHomePath(...(args as [string])),
    platformName: 'macOS',
  },
}));

import { findActiveSessions, type SessionCache } from './sessions.js';

// ---- Helpers ----

const NOW = Date.now();
const MIN = 60 * 1000;

/** Build a minimal JSONL line that parseLine() will accept as a user message. */
function userLine(text: string, cwd: string, minutesAgo: number): string {
  const ts = new Date(NOW - minutesAgo * MIN).toISOString();
  return JSON.stringify({ type: 'user', timestamp: ts, cwd, message: { content: text } });
}

/**
 * Set up mockFs so that findActiveSessions sees one session file.
 * @param mtimeMinutesAgo How many minutes ago the file was "modified"
 * @param jsonlContent The raw JSONL content to return from the file
 * @param cwd The cwd embedded in the JSONL (used for project dir encoding)
 */
function setupSingleSession(mtimeMinutesAgo: number, jsonlContent: string, cwd: string) {
  const mtimeMs = NOW - mtimeMinutesAgo * MIN;
  const birthtimeMs = NOW - 120 * MIN; // started 2h ago

  // Encode project dir the way Claude Code does
  const encodedProject = mockEncodeHomePath(cwd);

  mockExistsSync.mockReturnValue(true);

  // readdirSync calls:
  // 1. projectsDir → one project folder
  // 2. projectDir → one .jsonl file
  mockReaddirSync
    .mockReturnValueOnce([encodedProject])   // projects dir
    .mockReturnValueOnce(['session-1.jsonl']); // project dir

  // statSync calls:
  // 1. projectDir → isDirectory
  // 2. filePath → file stat
  mockStatSync
    .mockReturnValueOnce({ isDirectory: () => true })
    .mockReturnValueOnce({
      mtimeMs,
      birthtimeMs,
      size: Buffer.byteLength(jsonlContent),
    });

  // tailFile: openSync → fd, fstatSync → size, readSync → fill buffer, closeSync
  const buf = Buffer.from(jsonlContent);
  mockOpenSync.mockReturnValue(42);
  mockFstatSync.mockReturnValue({ size: buf.length });
  mockReadSync.mockImplementation((_fd: number, buffer: Buffer) => {
    buf.copy(buffer);
    return buf.length;
  });
  mockCloseSync.mockReturnValue(undefined);
}

// ---- Tests ----

describe('findActiveSessions', () => {
  const cache: SessionCache = new Map();
  const claudeDir = '/home/user/.claude';

  beforeEach(() => {
    vi.clearAllMocks();
    cache.clear();
    // Default: mock as Unix platform with no running processes
    mockGetRunningClaudeCwds.mockReturnValue(new Set());
    // Restore default Unix encodeHomePath
    mockEncodeHomePath.mockImplementation((home: string) =>
      '-' + home.split('/').filter(Boolean).join('-').replace(/\./g, '-'),
    );
    vi.useFakeTimers({ now: NOW });
  });

  it('shows recently active session (< 5min idle) regardless of running processes', () => {
    const cwd = '/home/user/project';
    const content = userLine('hello', cwd, 2); // 2min ago
    setupSingleSession(2, content, cwd);

    const sessions = findActiveSessions(claudeDir, cache);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.cwd).toBe(cwd);
  });

  it('keeps idle Unix session alive when CWD is in runningCwds', () => {
    const cwd = '/home/user/project';
    const content = userLine('working', cwd, 8); // 8min idle
    setupSingleSession(8, content, cwd);
    mockGetRunningClaudeCwds.mockReturnValue(new Set([cwd]));

    const sessions = findActiveSessions(claudeDir, cache);
    expect(sessions).toHaveLength(1);
  });

  it('filters idle Unix session when CWD is NOT in runningCwds (past grace)', () => {
    const cwd = '/home/user/project';
    const content = userLine('old work', cwd, 15); // 15min idle — past 5min idle + 5min grace
    setupSingleSession(15, content, cwd);
    mockGetRunningClaudeCwds.mockReturnValue(new Set());

    const sessions = findActiveSessions(claudeDir, cache);
    expect(sessions).toHaveLength(0);
  });

  it('shows closed session during grace period', () => {
    const cwd = '/home/user/project';
    const content = userLine('just closed', cwd, 7); // 7min idle — within 5+5=10min window
    setupSingleSession(7, content, cwd);
    mockGetRunningClaudeCwds.mockReturnValue(new Set());

    const sessions = findActiveSessions(claudeDir, cache);
    expect(sessions).toHaveLength(1);
  });

  it('returns empty array when projects dir does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    const sessions = findActiveSessions(claudeDir, cache);
    expect(sessions).toHaveLength(0);
  });
});

describe('findActiveSessions (Windows)', () => {
  const cache: SessionCache = new Map();
  const claudeDir = 'C:\\Users\\joao\\.claude';

  beforeEach(async () => {
    vi.clearAllMocks();
    cache.clear();
    vi.useFakeTimers({ now: NOW });

    // Override platformName to Windows for these tests
    const { platform } = await import('./platform.js');
    (platform as { platformName: string }).platformName = 'Windows';
    mockEncodeHomePath.mockImplementation((home: string) =>
      '-' + home.split(/[/\\]/).filter(Boolean).join('-').replace(/[.:]/g, '-'),
    );
  });

  it('keeps idle Windows session alive when claude process exists and < 1hr idle', () => {
    const cwd = 'C:\\Users\\joao\\project';
    const content = userLine('coding', cwd, 8); // 8min idle
    setupSingleSession(8, content, cwd);
    // Windows sentinel: any claude process running
    mockGetRunningClaudeCwds.mockReturnValue(new Set(['__windows_has_claude_process__']));

    const sessions = findActiveSessions(claudeDir, cache);
    expect(sessions).toHaveLength(1);
  });

  it('filters Windows session that is idle > 1hr even with claude process', () => {
    const cwd = 'C:\\Users\\joao\\project';
    const content = userLine('old work', cwd, 90); // 90min idle — past 1hr cutoff
    setupSingleSession(90, content, cwd);
    mockGetRunningClaudeCwds.mockReturnValue(new Set(['__windows_has_claude_process__']));

    const sessions = findActiveSessions(claudeDir, cache);
    expect(sessions).toHaveLength(0);
  });
});
