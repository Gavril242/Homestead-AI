// Persistent bash sessions per task.
//
// Each task that runs `shell_exec` gets a long-lived bash subprocess so that
// `cd`, env vars, virtualenv activation, and shell history persist between
// calls. The session is created lazily on first use and torn down when the
// task ends (see endSession() — task-runner calls it).

import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { ensureWorkspace } from './exec-tools.js';

function readProjectEnv(ws) {
  try {
    const p = path.join(ws, '.env');
    if (!fs.existsSync(p)) return {};
    const out = {};
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    return out;
  } catch { return {}; }
}

// Map: taskId → { proc, cwd, queue: [{cmd, resolve}], current?, tail }
const sessions = new Map();

const PROMPT_MARK = '<<GAVIRILA_PROMPT_END_OF_CMD>>';

/**
 * Get or create a session for a task. Returns a handle with .exec(cmd).
 * Each session is its own bash subprocess, kept alive between calls.
 */
export function getSession(taskId, projectId) {
  if (!taskId) throw new Error('shell session requires taskId');
  let s = sessions.get(taskId);
  if (s) return s;

  const ws = ensureWorkspace(projectId);
  const proc = spawn('bash', ['--noprofile', '--norc', '-i'], {
    cwd: ws,
    env: {
      ...process.env,
      ...readProjectEnv(ws),     // expose project .env to commands
      HOME: os.homedir(),
      PS1: '$ ',
      TERM: 'dumb',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  s = {
    taskId, projectId, proc, cwd: ws,
    queue: [],
    current: null,
    buffers: { stdout: '', stderr: '' },
    closed: false,
  };
  sessions.set(taskId, s);

  proc.stdout.on('data', (chunk) => {
    s.buffers.stdout += chunk.toString();
    drain(s);
  });
  proc.stderr.on('data', (chunk) => {
    s.buffers.stderr += chunk.toString();
    drain(s);
  });
  proc.on('exit', () => {
    s.closed = true;
    if (s.current) {
      s.current.resolve({ stdout: s.buffers.stdout, stderr: s.buffers.stderr, exitCode: -1, error: 'session terminated' });
    }
    sessions.delete(taskId);
  });

  s.exec = (cmd, opts = {}) => exec(s, cmd, opts);
  return s;
}

/**
 * Send a command to the session and wait for its completion marker.
 * Resolves with { stdout, stderr, exitCode, cwd }.
 */
function exec(s, cmd, { timeoutMs = 60_000 } = {}) {
  if (s.closed) return Promise.resolve({ error: 'session closed', exitCode: -1 });

  return new Promise((resolve) => {
    const wrapped = `{ ${cmd} ; }; printf "%s|%d|%s\\n" "${PROMPT_MARK}" $? "$(pwd)"\n`;
    s.queue.push({ cmd, wrapped, resolve, startedAt: Date.now() });
    if (!s.current) advance(s);

    // Timeout watchdog: kill the session if a single command stalls. The
    // session's exit handler resolves any pending command.
    setTimeout(() => {
      if (s.current && s.current.wrapped === wrapped && !s.closed) {
        try { s.proc.kill('SIGKILL'); } catch {}
      }
    }, timeoutMs);
  });
}

function advance(s) {
  const next = s.queue.shift();
  if (!next) return;
  s.current = next;
  s.buffers.stdout = '';
  s.buffers.stderr = '';
  try {
    s.proc.stdin.write(next.wrapped);
  } catch (err) {
    next.resolve({ error: err.message, exitCode: -1 });
    s.current = null;
    advance(s);
  }
}

function drain(s) {
  if (!s.current) return;
  const idx = s.buffers.stdout.indexOf(PROMPT_MARK);
  if (idx < 0) return;
  // Found the marker. Parse: <stdout>|MARK|<exitCode>|<pwd>\n
  const before = s.buffers.stdout.slice(0, idx);
  const tail = s.buffers.stdout.slice(idx + PROMPT_MARK.length);
  const m = tail.match(/^\|(\d+)\|([^\n]*)\n([\s\S]*)$/);
  let exitCode = -1, pwd = s.cwd, leftover = '';
  if (m) {
    exitCode = Number(m[1]);
    pwd = m[2];
    leftover = m[3];
  }
  const result = {
    stdout: before.replace(/\r/g, ''),
    stderr: s.buffers.stderr.replace(/\r/g, ''),
    exitCode,
    cwd: pwd,
  };
  s.cwd = pwd;
  const cur = s.current;
  s.current = null;
  s.buffers.stdout = leftover;
  s.buffers.stderr = '';
  cur.resolve(result);
  advance(s);
}

/** Tear down a task's session. Called by the runner when the task finishes. */
export function endSession(taskId) {
  const s = sessions.get(taskId);
  if (!s) return;
  s.closed = true;
  try { s.proc.kill('SIGTERM'); } catch {}
  setTimeout(() => { try { s.proc.kill('SIGKILL'); } catch {} }, 1000);
  sessions.delete(taskId);
}

export function listSessions() {
  return [...sessions.values()].map((s) => ({
    taskId: s.taskId, projectId: s.projectId, cwd: s.cwd,
    queueLength: s.queue.length, current: s.current?.cmd?.slice(0, 80) || null,
  }));
}
