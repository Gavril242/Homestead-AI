// Atlassian Doc Engine — pushes living documentation from Homestead vault → Confluence.
//
// Runs in two modes:
//   Manual:    POST /api/projects/:id/atlassian/push-docs
//   Scheduled: auto-started when a project with enabled=true boots, every 15min
//
// Pages managed per project:
//   <Name> — Overview          current task state, description, health
//   <Name> — Architecture      from vault projects/<id>/architecture.md
//   <Name> — Test Results      from test tasks + vault test notes
//   <Name> — Reports & Metrics task velocity, bug counts
//   <Name> — Changelog         completed tasks + system events
//
// Jira → Vault sync is handled by atlassian-etl.js (bulkSyncJiraProject)
// Vault → Confluence sync is handled here.
//
// Conductor context:
//   getAtlassianSummary(project) → markdown string for conductor prompt injection

import { readNote } from '../brain/vault.js';
import { repo } from '../db.js';

// ── shared auth ──────────────────────────────────────────────────────

function confluenceAuth() {
  const email = process.env.JIRA_EMAIL;
  const token = process.env.CONFLUENCE_TOKEN || process.env.JIRA_TOKEN;
  if (!email || !token) throw new Error('JIRA_EMAIL and CONFLUENCE_TOKEN must be set in .env');
  return 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
}

function confluenceBase() {
  const base = process.env.CONFLUENCE_BASE_URL || process.env.JIRA_BASE_URL;
  if (!base) throw new Error('CONFLUENCE_BASE_URL not set');
  return base.endsWith('/wiki') ? base : `${base}/wiki`;
}

async function confluenceFetch(path, opts = {}) {
  const url = `${confluenceBase()}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: confluenceAuth(),
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text().catch(() => '');
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json };
}

// ── Confluence page upsert ───────────────────────────────────────────

export async function upsertConfluencePage(spaceKey, title, htmlContent) {
  // Find existing page by title + space
  const { status: findStatus, json: findResult } = await confluenceFetch(
    `/rest/api/content?spaceKey=${encodeURIComponent(spaceKey)}&title=${encodeURIComponent(title)}&expand=version,ancestors`
  );

  const existing = findStatus === 200 ? (findResult?.results?.[0] ?? null) : null;

  if (existing) {
    const newVersion = (existing.version?.number ?? 1) + 1;
    const { status, json } = await confluenceFetch(`/rest/api/content/${existing.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        id: existing.id,
        type: 'page',
        title,
        space: { key: spaceKey },
        body: { storage: { value: htmlContent, representation: 'storage' } },
        version: { number: newVersion },
      }),
    });
    return { ok: status === 200, id: json?.id, updated: true, url: json?._links?.webui };
  }

  // Create new page
  const { status, json } = await confluenceFetch('/rest/api/content', {
    method: 'POST',
    body: JSON.stringify({
      type: 'page',
      title,
      space: { key: spaceKey },
      body: { storage: { value: htmlContent, representation: 'storage' } },
    }),
  });
  return { ok: status === 200 || status === 201, id: json?.id, created: true, url: json?._links?.webui };
}

// ── Markdown → Confluence storage HTML ──────────────────────────────
// Handles headings, bold, inline code, bullets, code blocks.
// Does NOT require turndown — pure string processing.

function mdToHtml(md) {
  if (!md) return '';
  const lines = md.split('\n');
  const out = [];
  let inCode = false;
  let codeLang = '';
  let codeLines = [];
  let inList = false;

  const flushList = () => {
    if (inList) { out.push('</ul>'); inList = false; }
  };

  for (const raw of lines) {
    // Code block fence
    if (raw.startsWith('```')) {
      if (!inCode) {
        flushList();
        inCode = true;
        codeLang = raw.slice(3).trim();
        codeLines = [];
      } else {
        const lang = codeLang ? ` class="language-${codeLang}"` : '';
        out.push(`<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">${codeLang || 'text'}</ac:parameter><ac:plain-text-body><![CDATA[${codeLines.join('\n')}]]></ac:plain-text-body></ac:structured-macro>`);
        inCode = false;
      }
      continue;
    }

    if (inCode) {
      codeLines.push(raw);
      continue;
    }

    // Headings
    const h3 = raw.match(/^### (.+)/);
    const h2 = raw.match(/^## (.+)/);
    const h1 = raw.match(/^# (.+)/);
    if (h3) { flushList(); out.push(`<h3>${inline(h3[1])}</h3>`); continue; }
    if (h2) { flushList(); out.push(`<h2>${inline(h2[1])}</h2>`); continue; }
    if (h1) { flushList(); out.push(`<h1>${inline(h1[1])}</h1>`); continue; }

    // List items
    const li = raw.match(/^[-*] (.+)/);
    if (li) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(li[1])}</li>`);
      continue;
    }

    flushList();

    // Blank line → paragraph break
    if (!raw.trim()) {
      out.push('');
      continue;
    }

    out.push(`<p>${inline(raw)}</p>`);
  }

  flushList();
  return out.filter((line, i, arr) => !(line === '' && arr[i - 1] === '')).join('\n');
}

function inline(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

// ── Content generators ───────────────────────────────────────────────

function statusBadge(status) {
  const colors = {
    done: '#00875a', completed: '#00875a',
    running: '#0052cc', 'in-progress': '#0052cc', active: '#0052cc',
    queued: '#42526e', pending: '#42526e',
    failed: '#de350b', error: '#de350b',
  };
  const s = (status || 'unknown').toLowerCase();
  const color = colors[s] || '#42526e';
  return `<ac:structured-macro ac:name="status"><ac:parameter ac:name="colour">${color}</ac:parameter><ac:parameter ac:name="title">${s.toUpperCase()}</ac:parameter></ac:structured-macro>`;
}

function tableRow(...cells) {
  return `<tr>${cells.map(c => `<td>${c}</td>`).join('')}</tr>`;
}

function tableHeaderRow(...cells) {
  return `<tr>${cells.map(c => `<th>${c}</th>`).join('')}</tr>`;
}

export async function generateOverviewContent(project) {
  const allTasks = repo.list('tasks').filter(t => t.project_id === project.id);
  const done = allTasks.filter(t => ['done', 'completed'].includes((t.status || '').toLowerCase()));
  const inProgress = allTasks.filter(t => ['running', 'in-progress', 'active'].includes((t.status || '').toLowerCase()));
  const queued = allTasks.filter(t => ['queued', 'pending', 'new'].includes((t.status || '').toLowerCase()));

  const jiraKey = project.integrations?.atlassian?.jiraProjectKey || '';
  const spaceKey = project.integrations?.atlassian?.confluenceSpaceKey || '';
  const lastSync = project.integrations?.atlassian?.lastDocSync
    ? new Date(project.integrations.atlassian.lastDocSync).toLocaleString()
    : 'Never';
  const jiraUrl = jiraKey
    ? `<a href="${process.env.JIRA_BASE_URL}/jira/software/projects/${jiraKey}/boards">Jira Board</a>`
    : 'Not linked';

  const total = allTasks.length;
  const pct = total > 0 ? Math.round((done.length / total) * 100) : 0;

  return `
<h1>${project.name} — Overview</h1>
<p><em>Auto-generated by Homestead Documentation Engine. Last synced: ${new Date().toLocaleString()}</em></p>

<h2>Health Dashboard</h2>
<table>
  <tbody>
    ${tableHeaderRow('Metric', 'Value')}
    ${tableRow('Status', statusBadge('active'))}
    ${tableRow('Tasks Done', `<strong>${done.length}</strong> / ${total} (${pct}%)`)}
    ${tableRow('In Progress', String(inProgress.length))}
    ${tableRow('Queued', String(queued.length))}
    ${tableRow('Jira Project', jiraUrl)}
    ${tableRow('Confluence Space', spaceKey || '—')}
    ${tableRow('Last Doc Sync', lastSync)}
  </tbody>
</table>

<h2>Description</h2>
<p>${inline(project.description || project.sub || 'No description provided.')}</p>

<h2>Active Work</h2>
${inProgress.length
    ? `<table><tbody>${tableHeaderRow('Task', 'Agent', 'Status')}${inProgress.slice(0, 15).map(t => tableRow(inline(t.title || ''), t.by || '—', statusBadge(t.status))).join('')}</tbody></table>`
    : '<p>No tasks currently in progress.</p>'}

<h2>Recently Completed</h2>
${done.length
    ? `<ul>${done.slice().sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0)).slice(0, 15).map(t => `<li>${inline(t.title || '')}</li>`).join('')}</ul>`
    : '<p>No completed tasks yet.</p>'}
`.trim();
}

export async function generateArchitectureContent(project) {
  const note = readNote(`projects/${project.id}/architecture.md`);
  const body = note?.body || '';

  return `
<h1>${project.name} — Architecture</h1>
<p><em>Synced from Homestead Vault on ${new Date().toLocaleString()}</em></p>
${body ? mdToHtml(body) : '<p>Architecture not yet documented. Assign a goal to the <strong>delphi</strong> agent to generate the architecture document.</p>'}
`.trim();
}

export async function generateTestingContent(project) {
  const allTasks = repo.list('tasks').filter(t => t.project_id === project.id);
  const testTasks = allTasks.filter(t =>
    t.tag === 'test' ||
    t.by === 'vince' ||
    (t.title || '').toLowerCase().includes('test') ||
    (t.title || '').toLowerCase().includes('spec') ||
    (t.title || '').toLowerCase().includes('bug')
  );

  const passed = testTasks.filter(t => ['done', 'completed'].includes((t.status || '').toLowerCase()));
  const failed = testTasks.filter(t => (t.status || '').toLowerCase() === 'failed');
  const running = testTasks.filter(t => ['running', 'in-progress'].includes((t.status || '').toLowerCase()));

  // Read vault test notes if any
  const reqs = repo.list('reqs').filter(r => r.project_id === project.id);
  const bugs = reqs.filter(r => (r.source === 'jira' && (r.priority === 'high' || (r.title || '').toLowerCase().includes('bug'))));

  return `
<h1>${project.name} — Test Results</h1>
<p><em>Auto-updated by Homestead on ${new Date().toLocaleString()}</em></p>

<h2>Summary</h2>
<table>
  <tbody>
    ${tableHeaderRow('Category', 'Count')}
    ${tableRow('Test Tasks Total', String(testTasks.length))}
    ${tableRow('Passed / Done', String(passed.length))}
    ${tableRow('Failed', String(failed.length))}
    ${tableRow('Running', String(running.length))}
    ${tableRow('Jira Issues Tracked', String(reqs.length))}
    ${tableRow('High Priority / Bugs', String(bugs.length))}
  </tbody>
</table>

<h2>Test Tasks</h2>
${testTasks.length
    ? `<table><tbody>${tableHeaderRow('Task', 'Agent', 'Status')}${testTasks.slice(0, 25).map(t => tableRow(inline(t.title || ''), t.by || '—', statusBadge(t.status))).join('')}</tbody></table>`
    : '<p>No test tasks found yet. Assign tasks to the <strong>vince</strong> agent to start testing.</p>'}

<h2>Jira Issues (synced from Homestead Vault)</h2>
${reqs.length
    ? `<table><tbody>${tableHeaderRow('Key', 'Title', 'Status', 'Priority')}${reqs.slice(0, 20).map(r => tableRow(r.jira_key || r.id, inline(r.title || ''), statusBadge(r.status), r.priority || '—')).join('')}</tbody></table>`
    : '<p>No Jira issues synced yet. Run <strong>POST /api/projects/:id/sync</strong> to pull from Jira.</p>'}
`.trim();
}

export async function generateReportsContent(project) {
  const allTasks = repo.list('tasks').filter(t => t.project_id === project.id);
  const done = allTasks.filter(t => ['done', 'completed'].includes((t.status || '').toLowerCase()));

  // Velocity: tasks completed grouped by agent
  const byAgent = {};
  for (const t of done) {
    const agent = t.by || 'unassigned';
    byAgent[agent] = (byAgent[agent] || 0) + 1;
  }

  // Tasks by day (last 7 days)
  const now = Date.now();
  const DAY = 86400000;
  const recent = done.filter(t => now - (t.updated_at || 0) < 7 * DAY);

  return `
<h1>${project.name} — Reports &amp; Metrics</h1>
<p><em>Auto-updated by Homestead on ${new Date().toLocaleString()}</em></p>

<h2>Task Velocity</h2>
<table>
  <tbody>
    ${tableHeaderRow('Agent', 'Tasks Completed')}
    ${Object.entries(byAgent).sort((a, b) => b[1] - a[1]).map(([agent, count]) => tableRow(agent, String(count))).join('') || tableRow('No data', '—')}
  </tbody>
</table>

<h2>Last 7 Days</h2>
<p>${recent.length} tasks completed in the last 7 days.</p>
${recent.length
    ? `<ul>${recent.slice(0, 15).map(t => `<li>${inline(t.title || '')} <em>(${t.by || 'agent'})</em></li>`).join('')}</ul>`
    : ''}

<h2>Project Progress</h2>
<p>${allTasks.length > 0
    ? `${done.length} of ${allTasks.length} tasks completed (${Math.round((done.length / allTasks.length) * 100)}%).`
    : 'No tasks created yet.'}</p>
`.trim();
}

export async function generateChangelogContent(project) {
  const allTasks = repo.list('tasks').filter(t => t.project_id === project.id);
  const done = allTasks
    .filter(t => ['done', 'completed'].includes((t.status || '').toLowerCase()))
    .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));

  const events = (repo.list('events') || [])
    .filter(e => {
      const obj = String(e.obj || '').toLowerCase();
      return obj.includes(project.name.toLowerCase()) || obj.includes(project.id);
    })
    .slice(0, 30);

  return `
<h1>${project.name} — Changelog</h1>
<p><em>Auto-updated by Homestead on ${new Date().toLocaleString()}</em></p>

<h2>Completed Tasks</h2>
${done.length
    ? `<table><tbody>${tableHeaderRow('Date', 'Task', 'Agent')}${done.slice(0, 30).map(t => {
      const date = t.updated_at ? new Date(t.updated_at).toLocaleDateString() : '—';
      return tableRow(date, inline(t.title || ''), t.by || '—');
    }).join('')}</tbody></table>`
    : '<p>No completed work yet.</p>'}

<h2>System Events</h2>
${events.length
    ? `<ul>${events.map(e => `<li><strong>${inline(e.what || '')}</strong> — ${inline(e.obj || '')}</li>`).join('')}</ul>`
    : '<p>No events logged for this project.</p>'}
`.trim();
}

// ── Main doc push ────────────────────────────────────────────────────

const PAGE_GENERATORS = [
  { suffix: 'Overview',          fn: generateOverviewContent },
  { suffix: 'Architecture',      fn: generateArchitectureContent },
  { suffix: 'Test Results',      fn: generateTestingContent },
  { suffix: 'Reports & Metrics', fn: generateReportsContent },
  { suffix: 'Changelog',         fn: generateChangelogContent },
];

export async function pushAllDocs(project) {
  const spaceKey = project.integrations?.atlassian?.confluenceSpaceKey;
  if (!spaceKey) throw new Error(`Project ${project.id}: confluenceSpaceKey not set`);
  if (!process.env.JIRA_TOKEN) throw new Error('Atlassian credentials not configured in .env');

  const results = [];

  for (const pg of PAGE_GENERATORS) {
    const title = `${project.name} — ${pg.suffix}`;
    try {
      const html = await pg.fn(project);
      const r = await upsertConfluencePage(spaceKey, title, html);
      results.push({ title, ...r });
    } catch (err) {
      console.error(`[doc-engine] ${title}: ${err.message}`);
      results.push({ title, ok: false, error: err.message });
    }
  }

  // Update lastDocSync timestamp on project
  const updated = {
    ...project,
    integrations: {
      ...project.integrations,
      atlassian: {
        ...project.integrations.atlassian,
        lastDocSync: new Date().toISOString(),
      },
    },
  };
  repo.upsert('projects', updated);

  const pushed = results.filter(r => r.ok).length;
  console.log(`[doc-engine] ${project.id}: pushed ${pushed}/${results.length} pages to Confluence space ${spaceKey}`);
  return results;
}

// ── Scheduled sync ───────────────────────────────────────────────────

const _schedules = new Map(); // projectId → timer

export function scheduleDocSync(project, intervalMs = 15 * 60 * 1000) {
  const pid = project.id;
  stopDocSync(pid); // clear any previous timer

  const timer = setInterval(async () => {
    const fresh = repo.byId('projects', pid);
    if (!fresh?.integrations?.atlassian?.enabled) {
      stopDocSync(pid);
      return;
    }
    try {
      await pushAllDocs(fresh);
    } catch (err) {
      console.error(`[doc-engine] scheduled sync ${pid}: ${err.message}`);
    }
  }, intervalMs);

  _schedules.set(pid, timer);
  console.log(`[doc-engine] ${pid}: doc sync scheduled every ${Math.round(intervalMs / 60000)}min`);
}

export function stopDocSync(projectId) {
  if (_schedules.has(projectId)) {
    clearInterval(_schedules.get(projectId));
    _schedules.delete(projectId);
  }
}

// ── Conductor context helper ─────────────────────────────────────────

export function getAtlassianSummary(project) {
  if (!project.integrations?.atlassian?.enabled) return null;

  const atl = project.integrations.atlassian;
  const tasks = repo.list('tasks').filter(t => t.project_id === project.id);
  const done = tasks.filter(t => ['done', 'completed'].includes((t.status || '').toLowerCase())).length;
  const inProg = tasks.filter(t => ['running', 'in-progress', 'active'].includes((t.status || '').toLowerCase())).length;
  const queued = tasks.filter(t => ['queued', 'pending', 'new'].includes((t.status || '').toLowerCase())).length;
  const reqs = repo.list('reqs').filter(r => r.project_id === project.id);
  const lastSync = atl.lastDocSync
    ? new Date(atl.lastDocSync).toLocaleString()
    : 'not yet synced';

  return [
    '## Atlassian Integration Status',
    atl.jiraProjectKey
      ? `- Jira project: **${atl.jiraProjectKey}** (${reqs.length} issues synced to vault)`
      : '- Jira: not linked (set jiraProjectKey to enable)',
    atl.confluenceSpaceKey
      ? `- Confluence space: **${atl.confluenceSpaceKey}** (docs last pushed: ${lastSync})`
      : '- Confluence: not linked',
    `- Task health: ${done} done, ${inProg} in-progress, ${queued} queued`,
    atl.jiraProjectKey
      ? `- To see Jira tickets: POST /api/projects/${project.id}/sync`
      : '',
  ].filter(Boolean).join('\n');
}
