// Gavirila v2 — Sidebar (rooms nav) + Topbar
// Homestead metaphor: Fields = projects, Rooms = sections of a field

function GSidebar({ route, setRoute, projectId, setProjectId, projects, wsOk, offline, onPostChore, onRefresh, onOpenSettings, overlay = false, open = true, onClose }) {
  const { t, mode, setMode } = useG();
  const layout = useGLayout();
  const isLight = mode === 'light';
  const [showNewProject, setShowNewProject] = React.useState(false);
  const [newProjName, setNewProjName] = React.useState('');
  const [newProjDesc, setNewProjDesc] = React.useState('');
  const [newProjIntegrations, setNewProjIntegrations] = React.useState({ atlassian: { enabled: false, jiraProjectKey: '', confluenceSpaceKey: '', autoSyncTasks: false }, github: { enabled: false, repoFullName: '' } });
  const [newProjWorkspace, setNewProjWorkspace] = React.useState('');
  const [creating, setCreating] = React.useState(false);
  const [jiraProjects, setJiraProjects] = React.useState(null);  // null=not loaded, []=[]=empty
  const [jiraSpaces, setJiraSpaces] = React.useState(null);
  const [loadingJira, setLoadingJira] = React.useState(false);
  const sidebarWidth = layout.isMobile ? Math.max(280, Math.min(layout.width - 24, 320)) : 240;

  const fields = (projects && projects.length) ? projects : [
    { id: 'afeela-shm', name: 'Afeela · SHM', sub: 'Safety Host Module · ECU', emoji: '🚗', hue: 22 },
  ];
  const rooms = [
    { id: 'porch',    label: 'The porch',     icon: G_ICONS.home,     sub: 'dashboard' },
    { id: 'chores',   label: 'Chore board',   icon: G_ICONS.kanban,   sub: 'kanban · live' },
    { id: 'kitchen',  label: 'Kitchen table', icon: G_ICONS.chat,     sub: 'chat with agents' },
    { id: 'shed',     label: 'Tool shed',     icon: G_ICONS.tools,    sub: 'MCP connectors' },
    { id: 'workshop', label: 'Workshop',      icon: G_ICONS.code,     sub: 'IDE · terminal' },
    { id: 'windmill', label: 'Windmill',      icon: G_ICONS.bolt,     sub: 'automations' },
    { id: 'reqs',     label: 'Requirements',  icon: G_ICONS.check,    sub: 'reqs · coverage' },
    { id: 'records',  label: 'Record room',   icon: G_ICONS.file,     sub: 'traceability & runs' },
    { id: 'settings', label: 'Settings',      icon: G_ICONS.gear,     sub: 'preferences' },
  ];

  async function loadJiraData() {
    if (jiraProjects !== null || loadingJira) return;
    setLoadingJira(true);
    try {
      const [pRes, sRes] = await Promise.all([
        fetch('/api/atlassian/jira-projects'),
        fetch('/api/atlassian/confluence-spaces'),
      ]);
      if (pRes.ok) { const d = await pRes.json(); setJiraProjects(d.projects || []); }
      else setJiraProjects([]);
      if (sRes.ok) { const d = await sRes.json(); setJiraSpaces(d.spaces || []); }
      else setJiraSpaces([]);
    } catch { setJiraProjects([]); setJiraSpaces([]); }
    setLoadingJira(false);
  }

  async function handleCreateProject() {
    if (!newProjName.trim() || creating) return;
    setCreating(true);
    try {
      // Resolve __new__ sentinel values
      const atl = newProjIntegrations.atlassian;
      const integrations = {
        ...newProjIntegrations,
        atlassian: {
          ...atl,
          jiraProjectKey: atl.jiraProjectKey === '__new__' ? '' : atl.jiraProjectKey,
          confluenceSpaceKey: atl.confluenceSpaceKey === '__new__' ? '' : atl.confluenceSpaceKey,
          createJiraProject: atl.jiraProjectKey === '__new__',
          provision: atl.enabled && (atl.confluenceSpaceKey === '__new__' || !atl.confluenceSpaceKey),
        },
      };
      const res = await fetch('/api/projects', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newProjName, desc: newProjDesc, integrations, ...(newProjWorkspace.trim() ? { workspace: newProjWorkspace.trim() } : {}) }),
      });
      const p = await res.json();
      if (p.id) {
        setProjectId(p.id);
        setShowNewProject(false);
        setNewProjName(''); setNewProjDesc('');
        setNewProjIntegrations({ atlassian: { enabled: false, jiraProjectKey: '', confluenceSpaceKey: '', autoSyncTasks: false }, github: { enabled: false, repoFullName: '' } });
        setJiraProjects(null); setJiraSpaces(null);
        onRefresh?.();
      } else alert(p.error || 'Failed');
    } catch (e) { alert(e.message); }
    setCreating(false);
  }

  return (
    <>
      {overlay && open && <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.35)', zIndex: 38 }} />}
      <div style={{
        width: sidebarWidth, maxWidth: 'calc(100vw - 24px)', flexShrink: 0,
        background: isLight ? 'rgba(255,247,238,.78)' : 'rgba(8,3,14,.72)',
        backdropFilter: 'blur(32px)',
        borderRight: `1px solid ${t.border}`,
        display: 'flex', flexDirection: 'column', overflowY: 'auto',
        position: overlay ? 'absolute' : 'relative',
        top: overlay ? 0 : 'auto', left: overlay ? 0 : 'auto', bottom: overlay ? 0 : 'auto',
        zIndex: overlay ? 39 : 3,
        transform: overlay ? (open ? 'translateX(0)' : 'translateX(-108%)') : 'none',
        transition: overlay ? 'transform .24s ease' : 'none',
        boxShadow: overlay && open ? '0 18px 50px rgba(0,0,0,.28)' : 'none',
      }}>
      {/* Brand */}
      <div style={{ padding: '14px 14px 12px', display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{
          width: 32, height: 32, borderRadius: 10, flexShrink: 0,
          background: `conic-gradient(from 200deg, ${t.purple}, ${t.orange}, ${t.purpleDeep}, ${t.purple})`,
          boxShadow: `0 6px 22px ${t.orange}44`, position: 'relative',
        }}>
          <div style={{ position: 'absolute', inset: 4, borderRadius: 6, background: isLight ? '#fff' : t.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontFamily: 'Fraunces, serif', fontWeight: 700, color: t.orange }}>G</div>
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontFamily: 'Fraunces, serif', fontSize: 15.5, fontWeight: 600, color: t.text, letterSpacing: -.2 }}>Gavirila</div>
          <div style={{ fontSize: 9.5, color: t.textDim, letterSpacing: .7, textTransform: 'uppercase', fontWeight: 500 }}>Homestead · v0.7</div>
        </div>
        <button onClick={() => setMode(isLight ? 'dark' : 'light')} title={isLight ? 'Dusk' : 'Dawn'} style={{
          width: 28, height: 28, borderRadius: 14, background: 'transparent', color: t.textDim,
          border: `1px solid ${t.border}`, cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <GIcon d={isLight ? G_ICONS.moon : G_ICONS.sun} size={13} />
        </button>
        {overlay && (
          <button onClick={onClose} title="Close menu" style={{
            width: 28, height: 28, borderRadius: 14, background: 'transparent', color: t.textDim,
            border: `1px solid ${t.border}`, cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <GIcon d={G_ICONS.x} size={12} />
          </button>
        )}
      </div>

      <div style={{ padding: '0 10px' }}>
        <button onClick={() => onPostChore?.()} style={{
          width: '100%', padding: '10px 12px', borderRadius: 9, border: 'none', cursor: 'pointer',
          background: `linear-gradient(135deg, ${t.orange}, ${t.orangeHot})`,
          color: isLight ? '#fff' : '#1a0f06', fontWeight: 600, fontSize: 12.5,
          display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center',
          boxShadow: `0 6px 20px ${t.orange}44`,
        }}>
          <GIcon d={G_ICONS.plus} size={12} stroke={2.2} />
          Post a new chore
        </button>
      </div>

      {wsOk !== undefined && (
        <div style={{ padding: '10px 14px 0', display: 'flex', alignItems: 'center', gap: 6, fontSize: 9.5, color: t.textDimmer, letterSpacing: .5, textTransform: 'uppercase', fontWeight: 600 }}>
          <GDot color={offline ? t.red : (wsOk ? t.green : t.yellow)} pulse={!offline && wsOk} size={6}/>
          <span>{offline ? 'backend offline' : wsOk ? 'live · ws connected' : 'reconnecting…'}</span>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', padding: '16px 14px 6px' }}>
        <div style={{ fontSize: 9.5, color: t.textDimmer, letterSpacing: .9, textTransform: 'uppercase', fontWeight: 600, flex: 1 }}>Fields on the land</div>
        <button onClick={() => setShowNewProject(!showNewProject)} title="New project" style={{
          width: 18, height: 18, borderRadius: 5, background: t.chipBg, border: `1px solid ${t.border}`,
          color: t.textDim, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}><GIcon d={G_ICONS.plus} size={9} stroke={2.4}/></button>
      </div>

      {showNewProject && (
        <div style={{ margin: '0 8px 6px', padding: 10, borderRadius: 8, background: t.surface2, border: `1px solid ${t.borderHot}`, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <input value={newProjName} onChange={e => setNewProjName(e.target.value)} placeholder="Project name" style={{
            padding: '6px 8px', borderRadius: 6, border: `1px solid ${t.border}`, background: t.chipBg,
            color: t.text, fontSize: 12, fontFamily: 'inherit', outline: 'none',
          }}/>
          <input value={newProjDesc} onChange={e => setNewProjDesc(e.target.value)} placeholder="Description (optional)" style={{
            padding: '6px 8px', borderRadius: 6, border: `1px solid ${t.border}`, background: t.chipBg,
            color: t.text, fontSize: 11, fontFamily: 'inherit', outline: 'none',
          }}/>
          <input value={newProjWorkspace} onChange={e => setNewProjWorkspace(e.target.value)} placeholder="Workspace path (optional, e.g. F:\myProject)" style={{
            padding: '6px 8px', borderRadius: 6, border: `1px solid ${t.border}`, background: t.chipBg,
            color: t.text, fontSize: 11, fontFamily: 'inherit', outline: 'none',
          }}/>
          {/* Integration toggles */}
          <details style={{ fontSize: 11, color: t.textDim }}>
            <summary style={{ cursor: 'pointer', fontWeight: 600, padding: '2px 0', color: t.textDim, userSelect: 'none' }}>Integrations</summary>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 6 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 11 }}>
                <input type="checkbox" checked={newProjIntegrations.atlassian.enabled}
                  onChange={e => {
                    setNewProjIntegrations(f => ({ ...f, atlassian: { ...f.atlassian, enabled: e.target.checked } }));
                    if (e.target.checked) loadJiraData();
                  }} />
                Jira + Confluence (uses .env credentials)
              </label>
              {newProjIntegrations.atlassian.enabled && <>
                {loadingJira && <div style={{ fontSize: 10, color: t.textDimmer }}>Loading Jira projects…</div>}
                {jiraProjects && jiraProjects.length > 0 ? (
                  <select value={newProjIntegrations.atlassian.jiraProjectKey}
                    onChange={e => setNewProjIntegrations(f => ({ ...f, atlassian: { ...f.atlassian, jiraProjectKey: e.target.value } }))}
                    style={{ padding: '5px 7px', borderRadius: 5, border: `1px solid ${t.border}`, background: t.chipBg, color: t.text, fontSize: 11, fontFamily: 'inherit' }}>
                    <option value="">— link existing Jira project —</option>
                    {jiraProjects.map(p => <option key={p.key} value={p.key}>{p.key} — {p.name}</option>)}
                    <option value="__new__">+ create new Jira project</option>
                  </select>
                ) : (
                  <input value={newProjIntegrations.atlassian.jiraProjectKey}
                    onChange={e => setNewProjIntegrations(f => ({ ...f, atlassian: { ...f.atlassian, jiraProjectKey: e.target.value } }))}
                    placeholder="Jira Project Key (e.g. REQ)" style={{ padding: '5px 7px', borderRadius: 5, border: `1px solid ${t.border}`, background: t.chipBg, color: t.text, fontSize: 11, fontFamily: 'inherit', outline: 'none' }}/>
                )}
                {jiraSpaces && jiraSpaces.length > 0 ? (
                  <select value={newProjIntegrations.atlassian.confluenceSpaceKey}
                    onChange={e => setNewProjIntegrations(f => ({ ...f, atlassian: { ...f.atlassian, confluenceSpaceKey: e.target.value } }))}
                    style={{ padding: '5px 7px', borderRadius: 5, border: `1px solid ${t.border}`, background: t.chipBg, color: t.text, fontSize: 11, fontFamily: 'inherit' }}>
                    <option value="">— link existing Confluence space —</option>
                    {jiraSpaces.map(s => <option key={s.key} value={s.key}>{s.key} — {s.name}</option>)}
                    <option value="__new__">+ create new space</option>
                  </select>
                ) : (
                  <input value={newProjIntegrations.atlassian.confluenceSpaceKey}
                    onChange={e => setNewProjIntegrations(f => ({ ...f, atlassian: { ...f.atlassian, confluenceSpaceKey: e.target.value } }))}
                    placeholder="Confluence Space Key (e.g. ENG)" style={{ padding: '5px 7px', borderRadius: 5, border: `1px solid ${t.border}`, background: t.chipBg, color: t.text, fontSize: 11, fontFamily: 'inherit', outline: 'none' }}/>
                )}
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 10.5, color: t.textDim }}>
                  <input type="checkbox" checked={newProjIntegrations.atlassian.autoSyncTasks || false}
                    onChange={e => setNewProjIntegrations(f => ({ ...f, atlassian: { ...f.atlassian, autoSyncTasks: e.target.checked } }))} />
                  Auto-create Jira ticket for each new task
                </label>
              </>}
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 11 }}>
                <input type="checkbox" checked={newProjIntegrations.github.enabled}
                  onChange={e => setNewProjIntegrations(f => ({ ...f, github: { ...f.github, enabled: e.target.checked } }))} />
                GitHub (uses GITHUB_TOKEN from .env)
              </label>
              {newProjIntegrations.github.enabled && (
                <input value={newProjIntegrations.github.repoFullName}
                  onChange={e => setNewProjIntegrations(f => ({ ...f, github: { ...f.github, repoFullName: e.target.value } }))}
                  placeholder="Repo (org/repo)" style={{ padding: '5px 7px', borderRadius: 5, border: `1px solid ${t.border}`, background: t.chipBg, color: t.text, fontSize: 11, fontFamily: 'inherit', outline: 'none' }}/>
              )}
            </div>
          </details>
          <button onClick={handleCreateProject} disabled={creating || !newProjName.trim()} style={{
            padding: '7px 12px', borderRadius: 7, border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 600,
            background: `linear-gradient(135deg, ${t.orange}, ${t.orangeHot})`,
            color: isLight ? '#fff' : '#1a0f06', opacity: creating ? .5 : 1,
          }}>{creating ? 'Creating…' : 'Create project'}</button>
        </div>
      )}

      <div style={{ padding: '0 8px', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {fields.map((f) => {
          const active = projectId === f.id;
          const hasAtlassian = f.integrations?.atlassian?.enabled;
          return (
            <React.Fragment key={f.id}>
              <button onClick={() => setProjectId(f.id)} style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '8px 8px', borderRadius: 8,
                background: active ? (isLight ? 'rgba(234,90,28,.1)' : 'linear-gradient(135deg, rgba(255,138,76,.16), rgba(168,85,247,.12))') : 'transparent',
                border: active ? `1px solid ${t.borderHot}` : '1px solid transparent',
                color: active ? t.text : t.textDim,
                cursor: 'pointer', textAlign: 'left', width: '100%', transition: 'all .15s',
              }}>
                <div style={{
                  width: 26, height: 26, borderRadius: 7, flexShrink: 0,
                  background: `linear-gradient(135deg, hsl(${f.hue || 22},70%,60%), hsl(${((f.hue||22)+40)%360},60%,45%))`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13,
                }}>{f.emoji || '📁'}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: active ? 600 : 500, fontFamily: 'Fraunces, serif' }}>{f.name}</div>
                  <div style={{ fontSize: 9.5, color: t.textDimmer, fontStyle: 'italic' }}>{f.sub}</div>
                </div>
                {active && <GDot color={t.green} size={6} pulse />}
              </button>
              {active && hasAtlassian && (
                <button onClick={async () => {
                  try {
                    const r = await fetch(`/api/projects/${f.id}/sync`, { method: 'POST' });
                    const d = await r.json();
                    alert(`Sync done — Jira: ${d.jira?.synced ?? 0}, Confluence: ${d.confluence?.synced ?? 0}`);
                  } catch (err) { alert('Sync failed: ' + err.message); }
                }} style={{
                  margin: '0 4px 2px 36px', padding: '4px 8px', borderRadius: 6, border: `1px solid ${t.border}`,
                  background: 'transparent', color: t.textDim, cursor: 'pointer', fontSize: 10, fontWeight: 600,
                  display: 'flex', alignItems: 'center', gap: 4,
                }}>
                  ↻ Sync Jira
                </button>
              )}
              {active && (
                <button onClick={async () => {
                  if (!confirm(`Delete project "${f.name}" and ALL its tasks, reqs, runs, bugs, and vault notes? This cannot be undone.`)) return;
                  try {
                    const r = await GApi.deleteProject(f.id);
                    if (r.ok) {
                      window.GApi?.fetchState?.().then(s => {
                        if (s) {
                          const remaining = s.projects || [];
                          if (remaining.length) setProjectId(remaining[0].id);
                        }
                      });
                    } else { alert('Delete failed: ' + (r.error || 'unknown')); }
                  } catch (err) { alert('Delete failed: ' + err.message); }
                }} style={{
                  margin: '0 4px 2px 36px', padding: '4px 8px', borderRadius: 6, border: `1px solid ${t.border}`,
                  background: 'transparent', color: '#e55', cursor: 'pointer', fontSize: 10, fontWeight: 600,
                  display: 'flex', alignItems: 'center', gap: 4,
                }}>
                  🗑 Delete project
                </button>
              )}
            </React.Fragment>
          );
        })}
      </div>

      <div style={{ fontSize: 9.5, color: t.textDimmer, letterSpacing: .9, textTransform: 'uppercase', padding: '16px 14px 6px', fontWeight: 600 }}>Rooms on the porch</div>
      <div style={{ padding: '0 8px', display: 'flex', flexDirection: 'column', gap: 1 }}>
        {rooms.map((r) => {
          const active = route === r.id;
          return (
            <button key={r.id} onClick={() => setRoute(r.id)} style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', borderRadius: 7,
              background: active ? (isLight ? 'rgba(234,90,28,.08)' : 'rgba(255,255,255,.045)') : 'transparent',
              border: 'none', cursor: 'pointer', textAlign: 'left', width: '100%',
              color: active ? t.text : t.textDim, transition: 'all .12s', position: 'relative',
            }}>
              {active && <div style={{ position: 'absolute', left: 0, top: 8, bottom: 8, width: 2, borderRadius: 1, background: t.orange }} />}
              <span style={{ color: active ? t.orange : t.textDimmer }}>
                <GIcon d={r.icon} size={13} stroke={active ? 2 : 1.6} />
              </span>
              <span style={{ fontSize: 12.5, fontWeight: active ? 500 : 400 }}>{r.label}</span>
              <div style={{ flex: 1 }} />
            </button>
          );
        })}
      </div>

      <div style={{ flex: 1 }} />

      {/* User */}
      <button onClick={() => onOpenSettings?.()} style={{ margin: '0 10px 10px', padding: '8px 10px', borderRadius: 8, background: t.chipBg, border: `1px solid ${t.border}`, display: 'flex', alignItems: 'center', gap: 10, width: 'calc(100% - 20px)', cursor: 'pointer', color: t.text, textAlign: 'left' }}>
        <div style={{ width: 26, height: 26, borderRadius: 13, background: `linear-gradient(135deg, ${t.orange}, ${t.purple})`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 600, color: '#fff' }}>G</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11.5, color: t.text, fontWeight: 500 }}>Gavirila</div>
          <div style={{ fontSize: 9.5, color: t.textDimmer }}>local · homestead</div>
        </div>
        <GIcon d={G_ICONS.gear} size={11} />
      </button>
      </div>
    </>
  );
}

function GTopbar({ route, projectId, notifications, onToggleDrawer, onToggleSidebar, showMenuButton, onOpenNotifications, pool, projects, onOpenSearch, recentToolCalls = [] }) {
  const { t, mode } = useG();
  const layout = useGLayout();
  const proj = (projects || []).find(p => p.id === projectId);
  const project = proj ? proj.name : projectId;
  const roomLabel = {
    porch: 'the porch', chores: 'chore board', kitchen: 'kitchen table', shed: 'tool shed',
    workshop: 'workshop', windmill: 'windmill', reqs: 'requirements', records: 'record room', settings: 'settings',
  }[route];

  // Latest tool call to display as a live activity indicator
  const latest = recentToolCalls[0];
  const latestAge = latest ? Math.round((Date.now() - latest.ts) / 1000) : null;
  const showLatest = latest && !layout.isCompact && !layout.isMobile;

  return (
    <div style={{
      minHeight: 48, flexShrink: 0, padding: layout.isMobile ? '10px 14px' : '0 16px 0 20px',
      display: 'flex', alignItems: 'center', gap: 12,
      flexWrap: layout.isMobile ? 'wrap' : 'nowrap',
      borderBottom: `1px solid ${t.border}`,
      position: 'relative', zIndex: 2,
      background: mode === 'light' ? 'rgba(255,255,255,.4)' : 'rgba(10,4,16,.25)',
      backdropFilter: 'blur(20px)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: layout.isMobile ? '1 1 auto' : '0 1 auto' }}>
        {showMenuButton && (
          <button onClick={onToggleSidebar} title="Open navigation" style={{ width: 30, height: 30, borderRadius: 15, background: t.chipBg, border: `1px solid ${t.border}`, color: t.text, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <GIcon d={G_ICONS.menu} size={13} />
          </button>
        )}
        <div style={{ fontFamily: 'Fraunces, serif', fontSize: 14, color: t.text, fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{project}</div>
        <div style={{ color: t.textMuted }}>/</div>
        <div style={{ fontSize: 12.5, color: t.textDim, fontStyle: 'italic', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{roomLabel}</div>
      </div>

      {/* Live activity strip — shows the most recent tool call across all agents */}
      {showLatest && (
        <div title={JSON.stringify(latest.args || {}, null, 2)} style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '4px 10px', borderRadius: 12, marginLeft: 12,
          background: t.chipBg, border: `1px solid ${t.borderStrong || t.border}`,
          fontSize: 10.5, fontFamily: 'JetBrains Mono, monospace',
          color: t.textDim, maxWidth: 460, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
        }}>
          <GDot color={latestAge < 3 ? t.orange : t.textDim} size={5} pulse={latestAge < 3} />
          <b style={{ color: t.orange, fontWeight: 600 }}>{latest.agent || 'agent'}</b>
          <span style={{ color: t.text }}>·</span>
          <span style={{ color: t.text }}>{latest.name}</span>
          <span style={{ color: t.textDimmer }}>· {latestAge}s ago</span>
        </div>
      )}

      <div style={{ flex: 1 }} />

      {/* Search bar */}
      <div onClick={onOpenSearch} style={{
        height: 30, display: 'flex', alignItems: 'center', gap: 8,
        padding: '0 10px 0 12px', borderRadius: 15,
        background: t.chipBg, border: `1px solid ${t.border}`,
        minWidth: layout.isMobile ? '100%' : (layout.isCompact ? 220 : 320),
        flex: layout.isMobile ? '1 0 100%' : '0 1 360px',
        order: layout.isMobile ? 3 : 0,
        color: t.textDim, fontSize: 12, cursor: 'pointer',
      }}>
        <GIcon d={G_ICONS.search} size={12} />
        <span style={{ flex: 1, fontStyle: 'italic' }}>Ask Gavirila — REQs, tests, code, runs…</span>
        <kbd style={{ fontSize: 9.5, padding: '1px 5px', borderRadius: 3, background: t.chipBg, border: `1px solid ${t.border}`, fontFamily: 'inherit', color: t.textDim }}>{layout.kbdLabel} K</kbd>
      </div>

      {pool && pool.length > 0 && (
        <div title={`LLM pool: ${pool.length} provider(s)`} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 10px', height: 30, borderRadius: 15, background: t.chipBg, border: `1px solid ${t.border}`, fontSize: 10.5, color: t.textDim, fontFamily: 'JetBrains Mono, monospace' }}>
          <GDot color={t.green} size={5} />
          {pool.length}× LLM
        </div>
      )}

      <button onClick={onOpenNotifications} title="Open recent records" style={{ position: 'relative', width: 30, height: 30, borderRadius: 15, background: t.chipBg, border: `1px solid ${t.border}`, color: t.text, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <GIcon d={G_ICONS.bell} size={13} />
        {notifications > 0 && (
          <div style={{ position: 'absolute', top: -3, right: -3, minWidth: 15, height: 15, padding: '0 4px', borderRadius: 8, background: t.orange, color: mode === 'light' ? '#fff' : '#1a0f06', fontSize: 9, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', border: `2px solid ${mode === 'light' ? '#fff' : t.bg}` }}>{notifications}</div>
        )}
      </button>
      <button onClick={onToggleDrawer} title="Global kitchen table" style={{ width: 30, height: 30, borderRadius: 15, background: `linear-gradient(135deg, ${t.orange}44, ${t.purple}44)`, border: `1px solid ${t.borderHot}`, color: t.text, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <GIcon d={G_ICONS.chat} size={13} />
      </button>
    </div>
  );
}

// ----- Command Palette -----
function G_CommandPalette({ onClose, onSelect }) {
  const { t, mode } = useG();
  const layout = useGLayout();
  const [query, setQuery] = React.useState('');
  const [results, setResults] = React.useState([]);
  const [searching, setSearching] = React.useState(false);
  const inputRef = React.useRef(null);

  React.useEffect(() => {
    inputRef.current?.focus();
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  React.useEffect(() => {
    if (!query.trim()) { setResults([]); return; }
    const tId = setTimeout(async () => {
      setSearching(true);
      const q = query.toLowerCase();
      const roomResults = [
        { type: 'room', label: 'The porch', route: 'porch', id: 'room-porch', icon: G_ICONS.home },
        { type: 'room', label: 'Chore board', route: 'chores', id: 'room-chores', icon: G_ICONS.kanban },
        { type: 'room', label: 'Kitchen table', route: 'kitchen', id: 'room-kitchen', icon: G_ICONS.chat },
        { type: 'room', label: 'Tool shed', route: 'shed', id: 'room-shed', icon: G_ICONS.tools },
        { type: 'room', label: 'Workshop', route: 'workshop', id: 'room-workshop', icon: G_ICONS.code },
        { type: 'room', label: 'Windmill', route: 'windmill', id: 'room-windmill', icon: G_ICONS.bolt },
        { type: 'room', label: 'Requirements', route: 'reqs', id: 'room-reqs', icon: G_ICONS.check },
        { type: 'room', label: 'Record room', route: 'records', id: 'room-records', icon: G_ICONS.file },
        { type: 'room', label: 'Settings', route: 'settings', id: 'room-settings', icon: G_ICONS.gear },
      ].filter((item) => item.label.toLowerCase().includes(q) || item.route.includes(q));
      try {
        const res = await fetch('/api/vault/files');
        const data = await res.json();
        if (data.files) {
          const filtered = data.files.filter(f => f.toLowerCase().includes(q)).slice(0, Math.max(0, 8 - roomResults.length));
          setResults(roomResults.concat(filtered.map(f => ({ type: 'file', label: f, id: f, icon: G_ICONS.file }))));
        } else {
          setResults(roomResults);
        }
      } catch (e) {
        setResults(roomResults.length ? roomResults : [{ type: 'error', label: 'Search failed', id: 'error', icon: G_ICONS.warn }]);
      }
      setSearching(false);
    }, 300);
    return () => clearTimeout(tId);
  }, [query]);

  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 300, background: 'rgba(0,0,0,.4)', backdropFilter: 'blur(4px)', display: 'flex', paddingTop: layout.isMobile ? 24 : '15vh', justifyContent: 'center', paddingLeft: 12, paddingRight: 12 }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ width: layout.isMobile ? '100%' : 560, maxWidth: 560, background: t.surface, borderRadius: 16, border: `1px solid ${t.borderStrong}`, boxShadow: t.shadow, overflow: 'hidden', display: 'flex', flexDirection: 'column', maxHeight: layout.isMobile ? '78vh' : '60vh' }}>
        <div style={{ padding: '16px', borderBottom: `1px solid ${t.border}`, display: 'flex', alignItems: 'center', gap: 12 }}>
          <GIcon d={G_ICONS.search} size={16} stroke={2} />
          <input ref={inputRef} value={query} onChange={e => setQuery(e.target.value)} placeholder="Search files, requirements, bugs..." style={{ flex: 1, background: 'transparent', border: 'none', color: t.text, fontSize: 16, outline: 'none', fontFamily: 'inherit' }} />
          <kbd style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: t.chipBg, border: `1px solid ${t.border}`, color: t.textDim }}>ESC</kbd>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
          {searching && <div style={{ padding: 20, textAlign: 'center', color: t.textDim, fontSize: 13, fontStyle: 'italic' }}>Searching...</div>}
          {!searching && query && results.length === 0 && <div style={{ padding: 20, textAlign: 'center', color: t.textDim, fontSize: 13, fontStyle: 'italic' }}>No results found</div>}
          {!searching && results.map((r, i) => (
            <button key={r.id + i} onClick={() => onSelect(r)} style={{ width: '100%', padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 12, background: 'transparent', border: 'none', cursor: 'pointer', borderRadius: 8, textAlign: 'left', color: t.text }}>
              <div style={{ width: 24, height: 24, borderRadius: 6, background: t.chipBg, display: 'flex', alignItems: 'center', justifyContent: 'center', color: t.textDim }}>
                <GIcon d={r.icon || (r.type === 'file' ? G_ICONS.file : G_ICONS.bolt)} size={12} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                <div style={{ fontSize: 13, color: t.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label}</div>
                {r.route && <div style={{ fontSize: 10, color: t.textDim, fontFamily: 'JetBrains Mono, monospace' }}>go to {r.route}</div>}
              </div>
            </button>
          ))}
          {!query && (
            <div style={{ padding: 20, textAlign: 'center', color: t.textDim, fontSize: 13, fontStyle: 'italic' }}>Type to jump to a room or open a vault file...</div>
          )}
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { GSidebar, GTopbar, G_CommandPalette });
