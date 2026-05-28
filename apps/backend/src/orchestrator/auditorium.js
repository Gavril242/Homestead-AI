// The Auditorium — independent Gemma 4 jury that audits work.
//
// When a task hits "review" with substantive artifacts, we don't just trust
// the agent's own claim. We fire N Gemma 4 jurors in parallel to read the
// artifacts + acceptance criteria and vote PASS / FAIL / UNSURE. The
// majority verdict drives the next move:
//
//   • PASS   → promote the task to "done", trigger auto-propagation.
//   • FAIL   → demote to "needs-human" with the failure reasons attached.
//   • UNSURE → leave at "review" so the human takes a look.
//
// Why Gemma 4 specifically:
//   • Massive RPD/TPM headroom — we can run 3-5 jurors per audit cheaply.
//   • Doesn't need tools (it just reads the ticket and judges).
//   • A separate model class from the worker agents — independent failure
//     modes, so it catches what the worker hallucinates.
//
// The juror's verdict + reason is logged on the task as a `verdict` artifact,
// visible in the live timeline so the human always sees why.

import { chat } from '../llm/index.js';
import { repo } from '../db.js';
import { writeNote, readNote } from '../brain/vault.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const JURY_SIZE = 3;        // odd number for tiebreaks
const JURY_TIMEOUT_MS = 45_000;

const VERDICT_TOOL_NAME = 'auditorium_verdict';   // shows up in timeline as a tool call

/** Audit a task that hit "review". Returns { verdict, votes, reasons }. */
export async function auditTask(task, broadcast) {
  const acceptance = task.acceptance || [];
  const artifacts = task.artifacts || [];

  // No acceptance criteria → there's nothing to judge against. Mark as
  // "no-criteria" so the runner knows to leave it for human review (rather
  // than auto-promoting blind).
  if (!acceptance.length) {
    return { verdict: 'no-criteria', votes: [], reasons: ['no acceptance criteria defined for this task'] };
  }

  // Substantive artifact gate — if the agent didn't actually do anything,
  // we don't even bother juring. Cheaper to short-circuit.
  const SUBSTANTIVE = ['fs_write_file', 'shell_exec', 'shell_bg', 'python_run', 'vault_write_note', 'git_commit', 'web_build_and_smoke', 'npm_test', 'python_test', 'browser_open', 'browser_screenshot'];
  const meaningful = artifacts.filter((a) => SUBSTANTIVE.includes(a.tool) && a.ok !== false);
  if (meaningful.length === 0) {
    return {
      verdict: 'fail', votes: [], reasons: ['no substantive artifacts — nothing to verify'],
      shortcircuit: true,
    };
  }

  // Build the juror prompt. Every juror sees the same context but they vote
  // independently — different sampling temperature → some independence.
  const prompt = buildJurorPrompt(task);
  const system = `You are an Auditor for the Gavirila workbench. You are independent
and skeptical. Your only job is to judge whether a task's reported work
genuinely satisfies its acceptance criteria. Never call tools. Never write
prose beyond the required single line. Be honest — if you can't tell, say UNSURE.`;

  // Mixed-model jury: 1 Gemma 4, 1 Flash Lite, 1 Pro/Flash. Different
  // model families have different blind spots — diversity catches more.
  const purposes = ['classify', 'summarize', 'plan'];
  const calls = await Promise.all(
    Array.from({ length: JURY_SIZE }, (_, i) =>
      runOneJuror({ prompt, system, idx: i, broadcast, taskId: task.id, projectId: task.project_id, purpose: purposes[i % purposes.length] }),
    ),
  );

  const votes = calls.map((r, i) => ({ juror: i + 1, ...parseVote(r.reply) }));
  const counts = votes.reduce((acc, v) => { acc[v.verdict] = (acc[v.verdict] || 0) + 1; return acc; }, {});
  const passCount = counts.pass || 0;
  const failCount = counts.fail || 0;

  let verdict;
  if (passCount > JURY_SIZE / 2) verdict = 'pass';
  else if (failCount > JURY_SIZE / 2) verdict = 'fail';
  else verdict = 'unsure';

  const reasons = votes.map((v) => `[J${v.juror} ${v.verdict.toUpperCase()} ${v.confidence.toFixed(2)}] ${v.reason}`);

  return { verdict, votes, reasons, jury_size: JURY_SIZE };
}

async function runOneJuror({ prompt, system, idx, broadcast, taskId, projectId, purpose = 'classify' }) {
  try {
    const result = await Promise.race([
      chat({
        messages: [{ role: 'user', content: prompt }],
        system,
        agent: `auditorium-${idx + 1}`,
        purpose,
        toolScopes: [],
        toolCtx: { repo, broadcast, agentId: `juror-${idx + 1}`, projectId, taskId },
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('juror timeout')), JURY_TIMEOUT_MS)),
    ]);
    return result;
  } catch (err) {
    return { reply: `UNSURE|0|juror error: ${err.message}` };
  }
}

/**
 * Smoke audit — quick mid-task check after a few rounds. Doesn't transition
 * the task; just emits an advisory artifact so the agent (and human) can
 * see if it's drifting off-course.
 */
export async function smokeAudit(task, broadcast) {
  if (!(task.acceptance || []).length) return null;
  if ((task.artifacts || []).length < 2) return null;
  const prompt = buildJurorPrompt(task);
  const r = await runOneJuror({
    prompt, system: 'You are a smoke auditor. Quick check, single line verdict.',
    idx: 99, broadcast, taskId: task.id, projectId: task.project_id, purpose: 'classify',
  });
  const v = parseVote(r.reply);
  const artifact = {
    ts: Date.now(), by: 'auditorium-smoke', tool: 'smoke_audit',
    summary: `🔍 smoke audit ${v.verdict.toUpperCase()} (${v.confidence.toFixed(2)}) — ${v.reason.slice(0, 100)}`,
    ok: v.verdict !== 'fail',
    audit: { verdict: v.verdict, reason: v.reason },
  };
  const updated = repo.patch('tasks', task.id, {
    artifacts: [...(task.artifacts || []), artifact],
  });
  broadcast?.({ kind: 'task:artifact', taskId: task.id, artifact });
  return v;
}

function buildJurorPrompt(task) {
  const acceptance = task.acceptance || [];
  const artifactLines = (task.artifacts || []).slice(-25).map((a) => `  ${a.summary}`).join('\n') || '  (none)';
  const outcome = (task.outcome || '').slice(0, 1500);
  const lastReply = (task.messages || []).slice(-1)[0]?.text?.slice(0, 800) || '';

  // Pull the actual content of artifacts the agent produced so the jury
  // can verify substance, not just the existence of an action. This is the
  // anti-hallucination guardrail.
  const evidence = collectEvidence(task);

  return `
TASK UNDER AUDIT
  id: ${task.id}
  title: ${task.title}
  assigned: ${task.by}
  status: ${task.status}
  description: ${task.desc || '(no desc)'}

ACCEPTANCE CRITERIA (each MUST be met):
${acceptance.map((a, i) => `  ${i + 1}. ${a}`).join('\n')}

EVIDENCE — chronological tool calls:
${artifactLines}

EVIDENCE — actual content of artifacts (so you can verify, not just trust):
${evidence || '  (no readable evidence)'}

AGENT'S OWN OUTCOME SUMMARY:
${outcome || '(none)'}

${lastReply ? `AGENT'S LAST MESSAGE:\n${lastReply}\n` : ''}

YOUR DECISION
  PASS   = every acceptance criterion is clearly demonstrated by the evidence
  FAIL   = at least one criterion is not met, OR the agent is claiming
           something without supporting evidence in the artifacts
  UNSURE = you genuinely cannot tell from what's shown

REPLY FORMAT — exactly one line, nothing else:
  VERDICT|CONFIDENCE|REASON

  VERDICT      one of: PASS, FAIL, UNSURE
  CONFIDENCE   number 0.0 - 1.0
  REASON       one sentence (no pipes)

Example replies:
  PASS|0.92|all three criteria visible: file written, server hit returns 200, JSON has 3 products
  FAIL|0.85|criterion 2 (test coverage >80%) is not demonstrated — no test run artifact present
  UNSURE|0.4|artifacts mention products but no actual server hit captured`.trim();
}

// Pull actual content from artifact targets so the jury can verify substance,
// not just claims. We read up to ~6KB total, prioritizing the most recent
// substantive artifacts.
function collectEvidence(task) {
  const lines = [];
  let remaining = 6000;
  const ws = path.join(os.homedir(), 'gavirila-workspaces', task.project_id || '');
  for (const a of [...(task.artifacts || [])].reverse()) {
    if (remaining <= 0) break;
    try {
      if (a.tool === 'fs_write_file' && a.args?.path) {
        const full = path.join(ws, a.args.path);
        if (fs.existsSync(full)) {
          const txt = fs.readFileSync(full, 'utf8').slice(0, Math.min(remaining, 1500));
          lines.push(`── file: ${a.args.path} ──\n${txt}`);
          remaining -= txt.length + 30;
        }
      } else if (a.tool === 'vault_write_note' && a.args?.path) {
        const candidates = [
          a.args.path,
          `projects/${task.project_id}/${a.args.path}`,
          a.args.path.replace(/^projects\/[^/]+\//, ''),
        ];
        let note = null;
        for (const c of candidates) {
          note = safeReadNote(c);
          if (note?.body) break;
        }
        if (note?.body) {
          const body = note.body.slice(0, Math.min(remaining, 1500));
          lines.push(`── vault: ${a.args.path} ──\n${body}`);
          remaining -= body.length + 30;
        }
      } else if (a.tool === 'shell_exec' && a.args?.cmd) {
        // shell results aren't replayable; the artifact summary already
        // captured stdout tail. Just include the summary verbatim.
        lines.push(`── shell: ${a.args.cmd} ──\n${a.summary}`);
      } else if (a.tool === 'browser_open' && a.args?.url) {
        lines.push(`── browser hit: ${a.args.url} → ${a.summary}`);
      }
    } catch { /* tolerate any single-artifact read failure */ }
  }
  return lines.slice(0, 5).join('\n\n');
}

function safeReadNote(notePath) {
  try { return readNote(notePath); }
  catch { return null; }
}

// Tolerant parser. Gemma 4 frequently preambles; we look for the verdict
// anywhere in the reply. We try the strict pipe-format first (preferred,
// because Gemini and Pro respect it), then fall back to keyword scanning.
function parseVote(reply) {
  const text = (reply || '').trim();
  if (!text) return { verdict: 'unsure', confidence: 0, reason: 'empty reply' };

  // 1. Strict pipe format anywhere in the reply
  const pipeMatch = text.match(/(PASS|FAIL|UNSURE)\s*\|\s*([\d.]+)\s*\|\s*(.+?)(?:\n|$)/i);
  if (pipeMatch) {
    return {
      verdict: pipeMatch[1].toLowerCase(),
      confidence: Math.min(1, Math.max(0, Number(pipeMatch[2]) || 0)),
      reason: pipeMatch[3].trim().slice(0, 240),
    };
  }

  // 2. Keyword scan — find the LAST occurrence of PASS/FAIL/UNSURE.
  // Gemma typically reasons-then-concludes, so the last vote is the real one.
  const upper = text.toUpperCase();
  const lastPass = upper.lastIndexOf('PASS');
  const lastFail = upper.lastIndexOf('FAIL');
  const lastUnsure = upper.lastIndexOf('UNSURE');
  const winner = [['pass', lastPass], ['fail', lastFail], ['unsure', lastUnsure]]
    .filter(([_, idx]) => idx >= 0)
    .sort((a, b) => b[1] - a[1])[0];
  if (!winner) return { verdict: 'unsure', confidence: 0.2, reason: `no verdict keyword in: "${text.slice(0, 100)}"` };

  // Use the last sentence as the reason
  const lastSentences = text.split(/[.\n]/).map((s) => s.trim()).filter(Boolean).slice(-3).join(' ');
  return {
    verdict: winner[0],
    confidence: 0.5,           // lower confidence since format was loose
    reason: lastSentences.slice(0, 240),
  };
}

/**
 * Apply an audit verdict to a task: transition status, write a verdict
 * artifact, and emit broadcasts. Called by the task-runner after the
 * agent finishes.
 */
export function applyVerdict(task, audit, broadcast) {
  const { verdict, votes, reasons, shortcircuit } = audit;

  // Record the verdict as a synthetic artifact so it lands in the live timeline.
  const artifact = {
    ts: Date.now(),
    by: 'auditorium',
    tool: VERDICT_TOOL_NAME,
    summary: shortcircuit
      ? `🛡 auditorium short-circuit ${verdict.toUpperCase()} — ${reasons[0] || ''}`
      : `🛡 auditorium ${verdict.toUpperCase()} (${votes.filter((v) => v.verdict === 'pass').length}P / ${votes.filter((v) => v.verdict === 'fail').length}F / ${votes.filter((v) => v.verdict === 'unsure').length}U)`,
    ok: verdict !== 'fail',
    audit: { verdict, votes, reasons },
  };
  const artifacts = [...(task.artifacts || []), artifact];

  let nextStatus = task.status;
  let historyNote = '';
  if (verdict === 'pass') {
    nextStatus = 'done';
    historyNote = 'auditorium: PASS — promoted to done';
  } else if (verdict === 'fail') {
    nextStatus = 'needs-human';
    historyNote = `auditorium: FAIL — ${reasons.join(' · ').slice(0, 200)}`;
  } else if (verdict === 'no-criteria') {
    // Leave at review; just record that no audit happened
    historyNote = 'auditorium: skipped — no acceptance criteria';
  } else {
    // unsure → keep at review for human eyes
    historyNote = `auditorium: UNSURE (${votes.length} jurors split) — left at review for human`;
  }

  const updated = repo.patch('tasks', task.id, {
    status: nextStatus,
    artifacts,
    audit: { verdict, jury_size: votes.length, reasons, ts: Date.now() },
    history: [...(task.history || []), { ts: Date.now(), kind: 'audited', by: 'auditorium', note: historyNote }],
  });

  broadcast?.({ kind: 'task:artifact', taskId: task.id, artifact });
  broadcast?.({ kind: 'task:update', task: updated });

  // Persist the audit to the vault for traceability — useful for the
  // Records page and for later root-cause analysis.
  if (!shortcircuit && votes.length > 0) {
    try {
      writeNote(`projects/${task.project_id}/audits/${task.id}-${Date.now()}.md`, {
        frontmatter: {
          id: `audit-${task.id}-${Date.now()}`,
          title: `Audit: ${task.title}`,
          kind: 'audit',
          project: task.project_id,
          task: task.id,
          verdict,
          ts: new Date().toISOString(),
        },
        body: `# Audit of ${task.id} — ${task.title}\n\n**Verdict: ${verdict.toUpperCase()}**\n\n## Jury votes\n\n${reasons.map((r) => `- ${r}`).join('\n')}\n\n## Acceptance criteria\n\n${(task.acceptance || []).map((a) => `- ${a}`).join('\n')}\n\n## Artifacts at audit time\n\n${(task.artifacts || []).map((a) => `- ${a.summary}`).join('\n')}\n`,
      });
    } catch (err) {
      console.warn('[auditorium] vault write failed:', err.message);
    }
  }

  return updated;
}
