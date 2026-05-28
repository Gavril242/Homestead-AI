// Gavirila Homestead 1.0 — Verifier
// Runs structured acceptance checks and produces evidence bundles.
// Called after a task worker claims completion before status → done.

import { spawnSync } from 'node:child_process';
import { repo } from '../db.js';

const isWin = process.platform === 'win32';

/**
 * Run one shell command and return result.
 */
/**
 * On Windows, strip a leading `sh -c "..."` or `sh -c '...'` wrapper and
 * run the inner command directly via cmd.exe — `sh` is not available on Windows.
 */
function normalizeCmd(cmd) {
  if (!isWin) return cmd;
  // Match: sh -c "inner" or sh -c 'inner'
  const m = cmd.match(/^sh\s+-c\s+(?:"([\s\S]*)"|'([\s\S]*)')$/);
  if (m) return (m[1] ?? m[2]).replace(/\\"/g, '"');
  return cmd;
}

function runCmd(cmd, cwd, timeoutMs = 30_000) {
  const shell = isWin ? 'cmd.exe' : '/bin/bash';
  const flag  = isWin ? '/c' : '-c';
  const normalized = normalizeCmd(cmd);
  const result = spawnSync(shell, [flag, normalized], {
    cwd: cwd || process.cwd(),
    timeout: timeoutMs,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 512 * 1024,
  });
  return {
    cmd,
    stdout: (result.stdout || '').slice(0, 4096),
    stderr: (result.stderr || '').slice(0, 2048),
    exitCode: result.status ?? (result.error ? -1 : 0),
    error: result.error?.message || null,
    passed: (result.status === 0) && !result.error,
  };
}

/**
 * Build an evidence bundle for a task.
 * @param {object} task - Task row from DB
 * @param {string} workspacePath - Path to project workspace
 * @returns {object} evidence bundle
 */
export async function buildEvidenceBundle(task, workspacePath) {
  const acceptance_commands = task.acceptance_commands || [];
  const commandResults = [];

  for (const cmd of acceptance_commands) {
    if (typeof cmd === 'string' && cmd.trim()) {
      commandResults.push(runCmd(cmd, workspacePath));
      }
  }

  const allPassed = commandResults.length === 0
    ? null  // No commands = unverified, not passed
    : commandResults.every(r => r.passed);

  const bundle = {
    id: `ev-${Date.now().toString(36)}`,
    task_id: task.id,
    ts: Date.now(),
    commands: commandResults,
    all_passed: allPassed,
    verified: allPassed === true,
    // If no acceptance commands, mark as unverified but allow human review
    requires_human_review: acceptance_commands.length === 0,
    changed_files: task.artifacts?.filter(a => a.kind === 'file_write').map(a => a.path) || [],
    outcome_summary: task.outcome || '',
    environment: {
      platform: process.platform,
      node: process.version,
      cwd: workspacePath || process.cwd(),
    },
  };

  return bundle;
}

/**
 * Run verification for a task and update its status.
 * @returns {{ bundle, newStatus, task }}
 */
export async function runVerification(taskId, workspacePath) {
  const task = repo.byId('tasks', taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);

  const bundle = await buildEvidenceBundle(task, workspacePath);

  const evidenceBundles = [...(task.evidence_bundles || []), bundle];

  let newStatus;
  if (bundle.verified) {
    newStatus = 'done';
  } else {
    newStatus = 'review';  // No commands or commands failed — needs human
  }

  const updated = repo.patch('tasks', taskId, {
    evidence_bundles: evidenceBundles,
    last_verification: bundle,
    verification_status: bundle.verified ? 'verified' : 'unverified',
    status: newStatus,
    history: [
      ...(task.history || []),
      {
        ts: Date.now(),
        kind: 'verification',
        by: 'verifier',
        note: bundle.verified
          ? `verified: ${bundle.commands.length} commands passed`
          : bundle.requires_human_review
            ? 'no acceptance commands — requires human review'
            : `${bundle.commands.filter(c => !c.passed).length}/${bundle.commands.length} commands failed`,
      },
    ],
    updated_at: Date.now(),
  });

  return { bundle, newStatus, task: updated };
}

export default { buildEvidenceBundle, runVerification };
