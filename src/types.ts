// ---- Panel IDs ----

export type PanelId = 'teams' | 'tasks' | 'messages';

// ---- Teams ----

export interface TeamMember {
  name: string;
  agentType: string;
  model: string;
  color?: string;
  status: 'active' | 'idle' | 'unknown';
}

export interface Team {
  name: string;
  description: string;
  createdAt: number;
  members: TeamMember[];
  lastActivityMs: number;
}

// ---- Tasks ----

export interface Task {
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

export interface TaskGroup {
  teamName: string;
  tasks: Task[];
  completed: number;
  total: number;
}

// ---- Messages (discriminated union) ----

export interface MessageBase {
  from: string;
  text: string;
  summary: string;
  timestamp: number;
  color?: string;
  read: boolean;
  teamName: string;
}

export type Message =
  | MessageBase & { parsedType: 'text' }
  | MessageBase & { parsedType: 'idle_notification'; agentName: string }
  | MessageBase & { parsedType: 'task_assignment'; taskId: string; assignee: string }
  | MessageBase & { parsedType: 'shutdown_request'; requestId: string }
  | MessageBase & { parsedType: 'plan_approval_request'; requestId: string };

// ---- Stats ----

export interface DailyStats {
  date: string;
  messageCount: number;
  sessionCount: number;
  toolCallCount: number;
}

export interface StatsData {
  daily: DailyStats[];
  totalSessions: number;
  totalMessages: number;
}

// ---- App State ----

export interface DataState {
  teams: Team[];
  taskGroups: TaskGroup[];
  messages: Message[];
  stats: StatsData;
  loading: boolean;
}

export interface UIState {
  focusedPanel: PanelId;
  notificationsEnabled: boolean;
  scrollPositions: Record<PanelId, number>;
}

// ---- Notifications ----

export interface NotificationEvent {
  type: 'task_completed' | 'agent_idle' | 'new_message' | 'needs_input';
  title: string;
  body: string;
  dedupeKey: string;
}

// ---- Reducer actions ----

export type DataAction =
  | { type: 'FULL_REFRESH'; payload: Omit<DataState, 'loading'> }
  | { type: 'SET_LOADING'; loading: boolean };
