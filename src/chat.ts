import { execSync } from 'node:child_process';

interface ProcessInfo {
  pid: number;
  tty: string;
  cwd: string;
}

// ---- Find running Claude processes with their TTYs and CWDs ----

function findClaudeProcesses(): ProcessInfo[] {
  try {
    // Use ps (not pgrep) for reliable detection on macOS
    const psOutput = execSync(
      "ps -eo pid=,tty=,comm= | awk '$3 == \"claude\" && $2 != \"??\" {print $1, $2}'",
      { encoding: 'utf-8', timeout: 5000 }
    );

    const processes: ProcessInfo[] = [];
    for (const line of psOutput.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+/);
      const pid = parseInt(parts[0] ?? '', 10);
      const tty = parts[1];
      if (!pid || !tty || isNaN(pid)) continue;

      try {
        const lsofOutput = execSync(`lsof -a -p ${pid} -d cwd -Fn 2>/dev/null || true`, {
          encoding: 'utf-8',
          timeout: 3000,
        });
        for (const l of lsofOutput.split('\n')) {
          if (l.startsWith('n/')) {
            processes.push({ pid, tty, cwd: l.slice(1) });
            break;
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

  // Prefer exact match, then longest prefix match
  let best: ProcessInfo | null = null;
  let bestLen = -1;

  for (const p of processes) {
    if (p.cwd === sessionCwd) return p;
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
    let currentPid = pid;
    for (let i = 0; i < 20; i++) {
      const info = execSync(`ps -o ppid=,comm= -p ${currentPid} 2>/dev/null`, {
        encoding: 'utf-8',
        timeout: 2000,
      }).trim();

      if (!info) break;

      const ppid = parseInt(info.split(/\s+/)[0] ?? '', 10);
      const comm = info.replace(/^\s*\d+\s+/, '').toLowerCase();

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

// ---- Extract project name from CWD for window title matching ----

function projectNameFromCwd(cwd: string): string {
  const parts = cwd.split('/');
  return parts[parts.length - 1] || cwd;
}

// ---- Focus + send for Terminal.app (uses TTY to find exact tab) ----

function sendViaTerminal(ttyDevice: string, message: string): boolean {
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
    delay 0.5
    tell application "System Events"
      tell process "Terminal"
        keystroke "${escaped}"
        delay 0.3
        key code 36
      end tell
    end tell
  `;

  try {
    execSync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, {
      encoding: 'utf-8',
      timeout: 10000,
    });
    return true;
  } catch {
    return false;
  }
}

// ---- Focus + send for apps with window title matching (IDEs, etc.) ----

function sendViaAppWindow(appName: string, projectName: string, message: string): boolean {
  const escaped = escapeForAppleScript(message);
  const escapedProject = escapeForAppleScript(projectName);
  const escapedApp = escapeForAppleScript(appName);

  // Find the window whose title contains the project name, raise it, then type
  const script = `
    tell application "${escapedApp}" to activate
    delay 0.3
    tell application "System Events"
      tell process "${escapedApp}"
        set targetWindow to missing value
        set allWindows to every window
        repeat with w in allWindows
          if name of w contains "${escapedProject}" then
            set targetWindow to w
            exit repeat
          end if
        end repeat
        if targetWindow is not missing value then
          perform action "AXRaise" of targetWindow
          delay 0.3
        end if
        keystroke "${escaped}"
        delay 0.3
        key code 36
      end tell
    end tell
  `;

  try {
    execSync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, {
      encoding: 'utf-8',
      timeout: 10000,
    });
    return true;
  } catch {
    return false;
  }
}

// ---- Fallback: just activate the app and type (single-window apps) ----

function sendViaAppGeneric(appName: string, message: string): boolean {
  const escaped = escapeForAppleScript(message);
  const escapedApp = escapeForAppleScript(appName);

  const script = `
    tell application "${escapedApp}" to activate
    delay 0.5
    tell application "System Events"
      tell process "${escapedApp}"
        keystroke "${escaped}"
        delay 0.3
        key code 36
      end tell
    end tell
  `;

  try {
    execSync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, {
      encoding: 'utf-8',
      timeout: 10000,
    });
    return true;
  } catch {
    return false;
  }
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

// ---- Focus app window by project name ----

function focusAppWindow(appName: string, projectName: string): boolean {
  const escapedApp = escapeForAppleScript(appName);
  const escapedProject = escapeForAppleScript(projectName);

  const script = `
    tell application "${escapedApp}" to activate
    delay 0.2
    tell application "System Events"
      tell process "${escapedApp}"
        set allWindows to every window
        repeat with w in allWindows
          if name of w contains "${escapedProject}" then
            perform action "AXRaise" of w
            return true
          end if
        end repeat
      end tell
    end tell
    return false
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
  const app = findParentApp(proc.pid);
  const projectName = projectNameFromCwd(sessionCwd);

  // Terminal.app: use TTY-based tab matching
  if ((!app || app === 'Terminal') && focusTerminalTab(ttyDevice)) {
    return { success: true };
  }

  // IDEs and multi-window apps: match by window title
  if (app && focusAppWindow(app, projectName)) {
    return { success: true };
  }

  // Fallback: just activate the app
  if (app && focusApp(app)) {
    return { success: true };
  }

  return { success: false, error: `Could not find window for ${ttyDevice}` };
}

// ---- Public: send a message to a session ----

export function sendToSession(sessionCwd: string, message: string): { success: boolean; error?: string } {
  const proc = findProcessForSession(sessionCwd);
  if (!proc) {
    return { success: false, error: 'No running process found' };
  }

  const ttyDevice = `/dev/${proc.tty}`;
  const app = findParentApp(proc.pid);
  const projectName = projectNameFromCwd(sessionCwd);

  let success = false;

  if (!app || app === 'Terminal') {
    // Terminal.app: use TTY-based tab targeting (most precise)
    success = sendViaTerminal(ttyDevice, message);
  } else {
    // IDEs and multi-window apps: match window by project name
    success = sendViaAppWindow(app, projectName, message);
    // Fallback to generic if window matching fails
    if (!success) {
      success = sendViaAppGeneric(app, message);
    }
  }

  if (success) {
    return { success: true };
  }
  return { success: false, error: `Failed to send to ${app ?? 'Terminal'}` };
}

// ---- Public: start a new Claude session in a new Terminal tab ----

export function startNewSession(cwd: string, prompt?: string): { success: boolean; error?: string } {
  const shellEscape = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
  const shellCmd = prompt
    ? `cd ${shellEscape(cwd)} && claude --dangerously-skip-permissions ${shellEscape(prompt)}`
    : `cd ${shellEscape(cwd)} && claude --dangerously-skip-permissions`;

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
