// High-level "skill" tools — composite operations the agent invokes once.
// Each skill orchestrates several primitives so the agent doesn't have to.

import * as proc from './process-supervisor.js';
import * as browser from './browser.js';
import { getSession } from './shell-session.js';

export const SKILL_TOOLS = [
  // ── DEV SERVER LIFECYCLE ────────────────────────────────────────────
  {
    name: 'dev_server_start',
    description: 'Start a long-running dev server (e.g. "npm run dev"). Auto-stopped at task end. Optionally polls a ready_url before returning. Use this instead of shell_exec for anything that listens on a port.',
    category: 'exec_devserver',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short name for this server (e.g. "web", "api"). Used to stop or tail logs.' },
        cmd: { type: 'string', description: 'Shell command to run.' },
        port: { type: 'integer', description: 'Port the server will listen on. NEVER use 8765 (reserved for the orchestrator).' },
        ready_url: { type: 'string', description: 'Optional URL to poll until 2xx/3xx, e.g. "http://localhost:3000/api/health".' },
      },
      required: ['name', 'cmd'],
    },
    execute: async (args, ctx) => {
      if (args.port === 8765) return { error: 'port 8765 is reserved for the orchestrator. Pick another (3000, 5173, etc.).' };
      return await proc.start({ ...args, projectId: ctx.projectId, taskId: ctx.taskId });
    },
  },
  {
    name: 'dev_server_stop',
    description: 'Stop a running dev server by name.',
    category: 'exec_devserver',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The server name passed to dev_server_start.' } },
      required: ['name'],
    },
    execute: (args, ctx) => proc.stop({ projectId: ctx.projectId, name: args.name }),
  },
  {
    name: 'dev_server_logs',
    description: 'Tail the most recent log lines (stdout + stderr) of a running dev server.',
    category: 'exec_devserver',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        tail: { type: 'integer', description: 'How many recent lines to return. Default 50.' },
      },
      required: ['name'],
    },
    execute: (args, ctx) => proc.logs({ projectId: ctx.projectId, name: args.name, tail: args.tail || 50 }),
  },
  {
    name: 'dev_server_list',
    description: 'List the dev servers currently running for this project.',
    category: 'exec_devserver',
    parameters: { type: 'object', properties: {} },
    execute: (_, ctx) => ({ servers: proc.list({ projectId: ctx.projectId }) }),
  },

  // ── BROWSER (Playwright) ────────────────────────────────────────────
  {
    name: 'browser_open',
    description: 'Open a URL in a headless Chromium and capture: status, title, body text, console messages, network errors. Use to verify a web server actually responds correctly. Pair with dev_server_start.',
    category: 'exec_browser',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL, e.g. "http://localhost:3000/api/products".' },
        wait_for: { type: 'string', description: 'Optional CSS selector to wait for before capturing.' },
      },
      required: ['url'],
    },
    execute: (args, ctx) => browser.browserOpen(args),
  },
  {
    name: 'browser_eval',
    description: 'Open a URL and evaluate a JavaScript expression in the page context. Returns the result. Useful for asserting DOM state after rendering.',
    category: 'exec_browser',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        script: { type: 'string', description: 'JS expression — what it returns is the result. e.g. "document.querySelector(\\".product\\").length".' },
      },
      required: ['url', 'script'],
    },
    execute: (args, ctx) => browser.browserEval(args),
  },
  // browser_screenshot is defined in exec-tools.js — removed here to avoid duplicate tool name
  // (Gemini rejects schemas with duplicate function declarations)

  // ── COMPOSITE: web_build_and_smoke ──────────────────────────────────
  {
    name: 'web_build_and_smoke',
    description: 'Composite: install deps if needed, start a dev/prod server, hit a URL, return result, stop server. Use this whenever you want to prove a web change works end-to-end in ONE call.',
    category: 'exec_skill',
    parameters: {
      type: 'object',
      properties: {
        workdir: { type: 'string', description: 'Subdir of the workspace, e.g. "server" or "web". Use "." for root.' },
        install: { type: 'boolean', description: 'Run npm install before starting? Default true if node_modules is missing.' },
        serve_cmd: { type: 'string', description: 'Command to start the server, e.g. "npm run dev" or "node index.js".' },
        port: { type: 'integer', description: 'Port the server will use.' },
        check_url: { type: 'string', description: 'Full URL to fetch and report on, e.g. "http://localhost:3000/api/products".' },
      },
      required: ['workdir', 'serve_cmd', 'port', 'check_url'],
    },
    execute: async (args, ctx) => {
      const session = getSession(ctx.taskId, ctx.projectId);
      const wd = args.workdir === '.' ? '' : `cd ${args.workdir} && `;

      // 1. Optional install
      let install_log = null;
      if (args.install !== false) {
        const probe = await session.exec(`${wd}test -d node_modules && echo HAS || echo MISSING`);
        if (probe.stdout.trim() === 'MISSING') {
          const inst = await session.exec(`${wd}npm install --no-audit --no-fund 2>&1 | tail -20`, { timeoutMs: 180_000 });
          install_log = { exitCode: inst.exitCode, tail: inst.stdout.slice(-1500) };
          if (inst.exitCode !== 0) return { ok: false, step: 'install', install_log };
        }
      }

      // 2. Start server (unique name based on task+workdir)
      const serverName = `smoke-${args.workdir.replace(/\W/g, '_') || 'root'}`;
      const startRes = await proc.start({
        projectId: ctx.projectId, taskId: ctx.taskId,
        name: serverName,
        cmd: `${wd}${args.serve_cmd}`,
        port: args.port,
        ready_url: args.check_url,
      });
      if (!startRes.ok) {
        const tail = proc.logs({ projectId: ctx.projectId, name: serverName, tail: 30 });
        proc.stop({ projectId: ctx.projectId, name: serverName });
        return { ok: false, step: 'serve', start: startRes, logs: tail.logs };
      }

      // 3. Browser hit
      const result = await browser.browserOpen({ url: args.check_url });

      // 4. Always stop the server
      proc.stop({ projectId: ctx.projectId, name: serverName });

      return {
        ok: result.ok,
        install_log,
        check_url: args.check_url,
        status: result.status,
        title: result.title,
        body_excerpt: result.text?.slice(0, 1000),
        console: result.console,
        network_errors: result.network_errors,
      };
    },
  },

  // ── COMPOSITE: npm_test ─────────────────────────────────────────────
  {
    name: 'npm_test',
    description: 'Run `npm test` (or a custom test command) in a workdir, parse the output for pass/fail counts, return structured result.',
    category: 'exec_skill',
    parameters: {
      type: 'object',
      properties: {
        workdir: { type: 'string', description: 'Subdir or "." for root.' },
        cmd: { type: 'string', description: 'Test command. Default: "npm test".' },
      },
    },
    execute: async (args, ctx) => {
      const session = getSession(ctx.taskId, ctx.projectId);
      const wd = (args.workdir && args.workdir !== '.') ? `cd ${args.workdir} && ` : '';
      const cmd = args.cmd || 'npm test --silent 2>&1';
      const res = await session.exec(`${wd}${cmd}`, { timeoutMs: 120_000 });
      const out = (res.stdout || '') + (res.stderr || '');
      const passMatch = out.match(/(\d+)\s+passed/i);
      const failMatch = out.match(/(\d+)\s+failed/i);
      return {
        ok: res.exitCode === 0,
        exitCode: res.exitCode,
        passed: passMatch ? Number(passMatch[1]) : null,
        failed: failMatch ? Number(failMatch[1]) : null,
        tail: out.slice(-2000),
      };
    },
  },

  // ── COMPOSITE: python_test ──────────────────────────────────────────
  {
    name: 'python_test',
    description: 'Run pytest in a workdir, parse the output for pass/fail counts.',
    category: 'exec_skill',
    parameters: {
      type: 'object',
      properties: {
        workdir: { type: 'string' },
        pattern: { type: 'string', description: 'Optional pytest -k pattern.' },
      },
    },
    execute: async (args, ctx) => {
      const session = getSession(ctx.taskId, ctx.projectId);
      const wd = (args.workdir && args.workdir !== '.') ? `cd ${args.workdir} && ` : '';
      const k = args.pattern ? ` -k ${JSON.stringify(args.pattern)}` : '';
      const res = await session.exec(`${wd}python3 -m pytest -q${k} 2>&1`, { timeoutMs: 120_000 });
      const out = (res.stdout || '') + (res.stderr || '');
      const m = out.match(/(\d+)\s+passed.*?(\d+)\s+failed/);
      const p = out.match(/(\d+)\s+passed/);
      return {
        ok: res.exitCode === 0,
        exitCode: res.exitCode,
        passed: m ? Number(m[1]) : (p ? Number(p[1]) : null),
        failed: m ? Number(m[2]) : null,
        tail: out.slice(-2000),
      };
    },
  },

  // ── COMPOSITE: git_quick_commit ─────────────────────────────────────
  {
    name: 'git_quick_commit',
    description: 'Stage all changes and commit with the given message. No-ops on a clean tree. Uses Gavirila as committer.',
    category: 'exec_skill',
    parameters: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    },
    execute: async (args, ctx) => {
      const session = getSession(ctx.taskId, ctx.projectId);
      await session.exec('git add -A 2>&1');
      const status = await session.exec('git diff --cached --stat 2>&1');
      if (!status.stdout.trim()) return { ok: true, skipped: true, reason: 'nothing to commit' };
      const env = `GIT_AUTHOR_NAME=Gavirila GIT_AUTHOR_EMAIL=gavirila@homestead GIT_COMMITTER_NAME=Gavirila GIT_COMMITTER_EMAIL=gavirila@homestead`;
      const cmt = await session.exec(`${env} git commit -m ${JSON.stringify(args.message)} 2>&1`);
      return { ok: cmt.exitCode === 0, exitCode: cmt.exitCode, output: cmt.stdout.slice(0, 1000) };
    },
  },

  // ── INTRA-TASK COMMUNICATION ────────────────────────────────────────
  {
    name: 'task_post_update',
    description: 'Post a status update to the active ticket. Visible to the human watching the ticket. Use this between tool batches to say what you\'re about to do or what just happened. Does NOT change task status.',
    category: 'task_comms',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Short status message, 1-3 sentences.' },
        kind: { type: 'string', description: '"thought" (your reasoning), "progress" (what just happened), "blocker" (something off).' },
      },
      required: ['text'],
    },
    execute: (args, ctx) => {
      if (!ctx.taskId) return { error: 'task_post_update requires an active task' };
      const { repo } = ctx;
      const task = repo.byId('tasks', ctx.taskId);
      if (!task) return { error: `task ${ctx.taskId} not found` };
      const msg = {
        ts: Date.now(),
        by: ctx.agentId || 'agent',
        role: 'agent',
        kind: args.kind || 'progress',
        text: args.text,
      };
      const messages = [...(task.messages || []), msg];
      repo.patch('tasks', ctx.taskId, { messages, updated_at: Date.now() });
      ctx.broadcast?.({ kind: 'task:message', taskId: ctx.taskId, message: msg });
      return { ok: true };
    },
  },
];
