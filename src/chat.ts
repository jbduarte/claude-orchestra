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

// ---- Find the process matching a session by CWD ----

function findProcessForSession(sessionCwd: string): ProcessInfo | null {
  const processes = findClaudeProcesses();

  // Prefer exact match, then longest prefix match to avoid wrong session
  let best: ProcessInfo | null = null;
  let bestLen = -1;

  for (const p of processes) {
    if (p.cwd === sessionCwd) return p; // exact match — done
    if (sessionCwd.startsWith(p.cwd + '/') && p.cwd.length > bestLen) {
      best = p;
      bestLen = p.cwd.length;
    }
    if (p.cwd.startsWith(sessionCwd + '/') && sessionCwd.length > bestLen) {
      best = p;
      bestLen = sessionCwd.length;
    }
  }

  return best;
}

// ---- Walk up process tree to find the owning GUI app ----

function findParentApp(pid: number): string | null {
  const knownApps: Record<string, string> = {
    'terminal': 'Terminal',
    'iterm2': 'iTerm2',
    'iterm': 'iTerm',
    'alacritty': 'Alacritty',
    'kitty': 'kitty',
    'wezterm-gui': 'WezTerm',
    'warp': 'Warp',
    'hyper': 'Hyper',
  };

  // Also match apps by path patterns (IDEs with embedded terminals)
  const idePatterns: Array<{ pattern: RegExp; app: string }> = [
    { pattern: /pycharm/i, app: 'PyCharm' },
    { pattern: /idea/i, app: 'IntelliJ IDEA' },
    { pattern: /webstorm/i, app: 'WebStorm' },
    { pattern: /goland/i, app: 'GoLand' },
    { pattern: /clion/i, app: 'CLion' },
    { pattern: /rubymine/i, app: 'RubyMine' },
    { pattern: /rider/i, app: 'Rider' },
    { pattern: /code/i, app: 'Visual Studio Code' },
    { pattern: /cursor/i, app: 'Cursor' },
  ];

  try {
    // Walk up the process tree (max 20 levels to avoid infinite loops)
    let currentPid = pid;
    for (let i = 0; i < 20; i++) {
      const info = execSync(`ps -o ppid=,comm= -p ${currentPid} 2>/dev/null`, {
        encoding: 'utf-8',
        timeout: 2000,
      }).trim();

      if (!info) break;

      const ppid = parseInt(info.split(/\s+/)[0] ?? '', 10);
      const comm = info.replace(/^\s*\d+\s+/, '').toLowerCase();

      // Check matches BEFORE breaking on ppid — the app itself may have ppid=1
      for (const [key, appName] of Object.entries(knownApps)) {
        if (comm.includes(key)) return appName;
      }
      for (const { pattern, app } of idePatterns) {
        if (pattern.test(comm)) return app;
      }

      if (isNaN(ppid) || ppid <= 1) break;
      currentPid = ppid;
    }
  } catch {
    // Ignore errors
  }

  return null;
}

// ---- Focus the Terminal.app tab containing a TTY ----

function focusTerminalTab(ttyDevice: string): boolean {
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
        return false
      end if
      set selected of targetTab to true
      set frontmost of targetWindow to true
    end tell
    tell application "Terminal" to activate
    return true
  `;

  try {
    const result = execSync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    return result === 'true';
  } catch {
    return false;
  }
}

// ---- Focus any app by name ----

function focusApp(appName: string): boolean {
  try {
    execSync(`osascript -e 'tell application "${escapeForAppleScript(appName)}" to activate'`, {
      encoding: 'utf-8',
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

// ---- Public: focus a session's window ----

export function focusSession(sessionCwd: string): { success: boolean; error?: string } {
  const proc = findProcessForSession(sessionCwd);
  if (!proc) {
    return { success: false, error: 'No running process found' };
  }

  const ttyDevice = `/dev/${proc.tty}`;

  // Try Terminal.app first (can focus specific tab)
  if (focusTerminalTab(ttyDevice)) {
    return { success: true };
  }

  // Fallback: find parent app and activate it
  const app = findParentApp(proc.pid);
  if (app && focusApp(app)) {
    return { success: true };
  }

  return { success: false, error: `Could not find window for ${ttyDevice}` };
}

// ---- Public: send a message to a session via keystroke injection ----

export function sendToSession(sessionCwd: string, message: string): { success: boolean; error?: string } {
  const proc = findProcessForSession(sessionCwd);
  if (!proc) {
    return { success: false, error: 'No running process found' };
  }

  const ttyDevice = `/dev/${proc.tty}`;
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
    tell application "Terminal" to activate
    delay 0.3
    tell application "System Events"
      tell process "Terminal"
        keystroke "${escaped}"
        delay 0.15
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

// ---- Public: start a new Claude session in a new Terminal tab ----

export function startNewSession(cwd: string, prompt?: string): { success: boolean; error?: string } {
  // Use single quotes for shell args (safe inside AppleScript double-quoted strings)
  const shellEscape = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
  const shellCmd = prompt
    ? `cd ${shellEscape(cwd)} && claude ${shellEscape(prompt)}`
    : `cd ${shellEscape(cwd)} && claude`;

  const script = `tell application "Terminal"
    activate
    do script "${escapeForAppleScript(shellCmd)}"
  end tell`;

  try {
    execSync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, {
      encoding: 'utf-8',
      timeout: 5000,
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: `Failed to start session: ${(err as Error).message}` };
  }
}
