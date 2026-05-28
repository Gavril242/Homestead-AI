// Gavirila v2 — main app shell, now wired to the Node backend.
//
// Reads its initial snapshot from GET /api/state, subscribes to /ws for
// live deltas, and proxies chat through POST /api/agents/:id/messages.
// If the backend is unreachable, the app falls back to G_OFFLINE_FALLBACK
// so the UI never goes blank.

window.G_OFFLINE_FALLBACK = {
  projectId: 'afeela-shm',
  offline: true,
  projects: [
    { id: 'afeela-shm', name: 'Afeela · SHM', sub: 'Safety Host Module · ECU', emoji: '🚗', hue: 22 },
  ],
  agents: [], tasks: [], reqs: [], runs: [], bugs: [], connectors: [], pipelines: [],
  events: [{ id: 1, who: 'system', what: 'backend offline — start with', obj: 'npm start', icon: 'warn', color: 'yellow', time: 'now' }],
  pool: [], welcome: false,
};

// ---------- Notifications ----------
function G_Toast({ n, onDismiss }) {
  const { t, mode } = useG();
  React.useEffect(() => { const tm = setTimeout(onDismiss, 5000); return () => clearTimeout(tm); }, []);
  const colorMap = { green: t.green, orange: t.orange, purple: t.purple, yellow: t.yellow, red: t.red };
  const iconMap  = { check2: G_ICONS.check2, tools: G_ICONS.tools, warn: G_ICONS.warn, bolt: G_ICONS.bolt, chat: G_ICONS.chat, bell: G_ICONS.bell };
  const color = colorMap[n.color] || t.orange;
  const icon = iconMap[n.icon] || G_ICONS.bell;
  return (
    <div style={{
      padding: '10px 12px', borderRadius: 10,
      background: mode === 'light' ? 'rgba(255,255,255,.95)' : 'rgba(30,14,52,.92)',
      backdropFilter: 'blur(20px)',
      border: `1px solid ${n.kind === 'warn' ? t.borderHot : t.borderStrong}`,
      boxShadow: t.shadow, minWidth: 300, maxWidth: 360,
      display: 'flex', alignItems: 'flex-start', gap: 10,
      animation: 'g-toast-in .28s cubic-bezier(.2,1.2,.3,1)',
      position: 'relative', overflow: 'hidden',
    }}>
      <div style={{ width: 28, height: 28, borderRadius: 8, flexShrink: 0, background: `${color}22`, color, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <GIcon d={icon} size={13}/>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, color: t.text, fontWeight: 600, lineHeight: 1.35, fontFamily: 'Fraunces, serif' }}>{n.title}</div>
        <div style={{ fontSize: 11, color: t.textDim, lineHeight: 1.4, marginTop: 2 }}>{n.body}</div>
      </div>
      <button onClick={onDismiss} style={{ background: 'transparent', border: 'none', color: t.textDimmer, cursor: 'pointer', padding: 2, display: 'flex' }}>
        <GIcon d={G_ICONS.x} size={11}/>
      </button>
      <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 2, background: `${color}33` }}>
        <div style={{ height: '100%', background: color, animation: 'g-toast-bar 5s linear forwards' }}/>
      </div>
    </div>
  );
}

function G_ToastStack({ toasts, dismiss }) {
  return (
    <div style={{ position: 'absolute', top: 56, right: 16, display: 'flex', flexDirection: 'column', gap: 8, zIndex: 100, pointerEvents: 'none' }}>
      {toasts.map((n) => (
        <div key={n.id} style={{ pointerEvents: 'auto' }}>
          <G_Toast n={n} onDismiss={() => dismiss(n.id)}/>
        </div>
      ))}
    </div>
  );
}

// ---------- Onboarding (Afeela context) ----------
function G_Welcome({ onDone }) {
  const { t, mode } = useG();
  const [step, setStep] = React.useState(0);
  const isLight = mode === 'light';
  const steps = [
    { title: 'Welcome to Gavirila.',          sub: "A homestead for AI agents that test SW and HW via SW. Today we're running the Sony Afeela SHM (Safety Host Module) project end-to-end.",                                                                                                       art: '🏡', cta: 'Walk me through' },
    { title: 'Three fields.',                 sub: 'Afeela SHM is the lead — the safety host ECU. Sister fields ADAS and HMI share tooling, agents, and the same Obsidian brain.',                                                                                                                  art: '🚗', cta: 'Next' },
    { title: 'The hands.',                    sub: 'Aria reads requirements. Delphi designs SWCs. Forge writes code. Vince runs CAPL. Ingo drives CI. Hunter debugs. Scribe documents. Conductor ties it all together.',                                                                            art: '🧑‍🌾', cta: 'Next' },
    { title: 'The tools.',                    sub: 'Jira, Confluence, DOORS, Vector CANoe + CAPL, Jenkins, Git, AUTOSAR Builder, Python. Every connector is an MCP — plug once, every agent uses it.',                                                                                              art: '🔧', cta: 'Next' },
    { title: 'The brain.',                    sub: 'Every action lands in an Obsidian-style markdown vault: projects → reqs → components → tests → runs. The graph tells you what breaks if you change something.',                                                                                  art: '🧠', cta: 'Next' },
    { title: "Let's ship SHM v0.5.",          sub: "Post a chore, watch the pipelines, kick off a HIL soak. Bench-03's warm.",                                                                                                                                                                       art: '⚡', cta: 'Open Gavirila' },
  ];
  const s = steps[step];
  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 200,
      background: isLight ? 'rgba(253,243,231,.85)' : 'rgba(6,2,9,.85)',
      backdropFilter: 'blur(30px)', display: 'flex', alignItems: 'center', justifyContent: 'center',
      animation: 'g-fade-in .4s ease-out',
    }}>
      <div style={{
        width: 540, padding: 36, borderRadius: 20,
        background: t.surface, backdropFilter: 'blur(30px)',
        border: `1px solid ${t.borderStrong}`,
        boxShadow: `0 40px 100px rgba(0,0,0,.5), 0 0 80px ${t.orange}22`,
        textAlign: 'center', position: 'relative',
      }}>
        <div style={{ fontSize: 72, marginBottom: 20, filter: `drop-shadow(0 8px 24px ${t.orange}66)`, animation: 'g-float 3s ease-in-out infinite' }}>{s.art}</div>
        <div style={{ fontFamily: 'Fraunces, serif', fontSize: 32, fontWeight: 500, color: t.text, letterSpacing: -.6, lineHeight: 1.1 }}>{s.title}</div>
        <div style={{ fontSize: 14, color: t.textDim, lineHeight: 1.55, marginTop: 12, textWrap: 'pretty' }}>{s.sub}</div>
        <div style={{ display: 'flex', gap: 6, justifyContent: 'center', marginTop: 22 }}>
          {steps.map((_, i) => (
            <div key={i} style={{ width: i === step ? 20 : 6, height: 6, borderRadius: 3, background: i === step ? t.orange : (i < step ? `${t.orange}66` : t.textMuted), transition: 'all .3s' }}/>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 24, justifyContent: 'center' }}>
          {step > 0 && <button onClick={() => setStep(step - 1)} style={{ padding: '10px 18px', borderRadius: 9, cursor: 'pointer', background: t.chipBg, color: t.text, border: `1px solid ${t.border}`, fontSize: 12.5, fontWeight: 500 }}>Back</button>}
          <button onClick={() => step < steps.length - 1 ? setStep(step + 1) : onDone()} style={{ padding: '10px 22px', borderRadius: 9, border: 'none', cursor: 'pointer', background: `linear-gradient(135deg, ${t.orange}, ${t.orangeHot})`, color: isLight ? '#fff' : '#1a0f06', fontSize: 12.5, fontWeight: 700, boxShadow: `0 6px 20px ${t.orange}55` }}>{s.cta}</button>
        </div>
        <button onClick={onDone} style={{ position: 'absolute', top: 14, right: 14, background: 'transparent', border: 'none', color: t.textDimmer, cursor: 'pointer', fontSize: 11, padding: 4 }}>skip intro</button>
      </div>
    </div>
  );
}

// ---------- Main App ----------
function GavirilaApp({ width = 1440, height = 900 }) {
  const [mode, setMode] = React.useState('dark');
  const [route, setRoute] = React.useState('porch');
  const [projectId, setProjectId] = React.useState('afeela-shm');
  const [navOpen, setNavOpen] = React.useState(false);
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [welcome, setWelcome] = React.useState(true);
  const [selectedChore, setSelectedChore] = React.useState(null);
  const [selectedHandId, setSelectedHandId] = React.useState(null);
  const [selectedRecordPath, setSelectedRecordPath] = React.useState(null);
  const [showChoreForm, setShowChoreForm] = React.useState(false);
  const [showSearch, setShowSearch] = React.useState(false);

  const { state, setState, toasts, dismissToast, wsOk } = useLiveState();
  const layout = React.useMemo(() => {
    const isMobile = width < 900;
    const isTablet = width < 1180;
    const isCompact = width < 1360;
    const sidebarOverlay = width < 1120;
    const detailOverlay = width < 1520;
    const stackPanels = width < 1180;
    const platform = typeof navigator !== 'undefined' ? navigator.platform : '';
    const isMac = /Mac|iPhone|iPad/.test(platform);
    return {
      width,
      height,
      isMobile,
      isTablet,
      isCompact,
      sidebarOverlay,
      detailOverlay,
      stackPanels,
      kbdLabel: isMac ? '⌘' : 'Ctrl',
    };
  }, [width, height]);

  React.useEffect(() => {
    if (state.loading) return;
    setWelcome(!!state.welcome);
  }, [state.loading]);

  React.useEffect(() => {
    setNavOpen(!layout.sidebarOverlay);
  }, [layout.sidebarOverlay]);

  const closeSidebarIfOverlay = React.useCallback(() => {
    if (layout.sidebarOverlay) setNavOpen(false);
  }, [layout.sidebarOverlay]);

  const navigate = React.useCallback((nextRoute) => {
    setRoute(nextRoute);
    setSelectedChore(null);
    closeSidebarIfOverlay();
  }, [closeSidebarIfOverlay]);

  const openChoreComposer = React.useCallback(() => {
    setShowChoreForm(true);
    closeSidebarIfOverlay();
  }, [closeSidebarIfOverlay]);

  const openAgentChat = React.useCallback((handId) => {
    if (handId) setSelectedHandId(handId);
    setRoute('kitchen');
    closeSidebarIfOverlay();
  }, [closeSidebarIfOverlay]);

  const openRecord = React.useCallback((path) => {
    if (!path) return;
    setSelectedRecordPath(path);
    setRoute('records');
    setShowSearch(false);
    closeSidebarIfOverlay();
  }, [closeSidebarIfOverlay]);

  // Project switch — atomically evicts stale cross-project tasks and sets the new
  // projectId in BOTH local state AND shared state so the WS guard works immediately.
  const switchProject = React.useCallback((id) => {
    setProjectId(id);
    setState((prev) => ({
      ...prev,
      projectId: id,
      tasks: (prev.tasks || []).filter((t) => t.project_id === id),
    }));
  }, [setState]);

  React.useEffect(() => {
    const handleKeyDown = (e) => {
      const key = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && key === 'k') {
        e.preventDefault();
        setShowSearch(s => !s);
      }
      if ((e.metaKey || e.ctrlKey) && key === 'j') {
        e.preventDefault();
        setDrawerOpen((open) => !open);
      }
      if (key === 'escape') {
        if (showSearch) {
          setShowSearch(false);
          return;
        }
        if (drawerOpen) {
          setDrawerOpen(false);
          return;
        }
        if (selectedChore && layout.detailOverlay) {
          setSelectedChore(null);
          return;
        }
        if (navOpen && layout.sidebarOverlay) {
          setNavOpen(false);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [drawerOpen, layout.detailOverlay, layout.sidebarOverlay, navOpen, selectedChore, showSearch]);

  React.useEffect(() => {
    if (state.loading) return;
    window.GApi?.fetchState?.(projectId).then((s) => {
      if (s) setState((prev) => ({ ...prev, ...s }));
    }).catch(console.error);
  }, [projectId]);

  const events = state.events || [];
  const chores = (state.tasks || []).filter((t) => t.project_id === projectId);
  const setChores = (updater) => {
    setState((s) => {
      const next = typeof updater === 'function' ? updater(s.tasks || []) : updater;
      try {
        const before = s.tasks || [];
        for (const t of next) {
          const prev = before.find((x) => x.id === t.id);
          if (prev && (prev.status !== t.status || prev.progress !== t.progress)) {
            window.GApi.patchTask(t.id, { status: t.status, progress: t.progress }).catch(() => {});
          }
        }
      } catch {}
      return { ...s, tasks: next };
    });
  };

  const theme = G_THEMES[mode];
  const ctx = { t: theme, mode, setMode };
  const notifCount = toasts.length;

  const roomView = () => {
    if (state.loading) {
      return <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.textDim, fontFamily: 'Fraunces, serif', fontSize: 14, fontStyle: 'italic' }}>booting the homestead…</div>;
    }
    const props = {
      events, chores, tasks: chores, setChores, projectId, onOpenChore: setSelectedChore,
      agents: state.agents, connectors: state.connectors, reqs: state.reqs, runs: state.runs, bugs: state.bugs,
      pool: state.pool, pipelineDefs: state.pipelineDefs, links: state.links,
      recentTraces: state.recentTraces, recentToolCalls: state.recentToolCalls,
      supervisorEvents: state.supervisorEvents,
      notifications: state.notifications, missions: state.missions, gates: state.gates,
      project: (state.projects || []).find((p) => p.id === projectId),
        selectedHandId,
        selectedRecordPath,
        onCreateChore: openChoreComposer,
        onNavigate: navigate,
        onOpenAgent: openAgentChat,
        onOpenRecord: openRecord,
        onAssignChat: (chore) => openAgentChat((chore?.by || '').toLowerCase() || 'forge'),
    };
    
    let activeRoute;
    switch (route) {
      case 'porch':    activeRoute = <G_Porch    {...props}/>; break;
      case 'chores':   activeRoute = <G_Chores   {...props}/>; break;
      case 'kitchen':  activeRoute = <G_Kitchen  {...props}/>; break;
      case 'shed':     activeRoute = <G_Shed     {...props}/>; break;
      case 'workshop': activeRoute = <G_Workshop {...props}/>; break;
      case 'windmill': activeRoute = <G_Windmill {...props}/>; break;
      case 'reqs':     activeRoute = <G_Reqs     {...props}/>; break;
      case 'records':  activeRoute = <G_Records  {...props}/>; break;
      case 'settings': activeRoute = <G_Settings {...props}/>; break;
      default:         activeRoute = <G_Porch    {...props}/>; break;
    }

    const detailWidth = layout.isMobile ? layout.width : Math.min(520, Math.max(360, Math.round(layout.width * 0.36)));

    return (
      <div style={{ flex: 1, display: 'flex', minHeight: 0, position: 'relative', overflow: 'hidden' }}>
        {activeRoute}
        {selectedChore && !layout.detailOverlay && (
          <div style={{ width: detailWidth, borderLeft: `1px solid ${theme.border}`, background: theme.bg, display: 'flex', flexDirection: 'column', flexShrink: 0, minWidth: 360, maxWidth: 520 }}>
            <G_ChoreDetail chore={selectedChore} onClose={() => setSelectedChore(null)} />
          </div>
        )}
        {selectedChore && layout.detailOverlay && (
          <>
            <div onClick={() => setSelectedChore(null)} style={{ position: 'absolute', inset: 0, background: 'rgba(4,2,8,.42)', zIndex: 14 }} />
            <div style={{
              position: 'absolute', top: 0, right: 0, bottom: 0,
              width: detailWidth, maxWidth: '100%', zIndex: 15,
              borderLeft: `1px solid ${theme.borderStrong}`,
              background: theme.bg, display: 'flex', flexDirection: 'column',
              boxShadow: '-20px 0 40px rgba(0,0,0,.28)',
            }}>
              <G_ChoreDetail chore={selectedChore} onClose={() => setSelectedChore(null)} />
            </div>
          </>
        )}
      </div>
    );
  };

  return (
    <G_ThemeCtx.Provider value={ctx}>
      <G_LayoutCtx.Provider value={layout}>
      <style>{`
        @keyframes g-fade-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes g-toast-in { from { opacity: 0; transform: translateX(20px) scale(.96); } to { opacity: 1; transform: translateX(0) scale(1); } }
        @keyframes g-toast-bar { from { width: 100%; } to { width: 0%; } }
        @keyframes g-pulse { 0%, 100% { box-shadow: 0 0 0 0 currentColor; } 50% { box-shadow: 0 0 0 6px transparent; } }
        .g-pulse { animation: g-pulse 1.8s ease-out infinite; }
        @keyframes g-float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-6px); } }
        @keyframes g-flow-bar { 0% { transform: translateX(-100%); } 100% { transform: translateX(200%); } }
        @keyframes g-shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
        @keyframes g-typing { 0%, 60%, 100% { transform: translateY(0); opacity: .5; } 30% { transform: translateY(-3px); opacity: 1; } }
        @keyframes g-spin { to { transform: rotate(360deg); } }
        @keyframes g-blink { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }
        *::-webkit-scrollbar { width: 8px; height: 8px; }
        *::-webkit-scrollbar-track { background: transparent; }
        *::-webkit-scrollbar-thumb { background: ${theme.border}; border-radius: 4px; }
        *::-webkit-scrollbar-thumb:hover { background: ${theme.borderStrong}; }
      `}</style>
      <div style={{
        width, height, display: 'flex', flexDirection: 'column',
        background: theme.bg, color: theme.text, fontSize: 13,
        fontFamily: 'Inter, system-ui, sans-serif',
        position: 'relative', overflow: 'hidden',
        transition: 'background .4s', minWidth: 0, minHeight: 0,
      }}>
        <GLiquid />

        <div style={{ display: 'flex', flex: 1, minHeight: 0, position: 'relative', zIndex: 1 }}>
          <GSidebar route={route} setRoute={navigate} projectId={projectId} setProjectId={switchProject} projects={state.projects || []} wsOk={wsOk} offline={state.offline} onPostChore={openChoreComposer} onRefresh={() => window.GApi?.fetchState?.(projectId).then(s => s && setState(prev => ({ ...prev, ...s })))} onOpenSettings={() => navigate('settings')} overlay={layout.sidebarOverlay} open={!layout.sidebarOverlay || navOpen} onClose={() => setNavOpen(false)} />
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <GTopbar route={route} projectId={projectId} notifications={notifCount} onToggleDrawer={() => setDrawerOpen((o) => !o)} onToggleSidebar={() => setNavOpen((open) => !open)} showMenuButton={layout.sidebarOverlay} onOpenNotifications={() => navigate('records')} pool={state.pool} projects={state.projects || []} onOpenSearch={() => setShowSearch(true)} recentToolCalls={state.recentToolCalls || []} />
            {roomView()}
          </div>
          <G_Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
        </div>

        <G_ToastStack toasts={toasts} dismiss={dismissToast} />
        {welcome && !state.loading && <G_Welcome onDone={() => { setWelcome(false); window.GApi?.dismissWelcome?.().catch(() => {}); }} />}
        {showChoreForm && <G_ChoreFormModal projectId={projectId} onClose={() => setShowChoreForm(false)} onCreated={(task) => { setState(s => ({ ...s, tasks: [...(s.tasks||[]), task] })); setShowChoreForm(false); }} />}
        {showSearch && <G_CommandPalette onClose={() => setShowSearch(false)} onSelect={(r) => {
          if (r?.type === 'file') {
            openRecord(r.id);
            return;
          }
          if (r?.route) navigate(r.route);
          setShowSearch(false);
        }} />}
      </div>
      </G_LayoutCtx.Provider>
    </G_ThemeCtx.Provider>
  );
}

Object.assign(window, { GavirilaApp, G_Welcome, G_Toast });
