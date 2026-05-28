// Atlassian Provisioner — bootstraps a Confluence space + seeds documentation pages
// when a Homestead project is created with `integrations.atlassian.provision = true`.
//
// Also supports linking an existing Jira project key to the Homestead project.
//
// API:
//   provisionAtlassianForProject(project, opts)
//     opts.confluenceSpaceKey  — override derived key
//     opts.jiraProjectKey      — link to this existing Jira project
//     opts.createJiraProject   — attempt to create a new Jira project (requires admin)
//
// Vault layout produced:
//   projects/<id>/atlassian-meta.md  — stores page IDs for future upserts

import { writeNote } from '../brain/vault.js';
import { repo } from '../db.js';

// ── shared auth ──────────────────────────────────────────────────────

function jiraAuth() {
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_TOKEN;
  if (!email || !token) throw new Error('JIRA_EMAIL and JIRA_TOKEN must be set in .env');
  return 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
}

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

function jiraBase() {
  const base = process.env.JIRA_BASE_URL;
  if (!base) throw new Error('JIRA_BASE_URL not set');
  return base;
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
  return { status: res.status, json, text };
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
  return { status: res.status, json, text };
}

// ── key helpers ──────────────────────────────────────────────────────

function toSpaceKey(name) {
  // Confluence: uppercase alphanumeric, 2–10 chars
  const key = name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
  return key.length >= 2 ? key : (key + 'X').slice(0, 10);
}

function toJiraKey(name) {
  // Jira: uppercase alphanumeric, 2–10 chars
  const key = name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
  return key.length >= 2 ? key : (key + 'X').slice(0, 10);
}

// ── Confluence space ─────────────────────────────────────────────────

export async function createConfluenceSpace(key, name, description = '') {
  const { status, json } = await confluenceFetch('/rest/api/space', {
    method: 'POST',
    body: JSON.stringify({
      key,
      name,
      description: {
        plain: {
          value: description || `Homestead project: ${name}`,
          representation: 'plain',
        },
      },
    }),
  });

  if (status === 200 || status === 201) {
    return { ok: true, key: json.key, id: json.id, webUrl: json._links?.webui };
  }

  if (status === 409) {
    // Space already exists — fetch it and return
    const { status: getStatus, json: existing } = await confluenceFetch(
      `/rest/api/space/${encodeURIComponent(key)}?expand=homepage`
    );
    if (getStatus === 200) {
      return {
        ok: true,
        key: existing.key,
        id: existing.id,
        homepageId: existing.homepage?.id,
        webUrl: existing._links?.webui,
        existed: true,
      };
    }
  }

  throw new Error(
    `Confluence space creation failed: HTTP ${status} — ${json?.message || json?.errorMessages?.join(', ') || 'unknown'}`
  );
}

// ── Jira project (requires admin) ────────────────────────────────────

export async function tryCreateJiraProject(key, name) {
  // Get current user accountId for project lead
  const { status: meStatus, json: me } = await jiraFetch('/rest/api/2/myself');
  if (meStatus !== 200) throw new Error(`Cannot resolve current user: HTTP ${meStatus}`);

  const { status, json } = await jiraFetch('/rest/api/2/project', {
    method: 'POST',
    body: JSON.stringify({
      key,
      name,
      projectTypeKey: 'software',
      projectTemplateKey: 'com.pyxis.greenhopper.jira:gh-scrum-template',
      lead: me.accountId,
    }),
  });

  if (status === 201) {
    return { ok: true, key: json.key, id: json.id };
  }

  if (status === 400 && json?.errors?.projectKey) {
    // Key collision — try with numeric suffix
    const altKey = (key.slice(0, 8) + '2').slice(0, 10);
    return tryCreateJiraProject(altKey, name);
  }

  // Soft failure — user can create manually and set jiraProjectKey later
  return {
    ok: false,
    error: `HTTP ${status}: ${json?.errorMessages?.join(', ') || json?.message || 'unknown'}`,
    hint: 'Create the Jira project manually at https://id.atlassian.com then set jiraProjectKey via PATCH /api/projects/:id',
  };
}

// ── Initial Confluence page tree ─────────────────────────────────────

const INITIAL_PAGES = [
  {
    suffix: 'Overview',
    html: (name) => `
<h1>${name} — Project Overview</h1>
<p><em>Auto-created by Homestead. Kept up to date by the Documentation Engine.</em></p>
<h2>Purpose</h2>
<p>Describe what this project does and why it exists.</p>
<h2>Status</h2>
<p><strong>Active</strong></p>
<h2>Quick Links</h2>
<ul>
  <li>Architecture — see child page</li>
  <li>Test Results — see child page</li>
  <li>Reports &amp; Metrics — see child page</li>
  <li>Changelog — see child page</li>
</ul>
`.trim(),
  },
  {
    suffix: 'Architecture',
    html: (name) => `
<h1>${name} — Architecture</h1>
<p><em>Synced from Homestead Vault. Updated automatically after each architectural change.</em></p>
<h2>Stack</h2>
<p>To be documented. Delphi agent will populate this.</p>
<h2>Key Design Decisions</h2>
<p>ADRs will be recorded here as they are made.</p>
<h2>Component Diagram</h2>
<p>See architecture.md in the project vault for diagrams.</p>
`.trim(),
  },
  {
    suffix: 'Test Results',
    html: (name) => `
<h1>${name} — Test Results</h1>
<p><em>Auto-updated by Homestead after each test run via Vince agent.</em></p>
<h2>Latest Run</h2>
<p>No runs yet. Create tasks assigned to the <strong>vince</strong> agent to generate test runs.</p>
<h2>Coverage Summary</h2>
<p>Will be populated automatically after first test execution.</p>
<h2>Known Failures</h2>
<p>None.</p>
`.trim(),
  },
  {
    suffix: 'Reports &amp; Metrics',
    html: (name) => `
<h1>${name} — Reports &amp; Metrics</h1>
<p><em>Auto-updated by Homestead periodically.</em></p>
<h2>Task Completion Rate</h2>
<p>Updated from Homestead task state every 15 minutes.</p>
<h2>Bug Rate</h2>
<p>Tracked via Jira issues. Requires Jira project key to be configured.</p>
<h2>Velocity</h2>
<p>Tasks completed per day will appear here after project runs.</p>
`.trim(),
  },
  {
    suffix: 'Changelog',
    html: (name) => `
<h1>${name} — Changelog</h1>
<p><em>Auto-updated by Homestead after significant events (task completion, deployments, architectural changes).</em></p>
<h2>Latest Changes</h2>
<p>No entries yet. Activity will appear here as the project progresses.</p>
`.trim(),
  },
];

export async function seedConfluencePages(spaceKey, projectName) {
  // Get the space homepage so we can nest pages under it
  const { status: spaceStatus, json: spaceInfo } = await confluenceFetch(
    `/rest/api/space/${encodeURIComponent(spaceKey)}?expand=homepage`
  );
  const homepageId = spaceStatus === 200 ? spaceInfo?.homepage?.id : null;

  const results = [];

  for (const page of INITIAL_PAGES) {
    const title = `${projectName} — ${page.suffix}`;
    try {
      const body = {
        type: 'page',
        title,
        space: { key: spaceKey },
        body: {
          storage: {
            value: page.html(projectName),
            representation: 'storage',
          },
        },
      };
      if (homepageId) body.ancestors = [{ id: String(homepageId) }];

      const { status, json } = await confluenceFetch('/rest/api/content', {
        method: 'POST',
        body: JSON.stringify(body),
      });

      if (status === 200 || status === 201) {
        results.push({ suffix: page.suffix, id: json.id, ok: true, url: json._links?.webui });
      } else if (status === 409) {
        // Page already exists
        results.push({ suffix: page.suffix, ok: true, existed: true });
      } else {
        results.push({ suffix: page.suffix, ok: false, status, error: json?.message });
      }
    } catch (err) {
      results.push({ suffix: page.suffix, ok: false, error: err.message });
    }
  }

  return results;
}

// ── Main entry point ─────────────────────────────────────────────────

export async function provisionAtlassianForProject(project, opts = {}) {
  const log = [];
  const result = { ok: true, log, projectId: project.id };

  if (!process.env.JIRA_BASE_URL || !process.env.JIRA_TOKEN) {
    return { ok: false, error: 'Atlassian credentials not configured in .env', log };
  }

  const projectName = project.name;
  const desiredSpaceKey = opts.confluenceSpaceKey
    || project.integrations?.atlassian?.confluenceSpaceKey
    || toSpaceKey(projectName);
  const desiredJiraKey = opts.jiraProjectKey
    || project.integrations?.atlassian?.jiraProjectKey;
  const shouldCreateJira = opts.createJiraProject === true;

  // 1. Create or retrieve Confluence space
  let spaceKey = desiredSpaceKey;
  try {
    const spaceResult = await createConfluenceSpace(desiredSpaceKey, projectName);
    spaceKey = spaceResult.key;
    log.push({ step: 'confluence-space', ok: true, key: spaceKey, existed: spaceResult.existed || false });
    result.confluenceSpaceKey = spaceKey;
    result.confluenceUrl = `${process.env.CONFLUENCE_BASE_URL || process.env.JIRA_BASE_URL}/wiki/spaces/${spaceKey}`;
  } catch (err) {
    log.push({ step: 'confluence-space', ok: false, error: err.message });
    result.ok = false;
  }

  // 2. Jira project — create or just link
  let resolvedJiraKey = desiredJiraKey;
  if (shouldCreateJira) {
    const jiraKey = desiredJiraKey || toJiraKey(projectName);
    try {
      const jiraResult = await tryCreateJiraProject(jiraKey, projectName);
      log.push({ step: 'jira-project', ...jiraResult });
      if (jiraResult.ok) resolvedJiraKey = jiraResult.key;
    } catch (err) {
      log.push({ step: 'jira-project', ok: false, error: err.message });
    }
  } else if (desiredJiraKey) {
    log.push({ step: 'jira-project', ok: true, key: desiredJiraKey, linked: true });
  } else {
    log.push({ step: 'jira-project', ok: false, skipped: true, hint: 'Pass jiraProjectKey to link an existing Jira project' });
  }

  // 3. Seed Confluence pages
  if (result.confluenceSpaceKey) {
    try {
      const pages = await seedConfluencePages(spaceKey, projectName);
      const ok = pages.filter(p => p.ok).length;
      log.push({ step: 'seed-pages', ok: true, seeded: ok, total: pages.length, pages });
      result.pages = pages;
    } catch (err) {
      log.push({ step: 'seed-pages', ok: false, error: err.message });
    }
  }

  // 4. Write Atlassian meta to vault so doc engine can find pages
  try {
    writeNote(`projects/${project.id}/atlassian-meta.md`, {
      frontmatter: {
        kind: 'atlassian-meta',
        project: project.id,
        confluenceSpaceKey: spaceKey,
        jiraProjectKey: resolvedJiraKey || '',
        provisionedAt: new Date().toISOString(),
      },
      body: `# Atlassian Integration — ${projectName}\n\nManaged by Homestead Documentation Engine.\nDo not edit manually — this file is auto-updated.\n`,
    });
    log.push({ step: 'vault-meta', ok: true });
  } catch (err) {
    log.push({ step: 'vault-meta', ok: false, error: err.message });
  }

  // 5. Persist updated integration settings on the project
  const updatedAtlassian = {
    ...(project.integrations?.atlassian || {}),
    enabled: true,
    confluenceSpaceKey: spaceKey,
    ...(resolvedJiraKey ? { jiraProjectKey: resolvedJiraKey } : {}),
    provisionedAt: new Date().toISOString(),
  };

  const updatedProject = {
    ...project,
    integrations: { ...project.integrations, atlassian: updatedAtlassian },
  };
  repo.upsert('projects', updatedProject);
  result.integrations = updatedAtlassian;

  console.log(`[provisioner] ${project.id}: provision done — space=${spaceKey}, jira=${resolvedJiraKey || 'none'}`);
  return result;
}
