import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The snapshot repo lives at apps/backend/data/.snapshots/
const SNAPSHOT_REPO = path.resolve(__dirname, '../../data/.snapshots');
const DATA_DIR = path.resolve(__dirname, '../../data');

let initialized = false;

export function initTimeMachine() {
  if (initialized) return;
  try {
    if (!fs.existsSync(SNAPSHOT_REPO)) {
      fs.mkdirSync(SNAPSHOT_REPO, { recursive: true });
    }
    // Check if already a git repo
    const gitDir = path.join(SNAPSHOT_REPO, '.git');
    if (!fs.existsSync(gitDir)) {
      execSync('git init', { cwd: SNAPSHOT_REPO, stdio: 'pipe' });
      execSync('git config user.email "homestead@local"', { cwd: SNAPSHOT_REPO, stdio: 'pipe' });
      execSync('git config user.name "Gavirila Homestead"', { cwd: SNAPSHOT_REPO, stdio: 'pipe' });
      // Create .gitignore to exclude large/binary files
      fs.writeFileSync(path.join(SNAPSHOT_REPO, '.gitignore'), '*.png\n*.jpg\n*.jpeg\n*.gif\n*.mp3\n*.wav\n');
      console.log('[time-machine] Initialized snapshot repository');
    }
    initialized = true;
  } catch (e) {
    console.error('[time-machine] Init failed:', e.message);
  }
}

export function snapshotState(label = 'task-complete') {
  if (!initialized) initTimeMachine();
  try {
    // Copy gavirila.json into snapshot repo
    const dbSrc = path.join(DATA_DIR, 'gavirila.json');
    const dbDst = path.join(SNAPSHOT_REPO, 'gavirila.json');
    if (fs.existsSync(dbSrc)) fs.copyFileSync(dbSrc, dbDst);

    // Sync vault/ into snapshot repo
    const vaultSrc = path.join(DATA_DIR, 'vault');
    const vaultDst = path.join(SNAPSHOT_REPO, 'vault');
    if (fs.existsSync(vaultSrc)) {
      _syncDir(vaultSrc, vaultDst);
    }

    // Stage and commit
    execSync('git add -A', { cwd: SNAPSHOT_REPO, stdio: 'pipe' });
    // Check if there are staged changes
    const status = execSync('git status --porcelain', { cwd: SNAPSHOT_REPO, stdio: 'pipe' }).toString().trim();
    if (!status) return; // nothing changed, skip commit

    const msg = `${label} — ${new Date().toISOString()}`;
    execSync(`git commit -m "${msg.replace(/"/g, "'")}" --allow-empty-message`, { cwd: SNAPSHOT_REPO, stdio: 'pipe' });
    console.log(`[time-machine] Snapshot: ${msg}`);
  } catch (e) {
    console.error('[time-machine] Snapshot failed:', e.message);
  }
}

function _syncDir(src, dst) {
  if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) {
      _syncDir(s, d);
    } else if (e.name.endsWith('.md') || e.name.endsWith('.json')) {
      fs.copyFileSync(s, d);
    }
  }
}

export function listSnapshots() {
  if (!initialized) initTimeMachine();
  try {
    const log = execSync(
      'git log --oneline -20',
      { cwd: SNAPSHOT_REPO, stdio: 'pipe' }
    ).toString().trim();
    return log.split('\n').filter(Boolean).map(line => {
      const [hash, ...rest] = line.split(' ');
      return { hash, message: rest.join(' ') };
    });
  } catch {
    return [];
  }
}

// stepsBack: how many commits to rewind (default 5 = ~20 min if snapshots are every few min)
export async function restoreState(stepsBack = 5, { markTaskToxic, taskId } = {}) {
  if (!initialized) initTimeMachine();
  const snapshots = listSnapshots();
  if (snapshots.length < stepsBack) {
    throw new Error(`Only ${snapshots.length} snapshots available, cannot go back ${stepsBack}`);
  }

  const targetHash = snapshots[stepsBack - 1]?.hash;
  if (!targetHash) throw new Error('Target snapshot not found');

  console.log(`[time-machine] Restoring to ${targetHash} (${stepsBack} snapshots back)...`);

  // Hard reset the snapshot repo
  execSync(`git reset --hard ${targetHash}`, { cwd: SNAPSHOT_REPO, stdio: 'pipe' });

  // Copy files back to live data dirs
  const dbSrc = path.join(SNAPSHOT_REPO, 'gavirila.json');
  const dbDst = path.join(DATA_DIR, 'gavirila.json');
  if (fs.existsSync(dbSrc)) {
    fs.copyFileSync(dbSrc, dbDst);
    console.log('[time-machine] Restored gavirila.json');
  }

  const vaultSrc = path.join(SNAPSHOT_REPO, 'vault');
  const vaultDst = path.join(DATA_DIR, 'vault');
  if (fs.existsSync(vaultSrc)) {
    _syncDir(vaultSrc, vaultDst);
    console.log('[time-machine] Restored vault/');
  }

  // Mark the offending task as toxic to prevent re-run
  if (taskId) {
    try {
      const { repo } = await import('../db.js');
      const t = repo.byId('tasks', taskId);
      if (t) {
        repo.upsert('tasks', {
          ...t,
          toxic: true,
          status: 'cancelled',
          toxicReason: 'Marked toxic by Time Machine rollback',
        });
      }
    } catch {}
  }

  return { restored: stepsBack, targetHash };
}
