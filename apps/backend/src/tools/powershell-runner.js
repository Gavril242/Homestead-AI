// Gavirila Homestead 1.0 — PowerShell-first shell runner (Windows)
// Provides persistent per-job PowerShell sessions on Windows,
// falling back to bash on non-Windows systems.

import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';

const IS_WIN = process.platform === 'win32';

// ── PowerShell detection ──────────────────────────────────────────────────────
function detectShell() {
  if (!IS_WIN) {
    return { shell: '/bin/bash', flag: '-c', name: 'bash' };
  }
  // Try pwsh first (PowerShell 7+), fall back to Windows PowerShell 5.x
  try {
    const result = spawnSync('pwsh.exe', ['-NoProfile', '-Command', 'echo 1'], { timeout: 3000 });
    if (result.status === 0) return { shell: 'pwsh.exe', flag: '-Command', name: 'pwsh' };
  } catch {}
  try {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'echo 1'], { timeout: 3000 });
    if (result.status === 0) return { shell: 'powershell.exe', flag: '-Command', name: 'powershell' };
  } catch {}
  // Final fallback: cmd.exe
  return { shell: 'cmd.exe', flag: '/c', name: 'cmd' };
}

export const SHELL_INFO = detectShell();

/**
 * Execute a single command synchronously (for quick ops).
 */
export function execSync(cmd, options = {}) {
  const { cwd = process.cwd(), timeout = 30_000, env = process.env } = options;
  const { shell, flag, name } = SHELL_INFO;

  const result = spawnSync(shell, [flag, cmd], {
    cwd, timeout, env, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024,
  });

  return {
    stdout:   (result.stdout || '').trim(),
    stderr:   (result.stderr || '').trim(),
    exitCode: result.status ?? (result.error ? -1 : 0),
    error:    result.error?.message || null,
    shell:    name,
    ok:       result.status === 0 && !result.error,
  };
}

/**
 * Persistent shell session — keeps process alive between commands.
 * Supports PowerShell on Windows, bash on Linux/Mac.
 */
export class ShellSession extends EventEmitter {
  constructor(options = {}) {
    super();
    this.cwd = options.cwd || process.cwd();
    this.env = options.env || process.env;
    this.transcript = [];
    this._proc = null;
    this._queue = [];
    this._active = false;
    this.shell = SHELL_INFO;
    this._init();
  }

  _init() {
    const { shell } = this.shell;
    const args = IS_WIN ? ['-NoProfile', '-NonInteractive'] : ['-i'];

    this._proc = spawn(shell, args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this._proc.on('exit', () => {
      this.emit('exit');
      this._proc = null;
    });

    this._proc.stderr?.on('data', (d) => {
      this.emit('stderr', d.toString());
    });
  }

  /**
   * Run a command and collect output with a sentinel.
   */
  run(cmd, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      if (!this._proc) return reject(new Error('session closed'));
      
      const SENTINEL = `__DONE_${Date.now()}__`;
      const sentinelCmd = IS_WIN
        ? `${cmd}\nWrite-Output "${SENTINEL}"\n`
        : `${cmd}\necho "${SENTINEL}"\n`;

      let out = '';
      const handler = (data) => {
        out += data.toString();
        if (out.includes(SENTINEL)) {
          this._proc.stdout.off('data', handler);
          const idx = out.indexOf(SENTINEL);
          const clean = out.slice(0, idx).trim();
          const entry = { ts: Date.now(), cmd, stdout: clean, exitCode: 0 };
          this.transcript.push(entry);
          clearTimeout(timer);
          resolve({ stdout: clean, stderr: '', exitCode: 0, ok: true });
        }
      };

      const timer = setTimeout(() => {
        this._proc.stdout.off('data', handler);
        reject(new Error(`command timed out after ${timeoutMs}ms: ${cmd.slice(0,60)}`));
      }, timeoutMs);

      this._proc.stdout.on('data', handler);
      this._proc.stdin.write(sentinelCmd);
    });
  }

  getTranscript() {
    return this.transcript;
  }

  destroy() {
    try { this._proc?.kill(); } catch {}
    this._proc = null;
  }
}

// ── Session pool ──────────────────────────────────────────────────────────────
const sessions = new Map(); // key → ShellSession

export function getSession(key, options = {}) {
  if (!sessions.has(key)) {
    const s = new ShellSession(options);
    sessions.set(key, s);
    s.on('exit', () => sessions.delete(key));
  }
  return sessions.get(key);
}

export function destroySession(key) {
  const s = sessions.get(key);
  if (s) { s.destroy(); sessions.delete(key); }
}

export function listSessions() {
  return [...sessions.keys()];
}

export default { execSync, ShellSession, getSession, destroySession, listSessions, SHELL_INFO };
