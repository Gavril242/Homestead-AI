// Branch-per-task git workflow.
//
// At the start of every task: create branch task/<id>, snapshot HEAD ref.
// On PASS audit: merge to main. On FAIL: leave branch for inspection.
// On hard failure / cancel: discard the branch.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

function ws(projectId) {
  return path.join(process.env.WORKSPACES_ROOT || path.join(os.homedir(), 'gavirila-workspaces'), projectId);
}
function git(cwd, args) {
  return spawnSync('git', args, {
    cwd, encoding: 'utf8', timeout: 15_000,
    env: { ...process.env, GIT_AUTHOR_NAME: 'Gavirila', GIT_AUTHOR_EMAIL: 'gavirila@homestead', GIT_COMMITTER_NAME: 'Gavirila', GIT_COMMITTER_EMAIL: 'gavirila@homestead' },
  });
}

function ensureRepoAndMain(cwd) {
  if (!fs.existsSync(path.join(cwd, '.git'))) git(cwd, ['init']);
  // Ensure at least one commit on main
  const log = git(cwd, ['log', '--oneline', '-1']);
  if (log.status !== 0) {
    git(cwd, ['add', '-A']);
    git(cwd, ['commit', '--allow-empty', '-m', 'initial']);
  }
  // Ensure main exists and we're on it
  const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  if (branch !== 'main' && branch !== 'master') {
    git(cwd, ['branch', '-M', 'main']);
  }
}

export function startTaskBranch({ projectId, taskId }) {
  const cwd = ws(projectId);
  if (!fs.existsSync(cwd)) return { ok: false, error: 'workspace missing' };
  ensureRepoAndMain(cwd);
  const branch = `task/${taskId}`;
  const baseSha = git(cwd, ['rev-parse', 'HEAD']).stdout.trim();
  // Create-or-checkout the branch
  const exists = git(cwd, ['rev-parse', '--verify', branch]);
  if (exists.status === 0) git(cwd, ['checkout', branch]);
  else git(cwd, ['checkout', '-b', branch]);
  return { ok: true, branch, baseSha };
}

export function finishTaskBranch({ projectId, taskId, verdict }) {
  const cwd = ws(projectId);
  if (!fs.existsSync(path.join(cwd, '.git'))) return { ok: false, error: 'no repo' };
  const branch = `task/${taskId}`;

  // Stage anything left + autocommit
  git(cwd, ['add', '-A']);
  const status = git(cwd, ['status', '--porcelain']);
  if (status.stdout.trim()) git(cwd, ['commit', '-m', `task ${taskId} — autosave`]);

  if (verdict === 'pass' || verdict === 'merge') {
    // Switch to main and merge the branch
    git(cwd, ['checkout', 'main']);
    const merge = git(cwd, ['merge', '--no-ff', '-m', `merge task ${taskId} (verdict=${verdict || 'pass'})`, branch]);
    if (merge.status === 0) {
      git(cwd, ['branch', '-D', branch]);
      return { ok: true, merged: true, mainSha: git(cwd, ['rev-parse', 'HEAD']).stdout.trim() };
    }
    // Conflict — leave on main with the merge in flight
    return { ok: false, merged: false, error: merge.stderr || merge.stdout };
  }
  // Fail / cancel — leave branch for inspection, return to main
  git(cwd, ['checkout', 'main']);
  return { ok: true, merged: false, branch_kept: branch };
}

export function getBranchDiff({ projectId, taskId, max = 60_000 }) {
  const cwd = ws(projectId);
  if (!fs.existsSync(path.join(cwd, '.git'))) return { error: 'no repo' };
  const branch = `task/${taskId}`;
  const exists = git(cwd, ['rev-parse', '--verify', branch]);
  if (exists.status !== 0) {
    // Maybe already merged — diff main against its parent
    const merged = git(cwd, ['log', '--oneline', '--all', '--grep', `task ${taskId}`, '-1']);
    if (!merged.stdout.trim()) return { error: 'branch not found' };
  }
  const stat = git(cwd, ['diff', '--stat', `main...${branch}`]);
  const patch = git(cwd, ['diff', `main...${branch}`]);
  return {
    branch,
    stat: (stat.stdout || '').slice(0, 4000),
    diff: (patch.stdout || '').slice(0, max),
  };
}
