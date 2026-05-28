// Atlassian ETL — pulls Jira issues and Confluence pages into the Obsidian vault.
//
// No MCP required. Uses Jira REST API v2 and Confluence REST API v1 directly.
// Credentials come from global .env: JIRA_BASE_URL, JIRA_EMAIL, JIRA_TOKEN,
// CONFLUENCE_BASE_URL, CONFLUENCE_TOKEN.
//
// Vault layout produced:
//   projects/{pid}/reqs/{KEY}.md       — one per Jira issue
//   projects/{pid}/docs/{slug}.md      — one per Confluence page

import { writeNote } from '../brain/vault.js';
import { repo } from '../db.js';

// ── auth ─────────────────────────────────────────────────────────────

function jiraAuth() {
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_TOKEN;
  if (!email || !token) throw new Error('JIRA_EMAIL and JIRA_TOKEN must be set in .env');
  return 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
}

function confluenceAuth() {
  const email = process.env.JIRA_EMAIL; // same account for Confluence Cloud
  const token = process.env.CONFLUENCE_TOKEN || process.env.JIRA_TOKEN;
  if (!email || !token) throw new Error('JIRA_EMAIL and CONFLUENCE_TOKEN must be set in .env');
  return 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
}

// ── Jira issue → vault note ──────────────────────────────────────────

export async function ingestJiraIssue(project, issue) {
  const fields = issue.fields || {};
  const key = issue.key; // e.g. 'REQ-42'
  const pid = project.id;
  const reqId = `REQ-${key}`;

  // Extract issue link dependencies
  const dependsOn = [];
  const blockedBy = [];
  for (const link of (fields.issuelinks || [])) {
    const linkType = link.type?.name || '';
    if (linkType === 'Blocks' && link.outwardIssue) {
      dependsOn.push(`REQ-${link.outwardIssue.key}`);
    }
    if ((linkType === 'Blocks' && link.inwardIssue) || linkType === 'is blocked by') {
      blockedBy.push(`REQ-${link.inwardIssue?.key || ''}`);
    }
    if (linkType === 'is blocked by' && link.inwardIssue) {
      blockedBy.push(`REQ-${link.inwardIssue.key}`);
    }
  }

  // Description: Jira returns HTML for REST v2 (rendered), plain text otherwise
  let body = '';
  if (fields.description) {
    if (typeof fields.description === 'string') {
      body = await htmlToMarkdown(fields.description);
    } else if (fields.description.content) {
      // ADF (Atlassian Document Format) — render a simple plain-text version
      body = adfToText(fields.description);
    }
  }

  // Acceptance criteria: look for common custom field names
  const acField = fields['Acceptance Criteria'] || fields['acceptance_criteria'] || fields['customfield_10016'];
  const criteriaText = typeof acField === 'string'
    ? acField
    : acField?.content ? adfToText(acField) : '';
  const criteria = criteriaText
    .split('\n')
    .map((line) => line.replace(/^[-*\s\[\]xX0-9.]+/, '').trim())
    .filter(Boolean);
  let acBlock = '';
  if (criteria.length) {
    const lines = criteria.map((line) => `- [ ] ${line}`);
    acBlock = `\n\n### Acceptance Criteria\n${lines.join('\n')}`;
  }

  const desc = body || '*No description*';
  const reqRow = {
    id: reqId,
    project_id: pid,
    title: fields.summary || key,
    desc,
    priority: (fields.priority?.name || 'Medium').toLowerCase(),
    criteria,
    status: fields.status?.name || 'unknown',
    source: 'jira',
    jira_key: key,
    depends_on: dependsOn,
    blocked_by: blockedBy,
    created_at: Date.parse(fields.created || fields.updated || new Date().toISOString()) || Date.now(),
    updated_at: Date.parse(fields.updated || new Date().toISOString()) || Date.now(),
  };
  const existing = repo.byId('reqs', reqId);
  const isNew = !existing;
  const isUpdated = existing && existing.updated_at !== reqRow.updated_at;
  repo.upsert('reqs', reqRow);

  const frontmatter = {
    id: reqId,
    'jira-key': key,
    title: fields.summary || key,
    status: fields.status?.name || 'unknown',
    priority: fields.priority?.name || 'Medium',
    kind: 'req',
    project: pid,
    'updated-at': fields.updated || new Date().toISOString(),
    links: [`projects/${pid}/README`],
  };
  if (dependsOn.length) frontmatter['depends-on'] = dependsOn;
  if (blockedBy.length)  frontmatter['blocked-by'] = blockedBy;

  writeNote(`projects/${pid}/reqs/${key}.md`, {
    frontmatter,
    body: desc + acBlock,
  });

  return { key, pid, req: reqRow, isNew, isUpdated };
}

// ── Confluence page → vault note ─────────────────────────────────────

export async function ingestConfluencePage(project, page) {
  const pid = project.id;
  const slug = slugify(page.title || page.id);
  const htmlBody = page.body?.view?.value || page.body?.storage?.value || '';
  const mdBody = await htmlToMarkdown(htmlBody);

  writeNote(`projects/${pid}/docs/${slug}.md`, {
    frontmatter: {
      id: `DOC-${slug}`,
      'confluence-id': String(page.id),
      title: page.title || slug,
      kind: 'doc',
      space: page.space?.key || project.integrations?.atlassian?.confluenceSpaceKey || '',
      project: pid,
      'updated-at': page.version?.when || new Date().toISOString(),
    },
    body: mdBody || '*No content*',
  });

  return { slug, pid };
}

// ── Bulk sync ────────────────────────────────────────────────────────

export async function bulkSyncJiraProject(project) {
  const base = process.env.JIRA_BASE_URL;
  if (!base) return { synced: 0, errors: ['JIRA_BASE_URL not set'] };
  const jiraKey = project.integrations?.atlassian?.jiraProjectKey;
  if (!jiraKey) return { synced: 0, errors: ['jiraProjectKey not configured'] };

  const auth = jiraAuth();
  const maxResults = 50;
  let synced = 0;
  const newReqs = [];
  const updatedReqs = [];
  const errors = [];
  let nextPageToken = null;

  while (true) {
    // Atlassian Cloud deprecated GET /rest/api/2/search (returns 410).
    // Use POST /rest/api/3/search/jql instead. Pagination via nextPageToken.
    let url = `${base}/rest/api/3/search/jql`;
    if (nextPageToken) url += `?nextPageToken=${encodeURIComponent(nextPageToken)}`;
    const reqBody = {
      jql: `project=${jiraKey}`,
      maxResults,
      fields: ['summary', 'status', 'priority', 'description', 'issuelinks', 'updated', 'created', 'customfield_10016'],
    };
    let data;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: auth, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        errors.push(`HTTP ${res.status}: ${errText.slice(0, 200)}`);
        break;
      }
      data = await res.json();
    } catch (err) {
      errors.push(err.message);
      break;
    }

    for (const issue of data.issues || []) {
      try {
        const result = await ingestJiraIssue(project, issue);
        synced++;
        if (result.isNew) newReqs.push(result.req);
        else if (result.isUpdated) updatedReqs.push(result.req);
      } catch (err) {
        errors.push(`${issue.key}: ${err.message}`);
      }
    }

    // v3 uses isLast flag and nextPageToken for pagination (no startAt/total)
    if (data.isLast !== false) break;
    nextPageToken = data.nextPageToken;
    if (!nextPageToken) break;
  }

  console.log(`[etl] jira sync ${jiraKey} → ${synced} issues (${newReqs.length} new, ${updatedReqs.length} updated, ${errors.length} errors)`);
  return { synced, newReqs, updatedReqs, errors };
}

export async function bulkSyncConfluenceSpace(project) {
  const base = process.env.CONFLUENCE_BASE_URL || process.env.JIRA_BASE_URL;
  if (!base) return { synced: 0, errors: ['CONFLUENCE_BASE_URL not set'] };
  const spaceKey = project.integrations?.atlassian?.confluenceSpaceKey;
  if (!spaceKey) return { synced: 0, errors: ['confluenceSpaceKey not configured'] };

  const auth = confluenceAuth();
  let start = 0;
  const limit = 25;
  let synced = 0;
  const errors = [];

  while (true) {
    // Confluence Cloud API path — /wiki prefix if using the same base as Jira
    const basePath = base.includes('/wiki') ? base : `${base}/wiki`;
    const url = `${basePath}/rest/api/content?spaceKey=${encodeURIComponent(spaceKey)}&expand=body.view,version,space&limit=${limit}&start=${start}&type=page`;
    let data;
    try {
      const res = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json' } });
      if (!res.ok) { errors.push(`HTTP ${res.status} at start=${start}`); break; }
      data = await res.json();
    } catch (err) {
      errors.push(err.message);
      break;
    }

    for (const page of data.results || []) {
      try {
        await ingestConfluencePage(project, page);
        synced++;
      } catch (err) {
        errors.push(`${page.id}: ${err.message}`);
      }
    }

    if (!data._links?.next) break;
    start += limit;
  }

  console.log(`[etl] confluence sync ${spaceKey} → ${synced} pages (${errors.length} errors)`);
  return { synced, errors };
}

// ── HTML → Markdown (turndown) ───────────────────────────────────────

let _TurndownService = null;
async function htmlToMarkdown(html) {
  if (!html || !html.trim()) return '';
  if (!_TurndownService) {
    try {
      const mod = await import('turndown');
      _TurndownService = new (mod.default || mod)();
    } catch {
      // turndown not installed — strip tags as plain fallback
      return html.replace(/<[^>]+>/g, '').trim();
    }
  }
  return _TurndownService.turndown(html);
}

// ── ADF (Atlassian Document Format) plain-text fallback ──────────────

function adfToText(doc) {
  if (!doc || doc.type !== 'doc') return '';
  return nodesToText(doc.content || []);
}

function nodesToText(nodes) {
  return nodes.map(node => {
    switch (node.type) {
      case 'text':        return node.text || '';
      case 'paragraph':   return nodesToText(node.content || []) + '\n';
      case 'heading':     return '#'.repeat(node.attrs?.level || 2) + ' ' + nodesToText(node.content || []) + '\n';
      case 'bulletList':  return (node.content || []).map(li => '- ' + nodesToText(li.content || [])).join('\n') + '\n';
      case 'orderedList': return (node.content || []).map((li, i) => `${i + 1}. ` + nodesToText(li.content || [])).join('\n') + '\n';
      case 'listItem':    return nodesToText(node.content || []);
      case 'codeBlock':   return '```\n' + nodesToText(node.content || []) + '\n```\n';
      case 'inlineCard':  return node.attrs?.url || '';
      default:            return nodesToText(node.content || []);
    }
  }).join('');
}

// ── helpers ──────────────────────────────────────────────────────────

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'page';
}

function jiraBase() {
  const base = process.env.JIRA_BASE_URL;
  if (!base) throw new Error('JIRA_BASE_URL not set');
  return base;
}

function confluenceBase() {
  const base = process.env.CONFLUENCE_BASE_URL || process.env.JIRA_BASE_URL;
  if (!base) throw new Error('CONFLUENCE_BASE_URL not set');
  return base.endsWith('/wiki') ? base : `${base}/wiki`;
}

async function jiraFetch(path, opts = {}) {
  const url = `${jiraBase()}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: jiraAuth(),
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text().catch(() => '');
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, ok: res.ok, json, text };
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
  return { status: res.status, ok: res.ok, json, text };
}

// ── Jira: list all projects ──────────────────────────────────────────

export async function listJiraProjects() {
  const { status, json } = await jiraFetch('/rest/api/2/project?expand=description');
  if (status !== 200) throw new Error(`Jira list projects failed: HTTP ${status} — ${json?.message || 'unknown'}`);
  return (json || []).map((p) => ({
    key: p.key,
    id: p.id,
    name: p.name,
    type: p.projectTypeKey,
    avatarUrl: p.avatarUrls?.['48x48'] || null,
  }));
}

// ── Confluence: list all spaces ──────────────────────────────────────

export async function listConfluenceSpaces() {
  const { status, json } = await confluenceFetch('/rest/api/space?type=global&limit=50&expand=description.plain');
  if (status !== 200) throw new Error(`Confluence list spaces failed: HTTP ${status} — ${json?.message || 'unknown'}`);
  return (json?.results || []).map((s) => ({
    key: s.key,
    name: s.name,
    description: s.description?.plain?.value || '',
    webUrl: s._links?.webui || null,
  }));
}

// ── Jira: create issue from a Homestead task ─────────────────────────

/**
 * Creates a Jira issue from a Homestead task.
 * Returns { ok, key, id, url } on success.
 */
export async function createJiraIssue(project, { summary, description = '', issueType = 'Task', priority = 'Medium', labels = [] }) {
  const jiraKey = project.integrations?.atlassian?.jiraProjectKey;
  if (!jiraKey) throw new Error(`Project ${project.id} has no jiraProjectKey configured`);

  const body = {
    fields: {
      project: { key: jiraKey },
      summary: summary.slice(0, 255),
      description: description.slice(0, 32767) || undefined,
      issuetype: { name: issueType },
      priority: { name: priority },
      ...(labels.length ? { labels } : {}),
    },
  };

  const { status, json } = await jiraFetch('/rest/api/2/issue', {
    method: 'POST',
    body: JSON.stringify(body),
  });

  if (status === 201) {
    const url = `${jiraBase()}/browse/${json.key}`;
    console.log(`[etl] created Jira issue ${json.key} for task`);
    return { ok: true, key: json.key, id: json.id, url };
  }

  const errMsg = json?.errors ? JSON.stringify(json.errors) : (json?.errorMessages?.join(', ') || json?.message || `HTTP ${status}`);
  throw new Error(`Failed to create Jira issue: ${errMsg}`);
}

// ── Jira: update issue status (transition) ────────────────────────────

const STATUS_TO_TRANSITION_NAME = {
  done:         ['Done', 'Resolved', 'Closed', 'Complete'],
  running:      ['In Progress', 'Start Progress', 'Start Development'],
  queued:       ['To Do', 'Reopen Issue', 'Backlog'],
  'needs-human': ['In Progress'],
  failed:       ['In Progress'],
};

export async function transitionJiraIssue(issueKey, targetStatus) {
  // 1. Fetch available transitions
  const { status: tStatus, json: tJson } = await jiraFetch(`/rest/api/2/issue/${encodeURIComponent(issueKey)}/transitions`);
  if (tStatus !== 200) throw new Error(`Cannot fetch transitions for ${issueKey}: HTTP ${tStatus}`);

  const transitions = tJson?.transitions || [];
  const candidates = STATUS_TO_TRANSITION_NAME[targetStatus] || [];

  // Find first matching transition (case-insensitive)
  const match = transitions.find((t) =>
    candidates.some((c) => t.name.toLowerCase() === c.toLowerCase())
  );
  if (!match) {
    const available = transitions.map((t) => t.name).join(', ');
    console.warn(`[etl] no transition found for ${issueKey} → ${targetStatus}. Available: ${available}`);
    return { ok: false, reason: 'no matching transition', available };
  }

  // 2. Apply the transition
  const { status } = await jiraFetch(`/rest/api/2/issue/${encodeURIComponent(issueKey)}/transitions`, {
    method: 'POST',
    body: JSON.stringify({ transition: { id: match.id } }),
  });
  if (status === 204) {
    console.log(`[etl] transitioned ${issueKey} → ${match.name}`);
    return { ok: true, transition: match.name };
  }
  throw new Error(`Transition ${issueKey} failed: HTTP ${status}`);
}

// ── Jira: sync Homestead task → Jira (create or update) ──────────────

/**
 * Creates a Jira issue from a task if it doesn't have a jira_key yet.
 * If it already has a jira_key, syncs the status only.
 * Updates the task row with jira_key + jira_url.
 */
export async function syncTaskToJira(project, task) {
  if (!project.integrations?.atlassian?.enabled || !project.integrations?.atlassian?.jiraProjectKey) {
    return { ok: false, reason: 'Jira not enabled for project' };
  }

  if (!task.jira_key) {
    // Create new issue
    const priorityMap = { high: 'High', medium: 'Medium', low: 'Low', critical: 'Highest' };
    const result = await createJiraIssue(project, {
      summary: task.title,
      description: task.desc || '',
      issueType: 'Task',
      priority: priorityMap[task.priority?.toLowerCase()] || 'Medium',
    });
    // Persist jira_key on the task row
    repo.patch('tasks', task.id, { jira_key: result.key, jira_url: result.url });
    return result;
  } else {
    // Sync status only
    try {
      return await transitionJiraIssue(task.jira_key, task.status);
    } catch (err) {
      console.warn(`[etl] syncTaskToJira status transition failed: ${err.message}`);
      return { ok: false, reason: err.message };
    }
  }
}
