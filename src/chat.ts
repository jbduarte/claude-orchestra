import { platform } from './platform.js';
import type { Result } from './platform.js';

export function focusSession(sessionCwd: string): Result {
  return platform.focusSession(sessionCwd);
}

export function sendToSession(sessionCwd: string, message: string): Result {
  return platform.sendToSession(sessionCwd, message);
}

export function startNewSession(cwd: string, prompt?: string): Result {
  return platform.startNewSession(cwd, prompt);
}

export function killSession(sessionCwd: string): Result {
  return platform.killSession(sessionCwd);
}
