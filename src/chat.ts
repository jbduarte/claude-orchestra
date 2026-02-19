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

interface AppInfo {
  displayName: string;   // For tell application (e.g. "PyCharm")
  processName: string;   // For System Events process (e.g. "pycharm")
}

function findParentApp(pid: number): AppInfo | null {
  // Known terminal apps: comm substring → { displayName, processName }
  const knownApps: Record<string, AppInfo> = {
    'terminal': { displayName: 'Terminal', processName: 'Terminal' },
    'iterm2': { displayName: 'iTerm2', processName: 'iTerm2' },
    'iterm': { displayName: 'iTerm', processName: 'iTerm2' },
    'alacritty': { displayName: 'Alacritty', processName: 'Alacritty' },
    'kitty': { displayName: 'kitty', processName: 'kitty' },
    'wezterm-gui': { displayName: 'WezTerm', processName: 'WezTerm' },
    'warp': { displayName: 'Warp', processName: 'Warp' },
    'hyper': { displayName: 'Hyper', processName: 'Hyper' },
  };

  // IDE patterns: need to resolve actual System Events process name at runtime
  const idePatterns: Array<{ pattern: RegExp; displayName: string }> = [
    { pattern: /pycharm/i, displayName: 'PyCharm' },
    { pattern: /idea/i, displayName: 'IntelliJ IDEA' },
    { pattern: /webstorm/i, displayName: 'WebStorm' },
    { pattern: /goland/i, displayName: 'GoLand' },
    { pattern: /clion/i, displayName: 'CLion' },
    { pattern: /rubymine/i, displayName: 'RubyMine' },
    { pattern: /rider/i, displayName: 'Rider' },
    { pattern: /code/i, displayName: 'Visual Studio Code' },
    { pattern: /cursor/i, displayName: 'Cursor' },
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

      for (const [key, appInfo] of Object.entries(knownApps)) {
        if (comm.includes(key)) return appInfo;
      }
      for (const { pattern, displayName } of idePatterns) {
        if (pattern.test(comm)) {
          // Resolve the actual System Events process name
          const seName = resolveSystemEventsName(displayName);
          return { displayName, processName: seName ?? displayName };
        }
      }

      if (isNaN(ppid) || ppid <= 1) break;
      currentPid = ppid;
    }
  } catch {
    // Ignore errors
  }

  return null;
}

// Resolve the actual System Events process name for an app
function resolveSystemEventsName(displayName: string): string | null {
  try {
    const result = execSync(
      `osascript -e 'tell application "System Events" to get name of first process whose name contains "${escapeForAppleScript(displayName.toLowerCase())}"' 2>/dev/null`,
      { encoding: 'utf-8', timeout: 3000 }
    ).trim();
    if (result) return result;
  } catch { /* ignore */ }

  // Fallback: try lowercase
  try {
    const result = execSync(
      `osascript -e 'tell application "System Events" to get name of first process whose displayed name contains "${escapeForAppleScript(displayName)}"' 2>/dev/null`,
      { encoding: 'utf-8', timeout: 3000 }
    ).trim();
    if (result) return result;
  } catch { /* ignore */ }

  return null;
}

// ---- Extract project name from CWD for window title matching ----

function projectNameFromCwd(cwd: string): string {
  const parts = cwd.split('/');
  return parts[parts.length - 1] || cwd;
}

// ---- Send to Terminal.app tab, then refocus orchestra's tab ----

function sendViaTerminal(ttyDevice: string, message: string): boolean {
  const escaped = escapeForAppleScript(message);

  // Save orchestra's tab, switch to target, send keystrokes + Enter, switch back
  const script = `
    tell application "Terminal"
      set orchestraWindow to front window
      set orchestraTab to selected tab of orchestraWindow

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
        delay 0.2
        key code 36
      end tell
    end tell
    delay 0.2
    tell application "Terminal"
      set selected of orchestraTab to true
      set frontmost of orchestraWindow to true
    end tell
  `;

  try {
    execSync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, {
      encoding: 'utf-8',
      timeout: 15000,
    });
    return true;
  } catch {
    return false;
  }
}

// ---- Focus + send for apps with window title matching, then refocus back ----

function sendViaAppWindow(app: AppInfo, projectName: string, message: string): boolean {
  const escaped = escapeForAppleScript(message);
  const escapedProject = escapeForAppleScript(projectName);
  const escapedDisplayName = escapeForAppleScript(app.displayName);
  const escapedProcessName = escapeForAppleScript(app.processName);

  // Save current app, send keystrokes to target, then refocus back to orchestra
  const script = `
    tell application "System Events"
      set orchestraApp to name of first application process whose frontmost is true
    end tell
    tell application "${escapedDisplayName}" to activate
    delay 0.3
    tell application "System Events"
      tell process "${escapedProcessName}"
        set targetWindow to missing value
        set allWindows to every window
        repeat with w in allWindows
          if name of w contains "${escapedProject}" then
            set targetWindow to w
            exit repeat
          end if
        end repeat
        if targetWindow is missing value then
          error "No window found for ${escapedProject}"
        end if
        perform action "AXRaise" of targetWindow
        delay 0.3
        keystroke "${escaped}"
        delay 0.3
        key code 36
      end tell
    end tell
    delay 0.2
    tell application orchestraApp to activate
  `;

  try {
    execSync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, {
      encoding: 'utf-8',
      timeout: 15000,
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

function focusAppWindow(app: AppInfo, projectName: string): boolean {
  const escapedDisplayName = escapeForAppleScript(app.displayName);
  const escapedProcessName = escapeForAppleScript(app.processName);
  const escapedProject = escapeForAppleScript(projectName);

  const script = `
    tell application "${escapedDisplayName}" to activate
    delay 0.2
    tell application "System Events"
      tell process "${escapedProcessName}"
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
  if ((!app || app.displayName === 'Terminal') && focusTerminalTab(ttyDevice)) {
    return { success: true };
  }

  // IDEs and multi-window apps: match by window title (no fallback — never focus wrong window)
  if (app && focusAppWindow(app, projectName)) {
    return { success: true };
  }

  return { success: false, error: `Session window not found — it may have closed, Maestro` };
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

  if (!app || app.displayName === 'Terminal') {
    // Terminal.app: use TTY-based tab targeting (most precise)
    success = sendViaTerminal(ttyDevice, message);
  } else {
    // IDEs and multi-window apps: match window by project name (no fallback — never send to wrong window)
    success = sendViaAppWindow(app, projectName, message);
  }

  if (success) {
    return { success: true };
  }
  return { success: false, error: `Session window not found — it may have closed, Maestro` };
}

// ---- Public: start a new Claude session in a new Terminal tab ----

export function startNewSession(cwd: string, prompt?: string): { success: boolean; error?: string } {
  const shellEscape = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
  const shellCmd = prompt
    ? `cd ${shellEscape(cwd)} && claude --dangerously-skip-permissions ${shellEscape(prompt)}`
    : `cd ${shellEscape(cwd)} && claude --dangerously-skip-permissions`;

  // Start session in a new Terminal tab, then refocus orchestra
  const script = `
    tell application "System Events"
      set orchestraApp to name of first application process whose frontmost is true
    end tell
    tell application "Terminal"
      do script "${escapeForAppleScript(shellCmd)}"
    end tell
    delay 0.5
    tell application orchestraApp to activate
  `;

  try {
    execSync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, {
      encoding: 'utf-8',
      timeout: 10000,
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: `Failed to start session: ${(err as Error).message}` };
  }
}
