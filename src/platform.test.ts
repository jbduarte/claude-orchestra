import { describe, it, expect } from 'vitest';
import { matchProcessByCwd, type ClaudeProcess } from './platform.js';

// We also import platform to test encodeHomePath via the live adapter.
import { platform } from './platform.js';

// ---- matchProcessByCwd ----

describe('matchProcessByCwd', () => {
  it('returns exact CWD match immediately', () => {
    const procs: ClaudeProcess[] = [
      { pid: 1, cwd: '/home/user/project-a' },
      { pid: 2, cwd: '/home/user/project-b' },
    ];
    const result = matchProcessByCwd(procs, '/home/user/project-b');
    expect(result).toEqual({ pid: 2, cwd: '/home/user/project-b' });
  });

  it('matches parent dir with / (Unix separator)', () => {
    const procs: ClaudeProcess[] = [
      { pid: 1, cwd: '/home/user' },
    ];
    const result = matchProcessByCwd(procs, '/home/user/project');
    expect(result?.pid).toBe(1);
  });

  it('matches parent dir with \\ (Windows separator)', () => {
    const procs: ClaudeProcess[] = [
      { pid: 1, cwd: 'C:\\Users\\joao' },
    ];
    const result = matchProcessByCwd(procs, 'C:\\Users\\joao\\project');
    expect(result?.pid).toBe(1);
  });

  it('matches child dir with / (Unix)', () => {
    const procs: ClaudeProcess[] = [
      { pid: 1, cwd: '/home/user/project/src' },
    ];
    const result = matchProcessByCwd(procs, '/home/user/project');
    expect(result?.pid).toBe(1);
  });

  it('matches child dir with \\ (Windows)', () => {
    const procs: ClaudeProcess[] = [
      { pid: 1, cwd: 'C:\\Users\\joao\\project\\src' },
    ];
    const result = matchProcessByCwd(procs, 'C:\\Users\\joao\\project');
    expect(result?.pid).toBe(1);
  });

  it('picks longest prefix when multiple candidates match', () => {
    const procs: ClaudeProcess[] = [
      { pid: 1, cwd: '/home' },
      { pid: 2, cwd: '/home/user' },
      { pid: 3, cwd: '/home/user/project' },
    ];
    // Session CWD is a child of all three — longest prefix (/home/user/project) should win
    const result = matchProcessByCwd(procs, '/home/user/project/src/lib');
    expect(result?.pid).toBe(3);
  });

  it('returns null for empty process list', () => {
    expect(matchProcessByCwd([], '/home/user')).toBeNull();
  });

  it('returns null when no CWD matches', () => {
    const procs: ClaudeProcess[] = [
      { pid: 1, cwd: '/opt/other' },
      { pid: 2, cwd: '/tmp/scratch' },
    ];
    expect(matchProcessByCwd(procs, '/home/user/project')).toBeNull();
  });

  it('does not match partial directory names', () => {
    const procs: ClaudeProcess[] = [
      { pid: 1, cwd: '/home/user/proj' },
    ];
    // "/home/user/project" starts with "/home/user/proj" but NOT "/home/user/proj/"
    expect(matchProcessByCwd(procs, '/home/user/project')).toBeNull();
  });
});

// ---- encodeHomePath ----

describe('encodeHomePath', () => {
  it('encodes Unix-style paths correctly', () => {
    // e.g. /Users/joao.duarte → -Users-joao-duarte
    const encoded = platform.encodeHomePath('/Users/joao.duarte');
    expect(encoded).toBe('-Users-joao-duarte');
  });

  it('encodes paths with multiple segments', () => {
    const encoded = platform.encodeHomePath('/home/user');
    expect(encoded).toBe('-home-user');
  });

  it('handles root-level path', () => {
    const encoded = platform.encodeHomePath('/root');
    expect(encoded).toBe('-root');
  });
});
