import { execSync, execFileSync, execFile, spawn } from 'node:child_process';
import { readlinkSync } from 'node:fs';
import { MAX_NOTIFICATION_LENGTH } from './constants.js';

// ---- Types ----

export interface ClaudeProcess {
  pid: number;
  tty?: string;
  cwd?: string;
}

export type Result = { success: boolean; error?: string };

export interface PlatformAdapter {
  getRunningClaudeProcesses(): ClaudeProcess[];
  cleanupOrphanedProcesses(): void;
  findProcessForSession(sessionCwd: string): ClaudeProcess | null;
  sendToSession(sessionCwd: string, message: string): Result;
  focusSession(sessionCwd: string): Result;
  startNewSession(cwd: string, prompt?: string): Result;
  killSession(sessionCwd: string): Result;
  getRunningClaudeCwds(): Set<string>;
  isSessionProcessBusy(cwd: string): boolean;
  sendNotification(title: string, body: string, sound: boolean, done: () => void): void;
  maximizeWindow(): void;
  encodeHomePath(home: string): string;
  readonly supportsSendToSession: boolean;
  readonly supportsFocusSession: boolean;
  readonly platformName: string;
}

// ---- Shared helper ----

const shellEscape = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'";

// ---- CWD matching (shared by Darwin + Linux) ----

function matchProcessByCwd(processes: ClaudeProcess[], sessionCwd: string): ClaudeProcess | null {
  let best: ClaudeProcess | null = null;
  let bestLen = -1;

  for (const p of processes) {
    if (p.cwd === sessionCwd) return p;
    if (p.cwd && (sessionCwd.startsWith(p.cwd + '/') || sessionCwd.startsWith(p.cwd + '\\')) && p.cwd.length > bestLen) {
      best = p;
      bestLen = p.cwd.length;
    }
    if (p.cwd && (p.cwd.startsWith(sessionCwd + '/') || p.cwd.startsWith(sessionCwd + '\\')) && sessionCwd.length > bestLen) {
      best = p;
      bestLen = sessionCwd.length;
    }
  }

  return best;
}

// ============================================================================
// DarwinAdapter — macOS
// ============================================================================

interface AppInfo {
  displayName: string;   // For tell application (e.g. "PyCharm")
  processName: string;   // For System Events process (e.g. "pycharm")
}

class DarwinAdapter implements PlatformAdapter {
  readonly supportsSendToSession = true;
  readonly supportsFocusSession = true;
  readonly platformName = 'macOS';

  getRunningClaudeProcesses(): ClaudeProcess[] {
    try {
      // Use ps + awk for reliable detection on macOS
      const psOutput = execSync(
        "ps -eo pid=,tty=,comm= | awk '$3 == \"claude\" && $2 != \"??\" {print $1, $2}'",
        { encoding: 'utf-8', timeout: 5000 },
      );

      const processes: ClaudeProcess[] = [];
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

  cleanupOrphanedProcesses(): void {
    try {
      const output = execSync(
        'ps -eo pid=,ppid=,command= 2>/dev/null || true',
        { encoding: 'utf-8', timeout: 5000 },
      );
      for (const line of output.split('\n')) {
        if (!line.includes('.claude/shell-snapshots/')) continue;
        const parts = line.trim().split(/\s+/);
        const pid = parseInt(parts[0] ?? '', 10);
        const ppid = parseInt(parts[1] ?? '', 10);
        if (!isNaN(pid) && ppid === 1 && pid !== process.pid) {
          try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
        }
      }
    } catch {
      // Ignore errors
    }
  }

  // ---- Liveness detection (separate from chat ops — no TTY filter, includes CPU) ----

  private _livenessProcs: Array<{pid: number; cwd: string; cpu: number}> | null = null;
  private _livenessProcAt = 0;
  private readonly _LIVENESS_CACHE_MS = 15_000;

  private getLivenessProcesses(): Array<{pid: number; cwd: string; cpu: number}> {
    const now = Date.now();
    if (this._livenessProcs && now - this._livenessProcAt < this._LIVENESS_CACHE_MS) {
      return this._livenessProcs;
    }

    const procs: Array<{pid: number; cwd: string; cpu: number}> = [];
    try {
      const psOutput = execSync(
        "ps -eo pid=,%cpu=,comm= | awk '$NF == \"claude\" {print $1, $2}'",
        { encoding: 'utf-8', timeout: 3000 },
      ).trim();

      for (const line of psOutput.split('\n').filter(Boolean)) {
        const parts = line.trim().split(/\s+/);
        const pid = parseInt(parts[0] ?? '', 10);
        const cpu = parseFloat(parts[1] ?? '0');
        if (isNaN(pid)) continue;

        try {
          const lsofOutput = execSync(
            `lsof -a -p ${pid} -d cwd -Fn 2>/dev/null || true`,
            { encoding: 'utf-8', timeout: 2000 },
          );
          for (const lsofLine of lsofOutput.split('\n')) {
            if (lsofLine.startsWith('n/')) {
              procs.push({ pid, cwd: lsofLine.slice(1), cpu });
              break;
            }
          }
        } catch { /* skip */ }
      }
    } catch { /* ps failed */ }

    this._livenessProcs = procs;
    this._livenessProcAt = now;
    return procs;
  }

  getRunningClaudeCwds(): Set<string> {
    return new Set(this.getLivenessProcesses().map(p => p.cwd));
  }

  isSessionProcessBusy(cwd: string): boolean {
    const proc = this.getLivenessProcesses().find(p => p.cwd === cwd);
    return proc ? proc.cpu > 1.0 : false;
  }

  findProcessForSession(sessionCwd: string): ClaudeProcess | null {
    return matchProcessByCwd(this.getRunningClaudeProcesses(), sessionCwd);
  }

  // ---- AppleScript helpers (private) ----

  private escapeForAppleScript(str: string): string {
    return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  private sanitizeForAppleScript(str: string): string {
    return str
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, ' ')
      .replace(/\r/g, '')
      .slice(0, MAX_NOTIFICATION_LENGTH);
  }

  private findParentApp(pid: number): AppInfo | null {
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
            const seName = this.resolveSystemEventsName(displayName);
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

  private resolveSystemEventsName(displayName: string): string | null {
    try {
      const result = execSync(
        `osascript -e 'tell application "System Events" to get name of first process whose name contains "${this.escapeForAppleScript(displayName.toLowerCase())}"' 2>/dev/null`,
        { encoding: 'utf-8', timeout: 3000 },
      ).trim();
      if (result) return result;
    } catch { /* ignore */ }

    try {
      const result = execSync(
        `osascript -e 'tell application "System Events" to get name of first process whose displayed name contains "${this.escapeForAppleScript(displayName)}"' 2>/dev/null`,
        { encoding: 'utf-8', timeout: 3000 },
      ).trim();
      if (result) return result;
    } catch { /* ignore */ }

    return null;
  }

  private projectNameFromCwd(cwd: string): string {
    const parts = cwd.split('/');
    return parts[parts.length - 1] || cwd;
  }

  private focusTerminalTab(ttyDevice: string): boolean {
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

  private focusAppWindow(app: AppInfo, projectName: string): boolean {
    const escapedDisplayName = this.escapeForAppleScript(app.displayName);
    const escapedProcessName = this.escapeForAppleScript(app.processName);
    const escapedProject = this.escapeForAppleScript(projectName);

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

  private sendViaTerminal(ttyDevice: string, message: string): boolean {
    const escaped = this.escapeForAppleScript(message);

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
      delay 0.1
      set oldClip to the clipboard
      set the clipboard to "${escaped}"
      tell application "System Events"
        tell process "Terminal"
          keystroke "v" using command down
          delay 0.3
          keystroke return
        end tell
      end tell
      delay 0.1
      set the clipboard to oldClip
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

  private sendViaAppWindow(app: AppInfo, projectName: string, message: string): boolean {
    const escaped = this.escapeForAppleScript(message);
    const escapedProject = this.escapeForAppleScript(projectName);
    const escapedDisplayName = this.escapeForAppleScript(app.displayName);
    const escapedProcessName = this.escapeForAppleScript(app.processName);

    const script = `
      tell application "System Events"
        set orchestraApp to name of first application process whose frontmost is true
      end tell
      set oldClip to the clipboard
      set the clipboard to "${escaped}"
      tell application "${escapedDisplayName}" to activate
      delay 0.1
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
            set the clipboard to oldClip
            error "No window found for ${escapedProject}"
          end if
          perform action "AXRaise" of targetWindow
          delay 0.1
          keystroke "v" using command down
          delay 0.3
          keystroke return
        end tell
      end tell
      delay 0.1
      set the clipboard to oldClip
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

  // ---- Public methods ----

  focusSession(sessionCwd: string): Result {
    const proc = this.findProcessForSession(sessionCwd);
    if (!proc) {
      return { success: false, error: 'No running process found' };
    }

    const ttyDevice = `/dev/${proc.tty}`;
    const app = this.findParentApp(proc.pid);
    const projectName = this.projectNameFromCwd(sessionCwd);

    // Terminal.app: use TTY-based tab matching
    if ((!app || app.displayName === 'Terminal') && this.focusTerminalTab(ttyDevice)) {
      return { success: true };
    }

    // IDEs and multi-window apps: match by window title
    if (app && this.focusAppWindow(app, projectName)) {
      return { success: true };
    }

    return { success: false, error: 'Session window not found — it may have closed' };
  }

  sendToSession(sessionCwd: string, message: string): Result {
    const proc = this.findProcessForSession(sessionCwd);
    if (!proc) {
      return { success: false, error: 'No running process found' };
    }

    const ttyDevice = `/dev/${proc.tty}`;
    const app = this.findParentApp(proc.pid);
    const projectName = this.projectNameFromCwd(sessionCwd);

    let success = false;

    if (!app || app.displayName === 'Terminal') {
      // Terminal.app: use TTY-based tab targeting with clipboard paste
      success = this.sendViaTerminal(ttyDevice, message);
    } else {
      // IDEs and multi-window apps: match window by project name
      success = this.sendViaAppWindow(app, projectName, message);
    }

    if (success) {
      return { success: true };
    }
    return { success: false, error: 'Session window not found — it may have closed' };
  }

  startNewSession(cwd: string, prompt?: string): Result {
    const shellCmd = prompt
      ? `cd ${shellEscape(cwd)} && claude --dangerously-skip-permissions ${shellEscape(prompt)}`
      : `cd ${shellEscape(cwd)} && claude --dangerously-skip-permissions`;

    // Start session in new Terminal tab, then refocus orchestra
    const script = `
      tell application "System Events"
        set orchestraApp to name of first application process whose frontmost is true
      end tell
      tell application "Terminal"
        do script "${this.escapeForAppleScript(shellCmd)}"
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

  killSession(sessionCwd: string): Result {
    const proc = this.findProcessForSession(sessionCwd);
    if (!proc) {
      return { success: false, error: 'No running process found' };
    }

    try {
      process.kill(proc.pid, 'SIGTERM');
      return { success: true };
    } catch (err) {
      return { success: false, error: `Failed to kill process: ${(err as Error).message}` };
    }
  }

  sendNotification(title: string, body: string, sound: boolean, done: () => void): void {
    const safeTitle = this.sanitizeForAppleScript(title);
    const safeBody = this.sanitizeForAppleScript(body);
    const soundStr = sound ? ' sound name "Glass"' : '';
    const script = `display notification "${safeBody}" with title "${safeTitle}"${soundStr}`;
    execFile('osascript', ['-e', script], { timeout: 5000 }, done);
  }

  maximizeWindow(): void {
    try {
      execSync(`osascript -e '
        tell application "System Events"
          set frontApp to name of first application process whose frontmost is true
        end tell
        tell application frontApp
          if (count of windows) > 0 then
            tell application "Finder" to set {_, _, screenW, screenH} to bounds of window of desktop
            set bounds of front window to {0, 25, screenW, screenH}
          end if
        end tell
      '`, { encoding: 'utf-8', timeout: 3000, stdio: 'ignore' });
    } catch {
      // Ignore errors
    }
  }

  encodeHomePath(home: string): string {
    return '-' + home.split('/').filter(Boolean).join('-').replace(/\./g, '-');
  }
}

// ============================================================================
// LinuxAdapter
// ============================================================================

class LinuxAdapter implements PlatformAdapter {
  private _xdotoolChecked = false;
  private _xdotoolAvailable = false;
  private _isWayland: boolean | null = null;

  get supportsSendToSession(): boolean {
    return this.hasXdotool() && !this.isWayland();
  }

  get supportsFocusSession(): boolean {
    return this.hasXdotool() && !this.isWayland();
  }

  readonly platformName = 'Linux';

  private isWayland(): boolean {
    if (this._isWayland === null) {
      this._isWayland = process.env['XDG_SESSION_TYPE'] === 'wayland';
    }
    return this._isWayland;
  }

  private hasXdotool(): boolean {
    if (!this._xdotoolChecked) {
      this._xdotoolChecked = true;
      try {
        execSync('which xdotool', { encoding: 'utf-8', timeout: 2000, stdio: 'pipe' });
        this._xdotoolAvailable = true;
      } catch {
        this._xdotoolAvailable = false;
      }
    }
    return this._xdotoolAvailable;
  }

  getRunningClaudeProcesses(): ClaudeProcess[] {
    try {
      const psOutput = execSync(
        'ps -o pid=,tty= -C claude 2>/dev/null || ps -o pid=,tty=,comm= | grep "claude$"',
        { encoding: 'utf-8', timeout: 5000 },
      );

      const processes: ClaudeProcess[] = [];
      for (const line of psOutput.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parts = trimmed.split(/\s+/);
        const pid = parseInt(parts[0] ?? '', 10);
        const tty = parts[1];
        if (!pid || !tty || tty === '?' || tty === '??' || isNaN(pid)) continue;

        let cwd: string | undefined;

        // Try lsof first
        try {
          const lsofOutput = execSync(`lsof -a -p ${pid} -d cwd 2>/dev/null`, {
            encoding: 'utf-8',
            timeout: 3000,
          });
          const cwdLine = lsofOutput.split('\n').find(l => l.includes('cwd'));
          if (cwdLine) {
            const cwdMatch = cwdLine.match(/\s(\/\S.*)$/);
            if (cwdMatch) cwd = cwdMatch[1]!;
          }
        } catch {
          // lsof failed — try /proc fallback
          try {
            cwd = readlinkSync(`/proc/${pid}/cwd`);
          } catch {
            // Can't get CWD
          }
        }

        if (cwd) {
          processes.push({ pid, tty, cwd });
        }
      }

      return processes;
    } catch {
      return [];
    }
  }

  cleanupOrphanedProcesses(): void {
    try {
      const output = execSync(
        'ps -o pid=,ppid=,comm= | grep claude',
        { encoding: 'utf-8', timeout: 5000 },
      );
      for (const line of output.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parts = trimmed.split(/\s+/);
        const pid = parseInt(parts[0] ?? '', 10);
        const ppid = parseInt(parts[1] ?? '', 10);
        if (pid && ppid === 1) {
          try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
        }
      }
    } catch {
      // Ignore errors
    }
  }

  // ---- Liveness detection (separate from chat ops — no TTY filter, includes CPU) ----

  private _livenessProcs: Array<{pid: number; cwd: string; cpu: number}> | null = null;
  private _livenessProcAt = 0;
  private readonly _LIVENESS_CACHE_MS = 15_000;

  private getLivenessProcesses(): Array<{pid: number; cwd: string; cpu: number}> {
    const now = Date.now();
    if (this._livenessProcs && now - this._livenessProcAt < this._LIVENESS_CACHE_MS) {
      return this._livenessProcs;
    }

    const procs: Array<{pid: number; cwd: string; cpu: number}> = [];
    try {
      const psOutput = execSync(
        "ps -eo pid=,%cpu=,comm= | awk '$NF == \"claude\" {print $1, $2}'",
        { encoding: 'utf-8', timeout: 3000 },
      ).trim();

      for (const line of psOutput.split('\n').filter(Boolean)) {
        const parts = line.trim().split(/\s+/);
        const pid = parseInt(parts[0] ?? '', 10);
        const cpu = parseFloat(parts[1] ?? '0');
        if (isNaN(pid)) continue;

        let cwd: string | undefined;

        // Try lsof first
        try {
          const lsofOutput = execSync(
            `lsof -a -p ${pid} -d cwd -Fn 2>/dev/null || true`,
            { encoding: 'utf-8', timeout: 2000 },
          );
          for (const lsofLine of lsofOutput.split('\n')) {
            if (lsofLine.startsWith('n/')) {
              cwd = lsofLine.slice(1);
              break;
            }
          }
        } catch {
          // lsof failed — try /proc fallback
          try {
            cwd = readlinkSync(`/proc/${pid}/cwd`);
          } catch { /* skip */ }
        }

        if (cwd) {
          procs.push({ pid, cwd, cpu });
        }
      }
    } catch { /* ps failed */ }

    this._livenessProcs = procs;
    this._livenessProcAt = now;
    return procs;
  }

  getRunningClaudeCwds(): Set<string> {
    return new Set(this.getLivenessProcesses().map(p => p.cwd));
  }

  isSessionProcessBusy(cwd: string): boolean {
    const proc = this.getLivenessProcesses().find(p => p.cwd === cwd);
    return proc ? proc.cpu > 1.0 : false;
  }

  findProcessForSession(sessionCwd: string): ClaudeProcess | null {
    return matchProcessByCwd(this.getRunningClaudeProcesses(), sessionCwd);
  }

  focusSession(sessionCwd: string): Result {
    if (this.isWayland()) {
      return { success: false, error: 'Focus not supported on Wayland' };
    }
    if (!this.hasXdotool()) {
      return { success: false, error: 'xdotool not installed. Install with: sudo apt install xdotool' };
    }

    const proc = this.findProcessForSession(sessionCwd);
    if (!proc) {
      return { success: false, error: 'No running process found' };
    }

    try {
      // Search by directory name in window title
      const dirName = sessionCwd.split('/').pop() ?? 'claude';
      let windowId = execSync(
        `xdotool search --name ${shellEscape(dirName)} 2>/dev/null | head -1`,
        { encoding: 'utf-8', timeout: 3000 },
      ).trim();

      // Fallback: search for "claude" in window title
      if (!windowId) {
        windowId = execSync(
          'xdotool search --name claude 2>/dev/null | head -1',
          { encoding: 'utf-8', timeout: 3000 },
        ).trim();
      }

      if (windowId) {
        execSync(`xdotool windowactivate ${windowId}`, { encoding: 'utf-8', timeout: 3000 });
        return { success: true };
      }

      return { success: false, error: 'Could not find window' };
    } catch (err) {
      return { success: false, error: `xdotool failed: ${(err as Error).message}` };
    }
  }

  sendToSession(sessionCwd: string, message: string): Result {
    if (this.isWayland()) {
      return { success: false, error: 'Send not supported on Wayland' };
    }
    if (!this.hasXdotool()) {
      return { success: false, error: 'xdotool not installed. Install with: sudo apt install xdotool' };
    }

    const focusResult = this.focusSession(sessionCwd);
    if (!focusResult.success) {
      return focusResult;
    }

    try {
      execSync(`xdotool type --clearmodifiers --delay 10 -- ${shellEscape(message)}`, {
        encoding: 'utf-8',
        timeout: 10000,
      });
      execSync('xdotool key Return', { encoding: 'utf-8', timeout: 3000 });
      return { success: true };
    } catch (err) {
      return { success: false, error: `xdotool type failed: ${(err as Error).message}` };
    }
  }

  startNewSession(cwd: string, prompt?: string): Result {
    const claudeCmd = prompt
      ? `cd ${shellEscape(cwd)} && claude --dangerously-skip-permissions ${shellEscape(prompt)}`
      : `cd ${shellEscape(cwd)} && claude --dangerously-skip-permissions`;

    const terminals: Array<{ cmd: string; args: string[] }> = [
      { cmd: 'gnome-terminal', args: ['--', 'bash', '-c', claudeCmd + '; exec bash'] },
      { cmd: 'konsole', args: ['-e', 'bash', '-c', claudeCmd + '; exec bash'] },
      { cmd: 'xfce4-terminal', args: ['-e', 'bash -c ' + shellEscape(claudeCmd + '; exec bash')] },
      { cmd: 'alacritty', args: ['-e', 'bash', '-c', claudeCmd + '; exec bash'] },
      { cmd: 'kitty', args: ['bash', '-c', claudeCmd + '; exec bash'] },
      { cmd: 'wezterm', args: ['start', '--', 'bash', '-c', claudeCmd + '; exec bash'] },
      { cmd: 'xterm', args: ['-e', 'bash', '-c', claudeCmd + '; exec bash'] },
    ];

    for (const { cmd, args } of terminals) {
      try {
        execSync(`which ${cmd}`, { encoding: 'utf-8', timeout: 2000, stdio: 'pipe' });
        const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
        child.unref();
        return { success: true };
      } catch {
        continue;
      }
    }

    return { success: false, error: 'No supported terminal emulator found' };
  }

  killSession(sessionCwd: string): Result {
    const proc = this.findProcessForSession(sessionCwd);
    if (!proc) {
      return { success: false, error: 'No running process found' };
    }

    try {
      process.kill(proc.pid, 'SIGTERM');
      return { success: true };
    } catch (err) {
      return { success: false, error: `Failed to kill process: ${(err as Error).message}` };
    }
  }

  sendNotification(title: string, body: string, _sound: boolean, done: () => void): void {
    execFile(
      'notify-send',
      [title.slice(0, MAX_NOTIFICATION_LENGTH), body.slice(0, MAX_NOTIFICATION_LENGTH)],
      { timeout: 5000 },
      done,
    );
  }

  maximizeWindow(): void {
    try {
      execSync('wmctrl -r :ACTIVE: -b add,maximized_vert,maximized_horz 2>/dev/null', {
        encoding: 'utf-8',
        timeout: 3000,
      });
    } catch {
      if (this.hasXdotool()) {
        try {
          execSync('xdotool key super+Up 2>/dev/null', { encoding: 'utf-8', timeout: 3000 });
        } catch {
          // Ignore errors
        }
      }
    }
  }

  encodeHomePath(home: string): string {
    return '-' + home.split('/').filter(Boolean).join('-').replace(/\./g, '-');
  }
}

// ============================================================================
// WindowsAdapter
// ============================================================================

class WindowsAdapter implements PlatformAdapter {
  readonly supportsSendToSession = true;
  readonly supportsFocusSession = true;
  readonly platformName = 'Windows';

  getRunningClaudeProcesses(): ClaudeProcess[] {
    try {
      let csvOutput = '';
      try {
        csvOutput = execSync(
          'tasklist /FI "IMAGENAME eq claude.exe" /FO CSV /NH',
          { encoding: 'utf-8', timeout: 5000 },
        );
      } catch {
        // ignore
      }

      if (!csvOutput.includes('claude')) {
        try {
          csvOutput = execSync(
            'tasklist /FI "IMAGENAME eq claude" /FO CSV /NH',
            { encoding: 'utf-8', timeout: 5000 },
          );
        } catch {
          return [];
        }
      }

      const processes: ClaudeProcess[] = [];
      for (const line of csvOutput.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('INFO:')) continue;
        // CSV format: "name","pid","session","session#","mem usage"
        const match = trimmed.match(/"[^"]*","(\d+)"/);
        if (match) {
          const pid = parseInt(match[1]!, 10);
          if (pid) {
            // CWD cannot be obtained on Windows without external tools
            processes.push({ pid });
          }
        }
      }

      return processes;
    } catch {
      return [];
    }
  }

  cleanupOrphanedProcesses(): void {
    // Skipped on Windows — ppid=1 is Unix-only
  }

  getRunningClaudeCwds(): Set<string> {
    // Windows: can't get CWD from tasklist. Return sentinel if any claude process exists.
    const processes = this.getRunningClaudeProcesses();
    if (processes.length > 0) {
      return new Set(['__windows_has_claude_process__']);
    }
    return new Set();
  }

  isSessionProcessBusy(_cwd: string): boolean {
    // No CPU data available from tasklist
    return false;
  }

  findProcessForSession(_sessionCwd: string): ClaudeProcess | null {
    // Windows heuristic: return any running claude process
    // CWD matching is not possible without external tools
    const processes = this.getRunningClaudeProcesses();
    return processes[0] ?? null;
  }

  focusSession(_sessionCwd: string): Result {
    try {
      const psScript = `
        Add-Type -AssemblyName Microsoft.VisualBasic
        $procs = Get-Process | Where-Object { $_.MainWindowTitle -like '*claude*' }
        if ($procs) {
          [Microsoft.VisualBasic.Interaction]::AppActivate($procs[0].Id)
        } else {
          throw "No claude window found"
        }
      `;
      execFileSync('powershell', ['-NoProfile', '-Command', psScript], {
        encoding: 'utf-8',
        timeout: 5000,
      });
      return { success: true };
    } catch (err) {
      return { success: false, error: `PowerShell failed: ${(err as Error).message}` };
    }
  }

  sendToSession(sessionCwd: string, message: string): Result {
    const focusResult = this.focusSession(sessionCwd);
    if (!focusResult.success) {
      return focusResult;
    }

    try {
      // Use clipboard-based paste to avoid SendKeys escaping issues
      const safeMsg = message.replace(/'/g, "''");
      const psScript = `
        Set-Clipboard -Value '${safeMsg}'
        Start-Sleep -Milliseconds 300
        $wshell = New-Object -ComObject WScript.Shell
        $wshell.SendKeys('^v')
        Start-Sleep -Milliseconds 150
        $wshell.SendKeys('~')
      `;
      execFileSync('powershell', ['-NoProfile', '-Command', psScript], {
        encoding: 'utf-8',
        timeout: 10000,
      });
      return { success: true };
    } catch (err) {
      return { success: false, error: `PowerShell failed: ${(err as Error).message}` };
    }
  }

  startNewSession(cwd: string, prompt?: string): Result {
    const claudeCmd = prompt
      ? `claude --dangerously-skip-permissions ${prompt}`
      : 'claude --dangerously-skip-permissions';

    try {
      // Try Windows Terminal first
      try {
        execSync('where wt', { encoding: 'utf-8', timeout: 2000, stdio: 'pipe' });
        const child = spawn('wt', ['-d', cwd, '--', 'cmd', '/k', claudeCmd], {
          detached: true,
          stdio: 'ignore',
        });
        child.unref();
        return { success: true };
      } catch {
        // Windows Terminal not found — use cmd.exe
        const child = spawn('cmd', ['/c', `start "" cmd /k "cd /d "${cwd}" && ${claudeCmd}"`], {
          detached: true,
          stdio: 'ignore',
        });
        child.unref();
        return { success: true };
      }
    } catch (err) {
      return { success: false, error: `Failed to start session: ${(err as Error).message}` };
    }
  }

  killSession(sessionCwd: string): Result {
    const proc = this.findProcessForSession(sessionCwd);
    if (!proc) {
      return { success: false, error: 'No running process found' };
    }

    try {
      process.kill(proc.pid);
      return { success: true };
    } catch {
      // Fallback to taskkill
      try {
        execSync(`taskkill /PID ${proc.pid} /T /F`, { encoding: 'utf-8', timeout: 5000 });
        return { success: true };
      } catch (err) {
        return { success: false, error: `Failed to kill process: ${(err as Error).message}` };
      }
    }
  }

  sendNotification(title: string, body: string, _sound: boolean, done: () => void): void {
    const safeTitle = title.replace(/'/g, "''").slice(0, MAX_NOTIFICATION_LENGTH);
    const safeBody = body.replace(/'/g, "''").slice(0, MAX_NOTIFICATION_LENGTH);

    const psScript = `
      [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
      [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null
      $xml = @'
      <toast>
        <visual><binding template='ToastGeneric'>
          <text>${safeTitle}</text>
          <text>${safeBody}</text>
        </binding></visual>
      </toast>
'@
      $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
      $doc.LoadXml($xml)
      $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Claude Orchestra')
      $notifier.Show([Windows.UI.Notifications.ToastNotification]::new($doc))
    `;

    execFile('powershell', ['-NoProfile', '-Command', psScript], { timeout: 5000 }, done);
  }

  maximizeWindow(): void {
    try {
      const psScript = `
        Add-Type @'
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
}
'@
        [Win32]::ShowWindow([Win32]::GetForegroundWindow(), 3)
      `;
      execFileSync('powershell', ['-NoProfile', '-Command', psScript], {
        encoding: 'utf-8',
        timeout: 5000,
      });
    } catch {
      // Ignore errors
    }
  }

  encodeHomePath(home: string): string {
    return '-' + home.split(/[/\\]/).filter(Boolean).join('-').replace(/[.:]/g, '-');
  }
}

// ============================================================================
// Platform factory
// ============================================================================

function createAdapter(): PlatformAdapter {
  switch (process.platform) {
    case 'darwin':
      return new DarwinAdapter();
    case 'win32':
      return new WindowsAdapter();
    default:
      return new LinuxAdapter();
  }
}

export const platform: PlatformAdapter = createAdapter();
