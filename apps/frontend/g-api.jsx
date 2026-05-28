// Frontend ↔ backend client.
// Exposes:
//   GApi.getState()                → bootstrap snapshot
//   GApi.patchTask(id, patch)      → kanban moves
//   GApi.sendMessage(agentId, txt) → real LLM round-trip
//   GApi.startPipeline(id, payload)
//   GApi.subscribe(handler)        → live WebSocket events
//   useLiveState()                 → React hook for the whole app

const API_BASE = (() => {
  // Same-origin in production. If the page is served over file:// (preview)
  // fall back to localhost so devtools work.
  if (location.protocol === 'file:') return 'http://localhost:8765';
  return '';
})();

// ── Per-agent real-time chat listeners ────────────────────────────────────────
// useG_Chat hooks register here so chat:reply WS events update them instantly
// without a full page re-render.
const _chatListeners = new Map(); // key: `${agentId}:${projectId}` → Set<fn>

function _dispatchChatReply(agentId, projectId, message, source) {
  const key = `${agentId}:${projectId}`;
  const enriched = { ...message, source: source || message.source };
  const fns = _chatListeners.get(key);
  if (fns) fns.forEach((fn) => fn(enriched));
  // also dispatch to wildcard project listeners (global kitchen drawer)
  const wcKey = `${agentId}:*`;
  const wcFns = _chatListeners.get(wcKey);
  if (wcFns) wcFns.forEach((fn) => fn(enriched));
}

function _subscribeChatReply(agentId, projectId, fn) {
  const key = `${agentId}:${projectId || '*'}`;
  if (!_chatListeners.has(key)) _chatListeners.set(key, new Set());
  _chatListeners.get(key).add(fn);
  return () => _chatListeners.get(key)?.delete(fn);
}

async function jsonFetch(path, opts = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText} — ${txt.slice(0, 200)}`);
  }
  return res.json();
}

const GApi = {
  base: API_BASE,
  getState: (projectId) =>
    jsonFetch(`/api/state${projectId ? '?project=' + encodeURIComponent(projectId) : ''}`),

  fetchState: (projectId) =>
    jsonFetch(`/api/state${projectId ? '?project=' + encodeURIComponent(projectId) : ''}`),

  patchTask: (id, patch) =>
    jsonFetch(`/api/tasks/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  createTask: (task) =>
    jsonFetch('/api/tasks', { method: 'POST', body: JSON.stringify(task) }),

  getTask: (id) => jsonFetch(`/api/tasks/${encodeURIComponent(id)}`),

  addTaskComment: (id, text, by = 'human') =>
    jsonFetch(`/api/tasks/${encodeURIComponent(id)}/comments`, { method: 'POST', body: JSON.stringify({ text, by }) }),

  postTaskMessage: (id, text, kind = 'comment', by = 'human') =>
    jsonFetch(`/api/tasks/${encodeURIComponent(id)}/messages`, { method: 'POST', body: JSON.stringify({ text, kind, by }) }),

  retryTask: (id) =>
    jsonFetch(`/api/tasks/${encodeURIComponent(id)}/retry`, { method: 'POST' }),
  cancelTask: (id) =>
    jsonFetch(`/api/tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  auditTask: (id) =>
    jsonFetch(`/api/tasks/${encodeURIComponent(id)}/audit`, { method: 'POST' }),
  taskDiff: (id) => jsonFetch(`/api/tasks/${encodeURIComponent(id)}/diff`),

  // Missions
  startMission: (projectId, goal) =>
    jsonFetch('/api/missions', { method: 'POST', body: JSON.stringify({ projectId, goal }) }),
  listMissions: (projectId) =>
    jsonFetch(`/api/missions${projectId ? '?projectId=' + encodeURIComponent(projectId) : ''}`),
  getMission: (id) => jsonFetch(`/api/missions/${encodeURIComponent(id)}`),

  // Gates
  listGates: (projectId) => jsonFetch(`/api/projects/${encodeURIComponent(projectId)}/gates`),
  setGate: (projectId, name, open) =>
    jsonFetch(`/api/projects/${encodeURIComponent(projectId)}/gates/${encodeURIComponent(name)}`, { method: 'POST', body: JSON.stringify({ open }) }),

  // Project env
  getProjectEnv: (projectId) => jsonFetch(`/api/projects/${encodeURIComponent(projectId)}/env`),
  setProjectEnv: (projectId, vars) =>
    jsonFetch(`/api/projects/${encodeURIComponent(projectId)}/env`, { method: 'POST', body: JSON.stringify({ vars }) }),

  // Per-project budget
  getProjectBudget: (projectId) => jsonFetch(`/api/projects/${encodeURIComponent(projectId)}/budget`),

  // Notifications
  listNotifications: () => jsonFetch('/api/notifications'),
  markNotifRead: (id) => jsonFetch(`/api/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' }),

  // Conductor goal → DAG plan
  planGoal: (projectId, goal) =>
    jsonFetch(`/api/projects/${encodeURIComponent(projectId)}/plan`, { method: 'POST', body: JSON.stringify({ goal }) }),

  // AI activity toggle
  pauseProject: (projectId, paused) =>
    jsonFetch(`/api/projects/${encodeURIComponent(projectId)}/pause`, { method: 'PATCH', body: JSON.stringify({ paused }) }),

  // Dev servers
  listDevServers: (projectId) => jsonFetch(`/api/exec/dev-servers?projectId=${encodeURIComponent(projectId)}`),
  devServerLogs: (projectId, name, tail = 100) =>
    jsonFetch(`/api/exec/dev-servers/${encodeURIComponent(name)}/logs?projectId=${encodeURIComponent(projectId)}&tail=${tail}`),
  stopDevServer: (projectId, name) =>
    jsonFetch(`/api/exec/dev-servers/${encodeURIComponent(name)}/stop`, { method: 'POST', body: JSON.stringify({ projectId }) }),

  shellSessions: () => jsonFetch('/api/exec/shell-sessions'),

  getMessages: (agentId, projectId, limit = 50) =>
    jsonFetch(`/api/agents/${agentId}/messages?projectId=${encodeURIComponent(projectId)}&limit=${limit}`),

  sendMessage: (agentId, text, projectId) => {
    if (!projectId) return Promise.reject(new Error('sendMessage needs a projectId'));
    return jsonFetch(`/api/agents/${agentId}/messages`, { method: 'POST', body: JSON.stringify({ text, projectId }) });
  },

  // Cross-project manager (no projectId — sees everything, modifies nothing)
  managerSend: (text) =>
    jsonFetch('/api/manager/messages', { method: 'POST', body: JSON.stringify({ text }) }),
  managerHistory: () => jsonFetch('/api/manager/messages'),

  // Project + template management
  listTemplates: () => jsonFetch('/api/templates'),
  createProject: (body) => jsonFetch('/api/projects', { method: 'POST', body: JSON.stringify(body) }),
  deleteProject: (id) => jsonFetch(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  getPool: () => jsonFetch('/api/llm/pool'),
  getTools: () => jsonFetch('/api/tools'),

  getPipelines: () => jsonFetch('/api/pipelines'),
  startPipeline: (pipelineId, payload, projectId) =>
    jsonFetch('/api/pipelines/start', { method: 'POST', body: JSON.stringify({ pipelineId, projectId, payload }) }),
  approvePipeline: (id) =>
    jsonFetch(`/api/pipelines/${id}/approve`, { method: 'POST' }),

  trace: (nodeId) => jsonFetch(`/api/trace/${encodeURIComponent(nodeId)}`),
  vaultFiles: (subdir = '') => jsonFetch(`/api/vault/files?subdir=${encodeURIComponent(subdir)}`),
  recordsMission: (projectId) => jsonFetch(`/api/records/mission?project=${encodeURIComponent(projectId)}`),
  vaultRecords: (projectId = '') => jsonFetch(`/api/vault/records?project=${encodeURIComponent(projectId)}`),  
  vaultNote: (path) => jsonFetch(`/api/vault/note?path=${encodeURIComponent(path)}`),
  vaultGraph: () => jsonFetch('/api/vault/graph'),

  fsTree: (projectId) => jsonFetch(`/api/exec/fs/tree?projectId=${encodeURIComponent(projectId)}`),
  fsRead: (projectId, file) => jsonFetch(`/api/exec/fs/read?projectId=${encodeURIComponent(projectId)}&file=${encodeURIComponent(file)}`),
  shellExec: (projectId, cmd) =>
    jsonFetch('/api/exec/shell', { method: 'POST', body: JSON.stringify({ projectId, cmd }) }),
  pyExec: (projectId, code) =>
    jsonFetch('/api/exec/python', { method: 'POST', body: JSON.stringify({ projectId, code }) }),
  getLogs: (projectId, limit = 100) =>
    jsonFetch(`/api/logs?${projectId ? 'project=' + encodeURIComponent(projectId) + '&' : ''}limit=${limit}`),

  dismissWelcome: () => jsonFetch('/api/welcome/dismiss', { method: 'POST' }),

  // Real-time chat: subscribe to replies from a specific agent in a project.
  // Returns an unsubscribe fn. Called by useG_Chat in g-kitchen.jsx.
  subscribeChatReply: (agentId, projectId, fn) => _subscribeChatReply(agentId, projectId, fn),

  subscribe(handler) {
    const wsUrl = (API_BASE || location.origin).replace(/^http/, 'ws') + '/ws';
    let ws, retries = 0;
    let alive = true;
    function connect() {
      ws = new WebSocket(wsUrl);
      ws.onopen = () => { retries = 0; handler({ kind: 'ws:open' }); };
      ws.onmessage = (e) => {
        try { handler(JSON.parse(e.data)); } catch { /* ignore non-JSON */ }
      };
      ws.onclose = () => {
        if (!alive) return;
        const wait = Math.min(8000, 500 * 2 ** retries++);
        setTimeout(connect, wait);
        handler({ kind: 'ws:close' });
      };
      ws.onerror = () => { try { ws.close(); } catch {} };
    }
    connect();
    return () => { alive = false; try { ws && ws.close(); } catch {} };
  },
};

// React hook that owns the live state slice the whole app reads from.
function useLiveState() {
  const [state, setState] = React.useState({ loading: true });
  const [toasts, setToasts] = React.useState([]);
  const [wsOk, setWsOk] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    GApi.getState().then(async (data) => {
      if (cancelled) return;
      // Pull notifications + missions in parallel for the first paint.
      const [notifs, missions] = await Promise.all([
        GApi.listNotifications().catch(() => ({ notifications: [] })),
        GApi.listMissions().catch(() => ({ missions: [] })),
      ]);
      setState({ loading: false, ...data, notifications: notifs.notifications || [], missions: missions.missions || [] });
    }).catch((err) => {
      console.warn('[gavirila] backend unavailable, falling back to static seed:', err.message);
      if (cancelled) return;
      setState({ loading: false, offline: true, ...window.G_OFFLINE_FALLBACK });
    });
    return () => { cancelled = true; };
  }, []);

  React.useEffect(() => {
    const off = GApi.subscribe((msg) => {
      if (msg.kind === 'ws:open')  setWsOk(true);
      if (msg.kind === 'ws:close') setWsOk(false);
      if (msg.kind === 'event:append') {
        setState((s) => ({ ...s, events: [{ ...msg.event, fresh: true }, ...(s.events || [])].slice(0, 80) }));
      }
      if (msg.kind === 'task:progress') {
        setState((s) => {
          // Skip progress ticks for tasks outside the current project scope
          const pid = s.projectId;
          if (pid && msg.projectId && msg.projectId !== pid) return s;
          return { ...s, tasks: (s.tasks || []).map((t) => t.id === msg.id ? { ...t, progress: msg.progress } : t) };
        });
      }
      if (msg.kind === 'task:update' || msg.kind === 'task:create') {
        setState((s) => {
          const pid = s.projectId; // set by fetchState / switchProject
          const incoming = msg.task;
          // Step 1: purge any cross-project tasks that snuck into state via earlier WS events
          const clean = pid
            ? (s.tasks || []).filter((t) => !t.project_id || t.project_id === pid)
            : (s.tasks || []);
          // Step 2: reject + evict tasks that belong to a different project
          if (pid && incoming.project_id && incoming.project_id !== pid) {
            return clean.length !== (s.tasks || []).length ? { ...s, tasks: clean } : s;
          }
          // Step 3: update in-place or prepend new
          const i = clean.findIndex((t) => t.id === incoming.id);
          if (i >= 0) {
            const next = [...clean];
            next[i] = incoming;
            return { ...s, tasks: next };
          }
          return { ...s, tasks: [incoming, ...clean] };
        });
      }
      if (msg.kind === 'connector:update') {
        setState((s) => ({ ...s, connectors: (s.connectors || []).map((c) => c.id === msg.connector.id ? msg.connector : c) }));
      }
      if (msg.kind === 'req:create') {
        setState((s) => ({ ...s, reqs: [...(s.reqs || []), msg.req] }));
      }
      if (msg.kind === 'req:update') {
        setState((s) => ({ ...s, reqs: (s.reqs || []).map((r) => r.id === msg.req.id ? msg.req : r) }));
      }
      if (msg.kind === 'req:delete') {
        setState((s) => ({ ...s, reqs: (s.reqs || []).filter((r) => r.id !== msg.id) }));
      }
      if (msg.kind === 'project:update') {
        setState((s) => ({ ...s, projects: (s.projects || []).map((p) => p.id === msg.project.id ? msg.project : p) }));
      }
      if (msg.kind === 'toast') {
        const t = { ...msg.toast, id: Date.now() + Math.random() };
        setToasts((ts) => [...ts, t]);
        setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== t.id)), 5500);
      }
      if (msg.kind === 'pipeline:start' || msg.kind === 'pipeline:reply' || msg.kind === 'pipeline:gate' || msg.kind === 'pipeline:done') {
        setState((s) => ({ ...s, pipelineEvents: [{ ...msg, ts: Date.now() }, ...((s.pipelineEvents) || [])].slice(0, 50) }));
      }
      // Live tool calls — for the topbar activity strip
      if (msg.kind === 'tool:call') {
        setState((s) => ({ ...s, recentToolCalls: [{ ...msg, ts: Date.now() }, ...((s.recentToolCalls) || [])].slice(0, 30) }));
      }
      // Live execution traces
      if (msg.kind === 'trace:append') {
        setState((s) => ({ ...s, recentTraces: [msg.trace, ...((s.recentTraces) || [])].slice(0, 50) }));
      }
      // Per-task artifacts and messages
      if (msg.kind === 'task:artifact' || msg.kind === 'task:message') {
        setState((s) => {
          const tasks = (s.tasks || []).map((t) => {
            if (t.id !== msg.taskId) return t;
            if (msg.kind === 'task:artifact') return { ...t, artifacts: [...(t.artifacts || []), msg.artifact] };
            if (msg.kind === 'task:message') return { ...t, messages: [...(t.messages || []), msg.message] };
            return t;
          });
          return { ...s, tasks };
        });
      }
      // Supervisor activity
      if (msg.kind === 'supervisor:tick') {
        setState((s) => ({ ...s, supervisorEvents: [{ ...msg, ts: Date.now() }, ...((s.supervisorEvents) || [])].slice(0, 20) }));
      }
      // Persistent notifications
      if (msg.kind === 'notification') {
        setState((s) => ({ ...s, notifications: [msg.notification, ...((s.notifications) || [])].slice(0, 50) }));
      }
      // Mission lifecycle
      if (msg.kind === 'mission:start' || msg.kind === 'mission:done' || msg.kind === 'mission:blocker') {
        setState((s) => {
          const ms = (s.missions || []).filter((m) => m.id !== msg.mission.id);
          return { ...s, missions: [msg.mission, ...ms].slice(0, 30) };
        });
      }
      // Gate updates
      if (msg.kind === 'gate:update') {
        setState((s) => ({ ...s, gates: [...((s.gates) || []).filter((g) => g.id !== msg.gate.id), msg.gate] }));
      }
      // Forward gate:needs_review events to service worker for push notifications
      if (msg.kind === 'gate:needs_review' || (msg.kind === 'task:update' && msg.task?.status === 'review')) {
        if (window._gwForwardToSW) {
          window._gwForwardToSW({
            type: 'gate:needs_review',
            taskId: msg.task?.id || msg.taskId,
            taskTitle: msg.task?.title || msg.taskTitle,
            agent: msg.task?.by || msg.agent,
          });
        }
      }
      // Real-time chat replies — dispatched to per-agent listeners so the kitchen
      // chat updates live without polling. Kitchen hooks register via subscribeChatReply.
      if (msg.kind === 'chat:reply') {
        _dispatchChatReply(msg.agent, msg.projectId, msg.message, msg.source);
      }
    });
    return off;
  }, []);

  const dismissToast = (id) => setToasts((ts) => ts.filter((t) => t.id !== id));
  return { state, setState, toasts, dismissToast, wsOk };
}

window.GApi = GApi;
window.useLiveState = useLiveState;
