// Gavirila v2 — The Porch (dashboard home)
// Full-scroll layout: hero → stats → agents → chore preview + activity + LLM health

function G_Sparkline({ data, color, height = 24, width = 100 }) {
  const max = Math.max(...data), min = Math.min(...data);
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - ((v - min) / (max - min || 1)) * height;
    return `${x},${y}`;
  }).join(' ');
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: 'block', flexShrink: 0 }}>
      <defs>
        <linearGradient id={`sg-${color.replace('#','')}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.4"/>
          <stop offset="100%" stopColor={color} stopOpacity="0"/>
        </linearGradient>
      </defs>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round"/>
      <polygon points={`0,${height} ${pts} ${width},${height}`} fill={`url(#sg-${color.replace('#','')})`}/>
    </svg>
  );
}

function G_HeroCard({ onCreateChore, onOpenWindmill, onViewEvidence, onStirTasks }) {
  const { t, mode } = useG();
  const layout = useGLayout();
  const isLight = mode === 'light';
  const now = new Date();
  const hour = now.getHours();
  const greet = hour < 5 ? "Burnin' the midnight oil" : hour < 12 ? "Mornin'" : hour < 18 ? "Afternoon" : "Evenin'";
  const day = now.toLocaleDateString('en-US', { weekday: 'long' });
  return (
    <div style={{
      padding: '20px 24px', borderRadius: 16,
      background: isLight
        ? 'linear-gradient(135deg, rgba(234,90,28,.1), rgba(234,90,28,.04))'
        : 'linear-gradient(135deg, rgba(168,85,247,.2), rgba(255,138,76,.14))',
      border: `1px solid ${t.borderStrong}`,
      position: 'relative', overflow: 'hidden',
      display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap',
    }}>
      <div style={{ position: 'absolute', right: -40, top: -40, width: 200, height: 200, background: `radial-gradient(circle, ${t.orange}33, transparent 60%)`, filter: 'blur(40px)', pointerEvents: 'none' }} />
      <div style={{ width: 56, height: 56, borderRadius: 14, flexShrink: 0, background: `conic-gradient(from 200deg, ${t.purple}, ${t.orange}, ${t.purpleDeep}, ${t.purple})`, boxShadow: `0 8px 28px ${t.orange}55`, position: 'relative' }}>
        <div style={{ position: 'absolute', inset: 5, borderRadius: 9, background: isLight ? '#fff' : '#1a0820', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24 }}>🏡</div>
      </div>
      <div style={{ flex: 1, minWidth: 200, position: 'relative' }}>
        <div style={{ fontSize: 10, color: t.orange, letterSpacing: .8, textTransform: 'uppercase', fontWeight: 700 }}>{day} · gavirila homestead</div>
        <div style={{ fontFamily: 'Fraunces, serif', fontSize: 26, fontWeight: 500, color: t.text, marginTop: 2, letterSpacing: -.5 }}>{greet}, engineer.</div>
        <div style={{ fontSize: 12.5, color: t.textDim, marginTop: 4, lineHeight: 1.55 }}>
          Your AI crew is online. Check the chore board for active tasks or launch a new mission from the Windmill.
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: layout.isMobile ? 'row' : 'column', gap: 6, flexShrink: 0, width: layout.isMobile ? '100%' : 'auto' }}>
        <button onClick={onCreateChore} style={{ padding: '10px 18px', borderRadius: 9, border: 'none', cursor: 'pointer', background: `linear-gradient(135deg, ${t.orange}, ${t.orangeHot})`, color: isLight ? '#fff' : '#1a0f06', fontSize: 12, fontWeight: 700, boxShadow: `0 4px 16px ${t.orange}44`, whiteSpace: 'nowrap', flex: layout.isMobile ? 1 : 'none' }}>
          + Post a chore
        </button>
        <button onClick={onOpenWindmill} style={{ padding: '8px 18px', borderRadius: 9, cursor: 'pointer', background: t.chipBg, color: t.text, border: `1px solid ${t.border}`, fontSize: 11.5, fontWeight: 500, whiteSpace: 'nowrap', flex: layout.isMobile ? 1 : 'none' }}>
          ⚡ Run a pipeline
        </button>
        <button onClick={onViewEvidence} style={{ padding: '8px 18px', borderRadius: 9, cursor: 'pointer', background: t.chipBg, color: t.purple, border: `1px solid ${t.border}`, fontSize: 11.5, fontWeight: 500, whiteSpace: 'nowrap', flex: layout.isMobile ? 1 : 'none' }}>
          📄 View evidence
        </button>
        <button onClick={onStirTasks} style={{ padding: '8px 18px', borderRadius: 9, cursor: 'pointer', background: t.chipBg, color: '#f59e0b', border: `1px solid ${t.border}`, fontSize: 11.5, fontWeight: 500, whiteSpace: 'nowrap', flex: layout.isMobile ? 1 : 'none' }}>
          🔄 Stir tasks
        </button>
      </div>
    </div>
  );
}

function G_StatRow({ tasks = [], reqs = [], bugs = [], events = [] }) {
  const { t } = useG();
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;

  const activeTasks = tasks.filter((tk) => !['done', 'cancelled'].includes(tk.status)).length;
  const doneToday   = tasks.filter((tk) => tk.status === 'done' && new Date(tk.updated_at || 0).getTime() > dayAgo).length;
  const openBugs    = bugs.filter((b) => !['closed', 'resolved'].includes(b.status)).length;
  const reqsTotal   = reqs.length;
  const doneTasks   = tasks.filter((tk) => tk.status === 'done');
  const verified    = doneTasks.filter((tk) => tk.verification_status === 'verified').length;

  const stats = [
    { label: 'Active tasks',      value: activeTasks, color: activeTasks > 0 ? t.orange : t.textDim },
    { label: 'Done today',        value: doneToday,   color: doneToday > 0 ? t.green : t.textDim    },
    { label: 'Open bugs',         value: openBugs,    color: openBugs > 0 ? t.red : t.green          },
    { label: 'Reqs total',        value: reqsTotal,   color: t.purple                                },
    { label: 'Verified evidence', value: verified,    color: verified > 0 ? t.green : t.textDim, sub: `/ ${doneTasks.length} done` },
  ];

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10 }}>
      {stats.map((s, i) => (
        <div key={i} style={{ padding: '14px 16px', borderRadius: 12, background: t.surface, border: `1px solid ${t.border}` }}>
          <div style={{ fontSize: 10, color: t.textDim, letterSpacing: .4, textTransform: 'uppercase', fontWeight: 600, marginBottom: 8 }}>{s.label}</div>
          <div style={{ fontFamily: 'Fraunces, serif', fontSize: 28, fontWeight: 600, color: s.color, letterSpacing: -.5, lineHeight: 1, display: 'flex', alignItems: 'baseline', gap: 4 }}>
            <GCount to={s.value} format={(n) => Math.round(n)} />
            {s.sub && <span style={{ fontSize: 12, color: t.textDimmer, fontFamily: 'inherit', fontWeight: 400 }}>{s.sub}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

function G_Panel({ title, sub, action, accent, children, style = {}, noPad = false, scrollable = false, maxH }) {
  const { t } = useG();
  return (
    <div style={{ background: t.surface, border: `1px solid ${t.border}`, borderRadius: 12, display: 'flex', flexDirection: 'column', ...style }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px 10px', flexShrink: 0, borderBottom: `1px solid ${t.border}` }}>
        {accent && <div style={{ width: 6, height: 6, borderRadius: 3, background: accent, boxShadow: `0 0 8px ${accent}`, flexShrink: 0 }} />}
        <div style={{ fontFamily: 'Fraunces, serif', fontSize: 14, fontWeight: 600, color: t.text }}>{title}</div>
        {sub && <div style={{ fontSize: 11, color: t.textDim, fontStyle: 'italic' }}>· {sub}</div>}
        <div style={{ flex: 1 }} />
        {action}
      </div>
      <div style={{
        padding: noPad ? 0 : '12px 16px',
        overflowY: scrollable ? 'auto' : 'visible',
        maxHeight: maxH || undefined,
      }}>{children}</div>
    </div>
  );
}

const G_HANDS = [
  { id: 'aria',      name: 'Aria',      role: 'requirements analyst',   emoji: '📋', busy: true,  task: 'Normalizing REQ-SHM-0142, syncing DOORS → Jira for sprint 42.',     mcps: ['jira','confluence'],    progress: 0.55, since: '12m' },
  { id: 'forge',     name: 'Forge',     role: 'inline coder',           emoji: '🛠️', busy: true,  task: 'Patching Shm_Swc.c — awaiting CAPL re-run before claim.',           mcps: ['git','shell'],          progress: 0.78, since: '6m' },
  { id: 'vince',     name: 'Vince',     role: 'test engineer',          emoji: '🔧', busy: true,  task: 'TC-SHM-212 wake-up regression on bench-03.',                        mcps: ['canoe','capl'],         progress: 0.62, since: '8m' },
  { id: 'hunter',    name: 'Hunter',    role: 'debugger',               emoji: '🔎', busy: true,  task: 'B-9821 — CAN-HS2 frame loss at 78% bus load.',                      mcps: ['canoe','git'],          progress: 0.41, since: '22m', warn: true },
  { id: 'delphi',    name: 'Delphi',    role: 'sw architect',           emoji: '🏛️', busy: true,  task: 'ADR-017 amendment for diagnostic session FSM.',                     mcps: ['plantuml','git'],       progress: 0.34, since: '30m' },
  { id: 'conductor', name: 'Conductor', role: 'scrum master',           emoji: '🎼', busy: false, task: 'Watching for review needs and uncovered requirements.',             mcps: ['jira','vault'],         since: '5m' },
  { id: 'scribe',    name: 'Scribe',    role: 'documenter',             emoji: '📚', busy: false, task: "Idle — waiting on Forge's diff.",                                  mcps: ['confluence','vault'],   since: '5m' },
  { id: 'william',   name: 'William',   role: 'UI/UX & scout',          emoji: '🎨', busy: false, task: 'Idle — ready to scrape ReactBits.dev and ship beautiful components.', mcps: ['shell','vault'],       since: 'new' },
  { id: 'max',       name: 'Max',       role: 'devops & infra',         emoji: '⚙️', busy: false, task: 'Idle — Docker, CI/CD, nginx, deployments on standby.',              mcps: ['docker','shell'],       since: 'new' },
  { id: 'iris',      name: 'Iris',      role: 'security auditor',       emoji: '🔐', busy: false, task: 'Idle — OWASP scans and dependency audits at the ready.',            mcps: ['shell','npm-audit'],    since: 'new' },
  { id: 'sage',      name: 'Sage',      role: 'ml & data engineer',     emoji: '🧠', busy: false, task: 'Idle — Python, pandas, scikit-learn, LLM pipelines ready.',         mcps: ['python','shell'],       since: 'new' },
  { id: 'pixel',     name: 'Pixel',     role: 'visual qa & a11y',       emoji: '🖥️', busy: false, task: 'Idle — Playwright tests, screenshots, accessibility audits.',       mcps: ['playwright','shell'],   since: 'new' },
];

function G_HandCard({ h, onClick }) {
  const { t, mode } = useG();
  return (
    <div onClick={onClick} style={{ padding: '12px 14px', borderRadius: 10, background: t.surface2, border: `1px solid ${t.border}`, display: 'flex', flexDirection: 'column', gap: 8, cursor: 'pointer', transition: 'all .15s' }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = t.borderHot; e.currentTarget.style.transform = 'translateY(-1px)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = t.border; e.currentTarget.style.transform = 'none'; }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ width: 34, height: 34, borderRadius: 9, background: `linear-gradient(135deg, ${t.orange}44, ${t.purple}44)`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 17, flexShrink: 0 }}>{h.emoji}</div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontFamily: 'Fraunces, serif', fontSize: 13, color: t.text, fontWeight: 600 }}>{h.name}</div>
          <div style={{ fontSize: 10, color: t.textDim, fontStyle: 'italic' }}>{h.role}</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
          <GDot color={h.warn ? t.yellow : h.busy ? t.green : t.textMuted} pulse={h.busy} size={7} />
          <div style={{ fontSize: 9, color: t.textDimmer, fontFamily: 'JetBrains Mono, monospace' }}>{h.since}</div>
        </div>
      </div>
      <div style={{ fontSize: 11, color: t.textDim, lineHeight: 1.45 }}>{h.task}</div>
      {h.progress !== undefined && (
        <div style={{ height: 3, borderRadius: 2, background: mode === 'light' ? 'rgba(0,0,0,.06)' : 'rgba(255,255,255,.06)', overflow: 'hidden' }}>
          <div style={{ width: `${h.progress * 100}%`, height: '100%', background: `linear-gradient(90deg, ${t.orange}, ${t.purple})`, transition: 'width .6s' }} />
        </div>
      )}
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {(h.mcps || []).map((m, i) => (
          <div key={i} style={{ fontSize: 9, padding: '2px 6px', borderRadius: 4, background: t.chipBg, color: t.textDim, fontFamily: 'JetBrains Mono, monospace', border: `1px solid ${t.border}` }}>{m}</div>
        ))}
      </div>
    </div>
  );
}

function G_ActivityFeed({ events }) {
  const { t } = useG();
  if (!events?.length) return <div style={{ fontSize: 12, color: t.textMuted, fontStyle: 'italic', padding: 8 }}>No activity yet.</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {events.slice(0, 40).map((e, i) => (
        <div key={e.id || i} style={{ display: 'flex', gap: 10, padding: '8px 0', borderBottom: i < Math.min(events.length, 40) - 1 ? `1px solid ${t.border}` : 'none', animation: e.fresh ? 'g-fade-in .4s ease-out' : 'none' }}>
          <div style={{ width: 22, height: 22, borderRadius: 6, background: `${e.color || t.purple}22`, color: e.color || t.purple, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 }}>
            <GIcon d={e.icon} size={11}/>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11.5, color: t.text, lineHeight: 1.4, wordBreak: 'break-word' }}>
              <b style={{ fontWeight: 600 }}>{e.who}</b>{' '}
              <span style={{ color: t.textDim }}>{e.what}</span>{' '}
              {e.obj && <code style={{ fontSize: 10, padding: '1px 5px', borderRadius: 3, background: t.chipBg, color: t.orange, fontFamily: 'JetBrains Mono, monospace' }}>{e.obj}</code>}
            </div>
            <div style={{ fontSize: 10, color: t.textDimmer, marginTop: 2, fontFamily: 'JetBrains Mono, monospace' }}>{e.time}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function G_TokenMetrics() {
  const { t } = useG();
  const layout = useGLayout();
  const [pool, setPool] = React.useState([]);
  const [ts, setTs] = React.useState(null);
  const [selectedKey, setSelectedKey] = React.useState('all');

  const refresh = () => {
    fetch('/api/llm/pool').then((r) => r.ok ? r.json() : null)
      .then((d) => { if (d?.pool) { setPool(d.pool); setTs(new Date()); } }).catch(() => {});
  };
  React.useEffect(() => { refresh(); const id = setInterval(refresh, 300_000); return () => clearInterval(id); }, []);

  // Extract slot number from provider id (e.g. "vio-gpt5-high-2" → "2")
  const getSlot = (p) => { const m = p.id?.match(/-(\d+)$/); return m ? m[1] : '1'; };

  // Detect all unique key slots present in the pool
  const allSlots = [...new Set(pool.map(getSlot))].sort();

  // Filter raw providers by selected key slot (or keep all)
  const filterByKey = (providers) =>
    selectedKey === 'all' ? providers : providers.filter((p) => getSlot(p) === selectedKey);

  // For "All" view: merge same-model slots into one row (sum budgets).
  // For per-key view: show raw rows — each model appears once (filtered to that key).
  const dedup = (providers) => {
    if (selectedKey !== 'all') {
      return [...providers].sort((a, b) => {
        if (a.usable !== b.usable) return a.usable ? -1 : 1;
        return b.remaining - a.remaining;
      });
    }
    const map = {};
    for (const p of providers) {
      const key = p.model || p.id;
      if (!map[key]) map[key] = { ...p, used_24h: 0, remaining: 0, max: 0, usable: false, rpm_cap: 0 };
      map[key].used_24h  += p.used_24h;
      map[key].remaining += p.remaining;
      map[key].max       += p.max;
      map[key].usable     = map[key].usable || p.usable;
      map[key].rpm_cap   += (p.rpm_cap || 0);
    }
    return Object.values(map).sort((a, b) => {
      if (a.usable !== b.usable) return a.usable ? -1 : 1;
      return b.remaining - a.remaining;
    });
  };

  const vioRaw = pool.filter((p) => p.kind === 'aumovio');
  const gemRaw = pool.filter((p) => p.kind === 'gemini' && !p.id?.includes('embed'));

  const vio = dedup(filterByKey(vioRaw));
  const gem = dedup(filterByKey(gemRaw));

  const pct = (p) => p.max > 0 ? Math.round((p.used_24h / p.max) * 100) : 0;

  const bar = (p, usableColor) => {
    const used = Math.min(100, pct(p));
    const color = p.usable ? usableColor : t.red;
    return (
      <div style={{ height: 4, borderRadius: 2, background: 'rgba(255,255,255,.07)', flex: 1 }}>
        <div style={{ width: `${used}%`, height: '100%', borderRadius: 2, background: color, transition: 'width .4s' }} />
      </div>
    );
  };

  const broken = pool.filter((p) => p.broken).length;
  const rl     = pool.filter((p) => p.rate_limited_for_seconds > 0).length;

  const Row = ({ p, color }) => {
    const usedK   = (p.used_24h / 1000).toFixed(0);
    const maxK    = (p.max / 1000).toFixed(0);
    const usedPct = pct(p);
    const label   = (p.model || p.id).replace('VIO:', '').replace('gemini-', '').replace('-preview', '');
    const slotBadge = selectedKey === 'all' ? null : (
      <span style={{ fontSize: 9, color: t.textDimmer, fontFamily: 'JetBrains Mono, monospace' }}>K{getSlot(p)}</span>
    );
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '5px 0', borderBottom: `1px solid ${t.border}` }}>
        <div style={{ width: 6, height: 6, borderRadius: 3, flexShrink: 0,
          background: p.usable ? t.green : (usedPct >= 99 ? t.red : t.yellow) }} />
        <div style={{ flex: 1, minWidth: 0, fontSize: 10.5, color: p.usable ? t.text : t.textDim,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.model || p.id}>{label}</div>
        {slotBadge}
        <div style={{ fontSize: 9.5, color: t.textDim, fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'nowrap' }}>
          {usedK}k / {maxK}k
        </div>
        {bar(p, color)}
        <div style={{ fontSize: 10, fontFamily: 'JetBrains Mono, monospace', width: 30, textAlign: 'right',
          color: usedPct >= 99 ? t.red : usedPct > 80 ? t.yellow : t.textDim }}>
          {usedPct}%
        </div>
      </div>
    );
  };

  // Tab button style
  const tabStyle = (key) => ({
    padding: '3px 10px', borderRadius: 5, fontSize: 10.5, fontWeight: 600, cursor: 'pointer', border: 'none',
    background: selectedKey === key ? t.purple : t.surface2,
    color: selectedKey === key ? '#fff' : t.textDim,
    transition: 'background .15s',
  });

  const keyLabels = { all: 'All keys', ...Object.fromEntries(allSlots.map((s) => [s, `Key ${s}`])) };

  return (
    <G_Panel title="LLM pool health" sub={ts ? `↻ 5min · updated ${ts.toLocaleTimeString()}` : 'loading…'} accent={t.purple}
      action={<button onClick={refresh} style={{ background: 'transparent', border: 'none', color: t.purple, cursor: 'pointer', fontSize: 11, fontWeight: 500 }}>↺ Refresh</button>}>

      {/* Key selector tabs */}
      <div style={{ display: 'flex', gap: 5, marginBottom: 10, flexWrap: 'wrap' }}>
        {['all', ...allSlots].map((k) => (
          <button key={k} style={tabStyle(k)} onClick={() => setSelectedKey(k)}>{keyLabels[k]}</button>
        ))}
      </div>

      {/* Summary stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8, marginBottom: 12 }}>
        {[
          { label: 'VIO active',    value: vio.filter((p) => p.usable).length, total: vio.length, color: t.orange },
          { label: 'Gemini active', value: gem.filter((p) => p.usable).length, total: gem.length, color: t.purple },
          { label: 'Rate-limited',  value: rl,     color: rl > 0 ? t.yellow : t.green },
          { label: 'Broken',        value: broken, color: broken > 0 ? t.red : t.green },
        ].map((s, i) => (
          <div key={i} style={{ padding: '8px 10px', borderRadius: 8, background: t.surface2, border: `1px solid ${t.border}`, textAlign: 'center' }}>
            <div style={{ fontSize: 9, color: t.textDim, textTransform: 'uppercase', letterSpacing: .4, fontWeight: 600 }}>{s.label}</div>
            <div style={{ fontFamily: 'Fraunces, serif', fontSize: 19, color: s.color, fontWeight: 600, marginTop: 2 }}>
              {s.value}{s.total != null ? <span style={{ fontSize: 11, color: t.textDimmer }}>/{s.total}</span> : ''}
            </div>
          </div>
        ))}
      </div>

      {/* Model rows */}
      <div style={{ display: 'grid', gridTemplateColumns: layout.stackPanels ? '1fr' : '1fr 1fr', gap: 14 }}>
        <div>
          <div style={{ fontSize: 10, color: t.orange, fontWeight: 700, marginBottom: 6, letterSpacing: .3, textTransform: 'uppercase' }}>
            VIO — GPT / DeepSeek / Claude
          </div>
          {vio.length ? vio.map((p) => <Row key={p.id} p={p} color={t.orange} />)
            : <div style={{ fontSize: 11, color: t.textDim, fontStyle: 'italic' }}>No VIO providers</div>}
        </div>
        <div>
          <div style={{ fontSize: 10, color: t.purple, fontWeight: 700, marginBottom: 6, letterSpacing: .3, textTransform: 'uppercase' }}>Gemini</div>
          {gem.length ? gem.map((p) => <Row key={p.id} p={p} color={t.purple} />)
            : <div style={{ fontSize: 11, color: t.textDim, fontStyle: 'italic' }}>No Gemini providers</div>}
        </div>
      </div>
    </G_Panel>
  );
}

function G_ModelPoolStatus({ pool = [] }) {
  const { t } = useG();
  if (!pool.length) {
    return (
      <G_Panel title="Model Pool" accent={t.purple}>
        <div style={{ fontSize: 12, color: t.textDimmer, fontStyle: 'italic' }}>No providers configured</div>
      </G_Panel>
    );
  }
  const online      = pool.filter((p) => p.usable).length;
  const rateLimited = pool.filter((p) => (p.rate_limited_for_seconds || 0) > 0).length;
  const dotColor = (p) => {
    if (p.usable) return t.green;
    if ((p.rate_limited_for_seconds || 0) > 0) return t.yellow;
    return t.red;
  };
  return (
    <G_Panel title="Model Pool" sub={`${online} online · ${rateLimited} rate-limited`} accent={t.purple}>
      {pool.length ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {pool.map((p, i) => {
            const label = (p.model || p.id || '').replace('VIO:', '').replace('gemini-', '').replace('-preview', '').slice(0, 24);
            return (
              <div key={p.id || i} title={p.model || p.id} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 9px', borderRadius: 6, background: t.surface2, border: `1px solid ${t.border}` }}>
                <div style={{ width: 6, height: 6, borderRadius: 3, background: dotColor(p), flexShrink: 0 }} />
                <span style={{ fontSize: 10, color: p.usable ? t.text : t.textDim, fontFamily: 'JetBrains Mono, monospace' }}>{label}</span>
              </div>
            );
          })}
        </div>
      ) : (
        <div style={{ fontSize: 12, color: t.textDimmer, fontStyle: 'italic' }}>No providers configured</div>
      )}
    </G_Panel>
  );
}

function G_ChorePreview({ chores }) {
  const { t } = useG();
  const col = (c) => ({ queued: t.textDimmer, running: t.orange, review: t.yellow, done: t.green, failed: t.red, 'needs-human': t.red }[c] || t.textDimmer);
  const label = (c) => ({ queued: 'queued', running: 'running', review: 'review', done: 'done', failed: 'failed', 'needs-human': 'needs you', cancelled: 'cancelled' }[c] || c);
  if (!chores?.length) return <div style={{ fontSize: 12, color: t.textMuted, fontStyle: 'italic' }}>No chores yet.</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {chores.map((c) => (
        <div key={c.id} style={{ padding: '10px 12px', borderRadius: 8, background: t.surface2, border: `1px solid ${t.border}`, display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <GDot color={col(c.status)} size={7} pulse={c.status === 'running'} style={{ marginTop: 3, flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11.5, color: t.text, fontWeight: 500, lineHeight: 1.4, wordBreak: 'break-word' }}>{c.title}</div>
            <div style={{ display: 'flex', gap: 5, alignItems: 'center', marginTop: 3, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 10, color: col(c.status), fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>{label(c.status)}</span>
              <span style={{ color: t.textMuted, fontSize: 10 }}>·</span>
              <span style={{ fontSize: 10, color: t.textDim, fontStyle: 'italic' }}>{c.by}</span>
              {c.attempts > 1 && <GTag color={t.yellow}>×{c.attempts}</GTag>}
            </div>
          </div>
          <GTag color={t.purple} style={{ flexShrink: 0 }}>{c.tag}</GTag>
        </div>
      ))}
    </div>
  );
}

function G_Porch({ events = [], chores = [], tasks, reqs = [], bugs = [], agents, connectors, runs, pool = [], project, onCreateChore, onNavigate, onOpenAgent }) {
  const { t } = useG();
  const layout = useGLayout();
  // Normalize: accept both `chores` and `tasks` prop names
  const allChores = (chores.length ? chores : (tasks || []));
  const active  = allChores.filter((c) => ['queued','running','review','needs-human'].includes(c.status));
  const recent  = allChores.filter((c) => c.status === 'done').slice(0, 3);
  const preview = [...active.slice(0, 6), ...recent].slice(0, 7);

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: layout.isMobile ? '14px 14px 36px' : '18px 20px 48px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Project banner */}
      {project ? (
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '7px 14px', borderRadius: 9, background: t.surface, border: `1px solid ${t.borderStrong}`, alignSelf: 'flex-start' }}>
          <span style={{ fontSize: 16 }}>{project.emoji || '📁'}</span>
          <span style={{ fontWeight: 700, color: t.text, fontSize: 13, fontFamily: 'Fraunces, serif' }}>{project.name}</span>
          {project.sub && <span style={{ fontSize: 11, color: t.textDimmer }}>· {project.sub}</span>}
        </div>
      ) : (
        <div style={{ fontSize: 12, color: t.yellow, padding: '7px 14px', borderRadius: 9, background: `${t.yellow}11`, border: `1px solid ${t.yellow}33`, alignSelf: 'flex-start' }}>
          ⚠ No project selected — pick one from the sidebar to start working.
        </div>
      )}

      {/* Hero */}
      <G_HeroCard
        onCreateChore={onCreateChore}
        onOpenWindmill={() => onNavigate?.('windmill')}
        onViewEvidence={() => onNavigate?.('records')}
        onStirTasks={() => {
          fetch('/api/tasks/stir', { method: 'POST' })
            .then(r => r.json())
            .then(d => alert(d.message || 'Tasks stirred!'))
            .catch(e => alert('Stir failed: ' + e.message));
        }}
      />

      {/* Stats */}
      <G_StatRow tasks={allChores} reqs={reqs} bugs={bugs} events={events} />

      {/* Model pool status (live from prop, no extra fetch) */}
      <G_ModelPoolStatus pool={pool} />

      {/* Agents */}
      <G_Panel title="The hands" sub={`${G_HANDS.length} agents`} accent={t.orange}
        action={<button onClick={() => onNavigate?.('kitchen')} style={{ fontSize: 10.5, color: t.textDim, background: 'transparent', border: 'none', cursor: 'pointer' }}>open kitchen →</button>}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10 }}>
          {G_HANDS.map((h) => <G_HandCard key={h.id} h={h} onClick={() => onOpenAgent?.(h.id)} />)}
        </div>
      </G_Panel>

      {/* LLM pool (detailed metrics panel with own fetch) */}
      <G_TokenMetrics />

      {/* Bottom row: chores + activity */}
      <div style={{ display: 'grid', gridTemplateColumns: layout.stackPanels ? '1fr' : 'minmax(0,1.4fr) minmax(0,1fr)', gap: 14 }}>
        <G_Panel title="Active chores" sub={`${active.length} in flight`} accent={t.orange}
          action={<button onClick={() => onNavigate?.('chores')} style={{ fontSize: 10.5, color: t.textDim, background: 'transparent', border: 'none', cursor: 'pointer' }}>open board →</button>}
          scrollable maxH={400}>
          <G_ChorePreview chores={preview} />
        </G_Panel>
        <G_Panel title="Recent activity" sub="what just happened" accent={t.purple} scrollable maxH={400}>
          <G_ActivityFeed events={events} />
        </G_Panel>
      </div>
    </div>
  );
}

Object.assign(window, { G_Porch, G_Panel, G_HandCard, G_HANDS, G_Sparkline, G_ActivityFeed, G_ModelPoolStatus });
window.G_HANDS = G_HANDS;
