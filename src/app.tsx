import { Component, useState, type ReactNode } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { Spinner } from '@inkjs/ui';
import { FullScreenBox, useScreenSize } from 'fullscreen-ink';
import { useClaudeData } from './hooks.js';
import { setNotificationsEnabled } from './notify.js';
import { MIN_TERMINAL_WIDTH, MIN_TERMINAL_HEIGHT, STALE_THRESHOLD_MS } from './constants.js';
import type { PanelId, Team, TaskGroup, Task, TeamMember, Message } from './types.js';

// ---- Helpers ----

function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

function statusDot(status: TeamMember['status']): { char: string; color: string } {
  switch (status) {
    case 'active': return { char: '●', color: 'green' };
    case 'idle': return { char: '●', color: 'yellow' };
    default: return { char: '○', color: 'gray' };
  }
}

function taskIcon(task: Task): { icon: string; color: string } {
  if (task.blockedBy.length > 0 && task.status !== 'completed') {
    return { icon: '⊘', color: 'red' };
  }
  switch (task.status) {
    case 'completed': return { icon: '✓', color: 'green' };
    case 'in_progress': return { icon: '◉', color: 'yellow' };
    default: return { icon: '○', color: 'gray' };
  }
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

// ---- Panels ----

function TeamsPanel({ teams, focused }: { teams: Team[]; focused: boolean }): ReactNode {
  return (
    <Box
      borderStyle="round"
      borderColor={focused ? 'cyan' : 'gray'}
      flexDirection="column"
      paddingX={1}
      flexGrow={1}
      overflow="hidden"
    >
      <Text bold color={focused ? 'cyan' : undefined}>
        {' '}Teams ({teams.length}){' '}
      </Text>
      {teams.length === 0 ? (
        <Text dimColor>No active teams</Text>
      ) : (
        teams.map((team) => {
          const isStale = Date.now() - team.lastActivityMs > STALE_THRESHOLD_MS;
          return (
            <Box key={team.name} flexDirection="column">
              <Text dimColor={isStale}>
                {team.name}{' '}
                <Text dimColor>{isStale ? '(stale)' : timeAgo(team.lastActivityMs)}</Text>
              </Text>
              {team.members.map((member) => {
                const dot = statusDot(member.status);
                return (
                  <Text key={member.name} dimColor={isStale} wrap="truncate-end">
                    {'  '}
                    <Text color={dot.color}>{dot.char}</Text> {member.name}{' '}
                    <Text dimColor>({member.agentType})</Text>
                  </Text>
                );
              })}
            </Box>
          );
        })
      )}
    </Box>
  );
}

function TasksPanel({ taskGroups, focused }: { taskGroups: TaskGroup[]; focused: boolean }): ReactNode {
  return (
    <Box
      borderStyle="round"
      borderColor={focused ? 'cyan' : 'gray'}
      flexDirection="column"
      paddingX={1}
      flexGrow={1}
      overflow="hidden"
    >
      <Text bold color={focused ? 'cyan' : undefined}>
        {' '}Tasks{' '}
      </Text>
      {taskGroups.length === 0 ? (
        <Text dimColor>No tasks</Text>
      ) : (
        taskGroups.map((group) => (
          <Box key={group.teamName} flexDirection="column">
            <Text>
              <Text bold>{group.teamName}</Text>{' '}
              <Text dimColor>
                {group.completed}/{group.total}
              </Text>
            </Text>
            {group.tasks.map((task) => {
              const { icon, color } = taskIcon(task);
              return (
                <Text key={task.id} wrap="truncate-end">
                  {'  '}
                  <Text color={color}>{icon}</Text> {task.subject}
                  {task.owner ? <Text dimColor> [{task.owner}]</Text> : null}
                </Text>
              );
            })}
          </Box>
        ))
      )}
    </Box>
  );
}

function MessagesPanel({ messages, focused }: { messages: Message[]; focused: boolean }): ReactNode {
  return (
    <Box
      borderStyle="round"
      borderColor={focused ? 'cyan' : 'gray'}
      flexDirection="column"
      paddingX={1}
      flexGrow={1}
      overflow="hidden"
    >
      <Text bold color={focused ? 'cyan' : undefined}>
        {' '}Messages ({messages.length}){' '}
      </Text>
      {messages.length === 0 ? (
        <Text dimColor>No messages</Text>
      ) : (
        messages.slice(0, 30).map((msg, i) => {
          let label: ReactNode;
          switch (msg.parsedType) {
            case 'idle_notification':
              label = <Text dimColor>[{msg.agentName}] idle</Text>;
              break;
            case 'task_assignment':
              label = (
                <Text>
                  <Text color="blue">{msg.from}</Text> → task {msg.taskId}
                </Text>
              );
              break;
            case 'shutdown_request':
              label = <Text color="red">{msg.from} requests shutdown</Text>;
              break;
            case 'plan_approval_request':
              label = (
                <Text color="yellow" bold>
                  NEEDS APPROVAL: {msg.from}
                </Text>
              );
              break;
            default:
              label = <Text>{msg.summary || msg.text.slice(0, 80)}</Text>;
          }
          return (
            <Text key={`${msg.teamName}-${msg.timestamp}-${i}`} wrap="truncate-end">
              <Text dimColor>{timeAgo(msg.timestamp)} </Text>
              <Text color={msg.color ?? undefined}>{msg.from}: </Text>
              {label}
            </Text>
          );
        })
      )}
    </Box>
  );
}

function StatusBar({
  notificationsOn,
  totalSessions,
  totalMessages,
}: {
  notificationsOn: boolean;
  totalSessions: number;
  totalMessages: number;
}): ReactNode {
  return (
    <Box paddingX={1}>
      <Text dimColor>
        Sessions:{totalSessions} Msgs:{totalMessages} Notif:
        {notificationsOn ? 'ON' : 'OFF'} │ Tab:switch 1-3:panel q:quit n:notif
        r:refresh
      </Text>
    </Box>
  );
}

// ---- Main App ----

export default function App({ claudeDir }: { claudeDir: string }): ReactNode {
  const { exit } = useApp();
  const { width, height } = useScreenSize();
  const { teams, taskGroups, messages, stats, loading, forceRefresh } =
    useClaudeData(claudeDir);
  const [focusedPanel, setFocusedPanel] = useState<PanelId>('teams');
  const [notificationsOn, setNotificationsOn] = useState(true);

  const panels: PanelId[] = ['teams', 'tasks', 'messages'];

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
    if (input === '1') {
      setFocusedPanel('teams');
      return;
    }
    if (input === '2') {
      setFocusedPanel('tasks');
      return;
    }
    if (input === '3') {
      setFocusedPanel('messages');
      return;
    }
    if (key.tab) {
      const idx = panels.indexOf(focusedPanel);
      if (key.shift) {
        setFocusedPanel(panels[(idx - 1 + panels.length) % panels.length]!);
      } else {
        setFocusedPanel(panels[(idx + 1) % panels.length]!);
      }
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

  // Loading state
  if (loading) {
    return (
      <FullScreenBox justifyContent="center" alignItems="center">
        <Spinner label="Scanning ~/.claude/ ..." />
      </FullScreenBox>
    );
  }

  return (
    <FullScreenBox flexDirection="column">
      {/* Header */}
      <Box paddingX={1}>
        <Text bold color="cyan">
          Claude Orchestra
        </Text>
        <Text dimColor> — {claudeDir}</Text>
      </Box>

      {/* Main: 2 columns */}
      <Box flexGrow={1}>
        {/* Left: Teams + Tasks */}
        <Box width="50%" flexDirection="column">
          <ErrorBoundary fallback="[Teams panel error]">
            <TeamsPanel teams={teams} focused={focusedPanel === 'teams'} />
          </ErrorBoundary>
          <ErrorBoundary fallback="[Tasks panel error]">
            <TasksPanel
              taskGroups={taskGroups}
              focused={focusedPanel === 'tasks'}
            />
          </ErrorBoundary>
        </Box>

        {/* Right: Messages */}
        <Box width="50%" flexDirection="column">
          <ErrorBoundary fallback="[Messages panel error]">
            <MessagesPanel
              messages={messages}
              focused={focusedPanel === 'messages'}
            />
          </ErrorBoundary>
        </Box>
      </Box>

      {/* Status bar */}
      <StatusBar
        notificationsOn={notificationsOn}
        totalSessions={stats.totalSessions}
        totalMessages={stats.totalMessages}
      />
    </FullScreenBox>
  );
}
