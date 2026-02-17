import { Component, useState, type ReactNode } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { Spinner } from '@inkjs/ui';
import { FullScreenBox, useScreenSize } from 'fullscreen-ink';
import { useClaudeData } from './hooks.js';
import { setNotificationsEnabled } from './notify.js';
import { MIN_TERMINAL_WIDTH, MIN_TERMINAL_HEIGHT } from './constants.js';
import { homedir } from 'node:os';
import type { ActiveSession, SessionEntry } from './types.js';

const HOME = homedir();

// ---- Helpers ----

function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function shortId(id: string): string {
  return id.slice(0, 7);
}

function sessionLabel(session: ActiveSession): string {
  // Prefer cwd-based name, then project, then short ID
  if (session.cwd) {
    if (session.cwd === HOME) return '~';
    if (session.cwd.startsWith(HOME + '/')) {
      const parts = session.cwd.slice(HOME.length + 1).split('/');
      return parts[parts.length - 1] || '~';
    }
    const parts = session.cwd.split('/');
    return parts[parts.length - 1] || session.cwd;
  }
  if (session.project && session.project !== '~') return session.project;
  return shortId(session.sessionId);
}

// ---- Error Boundary ----

class ErrorBoundary extends Component<
  { fallback: string; children: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { fallback: string; children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return <Text color="red">{this.props.fallback}</Text>;
    }
    return this.props.children;
  }
}

// ---- Session List (left sidebar) ----

function SessionList({
  sessions,
  selectedIndex,
}: {
  sessions: ActiveSession[];
  selectedIndex: number;
}): ReactNode {
  if (sessions.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="cyan"> Sessions </Text>
        <Text dimColor>No active sessions</Text>
        <Text dimColor>(waiting for JSONL</Text>
        <Text dimColor> activity...)</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1} overflow="hidden">
      <Text bold color="cyan"> Sessions ({sessions.length}) </Text>
      {sessions.map((session, i) => {
        const isSelected = i === selectedIndex;
        const isActive = Date.now() - session.lastActivityMs < 2 * 60 * 1000;
        return (
          <Box key={session.sessionId} flexDirection="column">
            <Text
              wrap="truncate-end"
              color={isSelected ? 'cyan' : undefined}
              bold={isSelected}
              inverse={isSelected}
            >
              {isActive ? <Text color="green">●</Text> : <Text dimColor>○</Text>}{' '}
              {sessionLabel(session)}
            </Text>
            <Text dimColor wrap="truncate-end">
              {'  '}{session.model ? session.model.replace('claude-', '').split('-202')[0] : ''} {timeAgo(session.lastActivityMs)}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

// ---- Conversation View (main area) ----

function ConversationView({
  session,
  scrollOffset,
  visibleRows,
}: {
  session: ActiveSession | null;
  scrollOffset: number;
  visibleRows: number;
}): ReactNode {
  if (!session) {
    return (
      <Box flexDirection="column" paddingX={1} flexGrow={1}>
        <Text dimColor>No session selected</Text>
      </Box>
    );
  }

  const entries = session.entries;
  const totalEntries = entries.length;

  // Compute which entries to show based on scroll
  // scrollOffset 0 = show latest (bottom), positive = scroll up
  const endIdx = Math.max(0, totalEntries - scrollOffset);
  const startIdx = Math.max(0, endIdx - visibleRows);
  const visible = entries.slice(startIdx, endIdx);

  return (
    <Box flexDirection="column" paddingX={1} overflow="hidden" flexGrow={1}>
      <Box>
        <Text bold color="cyan">
          {sessionLabel(session)}
        </Text>
        <Text dimColor> — {session.model?.replace('claude-', '').split('-202')[0] ?? ''}</Text>
        {session.cwd ? (
          <Text dimColor> — {session.cwd.startsWith(HOME) ? '~' + session.cwd.slice(HOME.length) : session.cwd}</Text>
        ) : null}
      </Box>
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {visible.map((entry, i) => (
          <EntryLine key={`${entry.timestamp}-${i}`} entry={entry} />
        ))}
      </Box>
      {scrollOffset > 0 ? (
        <Text dimColor>↑ {scrollOffset} more below — press ↓ to scroll down</Text>
      ) : null}
    </Box>
  );
}

function EntryLine({ entry }: { entry: SessionEntry }): ReactNode {
  const time = <Text dimColor>{formatTime(entry.timestamp)} </Text>;

  switch (entry.type) {
    case 'user':
      return (
        <Text wrap="truncate-end">
          {time}
          <Text color="green" bold>You  </Text>
          <Text>{entry.text.split('\n')[0]?.slice(0, 200)}</Text>
        </Text>
      );
    case 'assistant':
      return (
        <Text wrap="truncate-end">
          {time}
          <Text color="blue" bold>Claude </Text>
          <Text>{entry.text.split('\n')[0]?.slice(0, 200)}</Text>
        </Text>
      );
    case 'tool_use':
      return (
        <Text wrap="truncate-end" dimColor>
          {time}
          {'       '}
          <Text color="yellow">▸ </Text>
          {entry.text}
        </Text>
      );
  }
}

// ---- Main App ----

export default function App({ claudeDir }: { claudeDir: string }): ReactNode {
  const { exit } = useApp();
  const { width, height } = useScreenSize();
  const { sessions, loading, forceRefresh } = useClaudeData(claudeDir);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [notificationsOn, setNotificationsOn] = useState(true);

  // Keep selectedIdx in bounds
  const safeIdx = sessions.length > 0 ? Math.min(selectedIdx, sessions.length - 1) : 0;
  const selectedSession = sessions[safeIdx] ?? null;

  // Approximate visible rows for conversation (height minus header/status/borders)
  const visibleRows = Math.max(5, height - 4);

  useInput((input, key) => {
    if (input === 'q') {
      exit();
      return;
    }
    if (input === 'n') {
      setNotificationsOn((prev) => {
        const next = !prev;
        setNotificationsEnabled(next);
        return next;
      });
      return;
    }
    if (input === 'r') {
      forceRefresh();
      return;
    }

    // Number keys: jump to session
    const num = parseInt(input, 10);
    if (num >= 1 && num <= 9 && num <= sessions.length) {
      setSelectedIdx(num - 1);
      setScrollOffset(0);
      return;
    }

    // Tab: cycle sessions
    if (key.tab) {
      if (sessions.length > 0) {
        if (key.shift) {
          setSelectedIdx((prev) => (prev - 1 + sessions.length) % sessions.length);
        } else {
          setSelectedIdx((prev) => (prev + 1) % sessions.length);
        }
        setScrollOffset(0);
      }
      return;
    }

    // Up/Down: scroll conversation
    if (key.upArrow) {
      setScrollOffset((prev) =>
        Math.min(prev + 3, (selectedSession?.entries.length ?? 0) - visibleRows)
      );
      return;
    }
    if (key.downArrow) {
      setScrollOffset((prev) => Math.max(0, prev - 3));
      return;
    }

    // Home/End: jump to start/end of conversation
    if (key.home || input === 'g') {
      setScrollOffset(Math.max(0, (selectedSession?.entries.length ?? 0) - visibleRows));
      return;
    }
    if (key.end || input === 'G') {
      setScrollOffset(0);
      return;
    }
  });

  // Min size check
  if (width < MIN_TERMINAL_WIDTH || height < MIN_TERMINAL_HEIGHT) {
    return (
      <FullScreenBox justifyContent="center" alignItems="center">
        <Text>
          Resize terminal to at least {MIN_TERMINAL_WIDTH}x{MIN_TERMINAL_HEIGHT}
        </Text>
      </FullScreenBox>
    );
  }

  if (loading) {
    return (
      <FullScreenBox justifyContent="center" alignItems="center">
        <Spinner label="Scanning sessions..." />
      </FullScreenBox>
    );
  }

  return (
    <FullScreenBox flexDirection="column">
      {/* Header */}
      <Box paddingX={1}>
        <Text bold color="cyan">Claude Orchestra</Text>
        <Text dimColor>
          {' '}— {sessions.length} active session{sessions.length !== 1 ? 's' : ''}
        </Text>
      </Box>

      {/* Main: sidebar + conversation */}
      <Box flexGrow={1}>
        {/* Left sidebar: session list */}
        <Box width={24} borderStyle="round" borderColor="gray" flexDirection="column">
          <ErrorBoundary fallback="[Error]">
            <SessionList sessions={sessions} selectedIndex={safeIdx} />
          </ErrorBoundary>
        </Box>

        {/* Right: conversation view */}
        <Box flexGrow={1} borderStyle="round" borderColor="cyan" flexDirection="column">
          <ErrorBoundary fallback="[Error]">
            <ConversationView
              session={selectedSession}
              scrollOffset={scrollOffset}
              visibleRows={visibleRows}
            />
          </ErrorBoundary>
        </Box>
      </Box>

      {/* Status bar */}
      <Box paddingX={1}>
        <Text dimColor>
          Tab:switch ↑↓:scroll 1-9:session g/G:top/bottom q:quit n:notif({notificationsOn ? 'ON' : 'OFF'}) r:refresh
        </Text>
      </Box>
    </FullScreenBox>
  );
}
