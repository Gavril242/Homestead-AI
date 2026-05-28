// Agent-Computer Interface (ACI) — higher-level, safer abstractions over raw shell commands.
//
// Instead of agents running arbitrary shell_exec("rm -rf ..."), they use semantic tools
// with built-in validation, safety checks, and structured output.
//
// Each tool follows the same shape as exec-tools.js:
//   { name, description, category, parameters, execute(args, ctx) }

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { ensureWorkspace } from './exec-tools.js';

// ── helpers ─────────────────────────────────────────────────────────

function requireProjectId(ctx) {
  if (!ctx?.projectId) {
    throw new Error('No projectId in tool context — every ACI action must be tied to a project.');
  }
  return ctx.projectId;
}

function safePath(workspace, relPath) {
  const resolved = path.resolve(workspace, relPath);
  if (!resolved.startsWith(workspace)) {
    throw new Error(`Path traversal blocked: ${relPath}`);
  }
  return resolved;
}

function log(tool, msg) {
  console.log(`[aci:${tool}] ${msg}`);
}

// ── Private IP check for aci_http_request ───────────────────────────

const PRIVATE_IP_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\./,
  /^169\.254\./,
  /^fc00:/i,
  /^fd/i,
  /^fe80:/i,
  /^::1$/,
  /^localhost$/i,
];

function isPrivateHost(hostname) {
  return PRIVATE_IP_RANGES.some(re => re.test(hostname));
}

// ── Tool definitions ────────────────────────────────────────────────

const aci_file_replace_lines = {
  name: 'aci_file_replace_lines',
  description: 'Replace lines N through M (1-indexed, inclusive) in a file with new content. Safer than sed/awk — reads the file, validates the line range, splices, and writes atomically via tmp+rename. Use this for precise, line-range edits.',
  category: 'aci',
  parameters: {
    type: 'object',
    properties: {
      path:        { type: 'string', description: 'Relative file path within the project workspace.' },
      start_line:  { type: 'integer', description: 'First line to replace (1-indexed, inclusive).' },
      end_line:    { type: 'integer', description: 'Last line to replace (1-indexed, inclusive).' },
      new_content: { type: 'string', description: 'Replacement content (may be multi-line). An empty string deletes the lines.' },
    },
    required: ['path', 'start_line', 'end_line', 'new_content'],
  },
  execute: ({ path: filePath, start_line, end_line, new_content }, ctx) => {
    const ws = ensureWorkspace(requireProjectId(ctx));
    const full = safePath(ws, filePath);

    if (!fs.existsSync(full)) return { error: `File not found: ${filePath}` };
    if (typeof start_line !== 'number' || typeof end_line !== 'number') {
      return { error: 'start_line and end_line must be integers.' };
    }
    if (start_line < 1) return { error: 'start_line must be >= 1.' };
    if (end_line < start_line) return { error: 'end_line must be >= start_line.' };

    const content = fs.readFileSync(full, 'utf8');
    const lines = content.split('\n');

    if (start_line > lines.length) {
      return { error: `start_line ${start_line} exceeds file length (${lines.length} lines).` };
    }
    if (end_line > lines.length) {
      return { error: `end_line ${end_line} exceeds file length (${lines.length} lines).` };
    }

    // Splice: replace lines [start_line-1 .. end_line-1] with new_content lines
    const newLines = new_content === '' ? [] : new_content.split('\n');
    const replaced = lines.splice(start_line - 1, end_line - start_line + 1, ...newLines);
    const updated = lines.join('\n');

    // Atomic write: tmp file + rename
    const tmpPath = full + `.aci-tmp-${Date.now()}`;
    try {
      fs.writeFileSync(tmpPath, updated);
      fs.renameSync(tmpPath, full);
    } catch (e) {
      // Clean up tmp on failure
      try { fs.unlinkSync(tmpPath); } catch {}
      return { error: `Atomic write failed: ${e.message}` };
    }

    log('file_replace_lines', `${filePath}: replaced lines ${start_line}-${end_line} (${replaced.length} lines → ${newLines.length} lines)`);
    return {
      ok: true,
      path: filePath,
      lines_removed: replaced.length,
      lines_added: newLines.length,
      removed_preview: replaced.slice(0, 5).join('\n'),
    };
  },
};

const aci_run_tests = {
  name: 'aci_run_tests',
  description: 'Run the test suite for a project. Auto-detects the test framework (npm test, pytest, dotnet test, PowerShell Pester) based on project files. Returns structured results: { passed, failed, errors, output }.',
  category: 'aci',
  parameters: {
    type: 'object',
    properties: {
      path:   { type: 'string', description: 'Project root directory (relative to workspace). Defaults to ".".' },
      filter: { type: 'string', description: 'Optional test filter/grep pattern to run only matching tests.' },
    },
  },
  execute: ({ path: projectPath = '.', filter }, ctx) => {
    const ws = ensureWorkspace(requireProjectId(ctx));
    const root = safePath(ws, projectPath);

    if (!fs.existsSync(root)) return { error: `Directory not found: ${projectPath}` };

    // Detect test framework
    let cmd, framework;
    const exists = (f) => fs.existsSync(path.join(root, f));

    if (exists('package.json')) {
      framework = 'npm';
      cmd = filter ? `npx jest --forceExit --no-coverage --testPathPattern="${filter}"` : 'npm test -- --forceExit --no-coverage 2>&1';
      // Check if there's a vitest or jest config
      if (exists('vitest.config.ts') || exists('vitest.config.js')) {
        framework = 'vitest';
        cmd = filter ? `npx vitest run --reporter=verbose "${filter}"` : 'npx vitest run --reporter=verbose';
      }
    } else if (exists('pytest.ini') || exists('setup.py') || exists('pyproject.toml') || exists('requirements.txt')) {
      framework = 'pytest';
      cmd = filter ? `python3 -m pytest -v -k "${filter}" 2>&1` : 'python3 -m pytest -v 2>&1';
    } else if (exists('*.csproj') || exists('*.sln')) {
      framework = 'dotnet';
      cmd = filter ? `dotnet test --filter "${filter}" --verbosity normal 2>&1` : 'dotnet test --verbosity normal 2>&1';
    } else if (exists('*.Tests.ps1') || exists('Tests')) {
      framework = 'pester';
      cmd = filter
        ? `powershell -NoProfile -Command "Invoke-Pester -Path . -TestName '*${filter}*' -PassThru | Select-Object -Property TotalCount,PassedCount,FailedCount"`
        : `powershell -NoProfile -Command "Invoke-Pester -Path . -PassThru | Select-Object -Property TotalCount,PassedCount,FailedCount"`;
    } else {
      return { error: 'Could not auto-detect test framework. No package.json, pytest.ini, *.csproj, or Pester tests found.' };
    }

    log('run_tests', `Detected ${framework}, running: ${cmd}`);

    // Detect Windows host paths
    const isWinHostPath = /^[A-Z]:\\/.test(root);
    const shell = isWinHostPath ? 'powershell' : 'bash';
    const shellArgs = isWinHostPath
      ? ['-NoProfile', '-NonInteractive', '-Command', cmd]
      : ['-c', cmd];

    const result = spawnSync(shell, shellArgs, {
      cwd: root,
      timeout: 120_000,
      maxBuffer: 2_097_152,
      encoding: 'utf8',
      env: { ...process.env, CI: '1', HOME: os.homedir() },
    });

    const output = ((result.stdout || '') + '\n' + (result.stderr || '')).trim();

    // Parse results heuristically
    let passed = 0, failed = 0, errors = 0;
    const passMatch = output.match(/(\d+)\s+pass(ed|ing)?/i);
    const failMatch = output.match(/(\d+)\s+fail(ed|ing|ure)?/i);
    const errorMatch = output.match(/(\d+)\s+error/i);
    if (passMatch) passed = parseInt(passMatch[1], 10);
    if (failMatch) failed = parseInt(failMatch[1], 10);
    if (errorMatch) errors = parseInt(errorMatch[1], 10);

    log('run_tests', `${framework}: passed=${passed} failed=${failed} errors=${errors} exit=${result.status}`);

    return {
      framework,
      passed,
      failed,
      errors,
      exit_code: result.status,
      success: result.status === 0,
      output: output.slice(0, 10000),
    };
  },
};

// ── Git safety whitelist ────────────────────────────────────────────

const GIT_ALLOWED_SUBCOMMANDS = new Set([
  'status', 'diff', 'log', 'add', 'commit', 'branch', 'checkout', 'pull', 'push',
  'show', 'stash', 'tag', 'fetch', 'merge', 'rebase', 'cherry-pick', 'rev-parse',
]);

const GIT_BLOCKED_PATTERNS = [
  /push\s+.*--force/,
  /push\s+.*-f\b/,
  /reset\s+--hard/,
  /clean\s+-f/,
  /checkout\s+.*-f\b/,
  /branch\s+.*-D\b/,
];

const aci_git_safe = {
  name: 'aci_git_safe',
  description: 'Run safe git operations only. Whitelisted subcommands: status, diff, log, add, commit, branch, checkout, pull, push, show, stash, tag, fetch, merge, rebase, cherry-pick, rev-parse. Blocks force push, reset --hard, clean -f, checkout -f, branch -D.',
  category: 'aci',
  parameters: {
    type: 'object',
    properties: {
      subcommand: { type: 'string', description: 'Git subcommand (e.g. "status", "add", "commit").' },
      args:       { type: 'string', description: 'Arguments for the subcommand (e.g. "-m \\"fix: typo\\"", ".", "--oneline -10").' },
    },
    required: ['subcommand'],
  },
  execute: ({ subcommand, args = '' }, ctx) => {
    const ws = ensureWorkspace(requireProjectId(ctx));

    if (!GIT_ALLOWED_SUBCOMMANDS.has(subcommand)) {
      return { error: `Git subcommand "${subcommand}" is not in the safety whitelist. Allowed: ${[...GIT_ALLOWED_SUBCOMMANDS].join(', ')}` };
    }

    const fullArgs = `${subcommand} ${args}`.trim();

    for (const pat of GIT_BLOCKED_PATTERNS) {
      if (pat.test(fullArgs)) {
        return { error: `Blocked: "git ${fullArgs}" matches destructive pattern ${pat}. Use safe alternatives.` };
      }
    }

    log('git_safe', `git ${fullArgs}`);

    const result = spawnSync('git', fullArgs.split(/\s+/), {
      cwd: ws,
      timeout: 30_000,
      maxBuffer: 1_048_576,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: os.homedir(),
        GIT_AUTHOR_NAME: ctx.agentId || 'Gavirila',
        GIT_AUTHOR_EMAIL: 'gavirila@homestead',
        GIT_COMMITTER_NAME: ctx.agentId || 'Gavirila',
        GIT_COMMITTER_EMAIL: 'gavirila@homestead',
      },
    });

    return {
      command: `git ${fullArgs}`,
      exit_code: result.status,
      stdout: (result.stdout || '').slice(0, 8000),
      stderr: (result.stderr || '').slice(0, 4000),
      success: result.status === 0,
    };
  },
};

const aci_search_replace = {
  name: 'aci_search_replace',
  description: 'Find-and-replace across files in a directory using regex. Like sed -i but with a preview/dry-run mode (default). Set dry_run=false to apply changes. Returns a list of files and matches affected.',
  category: 'aci',
  parameters: {
    type: 'object',
    properties: {
      dir:         { type: 'string', description: 'Directory to search in (relative to workspace). Defaults to ".".' },
      pattern:     { type: 'string', description: 'Regex pattern to search for.' },
      replacement: { type: 'string', description: 'Replacement string (supports $1, $2 etc. for capture groups).' },
      file_glob:   { type: 'string', description: 'File name glob filter, e.g. "*.js", "*.py". Defaults to all files.' },
      dry_run:     { type: 'boolean', description: 'If true (default), only preview matches without modifying files.' },
    },
    required: ['dir', 'pattern', 'replacement'],
  },
  execute: ({ dir = '.', pattern, replacement, file_glob, dry_run = true }, ctx) => {
    const ws = ensureWorkspace(requireProjectId(ctx));
    const root = safePath(ws, dir);

    if (!fs.existsSync(root)) return { error: `Directory not found: ${dir}` };

    let regex;
    try {
      regex = new RegExp(pattern, 'g');
    } catch (e) {
      return { error: `Invalid regex: ${e.message}` };
    }

    // Build glob regex for file filtering
    let globRegex = null;
    if (file_glob) {
      const globPattern = '^' + file_glob.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
      globRegex = new RegExp(globPattern);
    }

    const results = [];
    const maxFiles = 100;
    const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'dist', 'build', '.next']);

    function walk(d, depth) {
      if (depth > 6 || results.length >= maxFiles) return;
      try {
        for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
          if (SKIP_DIRS.has(ent.name)) continue;
          const full = path.join(d, ent.name);
          if (ent.isDirectory()) {
            walk(full, depth + 1);
          } else if (ent.isFile()) {
            if (globRegex && !globRegex.test(ent.name)) continue;
            try {
              const stat = fs.statSync(full);
              if (stat.size > 512_000) continue; // skip large files
              const content = fs.readFileSync(full, 'utf8');
              const matches = [...content.matchAll(regex)];
              if (matches.length === 0) continue;

              const rel = path.relative(ws, full);
              const entry = {
                file: rel,
                match_count: matches.length,
                preview: matches.slice(0, 3).map(m => ({
                  match: m[0].slice(0, 100),
                  index: m.index,
                })),
              };

              if (!dry_run) {
                const updated = content.replace(regex, replacement);
                fs.writeFileSync(full, updated);
                entry.modified = true;
              }

              results.push(entry);
            } catch { /* skip unreadable */ }
          }
        }
      } catch { /* permission denied */ }
    }

    walk(root, 0);

    const totalMatches = results.reduce((sum, r) => sum + r.match_count, 0);
    log('search_replace', `${dry_run ? 'DRY RUN' : 'APPLIED'}: ${pattern} → ${replacement} in ${dir} (${file_glob || '*'}): ${totalMatches} matches in ${results.length} files`);

    return {
      dry_run,
      pattern,
      replacement,
      files_matched: results.length,
      total_matches: totalMatches,
      results: results.slice(0, 50),
      capped: results.length >= maxFiles,
    };
  },
};

const aci_http_request = {
  name: 'aci_http_request',
  description: 'Make HTTP requests (GET/POST/PUT/DELETE). Blocks requests to internal/private IP addresses for security. Returns { status, headers, body }.',
  category: 'aci',
  parameters: {
    type: 'object',
    properties: {
      method:  { type: 'string', description: 'HTTP method: GET, POST, PUT, DELETE, PATCH.' },
      url:     { type: 'string', description: 'Full URL to request (must be http:// or https://).' },
      headers: { type: 'object', description: 'Optional request headers as key-value pairs.' },
      body:    { type: 'string', description: 'Optional request body (for POST/PUT/PATCH).' },
    },
    required: ['method', 'url'],
  },
  execute: async ({ method, url, headers = {}, body }, ctx) => {
    // Validate method
    const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
    const m = (method || '').toUpperCase();
    if (!ALLOWED_METHODS.includes(m)) {
      return { error: `Invalid HTTP method: ${method}. Allowed: ${ALLOWED_METHODS.join(', ')}` };
    }

    // Validate URL
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return { error: `Invalid URL: ${url}` };
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { error: `Only http/https URLs are allowed. Got: ${parsed.protocol}` };
    }

    // Block private/internal IPs
    if (isPrivateHost(parsed.hostname)) {
      return { error: `Blocked: requests to private/internal addresses (${parsed.hostname}) are not allowed.` };
    }

    log('http_request', `${m} ${url}`);

    const fetchOpts = {
      method: m,
      headers: { 'User-Agent': 'Gavirila-ACI/1.0', ...headers },
      signal: AbortSignal.timeout(30_000),
    };

    if (body && ['POST', 'PUT', 'PATCH'].includes(m)) {
      fetchOpts.body = body;
      if (!headers['Content-Type'] && !headers['content-type']) {
        fetchOpts.headers['Content-Type'] = 'application/json';
      }
    }

    try {
      const resp = await fetch(url, fetchOpts);
      const respHeaders = {};
      resp.headers.forEach((v, k) => { respHeaders[k] = v; });

      let respBody;
      const ct = resp.headers.get('content-type') || '';
      if (ct.includes('json')) {
        try {
          respBody = await resp.json();
        } catch {
          respBody = await resp.text();
        }
      } else {
        respBody = await resp.text();
      }

      // Trim large responses
      if (typeof respBody === 'string' && respBody.length > 50000) {
        respBody = respBody.slice(0, 50000) + '\n... (truncated)';
      }

      return {
        status: resp.status,
        status_text: resp.statusText,
        headers: respHeaders,
        body: respBody,
      };
    } catch (e) {
      return { error: `HTTP request failed: ${e.message}` };
    }
  },
};

// ── Exports ─────────────────────────────────────────────────────────

export const ACI_TOOLS = [
  aci_file_replace_lines,
  aci_run_tests,
  aci_git_safe,
  aci_search_replace,
  aci_http_request,
];

/**
 * Register all ACI tools into an existing tools array (registry).
 * @param {Array} registry - The TOOLS array from registry.js
 */
export function registerAciTools(registry) {
  registry.push(...ACI_TOOLS);
  console.log(`[aci] Registered ${ACI_TOOLS.length} ACI tools: ${ACI_TOOLS.map(t => t.name).join(', ')}`);
}
