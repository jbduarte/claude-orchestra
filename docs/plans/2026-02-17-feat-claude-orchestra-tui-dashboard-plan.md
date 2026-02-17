---
title: "feat: Claude Orchestra TUI Dashboard"
type: feat
date: 2026-02-17
deepened: 2026-02-17
---

# Claude Orchestra — TUI Dashboard for Claude Code Sessions

## Enhancement Summary

**Deepened on:** 2026-02-17
**Review agents used:** TypeScript Reviewer, Performance Oracle, Security Sentinel, Code Simplicity Reviewer, Architecture Strategist, Pattern Recognition Specialist, Frontend Race Conditions Reviewer, Agent-Native Reviewer

### Key Improvements from Deepening
1. **Simplified architecture**: 20+ files collapsed to ~10 files (per simplicity review)
2. **Single watcher pattern**: Consolidated from 4 chokidar instances to 1 (consensus: performance + race conditions + architecture)
3. **Security fix**: osascript command injection vulnerability identified and remediated
4. **Naming fix**: `SessionsPanel` renamed to `TeamsPanel` (vocabulary consistency)
5. **Type safety**: Discriminated unions for `DetailView` and message types (TypeScript review)
6. **Race condition fixes**: Retain last-known-good state, batch dispatches, `awaitWriteFinish`
7. **Agent-native roadmap**: Plan approval + message sending promoted to v1.1 (not distant v2)

### Critical Findings Addressed
- **SECURITY**: Agent-generated text in osascript = arbitrary code execution. Fixed with sanitization.
- **RACE CONDITION**: 4 independent watchers cause inconsistent panel states. Fixed with single watcher.
- **TYPE SAFETY**: `detailView: { type: string; data: unknown }` defeats TypeScript. Fixed with discriminated union.
- **NAMING**: "Sessions" panel showing "Teams" data — semantic mismatch across entire codebase. Fixed.

---

## Overview

A fullscreen terminal dashboard that monitors all active Claude Code sessions, teams, tasks, and agent messages by reading the existing JSON files in `~/.claude/`. Built with Node.js, TypeScript, Ink (React for terminal), and chokidar for file watching. Sends macOS/Linux desktop notifications for key events.

## Problem Statement

Claude Code power users run multiple sessions, teams, and agents in parallel. There is no unified view to see what is running, what progress has been made, which agents need input, and what messages are waiting. Users must manually check each terminal or read JSON files. This is a pain that grows with the number of parallel sessions.

## Proposed Solution

A TUI dashboard that:
1. Watches `~/.claude/` for changes via a single chokidar watcher
2. Renders a 2-column fullscreen layout (Teams+Tasks | Messages+Stats)
3. Sends throttled, sanitized desktop notifications for key events
4. Supports keyboard navigation with Tab, number keys, and arrow keys

---

## Technical Approach

### Architecture (Simplified)

```
src/
  index.tsx              # Entry point — withFullScreen(<App />), process signal handlers
  app.tsx                # Root layout: 2 columns + status bar, all panels inline
  hooks.ts               # useClaudeData (single watcher + single dispatch), useNotifications
  parsers.ts             # All parsers: parseTeam, parseTask, parseMessage, parseStats
  types.ts               # All TypeScript interfaces (discriminated unions)
  notify.ts              # Platform-adaptive notifications with osascript sanitization
  constants.ts           # All thresholds, intervals, ratios, paths
package.json
tsconfig.json
```

**~10 files total** (down from 20+). Panels are defined as components within `app.tsx` since each is used exactly once. Parsers are all pure functions in one file. Hooks consolidated to two exports.

### Research Insights: Why This Structure

> **Simplicity reviewer**: "The acid test for an MVP: can someone sit down and read the entire codebase in 15 minutes? With 20+ files and 7 hooks, no. With ~10 files and 2 hooks, yes."

> **Architecture strategist**: "The hooks/parsers separation is the correct boundary — parsers are pure functions with no React dependency, testable with just a test runner and sample JSON."

> **Pattern recognition**: "Every domain follows the same five-layer pipeline. The `useClaudeData` master hook acts as a Facade pattern."

### Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| File watching | Single chokidar watcher on `~/.claude/` root | Eliminates cross-panel inconsistency, reduces file descriptors (consensus: 3 reviewers) |
| Debounce strategy | Batch debounce 500ms with `awaitWriteFinish: { stabilityThreshold: 300 }` | Prevents partial-write reads; ensures consistent cross-domain state per render |
| State management | Single `useReducer` with `FULL_REFRESH` dispatch | One render per debounce cycle instead of 4; consistent notification diffing |
| Parse failure handling | Retain last-known-good state | Never show blank panels from partial JSON reads |
| Active session detection | File mtime < 2 min + inbox message timestamps + idle notification parsing | Multi-signal: more precise than mtime alone (agent-native review) |
| Notification safety | Sanitize all strings before osascript interpolation | Prevents command injection from agent-generated text (security: CRITICAL) |
| Layout | Fixed 2-column | YAGNI: responsive 3→2→1 adds complexity with no validated user demand |
| Detail view | Deferred to v1.1 | YAGNI: show key fields inline; developers can read JSON files for full detail |
| CLI flags | Positional `[dir]` argument only | YAGNI: add flags when users request them |
| Terminology | "Teams" and "Messages" throughout | Consistent with data model (not "Sessions" or "Inbox") |

### Data Model

```typescript
// types.ts

// --- Discriminated union for detail view (TypeScript review: CRITICAL) ---
type DetailView =
  | { type: 'team'; teamName: string }
  | { type: 'task'; taskId: string; teamName: string }
  | { type: 'message'; messageIndex: number }
  | null;

// --- Discriminated union for parsed messages (TypeScript review: CRITICAL) ---
interface MessageBase {
  from: string;
  text: string;
  summary: string;
  timestamp: number;         // standardized to epoch ms (not mixed Date/string/number)
  color?: string;            // optional — not always present in real data
  read: boolean;
  teamName: string;          // derived: parent team directory
}

type Message =
  | MessageBase & { parsedType: 'text' }
  | MessageBase & { parsedType: 'idle_notification'; agentName: string }
  | MessageBase & { parsedType: 'task_assignment'; taskId: string; assignee: string }
  | MessageBase & { parsedType: 'shutdown_request'; requestId: string }
  | MessageBase & { parsedType: 'plan_approval_request'; requestId: string; planContent: string };

// --- Core domain types ---
interface Team {
  name: string;
  description: string;
  createdAt: number;
  members: TeamMember[];
  lastActivityMs: number;    // raw mtime in epoch ms (compute isActive at render time)
}

interface TeamMember {
  name: string;
  agentType: string;
  model: string;
  color?: string;
  status: 'active' | 'idle' | 'unknown';
}

interface Task {
  id: string;
  subject: string;
  description: string;
  activeForm: string;
  owner: string | null;
  status: 'pending' | 'in_progress' | 'completed';
  blocks: string[];
  blockedBy: string[];
  teamName: string;
}

interface TaskGroup {
  teamName: string;
  tasks: Task[];
  completed: number;
  total: number;
}

interface StatsData {
  daily: DailyStats[];
  totalSessions: number;
  totalMessages: number;
}

interface DailyStats {
  date: string;
  messageCount: number;
  sessionCount: number;
  toolCallCount: number;
}

// --- App state: data + UI separated ---
interface DataState {
  teams: Team[];
  taskGroups: TaskGroup[];
  messages: Message[];
  stats: StatsData;
}

interface UIState {
  focusedPanel: PanelId;
  notificationsEnabled: boolean;
  scrollPositions: Record<PanelId, number>;
}

type PanelId = 'teams' | 'tasks' | 'messages';

// --- Notification diff (computed before dispatch, not in useEffect) ---
interface NotificationEvent {
  type: 'task_completed' | 'agent_idle' | 'new_message' | 'needs_input';
  title: string;
  body: string;
}
```

### Research Insights: Type Safety

> **TypeScript reviewer**: "`detailView: { type: string; data: unknown }` means every consumer needs unsafe type assertions. Use a discriminated union — TypeScript's strongest feature."

> **TypeScript reviewer**: "Three different date representations (number, Date, string) across interfaces. Pick one: `number` (epoch ms). `Date` objects do not survive `JSON.parse`."

> **Pattern recognition**: "The `seen` field on InboxMessage mixes UI state into the data model. Separate data from UI state."

### Single Watcher Architecture

```typescript
// hooks.ts — core data hook (simplified)

function useClaudeData(claudeDir: string): DataState {
  const [data, dispatch] = useReducer(dataReducer, initialDataState);
  const cacheRef = useRef<Map<string, { mtime: number; data: unknown }>>(new Map());

  useEffect(() => {
    let disposed = false;  // cancelation token for async cleanup

    const watcher = chokidar.watch(claudeDir, {
      persistent: true,
      ignoreInitial: false,
      followSymlinks: false,           // security: prevent symlink traversal
      awaitWriteFinish: {
        stabilityThreshold: 300,       // wait for file writes to finish
        pollInterval: 100,
      },
    });

    const refresh = debounce(() => {
      if (disposed) return;

      const prevData = dataRef.current;
      const newData = readAllData(claudeDir, cacheRef.current);  // per-file mtime caching

      // Compute notification diff BEFORE dispatch (race conditions review)
      const events = computeNotifications(prevData, newData);

      dispatch({ type: 'FULL_REFRESH', payload: newData });
      dataRef.current = newData;

      // Fire notifications after dispatch
      for (const event of events) {
        queueNotification(event);
      }
    }, 500);

    watcher.on('all', refresh);

    return () => {
      disposed = true;
      refresh.cancel();
      watcher.close();
    };
  }, [claudeDir]);

  return data;
}
```

### Research Insights: Why Single Watcher

> **Race conditions reviewer** (HIGHEST impact finding): "Four independent watchers with four independent debounce timers is four times the opportunity for your dashboard panels to momentarily disagree with each other. A user watching a dashboard that cannot agree with itself about whether a task is done will not trust that dashboard for long."

> **Performance oracle**: "Each event triggers exactly 1 file read, 1 JSON parse, 1 cache update, and at most 1 batched React render. At 600 events/minute, this is 10 renders/second (after 500ms debounce), each touching only the changed data."

> **Architecture strategist**: "Use a single chokidar watcher at the `~/.claude/` root with a path-based router."

### Per-File Mtime Caching

```typescript
// parsers.ts — cache-aware file reading

function readJsonCached(
  path: string,
  cache: Map<string, { mtime: number; data: unknown }>
): unknown | null {
  try {
    const stat = statSync(path);
    if (stat.size > 10 * 1024 * 1024) return null;  // 10MB hard limit (security)

    const cached = cache.get(path);
    if (cached && cached.mtime >= stat.mtimeMs) return cached.data;  // skip unchanged

    const raw = readFileSync(path, 'utf-8');
    const data = JSON.parse(raw);
    cache.set(path, { mtime: stat.mtimeMs, data });
    return data;
  } catch {
    return cache.get(path)?.data ?? null;  // return last-known-good on failure
  }
}
```

> **Performance oracle** (P0): "Eliminates 90%+ of redundant parsing. Each file is only re-parsed when its mtime actually changes."

> **Race conditions reviewer**: "Never replace good state with a parse failure."

### Notification Sanitization (Security: CRITICAL)

```typescript
// notify.ts — MUST sanitize before osascript

function sanitizeForAppleScript(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, ' ')
    .replace(/\r/g, '')
    .slice(0, 200);  // truncate to prevent abuse
}

function notifyMacOS(title: string, message: string): void {
  const safeTitle = sanitizeForAppleScript(title);
  const safeMessage = sanitizeForAppleScript(message);
  const script = `display notification "${safeMessage}" with title "${safeTitle}"`;
  execFile('osascript', ['-e', script], { timeout: 5000 }, () => {});
}

function notifyLinux(title: string, message: string): void {
  // execFile with array args = safe (no shell interpretation, no code interpreter)
  execFile('notify-send', [title, message.slice(0, 200)], { timeout: 5000 }, () => {});
}
```

> **Security sentinel** (CRITICAL finding): "Agent-generated text flows into an AppleScript interpreter that supports `do shell script` for arbitrary command execution. A malicious or compromised agent could write crafted JSON to an inbox file, and the dashboard would execute arbitrary commands."

> **Security sentinel**: "For Linux `notify-send`, the current design is already safe since `execFile` passes arguments as an array."

### Staleness Detection (Multi-Signal)

```typescript
// Computed at RENDER TIME, not parse time (race conditions review)
function getTeamStatus(team: Team, messages: Message[]): 'active' | 'idle' | 'stale' {
  const now = Date.now();
  const ACTIVE_THRESHOLD = 2 * 60 * 1000;   // 2 minutes
  const STALE_THRESHOLD = 10 * 60 * 1000;    // 10 minutes

  // Signal 1: file mtime
  const fileRecent = (now - team.lastActivityMs) < ACTIVE_THRESHOLD;

  // Signal 2: latest inbox message timestamp
  const teamMessages = messages.filter(m => m.teamName === team.name);
  const latestMessageMs = Math.max(0, ...teamMessages.map(m => m.timestamp));
  const messageRecent = (now - latestMessageMs) < ACTIVE_THRESHOLD;

  // Signal 3: idle notifications
  const lastIdle = teamMessages
    .filter(m => m.parsedType === 'idle_notification')
    .sort((a, b) => b.timestamp - a.timestamp)[0];

  if (fileRecent || messageRecent) return 'active';
  if (lastIdle && (now - team.lastActivityMs) < STALE_THRESHOLD) return 'idle';
  return 'stale';
}
```

> **Agent-native reviewer**: "The 5-minute threshold is too coarse. Use multiple signals: file mtime, inbox message timestamps, and idle notification parsing. A three-tier status model (active/idle/stale) is more useful than binary."

---

### Implementation Phases

#### Phase 1: Setup + Watcher + Parsers

**Files:** `package.json`, `tsconfig.json`, `src/index.tsx`, `src/types.ts`, `src/constants.ts`, `src/parsers.ts`, `src/hooks.ts`

- [ ] Initialize npm project: `npm init -y`, set `"type": "module"` in package.json
- [ ] Install: `ink@6 react@18 fullscreen-ink @inkjs/ui@2 chokidar@5`
- [ ] Install dev: `typescript@5 @types/react tsx`
- [ ] Pin exact versions in package.json (no `^` or `~`) — security review
- [ ] Configure `tsconfig.json`: `module: "NodeNext"`, `moduleResolution: "NodeNext"`, `jsx: "react-jsx"`, `strict: true`, `verbatimModuleSyntax: true`
- [ ] Write `src/types.ts` — all interfaces with discriminated unions (per type review)
- [ ] Write `src/constants.ts` — all thresholds, paths, panel ratios
- [ ] Write `src/parsers.ts` — `parseTeam`, `parseTask`, `parseMessage`, `parseStats`, `readJsonCached`
  - All parsers use try/catch, never throw
  - `.passthrough()` pattern: ignore unknown JSON fields (forward compatibility)
  - Messages: attempt `JSON.parse` on `text` field to detect types
  - Tasks: filter directories with no `.json` files
  - Normalize all timestamps to epoch ms
  - Normalize `owner: undefined | ""` to `null`
- [ ] Write `src/hooks.ts` — `useClaudeData` (single watcher, single dispatch, per-file mtime cache, batch debounce, `awaitWriteFinish`, notification diff before dispatch, `disposed` cancelation flag)
- [ ] Write minimal `src/index.tsx` — `withFullScreen(<App />)` + process signal handlers for cleanup
- [ ] Add `"bin": { "claude-orchestra": "./dist/index.js" }` to package.json
- [ ] Verify: `npx tsx src/index.tsx` shows fullscreen "Claude Orchestra" with `q` to quit

**Success criteria:** Parsers correctly read real `~/.claude/` data. Watcher updates state on file changes. Clean exit restores terminal.

#### Phase 2: Layout + Panels + Navigation

**Files:** `src/app.tsx`, `src/notify.ts`

- [ ] Write `src/app.tsx` — root component with:
  - 2-column layout: Left (50%): TeamsPanel + TasksPanel stacked | Right (50%): MessagesPanel
  - StatusBar at bottom (1 row): today's stats + keyboard hints
  - Min size check: show "resize your terminal" if < 80x24
  - `TeamsPanel` inline component:
    - Active teams with members (name, role, model, status dot)
    - Stale teams dimmed with "stale" label
    - Three-tier status: green dot = active, yellow dot = idle, gray dot = stale
    - Teams sorted: active first, then by `lastActivityMs`
  - `TasksPanel` inline component:
    - Task groups by team with progress bar (completed/total)
    - Tasks with status icon, subject, owner
    - Colors: green=completed, yellow=in_progress, gray=pending, red=blocked
    - Memoize sorted lists with `useMemo`
  - `MessagesPanel` inline component:
    - Last 50 messages across all inboxes, sorted by timestamp desc
    - Type rendering: text → summary; idle → "[agent] idle"; task_assignment → "[agent] → [task]"; plan_approval → highlighted "NEEDS APPROVAL"
    - Unread indicator per message
  - Keyboard navigation:
    - Tab / Shift+Tab: cycle panels
    - 1/2/3: jump to panel
    - Up/Down: scroll within focused panel (array-sliced virtual scroll)
    - q: quit
    - n: toggle notifications
    - r: force refresh (cancel pending debounce, execute immediately)
  - Per-panel error boundary (class component wrapping each panel)
  - Empty states: "No active teams" / "No tasks" / "No messages"
  - Loading state: spinner during initial scan
- [ ] Write `src/notify.ts` — sanitized notifications:
  - macOS: sanitize strings, then `execFile('osascript', ...)`
  - Linux: `execFile('notify-send', [title, message])`
  - Platform detection via `process.platform`
  - Silent failure if command unavailable
  - Use only `summary` field in notifications (never raw `text`) — security review
  - Notification dedup: same event type + agent within 30s = skip
  - Serialize dispatch: at most 1 osascript process at a time

**Success criteria:** Fullscreen dashboard shows live data from `~/.claude/` in 2 columns with keyboard navigation, sanitized notifications, and error boundaries.

#### Phase 3: Polish + Packaging

**Files:** `README.md`, `package.json` updates

- [ ] Add `--help` output (hardcoded string, not a CLI parsing library)
- [ ] Support optional positional argument: `claude-orchestra [dir]` defaults to `~/.claude/`
- [ ] Validate `--claude-dir`: resolve path, check `teams/` and `tasks/` subdirs exist, disable symlink following — security review
- [ ] Add build script: `tsc` to compile to `dist/`
- [ ] Create `README.md` with: install, usage, screenshot placeholder, keyboard shortcuts
- [ ] Initial git commit + push to GitHub
- [ ] Test on: iTerm2, Terminal.app, Alacritty (macOS); basic Linux terminal

**Success criteria:** Installable via `npm install -g`, runs with `claude-orchestra`, polished README.

---

## v1.1 Roadmap (Fast-Follow, Not Distant v2)

> **Agent-native reviewer**: "Read-only is the right call for the first working version. But write capability for the three most critical actions — plan approval, shutdown approval, and send message — should be prioritized immediately after. The distance between agent-observing and agent-native is surprisingly small."

### v1.1: Agent Interaction (1-2 days after v1)

- [ ] **Plan approval**: When viewing a `plan_approval_request` message, press `a` to approve, `x` to reject → writes `plan_approval_response` JSON to agent's inbox file
- [ ] **Shutdown approval**: Press `a`/`x` on `shutdown_request` messages → writes `shutdown_response` to inbox
- [ ] **Send message**: Press `m` to open text input → sends free-text message to selected agent's inbox
- [ ] **Atomic writes**: Write to temp file, then `rename()` to prevent corruption from concurrent agent writes

### v1.2: Solo Session Visibility

- [ ] Parse `~/.claude/history.jsonl` (tail last N lines) — show recent sessions grouped by project
- [ ] Parse `~/.claude/todos/` for solo session task lists

### v2: Future

- Launch new Claude Code sessions from dashboard
- Cost tracking from token usage
- Detail view overlay (fullscreen drill-down)
- Responsive layout (3→2→1 columns)
- Web UI alternative

---

## Acceptance Criteria

### Functional Requirements

- [ ] Displays all teams from `~/.claude/teams/*/config.json` with member details and 3-tier status
- [ ] Displays task lists from `~/.claude/tasks/*/` with progress bars
- [ ] Displays messages from `~/.claude/teams/*/inboxes/*.json` with type-specific rendering
- [ ] Displays daily stats from `~/.claude/stats-cache.json`
- [ ] Updates in real-time when files change (< 1s latency)
- [ ] Sends sanitized desktop notifications for task completions and prolonged agent idle
- [ ] Keyboard navigation: Tab, 1/2/3, arrows, q, n, r
- [ ] Stale teams dimmed; three-tier status (active/idle/stale)
- [ ] Empty UUID task directories filtered out
- [ ] Graceful handling of missing/malformed JSON (last-known-good retained)
- [ ] Per-panel error boundaries prevent single-panel crash from killing dashboard

### Non-Functional Requirements

- [ ] Startup time < 2 seconds
- [ ] Memory usage < 50MB
- [ ] CPU idle < 1% when no files changing
- [ ] No writes to `~/.claude/` in v1 (read-only)
- [ ] Clean exit: restores terminal (alternate screen buffer + SIGINT/SIGTERM handlers)
- [ ] Works on macOS and Linux
- [ ] No command injection via notifications (sanitized)

### Quality Gates

- [ ] TypeScript strict mode + `verbatimModuleSyntax`, no `any` types
- [ ] All parsers handle malformed input without crashing
- [ ] Pinned dependency versions, `package-lock.json` committed
- [ ] Manual testing with real `~/.claude/` data

---

## Dependencies

- Node.js >= 20 (required by chokidar v5 ESM)
- `ink@6.6.0`, `react@18.x`, `fullscreen-ink`, `@inkjs/ui@2.0.0`, `chokidar@5.0.0`
- Dev: `typescript@5`, `@types/react`, `tsx`
- All versions pinned exactly (no `^` or `~`)

---

## Risk Analysis & Mitigation (Updated)

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| **Command injection via osascript** | High | Critical | Sanitize all strings, truncate to 200 chars, use `summary` only (never raw `text`) |
| **Partial-write JSON reads** | High | Medium | `awaitWriteFinish` in chokidar + retain last-known-good state on parse failure |
| **Panel state inconsistency** | High | Medium | Single watcher, single `FULL_REFRESH` dispatch per debounce cycle |
| Claude Code changes file formats | Medium | High | Parsers ignore unknown fields; validate expected fields only |
| Notification flooding | Medium | Medium | 30s dedup per event type, serialized osascript dispatch |
| Large inbox files (100KB+) | Low | Low | Parse full file but cache aggressively; display last 50 messages only |
| `fullscreen-ink` small user base | Low | Low | Audit source before adoption; it is small enough to read |

---

## References

### Data Sources

| Source | Path | Key Fields |
|--------|------|------------|
| Teams | `teams/*/config.json` | `name, description, createdAt, leadAgentId, members[]` |
| Inboxes | `teams/*/inboxes/*.json` | `[{ from, text, summary, timestamp, color, read }]` |
| Tasks | `tasks/*/*.json` | `id, subject, description, activeForm, owner, status, blocks, blockedBy` |
| Stats | `stats-cache.json` | `dailyActivity[], totalSessions, totalMessages, modelUsage` |
| History | `history.jsonl` | `display, timestamp, project, sessionId` (v1.2) |

### Framework Docs

- [Ink](https://github.com/vadimdemedes/ink) v6.6.0 — React renderer for CLI
- [@inkjs/ui](https://github.com/vadimdemedes/ink-ui) v2.0.0 — Pre-built components
- [fullscreen-ink](https://github.com/DaniGuardiola/fullscreen-ink) — Alternate screen buffer
- [chokidar](https://github.com/paulmillr/chokidar) v5.0.0 — File watching (ESM-only)

### Review Agent Reports (Full Details)

All 8 review agent reports are available in the deepening session context:
- TypeScript Review: Discriminated unions, timestamp standardization, `verbatimModuleSyntax`
- Performance Oracle: Per-file mtime caching, single watcher, batch dispatch, progressive startup
- Security Sentinel: osascript injection (CRITICAL), path traversal, file size limits, secret redaction
- Simplicity Review: 20+ files → ~10 files, 7 hooks → 2, cut DetailView and responsive layout
- Architecture Strategist: DataSource interface (deferred), split contexts, centralized derivation, error boundaries
- Pattern Recognition: SessionsPanel→TeamsPanel rename, Inbox→Messages unification, magic number centralization
- Race Conditions Review: Single watcher (highest impact), `disposed` flag, notification diff before dispatch, `awaitWriteFinish`
- Agent-Native Review: Plan approval as v1.1, solo sessions, multi-signal staleness, agent-native score 5/13
