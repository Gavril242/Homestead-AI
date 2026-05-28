// Process supervisor for long-running dev servers.
//
// Agents register named processes (e.g. "web", "api"). The supervisor:
//   • Spawns them detached in the project workspace
//   • Captures stdout+stderr to a ring buffer the agent can tail
//   • Optionally polls a ready_url until the server responds
//   • Auto-cleans on task end (taskRegistry → killOnTaskEnd)
//   • Hard-stops on process exit so we never leak

import { spawn } from 'node:child_process';
import os from 'node:os';
import { ensureWorkspace } from './exec-tools.js';

const procs = new Map(); // key = `${projectId}:${name}` → { proc, logs, info }
const taskOwnership = new Map(); // taskId → Set<key>

function key(projectId, name) { return `${projectId}:${name}`; }

export async function start({ projectId, name, cmd, port, ready_url, taskId }) {
  const k = key(projectId, name);
  if (procs.has(k)) {
    return { error: `process "${name}" already running for project ${projectId}. Stop it first.` };
  }
  const ws = ensureWorkspace(projectId);

  const proc = spawn('bash', ['-c', cmd], {
    cwd: ws,
    env: { ...process.env, HOME: os.homedir(), PORT: String(port || '') },
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logs = []; // ring of last 500 lines
  const append = (chunk, stream) => {
    for (const line of chunk.toString().split('\n')) {
      if (!line) continue;
      logs.push({ ts: Date.now(), stream, line });
      if (logs.length > 500) logs.shift();
    }
  };
  proc.stdout?.on('data', (c) => append(c, 'stdout'));
  proc.stderr?.on('data', (c) => append(c, 'stderr'));

  const info = {
    name, projectId, cmd, port, pid: proc.pid,
    started_at: Date.now(), exited: false, exitCode: null, taskId,
  };
  procs.set(k, { proc, logs, info });

  proc.on('exit', (code) => {
    info.exited = true;
    info.exitCode = code;
    info.exited_at = Date.now();
    // Keep logs accessible for a bit, then drop after 60s
    setTimeout(() => { if (procs.get(k)?.info?.exited) procs.delete(k); }, 60_000);
  });

  if (taskId) {
    if (!taskOwnership.has(taskId)) taskOwnership.set(taskId, new Set());
    taskOwnership.get(taskId).add(k);
  }

  // Optional readiness probe
  if (ready_url) {
    const ok = await waitFor(ready_url, 15_000);
    if (!ok) {
      return { ok: false, name, pid: proc.pid, port, ready: false, message: `started but ready_url ${ready_url} did not respond within 15s — see logs` };
    }
    return { ok: true, name, pid: proc.pid, port, ready: true };
  }
  // Give it a beat to crash
  await new Promise((r) => setTimeout(r, 500));
  if (info.exited) {
    return { ok: false, name, exitCode: info.exitCode, message: 'process exited immediately', logs: logs.slice(-20) };
  }
  return { ok: true, name, pid: proc.pid, port, ready: null };
}

export function stop({ projectId, name }) {
  const k = key(projectId, name);
  const entry = procs.get(k);
  if (!entry) return { error: `no process named "${name}" for ${projectId}` };
  if (entry.info.exited) {
    procs.delete(k);
    return { ok: true, message: `process already exited (code ${entry.info.exitCode})` };
  }
  try { entry.proc.kill('SIGTERM'); } catch {}
  setTimeout(() => { try { entry.proc.kill('SIGKILL'); } catch {} }, 2000);
  return { ok: true, message: `sent SIGTERM to ${name}` };
}

export function logs({ projectId, name, tail = 50 }) {
  const k = key(projectId, name);
  const entry = procs.get(k);
  if (!entry) return { error: `no process named "${name}" for ${projectId}` };
  return {
    name, pid: entry.info.pid, port: entry.info.port,
    exited: entry.info.exited, exitCode: entry.info.exitCode,
    logs: entry.logs.slice(-tail),
  };
}

export function list({ projectId } = {}) {
  return [...procs.values()]
    .filter((e) => !projectId || e.info.projectId === projectId)
    .map((e) => ({ ...e.info, log_count: e.logs.length }));
}

/** Called by the task-runner when a task ends. Cleans up that task's procs. */
export function killOnTaskEnd(taskId) {
  const owned = taskOwnership.get(taskId);
  if (!owned) return 0;
  let killed = 0;
  for (const k of owned) {
    const entry = procs.get(k);
    if (entry && !entry.info.exited) {
      try { entry.proc.kill('SIGTERM'); killed++; } catch {}
      setTimeout(() => { try { entry.proc.kill('SIGKILL'); } catch {} }, 1000);
    }
  }
  taskOwnership.delete(taskId);
  return killed;
}

async function waitFor(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.ok || (r.status >= 200 && r.status < 500)) return true;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}
