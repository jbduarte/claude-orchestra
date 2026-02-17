import { useReducer, useEffect, useRef, useCallback } from 'react';
import chokidar from 'chokidar';
import type { DataState, DataAction, NotificationEvent, Message, ActiveSession } from './types.js';
import { readAllData, enrichTeamStatuses } from './parsers.js';
import type { FileCache } from './parsers.js';
import { findActiveSessions } from './sessions.js';
import type { SessionCache } from './sessions.js';
import { DEBOUNCE_MS, AWAIT_WRITE_STABILITY_MS, AWAIT_WRITE_POLL_MS, AUTO_REFRESH_MS } from './constants.js';
import { sendNotification } from './notify.js';

// ---- Data reducer ----

const initialDataState: DataState = {
  sessions: [],
  teams: [],
  taskGroups: [],
  messages: [],
  stats: { daily: [], totalSessions: 0, totalMessages: 0 },
  loading: true,
};

function dataReducer(state: DataState, action: DataAction): DataState {
  switch (action.type) {
    case 'FULL_REFRESH':
      return { ...action.payload, loading: false };
    case 'SET_LOADING':
      return { ...state, loading: action.loading };
    default:
      return state;
  }
}

// ---- Simple debounce ----

function debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number): T & { cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const debounced = ((...args: unknown[]) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  }) as T & { cancel: () => void };
  debounced.cancel = () => { if (timer) clearTimeout(timer); };
  return debounced;
}

// ---- Notification diffing ----

function computeNotifications(
  prev: Omit<DataState, 'loading'> | null,
  next: Omit<DataState, 'loading'>
): NotificationEvent[] {
  if (!prev) return [];
  const events: NotificationEvent[] = [];

  // Detect newly completed tasks
  const prevTaskIds = new Set<string>();
  for (const g of prev.taskGroups) {
    for (const t of g.tasks) {
      if (t.status === 'completed') prevTaskIds.add(`${g.teamName}:${t.id}`);
    }
  }
  for (const g of next.taskGroups) {
    for (const t of g.tasks) {
      if (t.status === 'completed') {
        const key = `${g.teamName}:${t.id}`;
        if (!prevTaskIds.has(key)) {
          events.push({
            type: 'task_completed',
            title: 'Task Completed',
            body: t.subject.slice(0, 100),
            dedupeKey: `task_completed:${key}`,
          });
        }
      }
    }
  }

  // Detect new session activity (session has new entries)
  const prevSessionSizes = new Map<string, number>();
  for (const s of prev.sessions) {
    prevSessionSizes.set(s.sessionId, s.entries.length);
  }
  for (const s of next.sessions) {
    const prevSize = prevSessionSizes.get(s.sessionId) ?? 0;
    if (s.entries.length > prevSize && prevSize > 0) {
      const lastEntry = s.entries[s.entries.length - 1];
      if (lastEntry && lastEntry.type === 'assistant') {
        events.push({
          type: 'new_message',
          title: `Session: ${s.project}`,
          body: lastEntry.text.slice(0, 100),
          dedupeKey: `session:${s.sessionId}:${lastEntry.timestamp}`,
        });
      }
    }
  }

  // Detect sessions that just went idle (working → idle transition)
  const IDLE_THRESHOLD_MS = 60_000;
  const prevWorking = new Set<string>();
  for (const s of prev.sessions) {
    if (Date.now() - s.lastActivityMs < IDLE_THRESHOLD_MS) {
      prevWorking.add(s.sessionId);
    }
  }
  for (const s of next.sessions) {
    const isNowIdle = Date.now() - s.lastActivityMs >= IDLE_THRESHOLD_MS;
    if (isNowIdle && prevWorking.has(s.sessionId)) {
      const label = s.cwd?.split('/').pop() ?? s.project;
      events.push({
        type: 'agent_idle',
        title: 'Session Waiting',
        body: `${label} is waiting for input`,
        dedupeKey: `idle:${s.sessionId}:${Math.floor(s.lastActivityMs / 60000)}`,
      });
    }
  }

  // Detect messages needing input (plan approval, shutdown)
  const prevNeedsInput = new Set(
    prev.messages
      .filter(m => m.parsedType === 'plan_approval_request' || m.parsedType === 'shutdown_request')
      .map(m => `${m.teamName}:${m.from}:${m.timestamp}`)
  );
  for (const m of next.messages) {
    if (m.parsedType === 'plan_approval_request' || m.parsedType === 'shutdown_request') {
      const key = `${m.teamName}:${m.from}:${m.timestamp}`;
      if (!prevNeedsInput.has(key)) {
        events.push({
          type: 'needs_input',
          title: 'Action Needed',
          body: m.parsedType === 'plan_approval_request'
            ? `${m.from} needs plan approval`
            : `${m.from} requests shutdown`,
          dedupeKey: `needs_input:${key}`,
        });
      }
    }
  }

  return events;
}

// ---- Main data hook ----

export function useClaudeData(claudeDir: string): DataState & { forceRefresh: () => void } {
  const [data, dispatch] = useReducer(dataReducer, initialDataState);
  const cacheRef = useRef<FileCache>(new Map());
  const sessionCacheRef = useRef<SessionCache>(new Map());
  const dataRef = useRef<Omit<DataState, 'loading'> | null>(null);
  const notifEnabled = useRef(true);
  const debouncedRef = useRef<ReturnType<typeof debounce> | null>(null);

  const doRefresh = useCallback(() => {
    const raw = readAllData(claudeDir, cacheRef.current);
    const teams = enrichTeamStatuses(raw.teams, raw.messages);
    const sessions = findActiveSessions(claudeDir, sessionCacheRef.current);
    const newData = { ...raw, teams, sessions };

    // Compute notification diff BEFORE dispatch
    if (notifEnabled.current) {
      const events = computeNotifications(dataRef.current, newData);
      for (const evt of events) {
        sendNotification(evt);
      }
    }

    dataRef.current = newData;
    dispatch({ type: 'FULL_REFRESH', payload: newData });
  }, [claudeDir]);

  useEffect(() => {
    let disposed = false;

    const watcher = chokidar.watch(claudeDir, {
      persistent: true,
      ignoreInitial: false,
      followSymlinks: false,
      depth: 4,
      ignored: [
        /(^|[/\\])\../, // dotfiles
        /debug\//,
        /file-history\//,
        /shell-snapshots\//,
        /plugins\//,
        /cache\//,
        /telemetry\//,
        /paste-cache\//,
        /statsig\//,
        /downloads\//,
        /session-env\//,
        /ide\//,
        /subagents\//,
      ],
      awaitWriteFinish: {
        stabilityThreshold: AWAIT_WRITE_STABILITY_MS,
        pollInterval: AWAIT_WRITE_POLL_MS,
      },
    });

    const refresh = debounce(() => {
      if (disposed) return;
      doRefresh();
    }, DEBOUNCE_MS);

    debouncedRef.current = refresh;

    watcher.on('all', () => refresh());

    // Initial load
    doRefresh();

    // Periodic refresh — safety net when chokidar misses JSONL appends
    const interval = setInterval(() => {
      if (!disposed) doRefresh();
    }, AUTO_REFRESH_MS);

    return () => {
      disposed = true;
      refresh.cancel();
      clearInterval(interval);
      watcher.close();
    };
  }, [claudeDir, doRefresh]);

  const forceRefresh = useCallback(() => {
    debouncedRef.current?.cancel();
    doRefresh();
  }, [doRefresh]);

  return { ...data, forceRefresh };
}
