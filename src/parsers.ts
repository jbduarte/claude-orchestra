import { readFileSync, statSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { MAX_FILE_SIZE_BYTES, MAX_MESSAGES_DISPLAYED } from './constants.js';
import type { Team, TeamMember, Task, TaskGroup, Message, StatsData, DailyStats, DataState } from './types.js';

// ---- File-level mtime cache ----

export type FileCache = Map<string, { mtime: number; data: unknown }>;

function readJsonCached(path: string, cache: FileCache): unknown | null {
  try {
    const stat = statSync(path);
    if (stat.size > MAX_FILE_SIZE_BYTES) return null;

    const cached = cache.get(path);
    if (cached && cached.mtime >= stat.mtimeMs) return cached.data;

    const raw = readFileSync(path, 'utf-8');
    const data = JSON.parse(raw);
    cache.set(path, { mtime: stat.mtimeMs, data });
    return data;
  } catch {
    return cache.get(path)?.data ?? null;
  }
}

function safeDirEntries(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// ---- Team parsing ----

function parseTeamMember(raw: Record<string, unknown>): TeamMember {
  return {
    name: String(raw['name'] ?? 'unknown'),
    agentType: String(raw['agentType'] ?? 'unknown'),
    model: String(raw['model'] ?? 'unknown'),
    color: typeof raw['color'] === 'string' ? raw['color'] : undefined,
    status: 'unknown',
  };
}

function parseTeam(teamDir: string, cache: FileCache): Team | null {
  const configPath = join(teamDir, 'config.json');
  const raw = readJsonCached(configPath, cache) as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object') return null;

  const members = Array.isArray(raw['members'])
    ? (raw['members'] as Record<string, unknown>[]).map(parseTeamMember)
    : [];

  // Get last activity from config file mtime
  let lastActivityMs = 0;
  try {
    lastActivityMs = statSync(configPath).mtimeMs;
  } catch { /* ignore */ }

  // Also check inbox file mtimes for more precise activity
  const inboxDir = join(teamDir, 'inboxes');
  for (const f of safeDirEntries(inboxDir)) {
    if (f.endsWith('.json')) {
      try {
        const mt = statSync(join(inboxDir, f)).mtimeMs;
        if (mt > lastActivityMs) lastActivityMs = mt;
      } catch { /* ignore */ }
    }
  }

  return {
    name: String(raw['name'] ?? basename(teamDir)),
    description: String(raw['description'] ?? ''),
    createdAt: typeof raw['createdAt'] === 'number' ? raw['createdAt'] : 0,
    members,
    lastActivityMs,
  };
}

export function parseAllTeams(claudeDir: string, cache: FileCache): Team[] {
  const teamsDir = join(claudeDir, 'teams');
  const teams: Team[] = [];
  for (const entry of safeDirEntries(teamsDir)) {
    const teamDir = join(teamsDir, entry);
    try {
      if (!statSync(teamDir).isDirectory()) continue;
    } catch { continue; }
    const team = parseTeam(teamDir, cache);
    if (team) teams.push(team);
  }
  return teams.sort((a, b) => b.lastActivityMs - a.lastActivityMs);
}

// ---- Task parsing ----

function parseTask(filePath: string, teamName: string, cache: FileCache): Task | null {
  const raw = readJsonCached(filePath, cache) as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw['id'] !== 'string' && typeof raw['id'] !== 'number') return null;

  const owner = raw['owner'];
  return {
    id: String(raw['id']),
    subject: String(raw['subject'] ?? ''),
    description: String(raw['description'] ?? ''),
    activeForm: String(raw['activeForm'] ?? ''),
    owner: typeof owner === 'string' && owner.length > 0 ? owner : null,
    status: raw['status'] === 'pending' || raw['status'] === 'in_progress' || raw['status'] === 'completed'
      ? raw['status']
      : 'pending',
    blocks: Array.isArray(raw['blocks']) ? raw['blocks'].map(String) : [],
    blockedBy: Array.isArray(raw['blockedBy']) ? raw['blockedBy'].map(String) : [],
    teamName,
  };
}

export function parseAllTasks(claudeDir: string, cache: FileCache): TaskGroup[] {
  const tasksDir = join(claudeDir, 'tasks');
  const groups: TaskGroup[] = [];

  for (const entry of safeDirEntries(tasksDir)) {
    const dir = join(tasksDir, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch { continue; }

    // Filter: only directories containing at least one .json task file
    const jsonFiles = safeDirEntries(dir).filter(
      f => f.endsWith('.json') && !f.startsWith('.')
    );
    if (jsonFiles.length === 0) continue;

    const tasks: Task[] = [];
    for (const f of jsonFiles) {
      const task = parseTask(join(dir, f), entry, cache);
      if (task) tasks.push(task);
    }

    if (tasks.length > 0) {
      const completed = tasks.filter(t => t.status === 'completed').length;
      groups.push({
        teamName: entry,
        tasks: tasks.sort((a, b) => Number(a.id) - Number(b.id)),
        completed,
        total: tasks.length,
      });
    }
  }
  return groups;
}

// ---- Message parsing ----

function parseTimestamp(ts: unknown): number {
  if (typeof ts === 'number') return ts;
  if (typeof ts === 'string') {
    const d = new Date(ts);
    return isNaN(d.getTime()) ? 0 : d.getTime();
  }
  return 0;
}

function parseMessageEntry(raw: Record<string, unknown>, teamName: string): Message {
  const base = {
    from: String(raw['from'] ?? 'unknown'),
    text: String(raw['text'] ?? ''),
    summary: String(raw['summary'] ?? ''),
    timestamp: parseTimestamp(raw['timestamp']),
    color: typeof raw['color'] === 'string' ? raw['color'] : undefined,
    read: raw['read'] === true,
    teamName,
  };

  // Try to detect structured message types from the text field
  try {
    const parsed = JSON.parse(base.text);
    if (parsed && typeof parsed === 'object' && 'type' in parsed) {
      const msgType = parsed['type'] as string;

      if (msgType === 'idle_notification') {
        return { ...base, parsedType: 'idle_notification', agentName: String(parsed['from'] ?? base.from) };
      }
      if (msgType === 'task_assignment') {
        return { ...base, parsedType: 'task_assignment', taskId: String(parsed['taskId'] ?? ''), assignee: String(parsed['assignee'] ?? '') };
      }
      if (msgType === 'shutdown_request') {
        return { ...base, parsedType: 'shutdown_request', requestId: String(parsed['requestId'] ?? '') };
      }
      if (msgType === 'plan_approval_request') {
        return { ...base, parsedType: 'plan_approval_request', requestId: String(parsed['requestId'] ?? '') };
      }
    }
  } catch {
    // Not JSON — treat as plain text message
  }

  return { ...base, parsedType: 'text' };
}

export function parseAllMessages(claudeDir: string, cache: FileCache): Message[] {
  const teamsDir = join(claudeDir, 'teams');
  const allMessages: Message[] = [];

  for (const teamEntry of safeDirEntries(teamsDir)) {
    const inboxDir = join(teamsDir, teamEntry, 'inboxes');
    if (!existsSync(inboxDir)) continue;

    for (const f of safeDirEntries(inboxDir)) {
      if (!f.endsWith('.json')) continue;
      const raw = readJsonCached(join(inboxDir, f), cache);
      if (!Array.isArray(raw)) continue;

      for (const entry of raw) {
        if (entry && typeof entry === 'object') {
          allMessages.push(parseMessageEntry(entry as Record<string, unknown>, teamEntry));
        }
      }
    }
  }

  // Sort by timestamp descending, limit to most recent
  return allMessages
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, MAX_MESSAGES_DISPLAYED);
}

// ---- Stats parsing ----

export function parseStats(claudeDir: string, cache: FileCache): StatsData {
  const statsPath = join(claudeDir, 'stats-cache.json');
  const raw = readJsonCached(statsPath, cache) as Record<string, unknown> | null;

  const empty: StatsData = { daily: [], totalSessions: 0, totalMessages: 0 };
  if (!raw || typeof raw !== 'object') return empty;

  const daily: DailyStats[] = [];
  if (Array.isArray(raw['dailyActivity'])) {
    for (const d of raw['dailyActivity'] as Record<string, unknown>[]) {
      daily.push({
        date: String(d['date'] ?? ''),
        messageCount: typeof d['messageCount'] === 'number' ? d['messageCount'] : 0,
        sessionCount: typeof d['sessionCount'] === 'number' ? d['sessionCount'] : 0,
        toolCallCount: typeof d['toolCallCount'] === 'number' ? d['toolCallCount'] : 0,
      });
    }
  }

  return {
    daily,
    totalSessions: typeof raw['totalSessions'] === 'number' ? raw['totalSessions'] : 0,
    totalMessages: typeof raw['totalMessages'] === 'number' ? raw['totalMessages'] : 0,
  };
}

// ---- Read all data in one pass ----

export function readAllData(claudeDir: string, cache: FileCache): Omit<DataState, 'loading' | 'sessions'> {
  return {
    teams: parseAllTeams(claudeDir, cache),
    taskGroups: parseAllTasks(claudeDir, cache),
    messages: parseAllMessages(claudeDir, cache),
    stats: parseStats(claudeDir, cache),
  };
}

// ---- Update team member statuses from messages ----

export function enrichTeamStatuses(teams: Team[], messages: Message[]): Team[] {
  return teams.map(team => {
    const teamMsgs = messages.filter(m => m.teamName === team.name);
    const members = team.members.map(member => {
      // Find the latest message from/about this member
      const memberMsgs = teamMsgs.filter(m => m.from === member.name);
      if (memberMsgs.length === 0) return member;

      const latest = memberMsgs[0]; // already sorted desc
      let status: TeamMember['status'] = 'unknown';
      if (latest.parsedType === 'idle_notification') {
        status = 'idle';
      } else {
        // If there's a recent non-idle message, agent was recently active
        const age = Date.now() - latest.timestamp;
        status = age < 2 * 60 * 1000 ? 'active' : 'idle';
      }
      return { ...member, status };
    });
    return { ...team, members };
  });
}
