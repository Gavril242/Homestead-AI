// Execution tools — real filesystem, shell, Python, and git operations.
//
// All file operations are sandboxed to the project's workspace directory.
// Path traversal (../) is blocked. Shell commands run with cwd set to workspace.
//
// These tools are registered alongside the vault/DB tools in registry.js.
// Agents get access based on their toolScopes.

import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawnSync, spawn } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Script as VmScript } from 'node:vm';
import { execSync as psExecSync, SHELL_INFO } from './powershell-runner.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── E2B sandbox registry ─────────────────────────────────────────────
// One sandbox per task, lazy-created, auto-killed on task close.
// Only active when E2B_API_KEY is set.
const sandboxRegistry = new Map(); // taskId → Sandbox instance

export async function getOrCreateSandbox(taskId) {
  if (!process.env.E2B_API_KEY) return null;
  if (sandboxRegistry.has(taskId)) return sandboxRegistry.get(taskId);
  const { Sandbox } = await import('e2b');
  const sbx = await Sandbox.create({
    apiKey: process.env.E2B_API_KEY,
    timeoutMs: 15 * 60 * 1000, // 15 min per task
  });
  sandboxRegistry.set(taskId, sbx);
  return sbx;
}

export async function closeSandbox(taskId) {
  const sbx = sandboxRegistry.get(taskId);
  if (sbx) {
    sandboxRegistry.delete(taskId);
    try { await sbx.kill(); } catch {}
  }
}

// ── workspace resolution ────────────────────────────────────────────

const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT
  || path.join(os.homedir(), 'gavirila-workspaces');

// Cache of project workspace overrides (populated by resolveWorkspace)
const _workspaceOverrides = new Map(); // projectId → absolute path

/** Register a project's explicit workspace path (called from task-runner). */
export function setWorkspaceOverride(projectId, absPath) {
  if (projectId && absPath) _workspaceOverrides.set(projectId, absPath);
}

export function getWorkspacePath(projectId) {
  if (!projectId) throw new Error('projectId is required');
  // If the project has an explicit workspace (e.g. "F:\\uTAS5"), use it directly.
  if (_workspaceOverrides.has(projectId)) return _workspaceOverrides.get(projectId);
  const slug = projectId.replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
  return path.join(WORKSPACES_ROOT, slug);
}

export function ensureWorkspace(projectId) {
  const ws = getWorkspacePath(projectId);
  if (!fs.existsSync(ws)) fs.mkdirSync(ws, { recursive: true });
  // SYS-GAP-07: ensure the workspace is a git repo so shadow worktrees can be created.
  // A workspace with no commits causes `git worktree add HEAD` to fail with "fatal: not a valid ref".
  try {
    execSync('git rev-parse HEAD', { cwd: ws, stdio: 'ignore' });
  } catch {
    try {
      execSync('git init', { cwd: ws, stdio: 'ignore' });
      execSync('git commit --allow-empty -m "initial baseline"', { cwd: ws, stdio: 'ignore' });
      console.log(`[workspace] git-initialized ${ws}`);
    } catch (gitErr) {
      console.warn(`[workspace] could not git-init ${ws}: ${gitErr.message}`);
    }
  }
  return ws;
}

/** Pull projectId from the call context, refusing to fall back. */
function requireProjectId(ctx) {
  if (!ctx?.projectId) {
    throw new Error('No projectId in tool context — every agent action must be tied to a project workspace.');
  }
  return ctx.projectId;
}

function workspaceFor(ctx) {
  if (ctx?.shadowPath) {
    const shadowPath = path.resolve(ctx.shadowPath);
    try {
      if (!fs.statSync(shadowPath).isDirectory()) {
        throw new Error(`Shadow workspace is not a directory: ${shadowPath}`);
      }
      return shadowPath;
    } catch {
      throw new Error(`Shadow workspace is unavailable: ${shadowPath}`);
    }
  }
  return ensureWorkspace(requireProjectId(ctx));
}

/** Resolve a relative path within a workspace, blocking traversal. */
function safePath(workspace, relPath) {
  const resolved = path.resolve(workspace, relPath);
  if (!resolved.startsWith(workspace)) {
    throw new Error(`Path traversal blocked: ${relPath}`);
  }
  return resolved;
}

// ── GR1: Destructive command blocker ────────────────────────────────
// Hard-coded deny list. No prompt can override this — the kernel rejects
// the command before it ever reaches a shell.
const DESTRUCTIVE_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*[rf]){1,}\s/,          // rm -rf, rm -f, rm -fr
  /\bRemove-Item\b.*-Recurse/i,              // PowerShell recursive delete
  /\brmdir\s+\/s/i,                          // Windows rmdir /s
  /\bdel\s+\/[sfq]/i,                        // Windows del /s /f /q
  /\bformat\s+[A-Z]:/i,                      // format drive
  /\bmkfs\b/,                                // make filesystem
  /\bdd\s+if=/,                              // dd disk write
  /\b>\s*\/dev\/sd[a-z]/,                    // write to raw device
  /\bchmod\s+(-R\s+)?0?00\b/,               // chmod 000 (lock everything)
  /\bgit\s+(push\s+--force|reset\s+--hard)/i, // destructive git ops
  /\bnpm\s+publish\b/i,                      // accidental publishes
  /\bdrop\s+(table|database)\b/i,            // SQL drops
  /\btruncate\s+table\b/i,                   // SQL truncate
  /\bShutdown-Computer\b/i,                  // PowerShell shutdown
  /\bStop-Computer\b/i,                      // PowerShell shutdown alt
  /\bshutdown\s/,                            // Unix shutdown
  /\breboot\b/,                              // reboot
  /\bkill\s+-9\s+1\b/,                       // kill init/PID 1
  /\btaskkill\s+\/f\s+\/im\s+(explorer|csrss|svchost|winlogon)/i, // kill Windows system processes
];

/** Returns rejection reason if cmd is destructive, null if safe. */
function checkDestructiveCommand(cmd) {
  for (const pat of DESTRUCTIVE_PATTERNS) {
    if (pat.test(cmd)) {
      return `Execution Rejected by Gavirila Kernel: command matches destructive pattern ${pat}. This cannot be overridden by the agent.`;
    }
  }
  return null;
}

// ── GR3: Quarantine directory for soft-deletes ─────────────────────
const QUARANTINE_DIR = path.join(
  process.env.WORKSPACES_ROOT || path.join(os.homedir(), 'gavirila-workspaces'),
  '.gavirila-trash'
);

/** Move a file to quarantine instead of deleting it. Returns the quarantine path. */
function quarantineFile(absPath) {
  if (!fs.existsSync(QUARANTINE_DIR)) fs.mkdirSync(QUARANTINE_DIR, { recursive: true });
  const basename = path.basename(absPath);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(QUARANTINE_DIR, `${ts}_${basename}`);
  fs.renameSync(absPath, dest);
  return dest;
}

// ── GR4: Dry-run syntax validator ──────────────────────────────────
// Before overwriting a file, validate syntax for known languages.
// Returns { ok: true } or { ok: false, error: '...' }.
const SYNTAX_VALIDATORS = {
  // Note: VmScript only catches syntax errors, not runtime errors (require/import are not evaluated)
  '.js':   (content, full) => { try { new VmScript(content, { filename: full }); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } },
  '.mjs':  (content, full) => { try { new VmScript(content, { filename: full }); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } },
  '.json': (content) => { try { JSON.parse(content); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } },
  '.ps1':  (content, full) => {
    try {
      // Declare $errs before passing as [ref] — undeclared vars cause a runtime error
      const r = spawnSync('powershell', ['-NoProfile', '-Command', `$errs = $null; $null = [System.Management.Automation.Language.Parser]::ParseInput('${content.replace(/'/g, "''")}', [ref]$null, [ref]$errs); if($errs -and $errs.Count -gt 0){$errs | ForEach-Object { $_.Message } | Write-Output}`], { timeout: 5000, encoding: 'utf8' });
      if (r.stdout?.trim()) return { ok: false, error: r.stdout.trim() };
      return { ok: true };
    } catch { return { ok: true }; } // can't validate → allow through
  },
  '.psm1': null, // same as .ps1, set below
  '.xml':  (content) => { if (!content.trim().startsWith('<')) return { ok: false, error: 'XML must start with <' }; return { ok: true }; },
  '.yaml': (content) => { if (/\t/.test(content.split('\n')[0] || '')) return { ok: false, error: 'YAML must not use tabs for indentation' }; return { ok: true }; },
  '.yml':  null, // same as .yaml, set below
};
SYNTAX_VALIDATORS['.psm1'] = SYNTAX_VALIDATORS['.ps1'];
SYNTAX_VALIDATORS['.yml'] = SYNTAX_VALIDATORS['.yaml'];

/**
 * GR4: Validate content before writing. If the file type has a validator and
 * it fails, write a .proposed file and return the error so the agent can fix it.
 * Returns null if validation passed (or no validator exists), or an error result object.
 */
function dryRunValidate(full, content) {
  const ext = path.extname(full).toLowerCase();
  const validator = SYNTAX_VALIDATORS[ext];
  if (!validator) return null; // no validator → allow through
  const result = validator(content, full);
  if (result.ok) return null;
  // Write the proposed version so the agent can diff
  const proposedPath = full + '.proposed';
  fs.writeFileSync(proposedPath, content);
  return {
    error: `GR4 Dry-Run Syntax Check FAILED for ${path.basename(full)}: ${result.error}. Your proposed content was saved to "${path.basename(full)}.proposed" — fix the syntax error and try again.`,
    proposed_file: proposedPath,
    syntax_error: result.error,
  };
}

// ── tool definitions ────────────────────────────────────────────────

export const EXEC_TOOLS = [
  // ── Filesystem ──────────────────────────────────────────────────
  {
    name: 'fs_read_file',
    description: 'Read a file from the project workspace. Returns the file content as text. Use for reading source code, configs, logs, etc.',
    category: 'exec_fs',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path within the project workspace, e.g. "src/main.py" or "README.md".' },
      },
      required: ['path'],
    },
    execute: ({ path: filePath }, ctx) => {
      const ws = workspaceFor(ctx);
      const full = safePath(ws, filePath);
      if (!fs.existsSync(full)) return { error: `File not found: ${filePath}` };
      const stat = fs.statSync(full);
      if (stat.size > 512_000) return { error: `File too large: ${(stat.size / 1024).toFixed(0)}KB (max 500KB)` };
      const content = fs.readFileSync(full, 'utf8');
      return { path: filePath, size: stat.size, content };
    },
  },
  {
    name: 'fs_write_file',
    description: 'Write or create a file in the project workspace. Creates parent directories automatically. Use for writing source code, configs, scripts, etc.',
    category: 'exec_fs',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path within the workspace, e.g. "src/main.py" or "tests/test_main.py".' },
        content: { type: 'string', description: 'The full file content to write.' },
      },
      required: ['path', 'content'],
    },
    execute: async ({ path: filePath, content }, ctx) => {
      const ws = workspaceFor(ctx);
      const full = safePath(ws, filePath);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      // GR4: Dry-run syntax validation before overwriting
      const syntaxError = dryRunValidate(full, content);
      if (syntaxError) {
        console.warn(`[GR4] Syntax check failed for ${filePath} (agent: ${ctx.agentId}): ${syntaxError.syntax_error}`);
        return syntaxError;
      }
      fs.writeFileSync(full, content);
      // LSP feedback: auto-diagnose after write
      const result = { ok: true, path: filePath, bytes: Buffer.byteLength(content) };
      try {
        const { diagnose } = await import('./lsp-feedback.js');
        const diag = diagnose(full);
        const errors = diag.filter(d => d.level === 'error');
        if (errors.length > 0) {
          const msgs = errors.map(e => `${e.tool}: ${e.message.trim().split('\n')[0]}`).join('; ');
          result.diagnostics = diag;
          result.warning = `\n⚠️ Diagnostics: ${msgs}`;
        }
      } catch { /* lsp-feedback not available — skip silently */ }
      return result;
    },
  },
  {
    name: 'fs_list_dir',
    description: 'List files and directories in a project workspace directory. Returns names, types (file/dir), and sizes.',
    category: 'exec_fs',
    parameters: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Relative directory path, e.g. "src" or "." for root. Defaults to ".".' },
      },
    },
    execute: ({ dir = '.' }, ctx) => {
      const ws = workspaceFor(ctx);
      const full = safePath(ws, dir);
      if (!fs.existsSync(full)) return { error: `Directory not found: ${dir}` };
      const entries = fs.readdirSync(full, { withFileTypes: true }).map(ent => {
        const entPath = path.join(full, ent.name);
        return {
          name: ent.name,
          type: ent.isDirectory() ? 'dir' : 'file',
          size: ent.isFile() ? fs.statSync(entPath).size : undefined,
        };
      });
      return { dir, count: entries.length, entries };
    },
  },
  {
    name: 'fs_mkdir',
    description: 'Create a directory (and parent directories) in the project workspace.',
    category: 'exec_fs',
    parameters: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Directory path to create, e.g. "src/utils" or "tests".' },
      },
      required: ['dir'],
    },
    execute: ({ dir }, ctx) => {
      const ws = workspaceFor(ctx);
      const full = safePath(ws, dir);
      fs.mkdirSync(full, { recursive: true });
      return { ok: true, dir };
    },
  },
  {
    name: 'fs_delete_file',
    description: 'Delete a file from the project workspace. The file is moved to a quarantine folder for 7 days before permanent deletion — recoverable if the agent made a mistake.',
    category: 'exec_fs',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to delete.' },
      },
      required: ['path'],
    },
    execute: ({ path: filePath }, ctx) => {
      const ws = workspaceFor(ctx);
      const full = safePath(ws, filePath);
      if (!fs.existsSync(full)) return { error: `File not found: ${filePath}` };
      // GR3: Soft-delete — move to quarantine, never truly unlink
      const quarantinedTo = quarantineFile(full);
      console.log(`[GR3] Quarantined ${filePath} → ${quarantinedTo} (agent: ${ctx.agentId})`);
      return { ok: true, deleted: filePath, quarantined: true, recoverable_for: '7 days' };
    },
  },

  {
    name: 'fs_find',
    description: 'Recursively find files by name pattern (glob). Returns matching paths. Use this to discover project structure before editing.',
    category: 'exec_fs',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern, e.g. "*.test.js", "**/*.py", "src/**/*.ts"' },
        dir: { type: 'string', description: 'Starting directory (default: workspace root)' },
      },
      required: ['pattern'],
    },
    execute: ({ pattern, dir }, ctx) => {
      const ws = workspaceFor(ctx);
      const startDir = dir ? safePath(ws, dir) : ws;
      const results = [];
      const maxResults = 50;
      const walk = (d, depth) => {
        if (depth > 6 || results.length >= maxResults) return;
        try {
          for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
            if (['node_modules', '.git', '__pycache__', '.venv', 'dist', 'build'].includes(ent.name)) continue;
            const full = path.join(d, ent.name);
            const rel = path.relative(ws, full);
            if (ent.isDirectory()) {
              walk(full, depth + 1);
            } else {
              // Simple glob matching: * = any chars, ** already handled by recursion
              const globRegex = new RegExp('^' + pattern.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '.') + '$');
              if (globRegex.test(ent.name) || globRegex.test(rel)) {
                results.push(rel);
              }
            }
          }
        } catch { /* permission denied etc */ }
      };
      walk(startDir, 0);
      return { count: results.length, files: results, capped: results.length >= maxResults };
    },
  },

  // ── Shell ───────────────────────────────────────────────────────
  {
    name: 'shell_exec',
    description: 'Execute a shell command in the project workspace. Timeout: 30 seconds. Returns stdout, stderr, and exit code. Use for running builds, tests, installing packages, etc.',
    category: 'exec_shell',
    parameters: {
      type: 'object',
      properties: {
        cmd: { type: 'string', description: 'The shell command to execute, e.g. "ls -la", "pip install requests", "make test".' },
      },
      required: ['cmd'],
    },
    execute: async ({ cmd }, ctx) => {
      const ws = workspaceFor(ctx);

      // GR1: Destructive command blocker — hard reject before execution
      const rejection = checkDestructiveCommand(cmd);
      if (rejection) {
        console.warn(`[GR1] BLOCKED destructive command from ${ctx.agentId}: ${cmd}`);
        return { cmd, error: rejection, exitCode: -1, blocked: true };
      }

      // E2B sandbox path
      if (process.env.E2B_API_KEY && ctx.taskId) {
        try {
          const sbx = await getOrCreateSandbox(ctx.taskId);
          if (sbx) {
            const stdoutChunks = [];
            const stderrChunks = [];
            const r = await sbx.commands.run(cmd, {
              cwd: '/home/user',
              timeoutMs: 60_000,
              onStdout: (d) => {
                stdoutChunks.push(d);
                ctx.broadcast?.({ kind: 'event:append', event: { who: ctx.agentId, what: d.slice(0, 200), icon: 'terminal', color: 'blue' } });
              },
              onStderr: (d) => stderrChunks.push(d),
            });
            return {
              cmd, exitCode: r.exitCode,
              stdout: stdoutChunks.join('').slice(0, 8000),
              stderr: stderrChunks.join('').slice(0, 4000),
              sandbox: true,
            };
          }
        } catch (err) {
          // fall through to local execution on sandbox error
          console.warn('[shell_exec] E2B sandbox error, falling back to local:', err.message);
        }
      }

      try {
        const result = psExecSync(cmd, {
          cwd: ws,
          timeout: 30_000,
          env: { ...process.env, HOME: os.homedir() },
        });
        return {
          cmd,
          exitCode: result.exitCode,
          stdout: result.stdout.slice(0, 8000),
          stderr: result.stderr.slice(0, 4000),
          error: result.error || null,
          shell: SHELL_INFO.name,
        };
      } catch (err) {
        return { cmd, error: err.message, exitCode: -1, shell: SHELL_INFO.name };
      }
    },
  },
  {
    name: 'shell_bg',
    description: 'Start a long-running background process in the workspace (e.g. "npm run dev", "python server.py"). The process runs detached. Returns a job ID you can use with shell_ps and shell_kill.',
    category: 'exec_shell',
    parameters: {
      type: 'object',
      properties: {
        cmd: { type: 'string', description: 'The command to start in the background.' },
      },
      required: ['cmd'],
    },
    execute: ({ cmd }, ctx) => {
      const ws = workspaceFor(ctx);

      // GR1: Destructive command blocker
      const rejection = checkDestructiveCommand(cmd);
      if (rejection) {
        console.warn(`[GR1] BLOCKED destructive bg command from ${ctx.agentId}: ${cmd}`);
        return { error: rejection, blocked: true };
      }

      // spawn already imported at top level (ESM)
      const id = 'job-' + Date.now().toString(36);
      
      if (!global.__bgJobs) global.__bgJobs = new Map();

      try {
        const child = spawn('bash', ['-c', cmd], {
          cwd: ws,
          env: { ...process.env, HOME: os.homedir() },
          detached: true,
          stdio: 'ignore'
        });
        
        child.unref(); // don't block node exit
        global.__bgJobs.set(id, { id, cmd, pid: child.pid, started: Date.now(), project: requireProjectId(ctx) });
        
        // Clean up when it dies
        child.on('exit', () => global.__bgJobs.delete(id));
        
        return { ok: true, id, pid: child.pid, cmd };
      } catch (err) {
        return { error: err.message };
      }
    },
  },
  {
    name: 'shell_ps',
    description: 'List all running background processes started by shell_bg in this project.',
    category: 'exec_shell',
    parameters: { type: 'object', properties: {} },
    execute: (args, ctx) => {
      const pid = requireProjectId(ctx);
      if (!global.__bgJobs) return { jobs: [] };
      const jobs = Array.from(global.__bgJobs.values()).filter(j => j.project === pid);
      return { count: jobs.length, jobs };
    },
  },
  {
    name: 'shell_kill',
    description: 'Kill a background process started by shell_bg using its job ID.',
    category: 'exec_shell',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The job ID returned by shell_bg or shell_ps.' },
      },
      required: ['id'],
    },
    execute: ({ id }, ctx) => {
      if (!global.__bgJobs || !global.__bgJobs.has(id)) return { error: `Job not found: ${id}` };
      const job = global.__bgJobs.get(id);
      try {
        process.kill(-job.pid); // kill process group since it was detached
      } catch (e) {
        try { process.kill(job.pid); } catch (err) { return { error: `Kill failed: ${err.message}` }; }
      }
      global.__bgJobs.delete(id);
      return { ok: true, id, killed: true };
    },
  },

  // ── Python ──────────────────────────────────────────────────────
  {
    name: 'python_run',
    description: 'Run Python in the project workspace. Two modes: (1) pass `code` to write it to disk and execute it; (2) pass `filename` (without `code`) to execute an existing .py file in the workspace. Returns stdout, stderr, and exit code.',
    category: 'exec_python',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Python source code to write and execute. Optional if filename points to an existing file.' },
        filename: { type: 'string', description: 'Filename within the workspace, e.g. "src/fib.py". If `code` is also given, this file is written then run; if only filename is given, the existing file is run as-is.' },
      },
    },
    execute: async ({ code, filename }, ctx) => {
      const ws = workspaceFor(ctx);

      if (!code && !filename) {
        return { error: 'python_run needs either `code` or `filename`.' };
      }

      let scriptPath;
      if (code) {
        // Write mode (with or without a persistent filename)
        scriptPath = filename ? safePath(ws, filename) : path.join(ws, `.gavirila-run-${Date.now()}.py`);
        fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
        fs.writeFileSync(scriptPath, code);
      } else {
        // Run existing file
        scriptPath = safePath(ws, filename);
        if (!fs.existsSync(scriptPath)) {
          return { error: `File not found: ${filename}` };
        }
      }

      // E2B sandbox path
      if (process.env.E2B_API_KEY && ctx.taskId) {
        try {
          const sbx = await getOrCreateSandbox(ctx.taskId);
          if (sbx) {
            const remotePath = `/home/user/${path.basename(scriptPath)}`;
            await sbx.files.write(remotePath, fs.readFileSync(scriptPath, 'utf8'));
            const stdoutChunks = [];
            const stderrChunks = [];
            const r = await sbx.commands.run(`python3 ${remotePath}`, {
              cwd: '/home/user',
              timeoutMs: 60_000,
              onStdout: (d) => stdoutChunks.push(d),
              onStderr: (d) => stderrChunks.push(d),
            });
            // Clean up local temp file
            if (code && !filename) {
              try { fs.unlinkSync(scriptPath); } catch {}
            }
            return {
              exitCode: r.exitCode,
              stdout: stdoutChunks.join('').slice(0, 8000),
              stderr: stderrChunks.join('').slice(0, 4000),
              ran: filename || '<anonymous>',
              sandbox: true,
            };
          }
        } catch (err) {
          console.warn('[python_run] E2B sandbox error, falling back to local:', err.message);
        }
      }

      try {
        const result = spawnSync('python3', [scriptPath], {
          cwd: ws,
          timeout: 30_000,
          maxBuffer: 1_048_576,
          encoding: 'utf8',
          env: { ...process.env, HOME: os.homedir(), PYTHONIOENCODING: 'utf-8' },
        });

        // Clean up temp file only if it was anonymous
        if (code && !filename) {
          try { fs.unlinkSync(scriptPath); } catch {}
        }

        return {
          exitCode: result.status,
          stdout: (result.stdout || '').slice(0, 8000),
          stderr: (result.stderr || '').slice(0, 4000),
          signal: result.signal || null,
          ran: filename || '<anonymous>',
        };
      } catch (err) {
        return { error: err.message, exitCode: -1 };
      }
    },
  },
  {
    name: 'python_eval',
    description: 'Evaluate a Python expression and return the result. Quick way to do calculations, check data, test logic.',
    category: 'exec_python',
    parameters: {
      type: 'object',
      properties: {
        expr: { type: 'string', description: 'Python expression to evaluate, e.g. "2**10", "len(range(100))", "import sys; sys.version".' },
      },
      required: ['expr'],
    },
    execute: ({ expr }, ctx) => {
      const ws = workspaceFor(ctx);
      // Wrap in print() so we capture the output
      const code = `import sys\ntry:\n    result = eval(${JSON.stringify(expr)})\n    print(result)\nexcept:\n    exec(${JSON.stringify(expr)})`;
      const result = spawnSync('python3', ['-c', code], {
        cwd: ws,
        timeout: 10_000,
        encoding: 'utf8',
        env: { ...process.env, HOME: os.homedir() },
      });
      return {
        expr,
        result: (result.stdout || '').trim(),
        error: result.stderr ? result.stderr.trim() : null,
        exitCode: result.status,
      };
    },
  },

  // ── Git ─────────────────────────────────────────────────────────
  {
    name: 'git_init',
    description: 'Initialize a git repository in the project workspace. Safe to call if already initialized.',
    category: 'exec_git',
    parameters: { type: 'object', properties: {} },
    execute: (_, ctx) => {
      const ws = workspaceFor(ctx);
      const result = spawnSync('git', ['init'], { cwd: ws, encoding: 'utf8', timeout: 10_000 });
      return { ok: result.status === 0, output: (result.stdout || '').trim() };
    },
  },
  {
    name: 'git_status',
    description: 'Show the git status of the project workspace — modified, staged, untracked files.',
    category: 'exec_git',
    parameters: { type: 'object', properties: {} },
    execute: (_, ctx) => {
      const ws = workspaceFor(ctx);
      const result = spawnSync('git', ['status', '--short'], { cwd: ws, encoding: 'utf8', timeout: 10_000 });
      if (result.status !== 0) return { error: result.stderr?.trim() || 'not a git repo' };
      return { status: (result.stdout || '').trim(), clean: !(result.stdout || '').trim() };
    },
  },
  {
    name: 'git_diff',
    description: 'Show unstaged changes in the workspace.',
    category: 'exec_git',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Optional: specific file to diff.' },
      },
    },
    execute: ({ path: filePath }, ctx) => {
      const ws = workspaceFor(ctx);
      const args = ['diff'];
      if (filePath) args.push(filePath);
      const result = spawnSync('git', args, { cwd: ws, encoding: 'utf8', timeout: 10_000 });
      return { diff: (result.stdout || '').slice(0, 8000) };
    },
  },
  {
    name: 'git_add',
    description: 'Stage files for commit. Use "." to stage all changes.',
    category: 'exec_git',
    parameters: {
      type: 'object',
      properties: {
        files: { type: 'string', description: 'File(s) to stage, e.g. "." for all, or "src/main.py tests/".' },
      },
      required: ['files'],
    },
    execute: ({ files }, ctx) => {
      const ws = workspaceFor(ctx);
      const result = spawnSync('git', ['add', ...files.split(/\s+/)], { cwd: ws, encoding: 'utf8', timeout: 10_000 });
      if (result.status !== 0) return { error: result.stderr?.trim() };
      return { ok: true, staged: files };
    },
  },
  {
    name: 'git_commit',
    description: 'Commit staged changes with a message.',
    category: 'exec_git',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Commit message.' },
      },
      required: ['message'],
    },
    execute: ({ message }, ctx) => {
      const ws = workspaceFor(ctx);
      const result = spawnSync('git', ['commit', '-m', message], {
        cwd: ws, encoding: 'utf8', timeout: 10_000,
        env: { ...process.env, GIT_AUTHOR_NAME: 'Gavirila', GIT_AUTHOR_EMAIL: 'gavirila@homestead', GIT_COMMITTER_NAME: 'Gavirila', GIT_COMMITTER_EMAIL: 'gavirila@homestead' },
      });
      if (result.status !== 0) return { error: (result.stderr || result.stdout || '').trim() };
      return { ok: true, output: (result.stdout || '').trim() };
    },
  },
  {
    name: 'git_log',
    description: 'Show recent commit history (last 10 commits).',
    category: 'exec_git',
    parameters: {
      type: 'object',
      properties: {
        count: { type: 'integer', description: 'Number of commits to show. Default 10.' },
      },
    },
    execute: ({ count = 10 }, ctx) => {
      const ws = workspaceFor(ctx);
      const result = spawnSync('git', ['log', `--max-count=${count}`, '--oneline', '--no-decorate'], { cwd: ws, encoding: 'utf8', timeout: 10_000 });
      if (result.status !== 0) return { error: result.stderr?.trim() || 'no commits yet' };
      const commits = (result.stdout || '').trim().split('\n').filter(Boolean).map(line => {
        const [hash, ...rest] = line.split(' ');
        return { hash, message: rest.join(' ') };
      });
      return { count: commits.length, commits };
    },
  },

  // ── Tools Admin ─────────────────────────────────────────────────
  {
    name: 'fs_hot_reload_tool',
    description: 'Register a new dynamically-created tool file into the live server registry without restarting. The Forger uses this after writing a new tool script to apps/backend/src/tools/dynamic/. Pass the tool name and the path to the JS module — the registry will import it and make it immediately available to all agents.',
    category: 'exec_tools_admin',
    parameters: {
      type: 'object',
      properties: {
        tool_name: { type: 'string', description: 'The name of the tool being registered (e.g. "aws_s3_upload").' },
        module_path: { type: 'string', description: 'Relative path within apps/backend/ to the JS module, e.g. "src/tools/dynamic/aws-s3.js".' },
        description: { type: 'string', description: 'Human-readable description of what the tool does.' },
        category: { type: 'string', description: 'Tool category/scope string (e.g. "exec_aws"). Agents need this scope to use it.' },
      },
      required: ['tool_name', 'module_path', 'description', 'category'],
    },
    execute: async ({ tool_name, module_path, description, category }, ctx) => {
      try {
        // Resolve the module path relative to the backend src root
        const backendRoot = path.resolve(
          path.dirname(new URL(import.meta.url).pathname),
          '..'
        );
        const absPath = path.resolve(backendRoot, module_path);

        if (!fs.existsSync(absPath)) {
          return { error: `Module not found: ${absPath}. Write the tool file first using fs_write_file.` };
        }

        // Dynamically import the module — it must export a default function or { execute }
        const mod = await import(`${absPath}?hot=${Date.now()}`);  // cache-bust
        const executeFn = mod.default?.execute || mod.execute || mod.default;

        if (typeof executeFn !== 'function') {
          return { error: `Module ${module_path} must export an execute function or default object with execute method.` };
        }

        // Register into the live TOOLS array via registry
        const { TOOLS } = await import('../tools/registry.js');
        // Remove any existing tool with the same name (hot-reload = replace)
        const existingIdx = TOOLS.findIndex(t => t.name === tool_name);
        const newTool = {
          name: tool_name,
          description,
          category,
          parameters: mod.parameters || mod.default?.parameters || { type: 'object', properties: {} },
          execute: executeFn,
          _hotLoaded: true,
          _loadedAt: new Date().toISOString(),
        };

        if (existingIdx >= 0) {
          TOOLS[existingIdx] = newTool;
        } else {
          TOOLS.push(newTool);
        }

        ctx.broadcast?.({ kind: 'toast', toast: {
          title: 'New tool registered',
          body: `${tool_name} (${category}) is now live`,
          icon: 'lightning', color: 'green', kind: 'success',
        }});

        return {
          ok: true,
          tool_name,
          category,
          action: existingIdx >= 0 ? 'replaced' : 'registered',
          message: `Tool "${tool_name}" is now available to agents with scope "${category}". The agent that requested it has been notified.`,
        };
      } catch (e) {
        return { error: `Hot-reload failed: ${e.message}` };
      }
    },
  },

  // ── Browser ─────────────────────────────────────────────────────
  {
    name: 'browser_run',
    description: 'Run a browser automation task using AI-driven browser control (browser-use + Playwright). Use for visual UI testing, screenshot capture, form filling, navigation verification. Example: "Navigate to localhost:8765, open the Kanban board, verify task cards render". Requires browser-use installed: pip install browser-use && playwright install chromium',
    category: 'exec_browser',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Natural language description of the browser task, e.g. "Go to localhost:8765/chores and verify at least one kanban task card is visible".' },
        url: { type: 'string', description: 'Optional: starting URL for the task. If omitted, the task description should include the URL.' },
        model: { type: 'string', description: 'Optional: LLM model to use for browser control. Defaults to VIO:GPT 5-chat via LLM_BASE_URL.' },
      },
      required: ['task'],
    },
    execute: async ({ task, url, model }, ctx) => {
      const { spawnSync } = await import('node:child_process');
      const path = await import('node:path');
      const thisDir = path.dirname(new URL(import.meta.url).pathname);
      const scriptPath = path.join(thisDir, 'browser_task.py');

      const fullTask = url ? `Starting at ${url}: ${task}` : task;
      const vioBase = process.env.VIO_BASE_URL || process.env.AUMOVIO_BASE_URL;
      const vioKey = process.env.VIO_KEY_1 || process.env.AUMOVIO_KEY_1 || process.env.VIO_KEY;

      const env = {
        ...process.env,
        LLM_API_KEY: vioKey || process.env.LLM_API_KEY || 'no-key',
        LLM_BASE_URL: (vioBase ? vioBase + '/v1' : null) || process.env.LLM_BASE_URL || 'https://api.openai.com/v1',
        LLM_MODEL: model || process.env.LLM_BROWSER_MODEL || 'VIO:GPT 5-chat',
        PYTHONIOENCODING: 'utf-8',
      };

      const result = spawnSync('python3', [scriptPath, fullTask], {
        encoding: 'utf8',
        timeout: 120_000,
        maxBuffer: 5_242_880,
        env,
      });

      if (result.error) return { error: `Failed to spawn python3: ${result.error.message}` };

      try {
        const parsed = JSON.parse(result.stdout || '{}');
        // Strip screenshot from artifact log (too large), keep it as separate data
        const { screenshot_b64, ...logSafe } = parsed;
        return {
          ...logSafe,
          has_screenshot: !!screenshot_b64,
          screenshot_b64: screenshot_b64 || null,
          stderr: (result.stderr || '').slice(0, 1000),
        };
      } catch {
        return {
          error: 'browser_task.py returned non-JSON output',
          stdout: (result.stdout || '').slice(0, 1000),
          stderr: (result.stderr || '').slice(0, 1000),
          exitCode: result.status,
        };
      }
    },
  },

  {
    name: 'browser_screenshot',
    description: 'Capture a screenshot of a URL without running an agent task. Returns base64 PNG. Use before making UI changes to capture the "before" state for later visual comparison.',
    category: 'exec_browser',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL to screenshot, e.g. "http://localhost:8765".' },
      },
      required: ['url'],
    },
    execute: async ({ url }, ctx) => {
      const { spawnSync } = await import('node:child_process');
      const pathMod = await import('node:path');
      const thisDir = pathMod.dirname(new URL(import.meta.url).pathname);
      const scriptPath = pathMod.join(thisDir, 'browser_task.py');

      const result = spawnSync('python3', [scriptPath, '--screenshot', url], {
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 5_242_880,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      });

      if (result.error) return { error: `Failed to spawn python3: ${result.error.message}` };
      try {
        return JSON.parse(result.stdout || '{}');
      } catch {
        return { error: 'browser_task.py returned non-JSON', stdout: (result.stdout || '').slice(0, 500) };
      }
    },
  },

  // ── Patch ────────────────────────────────────────────────────────
  {
    name: 'fs_patch_file',
    description: 'Apply a targeted SEARCH/REPLACE patch to a file in the project workspace. More efficient than fs_write_file for small changes — only sends the diff, not the entire file. The SEARCH block must match the file byte-for-byte (including whitespace). Use separate patch calls for multiple non-contiguous changes.',
    category: 'exec_fs',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path to the file to patch, e.g. "src/main.py".' },
        search: { type: 'string', description: 'The exact content to find in the file. Must match verbatim (whitespace, indentation, line endings). Leave empty to create a new file.' },
        replace: { type: 'string', description: 'The replacement content. Leave empty to delete the matched content.' },
      },
      required: ['path', 'search', 'replace'],
    },
    execute: ({ path: filePath, search, replace }, ctx) => {
      const ws = workspaceFor(ctx);
      const full = safePath(ws, filePath);

      // CREATE: empty search = create new file
      if (search === '' || search === undefined || search === null) {
        if (fs.existsSync(full)) return { error: `File already exists: ${filePath}. Use a non-empty SEARCH block to modify it, or fs_write_file to overwrite.` };
        fs.mkdirSync(path.dirname(full), { recursive: true });
        // GR4: validate new file content
        const syntaxError = dryRunValidate(full, replace || '');
        if (syntaxError) return syntaxError;
        fs.writeFileSync(full, replace || '');
        if (ctx?.threadMeta?.filesRead) delete ctx.threadMeta.filesRead[filePath];
        return { ok: true, kind: 'created', path: filePath };
      }

      // MODIFY: read file, find search block, replace it
      if (!fs.existsSync(full)) return { error: `File not found: ${filePath}` };
      const stat = fs.statSync(full);
      if (stat.size > 512_000) return { error: `File too large to patch: ${(stat.size / 1024).toFixed(0)}KB` };

      let content = fs.readFileSync(full, 'utf8');

      // 1. Exact match
      if (content.includes(search)) {
        const updated = content.replace(search, replace);
        // GR4: validate patched content before writing
        const syntaxError = dryRunValidate(full, updated);
        if (syntaxError) return syntaxError;
        fs.writeFileSync(full, updated);
        if (ctx?.threadMeta?.filesRead) delete ctx.threadMeta.filesRead[filePath];
        const diff = makeMiniDiff(filePath, content, updated, true);
        return { ok: true, kind: 'patched', path: filePath, match: 'exact', diff };
      }

      // 2. Whitespace-normalized match (trim each line, compare)
      const normalizeLines = (s) => s.split('\n').map(l => l.trimEnd()).join('\n');
      const normContent = normalizeLines(content);
      const normSearch = normalizeLines(search);
      const normIdx = normContent.indexOf(normSearch);
      if (normIdx !== -1) {
        // Find the actual position in original content by counting newlines up to normIdx
        const linesBeforeNorm = normContent.slice(0, normIdx).split('\n').length - 1;
        const lines = content.split('\n');
        const searchLines = search.split('\n').length;
        const before = lines.slice(0, linesBeforeNorm).join('\n');
        const after = lines.slice(linesBeforeNorm + searchLines).join('\n');
        const updated = (before ? before + '\n' : '') + replace + (after ? '\n' + after : '');
        // GR4: validate patched content before writing
        const syntaxError = dryRunValidate(full, updated);
        if (syntaxError) return syntaxError;
        fs.writeFileSync(full, updated);
        if (ctx?.threadMeta?.filesRead) delete ctx.threadMeta.filesRead[filePath];
        const diff = makeMiniDiff(filePath, content, updated, true);
        return { ok: true, kind: 'patched', path: filePath, match: 'whitespace-normalized', diff };
      }

      // 3. Not found
      return {
        error: `SEARCH block not found in ${filePath}. The SEARCH content must match the file exactly (including indentation and whitespace). Read the file first with fs_read_file and copy the exact content you want to replace.`,
        hint: 'Use fs_read_file to get the current file content, then copy the exact lines you want to change into the SEARCH block.',
      };
    },
  },

  // ── Time Machine: atomic rollback ───────────────────────────────────────────
  {
    name: 'system_restore',
    description: 'Roll back the database and vault to N snapshots ago (default 5). Use when a catastrophic failure cannot be fixed. Marks the causative task as toxic.',
    category: 'exec_system',
    inputSchema: {
      type: 'object',
      properties: {
        steps_back: { type: 'number', description: 'How many snapshots to rewind (default 5)' },
        toxic_task_id: { type: 'string', description: 'Task ID to mark as toxic to prevent re-run' },
        reason: { type: 'string', description: 'Why the rollback is needed' }
      }
    },
    execute: async ({ steps_back = 5, toxic_task_id, reason }, ctx) => {
      const { restoreState, listSnapshots } = await import('../brain/time-machine.js');
      const snapshots = listSnapshots();
      if (snapshots.length === 0) {
        return { error: 'No snapshots available yet. Snapshots are created after each task completes.' };
      }
      console.log(`[system_restore] Rollback requested: steps=${steps_back}, reason="${reason}"`);
      const result = await restoreState(steps_back, { taskId: toxic_task_id, markTaskToxic: true });
      ctx.broadcast?.({ kind: 'system:restore', steps_back, reason, ...result });
      return { ok: true, ...result, available_snapshots: snapshots.length, reason };
    }
  },

  // ── Code Agent (Smolagents-style) ──────────────────────────────────────────
  {
    name: 'exec_code_block',
    description: 'Execute a multi-step Python or JavaScript code block in one shot. Use this instead of multiple sequential tool calls when you need to: read files, parse them, do calculations, write output. Returns stdout, stderr, and exit code. Python runs via python3, JS runs via node.',
    category: 'exec_shell',
    parameters: {
      type: 'object',
      required: ['code', 'language'],
      properties: {
        code: { type: 'string', description: 'The complete code to execute' },
        language: { type: 'string', enum: ['python', 'javascript', 'bash'], description: 'Language to run' },
        timeout_seconds: { type: 'number', description: 'Execution timeout (default 30s, max 120s)' },
        working_dir: { type: 'string', description: 'Working directory (default: project workspace or cwd)' },
      },
    },
    execute: async ({ code, language, timeout_seconds = 30, working_dir }, ctx) => {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const { writeFile, unlink, mkdtemp, rmdir } = await import('node:fs/promises');
      const osM = await import('node:os');
      const pathM = await import('node:path');
      const execFileAsync = promisify(execFile);

      const timeout = Math.min((timeout_seconds || 30) * 1000, 120_000);
      const tmpDir = await mkdtemp(pathM.join(osM.tmpdir(), 'gavirila-code-'));

      // Determine working directory
      let cwd = working_dir;
      if (!cwd && ctx?.projectId) {
        try {
          cwd = workspaceFor(ctx);
        } catch {}
      }
      if (!cwd) cwd = process.cwd();

      let ext, cmd;
      if (language === 'python') {
        ext = '.py'; cmd = 'python3';
      } else if (language === 'javascript') {
        ext = '.mjs'; cmd = 'node';
      } else {
        ext = '.sh'; cmd = 'bash';
      }

      const scriptPath = pathM.join(tmpDir, `script${ext}`);
      await writeFile(scriptPath, code, 'utf8');

      try {
        const { stdout, stderr } = await execFileAsync(cmd, [scriptPath], {
          cwd,
          timeout,
          maxBuffer: 1024 * 1024 * 5, // 5MB
          env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
        });
        return {
          success: true,
          stdout: stdout.slice(0, 20000),
          stderr: stderr.slice(0, 2000) || null,
          exit_code: 0,
        };
      } catch (e) {
        return {
          success: false,
          stdout: e.stdout?.slice(0, 10000) || '',
          stderr: e.stderr?.slice(0, 5000) || e.message?.slice(0, 2000),
          exit_code: e.code || 1,
        };
      } finally {
        await unlink(scriptPath).catch(() => {});
        await rmdir(tmpDir).catch(() => {});
      }
    },
  },
  {
    name: 'exec_python_inline',
    description: 'Evaluate a single Python expression and return the result. Perfect for quick calculations, JSON parsing, string manipulation, or data transformations without writing a full script. Common stdlib modules (json, os, sys, re, hashlib, pathlib) are pre-imported.',
    category: 'exec_shell',
    parameters: {
      type: 'object',
      required: ['expression'],
      properties: {
        expression: { type: 'string', description: 'Python expression to evaluate. Examples: "len(open(\'file.txt\').read())", "json.loads(open(\'data.json\').read())[\'key\']", "sorted([3,1,2])"' },
      },
    },
    execute: async ({ expression }, ctx) => {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);

      const code = `import json, os, sys, re, hashlib, pathlib\nprint(repr(${expression}))`;
      let cwd = process.cwd();
      if (ctx?.projectId) {
        try { cwd = workspaceFor(ctx); } catch {}
      }

      try {
        const { stdout } = await execFileAsync('python3', ['-c', code], {
          timeout: 10_000,
          maxBuffer: 1024 * 512,
          cwd,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        });
        return { result: stdout.trim() };
      } catch (e) {
        return { error: e.stderr?.slice(0, 500) || e.message };
      }
    },
  },

  // ── Ouroboros: Backend self-reload ─────────────────────────────────────────
  {
    name: 'system_reload_backend',
    description: 'Hot-reload the Gavirila backend server. Use ONLY after modifying core backend source files in the shadow workspace AND after all tests pass in the sandbox. This restarts the server process with the new code. Requires exec_system tool scope.',
    category: 'exec_system',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Brief explanation of what changed and why a reload is needed.' },
        apply_shadow_diff: { type: 'boolean', description: 'If true, first copies the shadow workspace diff into the main workspace, then reloads.' },
        shadow_path: { type: 'string', description: 'Path to the shadow workspace (required if apply_shadow_diff is true).' },
        main_workspace: { type: 'string', description: 'Path to the main backend source directory (required if apply_shadow_diff is true).' },
      },
      required: ['reason'],
    },
    async execute({ reason, apply_shadow_diff, shadow_path, main_workspace }, ctx) {
      const log = [];

      // Step 1: Optionally apply shadow diff to main workspace
      if (apply_shadow_diff && shadow_path && main_workspace) {
        try {
          // Generate diff from shadow
          const diff = execSync(`git -C "${shadow_path}" diff HEAD`, { maxBuffer: 4 * 1024 * 1024 }).toString();
          if (!diff.trim()) {
            return { ok: false, error: 'No changes found in shadow workspace. Did you actually modify files?' };
          }
          // Apply the diff to the main workspace
          const diffPath = path.join(os.tmpdir(), `gavirila-shadow-diff-${Date.now()}.patch`);
          fs.writeFileSync(diffPath, diff);
          execSync(`git -C "${main_workspace}" apply --check "${diffPath}"`, { stdio: 'inherit' });
          execSync(`git -C "${main_workspace}" apply "${diffPath}"`, { stdio: 'inherit' });
          log.push(`Applied shadow diff (${diff.split('\n').length} lines) to ${main_workspace}`);
        } catch (err) {
          return { ok: false, error: `Failed to apply shadow diff: ${err.message}`, log };
        }
      }

      // Step 2: Reload via PM2 if available, else signal tsx-watch to restart
      let reloaded = false;
      try {
        execSync('pm2 reload gavirila-backend --update-env', { stdio: 'pipe' });
        reloaded = true;
        log.push('Reloaded via PM2: pm2 reload gavirila-backend');
      } catch {
        // PM2 not running — try touching server.js to trigger tsx watch restart
        try {
          const serverPath = path.resolve(__dirname, '../server.js');
          const now = new Date();
          spawnSync('touch', [serverPath]); // unix only
          // On Windows: use fs.utimesSync
          try {
            fs.utimesSync(serverPath, now, now);
            reloaded = true;
            log.push(`Touched ${serverPath} to trigger tsx --watch restart`);
          } catch { /* ignore */ }
        } catch { /* ignore */ }
      }

      if (!reloaded) {
        return { ok: false, error: 'Could not reload server: PM2 not running and touch failed. Restart manually.', log };
      }

      // Broadcast to all connected WS clients that the backend is reloading
      ctx.broadcast?.({ kind: 'system:reload', reason, ts: Date.now() });

      return {
        ok: true,
        reason,
        log,
        warning: 'The server is reloading. This WebSocket connection will drop momentarily. The frontend will auto-reconnect.',
      };
    },
  },
];

// ── helpers ──────────────────────────────────────────────────────────

/** Produce a compact +/- diff summary for patch results. */
function makeMiniDiff(filePath, before, after, compact) {
  const bLines = before.split('\n');
  const aLines = after.split('\n');
  const removed = bLines.filter(l => !aLines.includes(l)).slice(0, 20).map(l => `- ${l}`);
  const added = aLines.filter(l => !bLines.includes(l)).slice(0, 20).map(l => `+ ${l}`);
  return `--- ${filePath}\n+++ ${filePath}\n${[...removed, ...added].join('\n')}`;
}
