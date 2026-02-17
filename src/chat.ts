import { execSync } from 'node:child_process';
import { openSync, writeSync, closeSync } from 'node:fs';

interface ProcessInfo {
  pid: number;
  tty: string;
  cwd: string;
}

// ---- Find running Claude processes with their TTYs and CWDs ----

function findClaudeProcesses(): ProcessInfo[] {
  try {
    // Get PIDs and TTYs of claude processes
    const psOutput = execSync('ps -o pid=,tty= -c -C claude 2>/dev/null || ps -o pid=,tty=,comm= | grep "claude$"', {
      encoding: 'utf-8',
      timeout: 5000,
    });

    const processes: ProcessInfo[] = [];
    for (const line of psOutput.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+/);
      const pid = parseInt(parts[0] ?? '', 10);
      const tty = parts[1];
      if (!pid || !tty || tty === '??' || isNaN(pid)) continue;

      // Get CWD via lsof
      try {
        const lsofOutput = execSync(`lsof -a -p ${pid} -d cwd 2>/dev/null`, {
          encoding: 'utf-8',
          timeout: 3000,
        });
        const cwdLine = lsofOutput.split('\n').find(l => l.includes('cwd'));
        if (cwdLine) {
          const cwdMatch = cwdLine.match(/\s(\/\S.*)$/);
          if (cwdMatch) {
            processes.push({ pid, tty, cwd: cwdMatch[1]! });
          }
        }
      } catch {
        // Skip if can't get CWD
      }
    }

    return processes;
  } catch {
    return [];
  }
}

// ---- Match a session to a process by CWD ----

export function sendToSession(sessionCwd: string, message: string): { success: boolean; error?: string } {
  const processes = findClaudeProcesses();

  if (processes.length === 0) {
    return { success: false, error: 'No running Claude processes found' };
  }

  // Find process whose CWD matches the session's CWD
  const match = processes.find(p => sessionCwd.startsWith(p.cwd) || p.cwd.startsWith(sessionCwd));

  if (!match) {
    return { success: false, error: `No process found for ${sessionCwd}` };
  }

  const ttyPath = `/dev/${match.tty}`;

  try {
    const fd = openSync(ttyPath, 'w');
    try {
      writeSync(fd, message + '\n');
    } finally {
      closeSync(fd);
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: `Cannot write to ${ttyPath}: ${(err as Error).message}` };
  }
}
