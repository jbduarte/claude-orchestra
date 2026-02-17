import { execSync } from 'node:child_process';

interface ProcessInfo {
  pid: number;
  tty: string;
  cwd: string;
}

// ---- Find running Claude processes with their TTYs and CWDs ----

function findClaudeProcesses(): ProcessInfo[] {
  try {
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

// ---- Escape string for AppleScript ----

function escapeForAppleScript(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// ---- Find the TTY device for a session by matching CWD ----

function findTtyForSession(sessionCwd: string): { tty: string; error?: string } | null {
  const processes = findClaudeProcesses();
  if (processes.length === 0) return { tty: '', error: 'No running Claude processes found' };

  const match = processes.find(p => sessionCwd.startsWith(p.cwd) || p.cwd.startsWith(sessionCwd));
  if (!match) return { tty: '', error: `No process found for ${sessionCwd}` };

  return { tty: `/dev/${match.tty}` };
}

// ---- Focus the Terminal tab containing a session ----

function focusTerminalTab(ttyDevice: string): { success: boolean; error?: string } {
  const script = `
    tell application "Terminal"
      set targetTab to missing value
      set targetWindow to missing value
      repeat with w in windows
        repeat with t in tabs of w
          if tty of t is "${ttyDevice}" then
            set targetTab to t
            set targetWindow to w
          end if
        end repeat
      end repeat
      if targetTab is missing value then
        error "No Terminal tab found for ${ttyDevice}"
      end if
      set selected of targetTab to true
      set frontmost of targetWindow to true
    end tell
    tell application "Terminal" to activate
  `;

  try {
    execSync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, {
      encoding: 'utf-8',
      timeout: 5000,
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: `AppleScript failed: ${(err as Error).message}` };
  }
}

// ---- Public: focus a session's Terminal tab ----

export function focusSession(sessionCwd: string): { success: boolean; error?: string } {
  const result = findTtyForSession(sessionCwd);
  if (!result || result.error) {
    return { success: false, error: result?.error ?? 'Unknown error' };
  }
  return focusTerminalTab(result.tty);
}

// ---- Public: send a message to a session via keystroke injection ----

export function sendToSession(sessionCwd: string, message: string): { success: boolean; error?: string } {
  const result = findTtyForSession(sessionCwd);
  if (!result || result.error) {
    return { success: false, error: result?.error ?? 'Unknown error' };
  }

  const ttyDevice = result.tty;
  const escaped = escapeForAppleScript(message);

  const script = `
    tell application "Terminal"
      set targetTab to missing value
      set targetWindow to missing value
      repeat with w in windows
        repeat with t in tabs of w
          if tty of t is "${ttyDevice}" then
            set targetTab to t
            set targetWindow to w
          end if
        end repeat
      end repeat
      if targetTab is missing value then
        error "No Terminal tab found for ${ttyDevice}"
      end if
      set selected of targetTab to true
      set frontmost of targetWindow to true
    end tell
    delay 0.1
    tell application "System Events"
      tell process "Terminal"
        keystroke "${escaped}"
        delay 0.05
        keystroke return
      end tell
    end tell
  `;

  try {
    execSync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, {
      encoding: 'utf-8',
      timeout: 10000,
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: `AppleScript failed: ${(err as Error).message}` };
  }
}
