/**
 * Chaos UI Swarm — spawns 5 adversarial Playwright agents for 60 seconds
 * each trying to break the frontend. If any throw console errors, they file
 * bug reports in the vault.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { repo } from '../db.js';
import { vaultRoot, ensureVault } from '../brain/vault.js';

const SWARM_SIZE = 5;
const SWARM_DURATION_MS = 60_000;
const _swarmAudited = new Set(); // taskId → don't double-fire

export { _swarmAudited };

// Determine if a task should trigger a swarm audit
export function shouldRunSwarm(task) {
  if (_swarmAudited.has(task.id)) return false;
  if (task.status !== 'done') return false;
  const UI_AGENTS = new Set(['forge', 'vince', 'william']);
  if (!UI_AGENTS.has(task.by)) return false;
  const desc = (task.desc || task.title || '').toLowerCase();
  const explicitSignals = ['[swarm]', '[ui-chaos]', 'run chaos swarm'];
  return task.enableSwarm === true || explicitSignals.some((signal) => desc.includes(signal));
}

// Main entry point — fire-and-forget safe
export async function runChaosSwarm(task, { projectUrl, broadcast } = {}) {
  if (!task?.id) return;
  _swarmAudited.add(task.id);

  const project = repo.byId('projects', task.project_id);
  const url = projectUrl || project?.localUrl || process.env.HOMESTEAD_URL || 'http://localhost:8765';

  console.log(`[ui-swarm] Starting ${SWARM_SIZE}-agent chaos swarm for task ${task.id} at ${url}`);
  broadcast?.({ kind: 'swarm:start', taskId: task.id, projectId: task.project_id, swarmSize: SWARM_SIZE });

  const agentResults = await Promise.allSettled(
    Array.from({ length: SWARM_SIZE }, (_, i) => runChaosAgent(i, url, task))
  );

  const allErrors = [];
  const allScreenshots = [];

  for (const result of agentResults) {
    if (result.status === 'fulfilled') {
      allErrors.push(...result.value.errors);
      if (result.value.screenshotPath) allScreenshots.push(result.value.screenshotPath);
    } else {
      console.warn('[ui-swarm] Agent crashed:', result.reason?.message);
    }
  }

  const uniqueErrors = [...new Map(allErrors.map(e => [e.message, e])).values()];
  console.log(`[ui-swarm] Swarm complete. Unique errors: ${uniqueErrors.length}`);

  if (uniqueErrors.length > 0) {
    await fileBugReport(task, uniqueErrors, allScreenshots, broadcast);
  } else {
    broadcast?.({ kind: 'swarm:clear', taskId: task.id, projectId: task.project_id, message: 'UI passed chaos swarm — no errors found' });
    console.log(`[ui-swarm] ✓ Task ${task.id} UI is bulletproof`);
  }
}

async function runChaosAgent(agentIndex, baseUrl, task) {
  const errors = [];
  let screenshotPath = null;
  let browser;

  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    // Capture all console errors
    page.on('console', msg => {
      if (msg.type() === 'error') {
        errors.push({ message: msg.text(), type: 'console-error', source: msg.location()?.url || '' });
      }
    });
    page.on('pageerror', err => {
      errors.push({ message: err.message, type: 'page-error', stack: err.stack?.slice(0, 500) });
    });
    page.on('requestfailed', req => {
      errors.push({ message: `Network: ${req.method()} ${req.url()} → ${req.failure()?.errorText}`, type: 'network-error' });
    });

    await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});

    const deadline = Date.now() + SWARM_DURATION_MS;

    // Chaos actions
    const CHAOS_ACTIONS = [
      // Click random elements
      async () => {
        const els = await page.$$('button, a, input, select, [role="button"], [tabindex]');
        if (els.length) await els[Math.floor(Math.random() * els.length)].click({ force: true }).catch(() => {});
      },
      // Type garbage into inputs
      async () => {
        const inputs = await page.$$('input[type="text"], input:not([type]), textarea');
        if (inputs.length) {
          const inp = inputs[Math.floor(Math.random() * inputs.length)];
          const CHAOS_STRINGS = ['😈💀🔥', '<script>alert(1)</script>', 'A'.repeat(500), '"><img src=x onerror=alert(1)>', '\x00\x01\x02', '   ', '9'.repeat(100)];
          await inp.fill(CHAOS_STRINGS[Math.floor(Math.random() * CHAOS_STRINGS.length)]).catch(() => {});
        }
      },
      // Submit forms
      async () => {
        const forms = await page.$$('form');
        if (forms.length) await forms[Math.floor(Math.random() * forms.length)].evaluate(f => f.submit()).catch(() => {});
      },
      // Resize viewport randomly
      async () => {
        const w = 320 + Math.floor(Math.random() * 1400);
        const h = 480 + Math.floor(Math.random() * 600);
        await page.setViewportSize({ width: w, height: h }).catch(() => {});
      },
      // Rapid double-click
      async () => {
        const pos = { x: 100 + Math.random() * 700, y: 100 + Math.random() * 400 };
        await page.mouse.dblclick(pos.x, pos.y).catch(() => {});
      },
      // Scroll aggressively
      async () => {
        await page.evaluate(() => window.scrollTo(0, Math.random() * document.body.scrollHeight)).catch(() => {});
      },
      // Press keyboard shortcuts
      async () => {
        const keys = ['Escape', 'Enter', 'Delete', 'Backspace', 'Tab', 'F5'];
        await page.keyboard.press(keys[Math.floor(Math.random() * keys.length)]).catch(() => {});
      },
    ];

    let actionCount = 0;
    while (Date.now() < deadline) {
      const action = CHAOS_ACTIONS[Math.floor(Math.random() * CHAOS_ACTIONS.length)];
      await action();
      actionCount++;
      await page.waitForTimeout(200 + Math.random() * 300);
    }

    console.log(`[ui-swarm] Agent ${agentIndex} completed ${actionCount} actions, ${errors.length} errors`);

    // Take screenshot if errors found
    if (errors.length > 0) {
      const os = await import('node:os');
      screenshotPath = path.join(os.default.tmpdir(), `swarm-agent${agentIndex}-${task.id}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => { screenshotPath = null; });
    }
  } catch (e) {
    errors.push({ message: `Agent ${agentIndex} crash: ${e.message}`, type: 'agent-crash' });
  } finally {
    await browser?.close().catch(() => {});
  }

  return { errors, screenshotPath };
}

async function fileBugReport(task, errors, screenshotPaths, broadcast) {
  const pid = task.project_id;
  const bugId = `B-SWARM-${task.id}-${Date.now()}`;
  const ts = new Date().toISOString();

  const errorList = errors.slice(0, 20).map(e =>
    `- **[${e.type}]** \`${e.message.slice(0, 200)}\`${e.stack ? '\n  ```\n  ' + e.stack.slice(0, 300) + '\n  ```' : ''}`
  ).join('\n');

  const content = `---
id: ${bugId}
kind: bug
project: ${pid}
task: ${task.id}
severity: high
status: open
source: chaos-swarm
created-at: "${ts}"
screenshots: ${JSON.stringify(screenshotPaths)}
---
# Chaos Swarm Bug Report — Task ${task.id}

Detected by UI chaos swarm (${SWARM_SIZE} adversarial agents, ${SWARM_DURATION_MS / 1000}s each).

## Errors (${errors.length} total, ${Math.min(errors.length, 20)} shown)

${errorList}

## Task Reference
Agent: ${task.by} | Task: "${(task.title || task.desc || '').slice(0, 100)}"
`;

  // Write vault note directly (content already contains raw frontmatter)
  try {
    ensureVault();
    const notePath = path.join(vaultRoot(), `projects/${pid}/bugs/${bugId}.md`);
    fs.mkdirSync(path.dirname(notePath), { recursive: true });
    fs.writeFileSync(notePath, content);
  } catch (err) {
    console.warn(`[ui-swarm] vault write failed: ${err.message}`);
  }

  // Also create a DB bug record
  try {
    const bug = {
      id: bugId,
      project_id: pid,
      task_id: task.id,
      title: `Chaos swarm found ${errors.length} UI error(s) after task ${task.id}`,
      desc: errorList,
      severity: 'high',
      status: 'open',
      source: 'chaos-swarm',
      screenshots: screenshotPaths,
      created_at: ts,
    };
    repo.upsert('bugs', bug);
  } catch (err) {
    console.warn(`[ui-swarm] db bug record failed: ${err.message}`);
  }

  broadcast?.({ kind: 'swarm:bug', taskId: task.id, projectId: pid, bugId, errorCount: errors.length });
  console.log(`[ui-swarm] ⚠ Filed bug ${bugId} — ${errors.length} UI errors`);
}
