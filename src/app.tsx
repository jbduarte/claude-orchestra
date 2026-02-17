import { Component, useState, type ReactNode } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { Spinner } from '@inkjs/ui';
import { FullScreenBox, useScreenSize } from 'fullscreen-ink';
import { useClaudeData } from './hooks.js';
import { setNotificationsEnabled } from './notify.js';
import { sendToSession, focusSession, startNewSession } from './chat.js';
import { MIN_TERMINAL_WIDTH, MIN_TERMINAL_HEIGHT } from './constants.js';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import type { ActiveSession, SessionEntry } from './types.js';

const HOME = homedir();

// ---- Helpers ----

function expandHome(p: string): string {
  if (p.startsWith('~/')) return HOME + p.slice(1);
  if (p === '~') return HOME;
  return p;
}

/** Parse "path prompt" where path may contain spaces or quotes. */
function parseCwdAndPrompt(input: string): { cwd: string; prompt?: string } {
  const trimmed = input.trim();

  // Handle quoted paths: 'path with spaces' prompt or "path with spaces" prompt
  const quoteMatch = trimmed.match(/^(['"])(.*?)\1\s*(.*)?$/);
  if (quoteMatch) {
    const cwd = expandHome(quoteMatch[2]!);
    const prompt = quoteMatch[3]?.trim() || undefined;
    return { cwd, prompt };
  }

  // Unquoted: try progressively longer paths against filesystem
  const words = trimmed.split(/\s+/);
  for (let i = words.length; i >= 1; i--) {
    const raw = words.slice(0, i).join(' ').replace(/^['"]|['"]$/g, '');
    const candidate = expandHome(raw);
    if (existsSync(candidate)) {
      const prompt = words.slice(i).join(' ') || undefined;
      return { cwd: candidate, prompt };
    }
  }
  // Nothing matched — use first word, strip quotes
  const raw = words[0]!.replace(/^['"]|['"]$/g, '');
  return { cwd: expandHome(raw), prompt: words.slice(1).join(' ') || undefined };
}

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

function isSessionIdle(session: ActiveSession): boolean {
  const age = Date.now() - session.lastActivityMs;
  if (age < 60_000) return false; // active within 60s — definitely working
  if (age > 180_000) return true; // 3 min silence — idle regardless
  // Between 1-3 min: check last entry — if assistant text, likely waiting for input
  const last = session.entries[session.entries.length - 1];
  return last?.type === 'assistant' || last?.type === 'user';
}

function sessionStatus(session: ActiveSession): { label: string; color: string; dot: string } {
  if (isSessionIdle(session)) return { label: 'idle', color: 'yellow', dot: '○' };
  return { label: 'working', color: 'green', dot: '●' };
}

function sessionLabel(session: ActiveSession): string {
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
        const status = sessionStatus(session);
        return (
          <Box key={session.sessionId} flexDirection="column">
            <Text
              wrap="truncate-end"
              color={isSelected ? 'cyan' : undefined}
              bold={isSelected}
              inverse={isSelected}
            >
              <Text color={status.color}>{status.dot}</Text>{' '}
              {sessionLabel(session)}
            </Text>
            <Text dimColor wrap="truncate-end">
              {'  '}<Text color={status.color}>{status.label}</Text> {timeAgo(session.lastActivityMs)}
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
          <Text color="green" bold>You    </Text>
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
  const [inputMode, setInputMode] = useState<false | 'chat' | 'new'>(false);
  const [inputText, setInputText] = useState('');
  const [statusMsg, setStatusMsg] = useState('');

  const safeIdx = sessions.length > 0 ? Math.min(selectedIdx, sessions.length - 1) : 0;
  const selectedSession = sessions[safeIdx] ?? null;
  const visibleRows = Math.max(5, height - 5);

  useInput((input, key) => {
    // ---- Input mode: typing a message ----
    if (inputMode) {
      if (key.escape) {
        setInputMode(false);
        setInputText('');
        return;
      }
      if (key.return) {
        const text = inputText.trim();
        if (inputMode === 'chat' && text && selectedSession?.cwd) {
          const result = sendToSession(selectedSession.cwd, text);
          if (result.success) {
            setStatusMsg(`Sent to ${sessionLabel(selectedSession)}`);
          } else {
            setStatusMsg(`Failed: ${result.error}`);
          }
        } else if (inputMode === 'new' && text) {
          const { cwd, prompt } = parseCwdAndPrompt(text);
          const result = startNewSession(cwd, prompt);
          if (result.success) {
            setStatusMsg(`Started session in ${cwd.split('/').pop()}`);
          } else {
            setStatusMsg(`Failed: ${result.error}`);
          }
        }
        setInputMode(false);
        setInputText('');
        setTimeout(() => setStatusMsg(''), 5000);
        return;
      }
      if (key.backspace || key.delete) {
        setInputText((prev) => prev.slice(0, -1));
        return;
      }
      // Regular character input
      if (input && !key.ctrl && !key.meta) {
        setInputText((prev) => prev + input);
      }
      return;
    }

    // ---- Normal mode ----
    if (input === 'q') {
      exit();
      return;
    }
    if (input === 'i') {
      setInputMode('chat');
      setInputText('');
      return;
    }
    if (input === 's') {
      setInputMode('new');
      setInputText('');
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
    if (key.return && selectedSession?.cwd) {
      const result = focusSession(selectedSession.cwd);
      if (result.success) {
        setStatusMsg(`Switched to ${sessionLabel(selectedSession)}`);
      } else {
        setStatusMsg(`Switch failed: ${result.error}`);
      }
      setTimeout(() => setStatusMsg(''), 3000);
      return;
    }

    const num = parseInt(input, 10);
    if (num >= 1 && num <= 9 && num <= sessions.length) {
      setSelectedIdx(num - 1);
      setScrollOffset(0);
      return;
    }

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
    if (key.home || input === 'g') {
      setScrollOffset(Math.max(0, (selectedSession?.entries.length ?? 0) - visibleRows));
      return;
    }
    if (key.end || input === 'G') {
      setScrollOffset(0);
      return;
    }
  });

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
        {statusMsg ? <Text color="green"> {statusMsg}</Text> : null}
      </Box>

      {/* Main: sidebar + conversation */}
      <Box flexGrow={1}>
        <Box width={24} borderStyle="round" borderColor="gray" flexDirection="column">
          <ErrorBoundary fallback="[Error]">
            <SessionList sessions={sessions} selectedIndex={safeIdx} />
          </ErrorBoundary>
        </Box>

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

      {/* Input bar / Status bar */}
      <Box paddingX={1}>
        {inputMode ? (
          <Text>
            <Text color="green" bold>{inputMode === 'new' ? 'new> ' : '> '}</Text>
            <Text>{inputText}</Text>
            <Text dimColor>█</Text>
            <Text dimColor>  {inputMode === 'new' ? '(path [prompt] Enter:start Esc:cancel)' : '(Enter:send Esc:cancel)'}</Text>
          </Text>
        ) : (
          <Text dimColor>
            Tab:switch Enter:focus ↑↓:scroll i:chat s:new q:quit n:notif({notificationsOn ? 'ON' : 'OFF'}) r:refresh
          </Text>
        )}
      </Box>
    </FullScreenBox>
  );
}
