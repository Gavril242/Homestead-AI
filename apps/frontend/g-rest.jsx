// Gavirila v2 — Workshop (IDE), Tool Shed (MCPs), Windmill (automations), Records, Settings

// ============== WORKSHOP ==============
function G_Workshop({ projectId, bugs = [], recentTraces = [] }) {
  const { t, mode } = useG();
  const layout = useGLayout();
  const [tab, setTab] = React.useState('terminal');
  const [selectedFile, setSelectedFile] = React.useState('TC-SHM-212-wakeup.can');
  const showInspector = !layout.isCompact;
  const treeWidth = layout.isTablet ? 180 : 220;

  // Terminal state
  const [history, setHistory] = React.useState([{ l: `Welcome to Gavirila workshop. Connected to ${projectId}`, c: t.textDim }]);
  const [cmd, setCmd] = React.useState('');
  const [runningCmd, setRunningCmd] = React.useState(false);
  const [logs, setLogs] = React.useState(null); // null = not yet fetched
  const termEndRef = React.useRef(null);

  React.useEffect(() => {
    termEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [history]);

  // Fetch logs when the tab is active
  React.useEffect(() => {
    if (tab !== 'logs') return;
    setLogs(null);
    fetch('/api/logs')
      .then(r => r.ok ? r.json() : null)
      .then(d => setLogs(d?.logs || []))
      .catch(() => setLogs([]));
  }, [tab]);

  async function handleCmd(e) {
    if (e.key !== 'Enter' || !cmd.trim() || runningCmd) return;
    const input = cmd.trim();
    setCmd('');
    setHistory(h => [...h, { l: `$ ${input}`, c: t.text }]);
    setRunningCmd(true);
    try {
      const res = await fetch('/api/exec/shell', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd: input, projectId })
      });
      const data = await res.json();
      if (data.stdout) setHistory(h => [...h, ...data.stdout.trim().split('\n').map(l => ({ l, c: t.textDim }))]);
      if (data.stderr) setHistory(h => [...h, ...data.stderr.trim().split('\n').map(l => ({ l, c: t.red }))]);
      if (data.error) setHistory(h => [...h, { l: data.error, c: t.red }]);
    } catch (err) {
      setHistory(h => [...h, { l: err.message, c: t.red }]);
    }
    setRunningCmd(false);
  }

  const [tree, setTree] = React.useState([]);
  const [fileContent, setFileContent] = React.useState('/* Select a file to view its contents */');

  React.useEffect(() => {
    window.GApi?.fsTree?.(projectId).then(res => {
      setTree(res.tree || []);
    }).catch(console.error);
  }, [projectId, tab]); // reload tree on tab switch or project change

  React.useEffect(() => {
    if (!selectedFile) return;
    window.GApi?.fsRead?.(projectId, selectedFile).then(res => {
      setFileContent(res.content || '');
    }).catch(err => {
      setFileContent(`/* Error reading file: ${err.message} */`);
    });
  }, [selectedFile, projectId]);

  // Flatten the nested tree for rendering with depth
  const activeBugs = bugs.filter((b) => !['closed', 'resolved', 'done', 'cancelled'].includes(b.status));
  const flatFiles = React.useMemo(() => {
    const out = [];
    function walk(nodes, depth) {
      for (const n of nodes) {
        out.push({ ...n, depth });
        if (n.type === 'dir' && n.children) walk(n.children, depth + 1);
      }
    }
    walk(tree, 0);
    return out;
  }, [tree]);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* Top bar */}
      <div style={{ minHeight: 40, flexShrink: 0, borderBottom: `1px solid ${t.border}`, display: 'flex', alignItems: 'center', gap: 8, padding: layout.isMobile ? '10px 12px' : '0 14px', flexWrap: layout.isMobile ? 'wrap' : 'nowrap' }}>
        <div style={{ fontFamily: 'Fraunces, serif', fontSize: 14, color: t.text, fontWeight: 600, marginRight: 14 }}>Workshop</div>
        <div style={{ display: 'flex', gap: 2 }}>
          {[
            { id: 'code', l: 'Code', icon: G_ICONS.code },
            { id: 'terminal', l: 'Terminal', icon: G_ICONS.terminal },
            { id: 'logs', l: 'Logs', icon: G_ICONS.file },
            { id: 'debug', l: 'Debug', icon: G_ICONS.bolt },
          ].map((x) => (
            <button key={x.id} onClick={() => setTab(x.id)} style={{
              padding: '6px 12px', borderRadius: 6, border: 'none', cursor: 'pointer',
              background: tab === x.id ? t.chipBg : 'transparent',
              color: tab === x.id ? t.text : t.textDim,
              fontSize: 12, fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 6,
              position: 'relative',
            }}>
              <GIcon d={x.icon} size={12}/> {x.l}
              {tab === x.id && <div style={{ position: 'absolute', bottom: -7, left: 8, right: 8, height: 2, background: t.orange, borderRadius: 1 }}/>}
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <GDot color={t.green} size={7} pulse/>
          <span style={{ fontSize: 10.5, color: t.textDim, fontFamily: 'JetBrains Mono, monospace' }}>connected · {projectId || 'workspace'}</span>
          <button onClick={() => setTab('terminal')} style={{ padding: '6px 12px', borderRadius: 7, background: `linear-gradient(135deg, ${t.orange}, ${t.orangeHot})`, color: mode === 'light' ? '#fff' : '#1a0f06', border: 'none', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}>
            <GIcon d={G_ICONS.terminal} size={10}/> Terminal
          </button>
        </div>
      </div>

      <div style={{ flex: 1, display: 'flex', minHeight: 0, flexDirection: layout.isMobile ? 'column' : 'row' }}>
        {/* File tree */}
        <div style={{ width: layout.isMobile ? '100%' : treeWidth, maxHeight: layout.isMobile ? 160 : 'none', flexShrink: 0, borderRight: layout.isMobile ? 'none' : `1px solid ${t.border}`, borderBottom: layout.isMobile ? `1px solid ${t.border}` : 'none', padding: '8px 6px', display: 'flex', flexDirection: 'column', gap: 1, overflow: 'auto' }}>
          <div style={{ fontSize: 9.5, color: t.textDimmer, letterSpacing: .6, textTransform: 'uppercase', padding: '4px 8px 6px', fontWeight: 600 }}>Files · workspace</div>
          {flatFiles.map((f, i) => (
            <button key={f.id} onClick={() => f.type === 'file' && setSelectedFile(f.id)} style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '4px 6px',
              paddingLeft: 6 + f.depth * 12,
              borderRadius: 5,
              background: selectedFile === f.id ? (mode === 'light' ? 'rgba(234,90,28,.08)' : 'rgba(255,255,255,.04)') : 'transparent',
              border: 'none', cursor: 'pointer', textAlign: 'left', width: '100%',
              color: selectedFile === f.id ? t.text : t.textDim,
              fontSize: 11.5, fontFamily: 'JetBrains Mono, monospace',
            }}>
              <GIcon d={f.type === 'dir' ? G_ICONS.folder : G_ICONS.file} size={11}/>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.label}{f.type === 'dir' ? '/' : ''}</span>
            </button>
          ))}
        </div>

        {/* Main content */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          {tab === 'code' && (
            <>
              <div style={{ height: 30, flexShrink: 0, display: 'flex', alignItems: 'center', borderBottom: `1px solid ${t.border}`, padding: '0 4px' }}>
                <div style={{ padding: '6px 12px', borderRight: `1px solid ${t.border}`, background: t.chipBg, fontSize: 11.5, color: t.text, fontFamily: 'JetBrains Mono, monospace', display: 'flex', alignItems: 'center', gap: 7 }}>
                  <GIcon d={G_ICONS.file} size={10}/>
                  {selectedFile}
                  <GDot color={t.orange} size={5} glow={false}/>
                </div>
              </div>
              <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
                <pre style={{
                  flex: 1, margin: 0, padding: '12px 6px 12px 0', overflow: 'auto',
                  fontFamily: 'JetBrains Mono, monospace', fontSize: 12.5, lineHeight: 1.55,
                  color: t.text, background: 'transparent',
                }}>
{fileContent.split('\n').map((ln, i) => (
  <div key={i} style={{ display: 'flex', gap: 12, paddingLeft: 12, position: 'relative' }}>
    <span style={{ width: 28, color: t.textMuted, textAlign: 'right', flexShrink: 0, userSelect: 'none' }}>{i + 1}</span>
    <code style={{ color: t.text, whiteSpace: 'pre' }}>
      {ln.split(/(\b(?:includes|variables|on|message|testcase|if|else|const|int|dword|msTimer|def|class|return|import|from)\b|'[^']*'|"[^"]*"|\/\/.*$|\/\*[\s\S]*?\*\/|#.*$)/).map((p, j) => {
        if (/^(includes|variables|on|message|testcase|if|else|const|int|dword|msTimer|def|class|return|import|from)$/.test(p)) return <span key={j} style={{ color: t.purple, fontWeight: 600 }}>{p}</span>;
        if (/^['"]/.test(p)) return <span key={j} style={{ color: t.orange }}>{p}</span>;
        if (/^\/\//.test(p) || /^\/\*/.test(p) || /^#/.test(p)) return <span key={j} style={{ color: t.textDimmer, fontStyle: 'italic' }}>{p}</span>;
        return p;
      })}
    </code>
  </div>
))}
                </pre>
                {showInspector && (
                  <div style={{ width: 300, flexShrink: 0, borderLeft: `1px solid ${t.border}`, padding: 14, display: 'flex', flexDirection: 'column', gap: 10, background: mode === 'light' ? 'rgba(255,247,238,.4)' : 'rgba(10,4,16,.3)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ width: 26, height: 26, borderRadius: 7, background: `linear-gradient(135deg, ${t.orange}44, ${t.purple}44)`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, border: `1px solid ${t.border}` }}>📄</div>
                      <div>
                        <div style={{ fontFamily: 'Fraunces, serif', fontSize: 12.5, color: t.text, fontWeight: 600 }}>File info</div>
                        <div style={{ fontSize: 10, color: t.textDim, fontStyle: 'italic' }}>context panel</div>
                      </div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                      {[
                        { label: 'File',  value: selectedFile ? selectedFile.split('/').pop() : '—' },
                        { label: 'Type',  value: selectedFile ? (selectedFile.split('.').pop().toUpperCase() || '—') : '—' },
                        { label: 'Lines', value: fileContent ? String(fileContent.split('\n').length) : '0' },
                      ].map((row) => (
                        <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, padding: '7px 0', borderBottom: `1px solid ${t.border}` }}>
                          <span style={{ color: t.textDim }}>{row.label}</span>
                          <span style={{ color: t.orange, fontFamily: 'JetBrains Mono, monospace', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.value}</span>
                        </div>
                      ))}
                    </div>
                    <div style={{ fontSize: 11, color: t.textDim, lineHeight: 1.55, padding: 10, borderRadius: 9, background: t.chipBg, border: `1px solid ${t.border}`, marginTop: 4 }}>
                      Ask Forge in the Kitchen Table to edit this file.
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {tab === 'terminal' && (
            <div style={{ flex: 1, padding: 14, background: mode === 'light' ? 'rgba(255,252,247,.6)' : 'rgba(5,2,10,.5)', display: 'flex', flexDirection: 'column', fontFamily: 'JetBrains Mono, monospace', fontSize: 12.5, lineHeight: 1.6 }}>
              <div style={{ flex: 1, overflow: 'auto' }}>
                {history.map((ln, i) => (
                  <div key={i} style={{ color: ln.c, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{ln.l}</div>
                ))}
                <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                  <span style={{ color: t.orange }}>$</span>
                  <input 
                    value={cmd} 
                    onChange={e => setCmd(e.target.value)} 
                    onKeyDown={handleCmd} 
                    disabled={runningCmd}
                    autoFocus
                    placeholder={runningCmd ? 'running...' : 'ls -la'}
                    style={{ flex: 1, background: 'transparent', border: 'none', color: t.text, fontFamily: 'inherit', fontSize: 'inherit', outline: 'none' }} 
                  />
                </div>
                <div ref={termEndRef} />
              </div>
            </div>
          )}

          {tab === 'logs' && (
            <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', gap: 6, padding: 12, borderBottom: `1px solid ${t.border}`, alignItems: 'center', flexShrink: 0 }}>
                {['all', 'INFO', 'WARN', 'ERROR'].map((l) => (
                  <div key={l} style={{ padding: '4px 10px', borderRadius: 5, background: t.chipBg, border: `1px solid ${t.border}`, fontSize: 10.5, color: l === 'ERROR' ? t.red : l === 'WARN' ? t.yellow : t.textDim, fontFamily: 'JetBrains Mono, monospace' }}>{l}</div>
                ))}
                <div style={{ flex: 1 }} />
                <div style={{ fontSize: 10.5, color: t.textDim, fontFamily: 'JetBrains Mono, monospace' }}>
                  {logs === null ? 'loading…' : `${logs.length + recentTraces.length} entries`}
                </div>
              </div>
              {logs === null ? (
                <div style={{ padding: 24, color: t.textDim, fontFamily: 'JetBrains Mono, monospace', fontSize: 12 }}>Loading logs…</div>
              ) : (logs.length === 0 && recentTraces.length === 0) ? (
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 48, gap: 10 }}>
                  <div style={{ fontSize: 28 }}>📋</div>
                  <div style={{ fontFamily: 'Fraunces, serif', fontSize: 14, color: t.textDim }}>No logs</div>
                  <div style={{ fontSize: 11.5, color: t.textDimmer, textAlign: 'center', maxWidth: 380, lineHeight: 1.55 }}>
                    Logs from shell commands and background processes appear here. Start a process from the Terminal tab to see output.
                  </div>
                </div>
              ) : (
                <div style={{ padding: '4px 14px', display: 'flex', flexDirection: 'column', gap: 0 }}>
                  {[...logs, ...recentTraces.map((tr) => ({ level: 'INFO', message: tr.summary || tr.agent || '', ts: tr.ts }))].slice(0, 300).map((entry, i) => (
                    <div key={i} style={{ display: 'flex', gap: 10, fontFamily: 'JetBrains Mono, monospace', fontSize: 11.5, padding: '4px 0', borderBottom: `1px solid ${t.border}` }}>
                      <span style={{ color: t.textMuted, width: 76, flexShrink: 0 }}>{entry.ts ? new Date(entry.ts).toLocaleTimeString() : ''}</span>
                      <span style={{ color: entry.level === 'ERROR' ? t.red : entry.level === 'WARN' ? t.yellow : t.green, width: 46, flexShrink: 0 }}>{entry.level || 'INFO'}</span>
                      <span style={{ color: t.textDim, flex: 1, wordBreak: 'break-all' }}>{entry.message || ''}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === 'debug' && (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 14, gap: 12, overflow: 'auto' }}>
              {activeBugs.length > 0 ? activeBugs.map((bug, i) => (
                <div key={bug.id || i}>
                  <div style={{ padding: 14, borderRadius: 10, background: `${t.red}14`, border: `1px solid ${t.red}44` }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <GIcon d={G_ICONS.warn} size={13}/>
                      <div style={{ fontFamily: 'Fraunces, serif', fontSize: 13.5, color: t.red, fontWeight: 600 }}>
                        {bug.id ? `${bug.id} · ` : ''}{bug.title || bug.description || 'Active debug session'}
                      </div>
                    </div>
                    {bug.description && bug.description !== bug.title && (
                      <div style={{ fontSize: 12, color: t.text, lineHeight: 1.5 }}>{bug.description}</div>
                    )}
                    <div style={{ fontSize: 10, color: t.textDim, fontFamily: 'JetBrains Mono, monospace', marginTop: 6 }}>
                      status: {bug.status}{bug.by ? ` · ${bug.by}` : ''}
                    </div>
                  </div>
                </div>
              )) : (
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 48, gap: 10 }}>
                  <div style={{ fontSize: 28 }}>🔎</div>
                  <div style={{ fontFamily: 'Fraunces, serif', fontSize: 14, color: t.textDim }}>No active debug sessions</div>
                  <div style={{ fontSize: 11.5, color: t.textDimmer, textAlign: 'center', maxWidth: 360, lineHeight: 1.55 }}>
                    Bugs that are being investigated will appear here.
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ============== TOOL SHED ==============
function G_Shed({ recentToolCalls = [], recentTraces = [] }) {
  const { t, mode } = useG();
  const [tools, setTools] = React.useState([]);
  const [filter, setFilter] = React.useState('');

  React.useEffect(() => {
    window.GApi?.getTools?.().then(setTools).catch(console.error);
  }, []);

  // Build last-call map from broadcasted tool calls + persisted traces
  const lastCall = React.useMemo(() => {
    const m = new Map();
    for (const tc of recentToolCalls) {
      const cur = m.get(tc.name);
      if (!cur || cur.ts < tc.ts) m.set(tc.name, { ts: tc.ts, agent: tc.agent, ok: !tc.result?.error });
    }
    for (const tr of recentTraces) {
      for (const tc of (tr.tool_calls || [])) {
        const cur = m.get(tc.name);
        if (!cur || cur.ts < tr.ts) m.set(tc.name, { ts: tr.ts, agent: tr.agent, ok: tr.ok !== false });
      }
    }
    return m;
  }, [recentToolCalls, recentTraces]);

  const filtered = React.useMemo(() => {
    if (!filter) return tools;
    const q = filter.toLowerCase();
    return tools.filter((tt) => tt.name.toLowerCase().includes(q) || tt.description?.toLowerCase().includes(q));
  }, [tools, filter]);

  const toolCats = React.useMemo(() => {
    const cats = { skill: [], exec: [], devserver: [], browser: [], brain: [], task: [], other: [] };
    filtered.forEach(tool => {
      if (tool.category === 'exec_skill') cats.skill.push(tool);
      else if (tool.category === 'exec_devserver') cats.devserver.push(tool);
      else if (tool.category === 'exec_browser') cats.browser.push(tool);
      else if (tool.category?.startsWith('exec_')) cats.exec.push(tool);
      else if (tool.category?.startsWith('vault_') || tool.category?.startsWith('db_') || tool.category === 'trace') cats.brain.push(tool);
      else if (tool.category === 'task_comms') cats.task.push(tool);
      else cats.other.push(tool);
    });
    return Object.entries(cats).filter(([_, items]) => items.length > 0);
  }, [filtered]);

  const catEmoji = { skill: '✨', exec: '💻', devserver: '🚀', browser: '🌐', brain: '🧠', task: '💬', other: '🔧' };
  const catNames = {
    skill: 'Skills (composite)', exec: 'Filesystem / Shell / Python / Git',
    devserver: 'Dev servers', browser: 'Browser (Playwright)',
    brain: 'Brain / DB / Trace', task: 'Task communication', other: 'Other',
  };

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <div>
          <div style={{ fontFamily: 'Fraunces, serif', fontSize: 22, fontWeight: 600, color: t.text, letterSpacing: -.3 }}>Tool shed</div>
          <div style={{ fontSize: 12, color: t.textDim, fontStyle: 'italic', marginTop: 2 }}>{tools.length} tools live. Each agent gets a slice based on its toolScopes.</div>
        </div>
        <div style={{ flex: 1 }} />
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter tools…" style={{
          padding: '8px 12px', borderRadius: 8, border: `1px solid ${t.border}`, background: t.chipBg, color: t.text,
          fontSize: 12, fontFamily: 'inherit', outline: 'none', minWidth: 240,
        }} />
      </div>

      {toolCats.map(([catKey, items]) => (
        <div key={catKey} style={{ marginBottom: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, borderBottom: `1px solid ${t.border}`, paddingBottom: 6 }}>
            <div style={{ fontSize: 18 }}>{catEmoji[catKey]}</div>
            <div style={{ fontFamily: 'Fraunces, serif', fontSize: 16, fontWeight: 600, color: t.text }}>{catNames[catKey]}</div>
            <div style={{ fontSize: 12, color: t.textDim, fontFamily: 'JetBrains Mono, monospace' }}>· {items.length} tools</div>
          </div>
          
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 10 }}>
            {items.map((tool) => (
              <div key={tool.name} style={{
                padding: 14, borderRadius: 12,
                background: t.surface, backdropFilter: 'blur(24px)',
                border: `1px solid ${t.border}`,
                display: 'flex', flexDirection: 'column', gap: 10,
                position: 'relative', overflow: 'hidden',
              }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 13, color: t.text, fontWeight: 600 }}>{tool.name}</div>
                      {(() => {
                        const lc = lastCall.get(tool.name);
                        if (!lc) return <GTag color={t.textMuted}>idle</GTag>;
                        const agoSec = Math.round((Date.now() - lc.ts) / 1000);
                        const ago = agoSec < 60 ? `${agoSec}s` : agoSec < 3600 ? `${Math.round(agoSec/60)}m` : `${Math.round(agoSec/3600)}h`;
                        return <GTag color={lc.ok ? t.green : t.red}>{lc.agent || 'agent'} · {ago} ago</GTag>;
                      })()}
                    </div>
                    <div style={{ fontSize: 11, color: t.textDim, marginTop: 4, lineHeight: 1.4 }}>{tool.description}</div>
                  </div>
                </div>
                {tool.parameters?.properties && Object.keys(tool.parameters.properties).length > 0 && (
                  <div style={{ paddingTop: 8, borderTop: `1px solid ${t.border}` }}>
                    <div style={{ fontSize: 9.5, color: t.textDimmer, textTransform: 'uppercase', letterSpacing: .5, fontWeight: 600, marginBottom: 6 }}>Parameters</div>
                    {Object.entries(tool.parameters.properties).map(([pName, pSchema]) => (
                      <div key={pName} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 4 }}>
                        <div style={{ fontSize: 10.5, color: t.orange, fontFamily: 'JetBrains Mono, monospace' }}>{pName}</div>
                        <div style={{ fontSize: 10, color: t.textDim, lineHeight: 1.3 }}>{pSchema.description || pSchema.type}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// Windmill — flow, planning, persistent missions, and Conductor chat.
function G_Windmill({ projectId, tasks = [], onOpenChore, missions = [], gates = [], project }) {
  const { t, mode } = useG();
  const [tab, setTab] = React.useState('flow');
  const [paused, setPaused] = React.useState(project?.paused || false);

  React.useEffect(() => { setPaused(project?.paused || false); }, [project?.paused]);

  const toggleAI = async () => {
    try {
      const next = !paused;
      setPaused(next);
      await window.GApi?.pauseProject?.(projectId, next);
    } catch (err) { alert(err.message); }
  };

  const statusColor = (s) => ({
    queued: t.purple, running: t.orange, review: t.yellow, done: t.green,
    failed: t.red, 'needs-info': t.yellow, 'needs-human': t.red, cancelled: t.textMuted,
  })[s] || t.textDim;

  const TABS = [
    { id: 'flow', label: '⚡ Flow' },
    { id: 'plan', label: '🗺 Plan' },
    { id: 'missions', label: '🎯 Missions' },
    { id: 'chat', label: '💬 Chat' },
  ];

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div>
          <div style={{ fontFamily: 'Fraunces, serif', fontSize: 22, fontWeight: 600, color: t.text, letterSpacing: -.3 }}>Windmill</div>
          <div style={{ fontSize: 12, color: t.textDim, fontStyle: 'italic', marginTop: 2 }}>Task flow · DAG planner · persistent missions · Conductor chat</div>
        </div>
        <div style={{ flex: 1 }} />
        {/* AI toggle */}
        <button onClick={toggleAI} style={{
          padding: '7px 14px', borderRadius: 8, fontSize: 11.5, fontWeight: 700, cursor: 'pointer', border: 'none',
          background: paused ? `${t.orange}22` : `${t.green}22`,
          color: paused ? t.orange : t.green,
          border: `1px solid ${paused ? t.orange : t.green}`,
        }}>
          {paused ? '⏸ AI PAUSED' : '▶ AI ON'}
        </button>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', background: t.chipBg, borderRadius: 8, border: `1px solid ${t.border}`, padding: 3, gap: 2, alignSelf: 'flex-start' }}>
        {TABS.map((tb) => (
          <button key={tb.id} onClick={() => setTab(tb.id)} style={{
            padding: '6px 16px', borderRadius: 6, fontSize: 11.5, fontWeight: 600, cursor: 'pointer', border: 'none',
            background: tab === tb.id ? t.orange : 'transparent',
            color: tab === tb.id ? '#fff' : t.textDim,
          }}>{tb.label}</button>
        ))}
      </div>

      {tab === 'flow' && <WindmillFlow tasks={tasks} statusColor={statusColor} onOpenChore={onOpenChore} t={t} />}
      {tab === 'plan' && <WindmillPlan projectId={projectId} tasks={tasks} missions={missions} onOpenChore={onOpenChore} statusColor={statusColor} t={t} mode={mode} />}
      {tab === 'missions' && <WindmillMissions projectId={projectId} tasks={tasks} missions={missions} onOpenChore={onOpenChore} statusColor={statusColor} t={t} />}
      {tab === 'chat' && <WindmillChat projectId={projectId} tasks={tasks} missions={missions} t={t} />}
    </div>
  );
}

// ── Flow: animated horizontal timeline grouped by topological stage ──────────
function WindmillFlow({ tasks, statusColor, onOpenChore, t }) {
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    const id = setInterval(() => setTick((x) => x + 1), 5000);
    return () => clearInterval(id);
  }, []);

  const layout = React.useMemo(() => buildDagLayout(tasks), [tasks, tick]);
  if (!tasks.length) {
    return <div style={{ fontSize: 13, color: t.textMuted, fontStyle: 'italic', padding: 24, textAlign: 'center' }}>No tasks yet. Head to the Plan tab to launch a goal.</div>;
  }

  const statusLabel = { queued: 'Queued', running: 'Running', review: 'Review', done: 'Done', failed: 'Failed', 'needs-human': 'Needs Human', cancelled: 'Cancelled' };

  return (
    <div style={{ display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 8 }}>
      {layout.layers.map((layer, ci) => (
        <div key={ci} style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 200 }}>
          <div style={{ fontSize: 9.5, color: t.textDim, textTransform: 'uppercase', letterSpacing: .6, fontWeight: 700, textAlign: 'center', paddingBottom: 4, borderBottom: `1px solid ${t.border}` }}>
            Stage {ci + 1}
          </div>
          {layer.map((task) => {
            const c = statusColor(task.status);
            const running = task.status === 'running';
            return (
              <div key={task.id} onClick={() => onOpenChore?.(task)} style={{
                padding: '10px 12px', borderRadius: 10, cursor: 'pointer',
                background: `${c}18`,
                border: `1.5px solid ${running ? c : c + '55'}`,
                animation: running ? 'g-pulse 2s ease-in-out infinite' : undefined,
                transition: 'box-shadow 0.15s',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <div style={{ width: 7, height: 7, borderRadius: '50%', background: c, flexShrink: 0 }} />
                  <div style={{ fontSize: 9, color: c, fontFamily: 'JetBrains Mono, monospace', fontWeight: 700, textTransform: 'uppercase' }}>
                    {statusLabel[task.status] || task.status}
                  </div>
                  <div style={{ flex: 1 }} />
                  <div style={{ fontSize: 9, color: t.textMuted, fontFamily: 'JetBrains Mono, monospace' }}>{(task.by || '').toUpperCase()}</div>
                </div>
                <div style={{ fontSize: 12, color: t.text, fontWeight: 600, lineHeight: 1.3 }}>
                  {(task.title || '').slice(0, 40)}{(task.title || '').length > 40 ? '…' : ''}
                </div>
                {task.artifacts?.length > 0 && (
                  <div style={{ fontSize: 9.5, color: t.textDim, marginTop: 4, fontFamily: 'JetBrains Mono, monospace' }}>
                    {task.artifacts.length} artifact{task.artifacts.length === 1 ? '' : 's'}
                  </div>
                )}
                {task.status === 'running' && (
                  <div style={{ marginTop: 6, height: 2, borderRadius: 1, background: `${c}33`, overflow: 'hidden' }}>
                    <div style={{ height: '100%', background: c, width: '60%', borderRadius: 1, animation: 'g-flow-bar 1.6s ease-in-out infinite' }} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ── Plan: DAG + goal launcher + gates ────────────────────────────────────────
function WindmillPlan({ projectId, tasks, missions, onOpenChore, statusColor, t, mode }) {
  const [goal, setGoal] = React.useState('');
  const [planning, setPlanning] = React.useState(false);
  const [planResult, setPlanResult] = React.useState(null);
  const [mode2, setMode2] = React.useState('mission');
  const [localGates, setLocalGates] = React.useState([]);

  React.useEffect(() => {
    if (!projectId) return;
    window.GApi?.listGates?.(projectId).then((r) => setLocalGates(r.gates || [])).catch(() => {});
  }, [projectId]);

  const projectMissions = missions.filter((m) => m.projectId === projectId);
  const layout = React.useMemo(() => buildDagLayout(tasks), [tasks]);

  const submit = async () => {
    if (!goal.trim() || planning || !projectId) return;
    setPlanning(true);
    try {
      const res = mode2 === 'mission'
        ? await window.GApi.startMission(projectId, goal)
        : await window.GApi.planGoal(projectId, goal);
      setPlanResult(res);
      setGoal('');
    } catch (err) { alert('Failed: ' + err.message); }
    finally { setPlanning(false); }
  };

  const toggleGate = async (g) => {
    try {
      const next = await window.GApi.setGate(projectId, g.name, !g.open);
      setLocalGates((arr) => arr.map((x) => x.name === (next.name || g.name) ? { ...x, ...next } : x));
    } catch (err) { alert(err.message); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Goal launcher */}
      <div style={{ padding: 14, borderRadius: 12, background: t.surface, border: `1px solid ${t.border}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <div style={{ fontSize: 10.5, color: t.textDim, textTransform: 'uppercase', letterSpacing: .5, fontWeight: 600 }}>Launch a goal</div>
          <div style={{ flex: 1 }} />
          <div style={{ display: 'flex', background: t.chipBg, borderRadius: 6, border: `1px solid ${t.border}`, padding: 2 }}>
            {['mission', 'plan'].map((m) => (
              <button key={m} onClick={() => setMode2(m)} style={{
                padding: '4px 10px', borderRadius: 4, fontSize: 10.5, fontWeight: 600, cursor: 'pointer', border: 'none',
                background: mode2 === m ? t.orange : 'transparent',
                color: mode2 === m ? '#fff' : t.textDim,
                textTransform: 'uppercase',
              }}>{m === 'mission' ? '🎯 mission' : '📋 plan only'}</button>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input value={goal} onChange={(e) => setGoal(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder={mode2 === 'mission' ? 'goal — Conductor plans + auto-executes' : 'goal — plan the DAG only, no auto-execution'}
            style={{ flex: 1, padding: '10px 12px', borderRadius: 8, border: `1px solid ${t.border}`, background: t.chipBg, color: t.text, fontSize: 13, outline: 'none' }} />
          <button onClick={submit} disabled={!goal.trim() || planning || !projectId} style={{
            padding: '10px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 700,
            background: `linear-gradient(135deg, ${t.orange}, ${t.purple})`, color: '#fff',
            opacity: (!goal.trim() || planning || !projectId) ? .5 : 1,
          }}>{planning ? 'Conductor working…' : (mode2 === 'mission' ? '🎯 Start' : '📋 Plan')}</button>
        </div>
        {planResult && (
          <div style={{ marginTop: 10, padding: 10, borderRadius: 8, background: `${t.green}11`, border: `1px solid ${t.green}33`, fontSize: 12, color: t.text }}>
            <div style={{ fontWeight: 600 }}>{planResult.id ? `🎯 Mission ${planResult.id}` : `✓ Plan: ${planResult.task_count} tasks`}</div>
            <div style={{ color: t.textDim, marginTop: 4 }}>{planResult.plan_summary || planResult.summary}</div>
            {planResult.id && <div style={{ color: t.textMuted, marginTop: 4 }}>Open the Missions tab to track the persistent orchestration plan.</div>}
          </div>
        )}
      </div>

      {/* Active missions */}
      {projectMissions.length > 0 && (
        <div style={{ padding: 14, borderRadius: 12, background: t.surface, border: `1px solid ${t.border}` }}>
          <div style={{ fontSize: 10.5, color: t.textDim, textTransform: 'uppercase', letterSpacing: .5, fontWeight: 600, marginBottom: 8 }}>Missions</div>
          {projectMissions.map((m) => {
            const tone = m.status === 'done' ? t.green : m.status === 'needs-human' ? t.red : t.orange;
            return (
              <div key={m.id} style={{ padding: 10, marginBottom: 8, borderRadius: 8, background: `${tone}11`, border: `1px solid ${tone}33` }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <GTag color={tone} solid>{m.status}</GTag>
                  <div style={{ fontSize: 12, color: t.text, fontWeight: 600 }}>{m.goal?.slice(0, 90)}</div>
                  <div style={{ flex: 1 }} />
                  <div style={{ fontSize: 10, color: t.textDim, fontFamily: 'JetBrains Mono, monospace' }}>{m.taskIds?.length || 0} tasks</div>
                </div>
                {m.blocker && <div style={{ fontSize: 11, color: t.red, marginTop: 4 }}>blocker: {m.blocker.title} — {m.blocker.error?.slice(0, 100)}</div>}
                {m.report && <div style={{ fontSize: 11, color: t.textDim, marginTop: 4, whiteSpace: 'pre-wrap' }}>{m.report.slice(0, 400)}</div>}
              </div>
            );
          })}
        </div>
      )}

      {/* Gates */}
      {localGates.length > 0 && (
        <div style={{ padding: 14, borderRadius: 12, background: t.surface, border: `1px solid ${t.border}` }}>
          <div style={{ fontSize: 10.5, color: t.textDim, textTransform: 'uppercase', letterSpacing: .5, fontWeight: 600, marginBottom: 8 }}>Pipeline gates</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {localGates.map((g) => (
              <button key={g.name} onClick={() => toggleGate(g)} style={{
                padding: '8px 14px', borderRadius: 8, fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
                background: g.open ? `${t.green}22` : t.chipBg,
                border: `1px solid ${g.open ? t.green : t.border}`,
                color: g.open ? t.green : t.textDim,
              }}>{g.open ? '🔓' : '🔒'} {g.name}</button>
            ))}
          </div>
        </div>
      )}

      {/* DAG */}
      <div style={{ padding: 16, borderRadius: 12, background: t.surface, border: `1px solid ${t.border}`, minHeight: 300 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={{ fontFamily: 'Fraunces, serif', fontSize: 14, fontWeight: 600, color: t.text }}>Task graph</div>
          <div style={{ fontSize: 10, color: t.textDim }}>{tasks.length} tasks · {layout.layers.length} stage{layout.layers.length === 1 ? '' : 's'}</div>
        </div>
        {tasks.length === 0
          ? <div style={{ fontSize: 12, color: t.textMuted, fontStyle: 'italic', padding: 20, textAlign: 'center' }}>No tasks yet.</div>
          : <DagSVG layout={layout} tasks={tasks} statusColor={statusColor} t={t} mode={mode} onOpenChore={onOpenChore} />}
      </div>
    </div>
  );
}

function WindmillMissions({ projectId, tasks, missions, onOpenChore, statusColor, t }) {
  const projectMissions = React.useMemo(
    () => missions.filter((mission) => mission.projectId === projectId),
    [missions, projectId]
  );
  const tasksById = React.useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);

  const missionCards = React.useMemo(() => projectMissions.map((mission) => {
    const missionTasks = (mission.taskIds || []).map((id) => tasksById.get(id)).filter(Boolean);
    const done = missionTasks.filter((task) => task.status === 'done').length;
    const running = missionTasks.filter((task) => task.status === 'running').length;
    const review = missionTasks.filter((task) => task.status === 'review').length;
    const blocked = missionTasks.filter((task) => ['needs-human', 'failed', 'blocked', 'tribunal'].includes(task.status)).length;
    const progress = missionTasks.length ? Math.round((done / missionTasks.length) * 100) : (mission.progress_pct || 0);
    let derivedStatus = mission.status;
    if (blocked > 0) derivedStatus = 'needs-human';
    else if (missionTasks.length > 0 && done === missionTasks.length) derivedStatus = 'done';
    else if (running > 0) derivedStatus = 'running';
    else if (review > 0) derivedStatus = 'review';
    else derivedStatus = mission.status || 'active';
    return {
      mission,
      missionTasks,
      stats: {
        total: missionTasks.length || mission.taskIds?.length || 0,
        done,
        running,
        review,
        blocked,
        progress,
        derivedStatus,
      },
    };
  }), [projectMissions, tasksById]);

  if (!projectMissions.length) {
    return (
      <div style={{ padding: 24, borderRadius: 12, background: t.surface, border: `1px solid ${t.border}`, color: t.textMuted, fontStyle: 'italic', textAlign: 'center' }}>
        No missions yet. Start one from the Plan tab or ask Conductor in chat to take on a goal.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {missionCards.map(({ mission, missionTasks, stats }) => {
        const tone = statusColor(stats.derivedStatus);
        return (
          <div key={mission.id} style={{ padding: 16, borderRadius: 14, background: t.surface, border: `1px solid ${t.border}`, boxShadow: `0 10px 30px ${tone}12` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <GTag color={tone} solid>{stats.derivedStatus}</GTag>
              <div style={{ fontFamily: 'Fraunces, serif', fontSize: 17, fontWeight: 600, color: t.text, flex: 1, minWidth: 240 }}>{mission.goal}</div>
              <div style={{ fontSize: 10.5, color: t.textDim, fontFamily: 'JetBrains Mono, monospace' }}>{mission.id}</div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10, marginTop: 14 }}>
              <div style={{ padding: 10, borderRadius: 10, background: t.chipBg, border: `1px solid ${t.border}` }}>
                <div style={{ fontSize: 9.5, color: t.textDim, textTransform: 'uppercase', letterSpacing: .5, fontWeight: 700 }}>Progress</div>
                <div style={{ fontSize: 18, color: t.text, fontWeight: 700, marginTop: 4 }}>{stats.progress}%</div>
              </div>
              <div style={{ padding: 10, borderRadius: 10, background: t.chipBg, border: `1px solid ${t.border}` }}>
                <div style={{ fontSize: 9.5, color: t.textDim, textTransform: 'uppercase', letterSpacing: .5, fontWeight: 700 }}>Tasks</div>
                <div style={{ fontSize: 18, color: t.text, fontWeight: 700, marginTop: 4 }}>{stats.done}/{stats.total}</div>
              </div>
              <div style={{ padding: 10, borderRadius: 10, background: t.chipBg, border: `1px solid ${t.border}` }}>
                <div style={{ fontSize: 9.5, color: t.textDim, textTransform: 'uppercase', letterSpacing: .5, fontWeight: 700 }}>Running</div>
                <div style={{ fontSize: 18, color: t.text, fontWeight: 700, marginTop: 4 }}>{stats.running}</div>
              </div>
              <div style={{ padding: 10, borderRadius: 10, background: t.chipBg, border: `1px solid ${t.border}` }}>
                <div style={{ fontSize: 9.5, color: t.textDim, textTransform: 'uppercase', letterSpacing: .5, fontWeight: 700 }}>Needs Human</div>
                <div style={{ fontSize: 18, color: stats.blocked ? t.red : t.text, fontWeight: 700, marginTop: 4 }}>{stats.blocked}</div>
              </div>
            </div>

            <div style={{ marginTop: 12, height: 7, borderRadius: 999, background: t.border, overflow: 'hidden' }}>
              <div style={{ width: `${Math.max(4, stats.progress)}%`, height: '100%', background: tone, borderRadius: 999, transition: 'width .3s ease' }} />
            </div>

            {mission.report && (
              <div style={{ marginTop: 12, fontSize: 12, color: t.textDim, whiteSpace: 'pre-wrap', lineHeight: 1.55 }}>
                {mission.report}
              </div>
            )}

            {mission.missing_outputs?.length > 0 && (
              <div style={{ marginTop: 10, fontSize: 11.5, color: t.red }}>
                Missing outputs: {mission.missing_outputs.join(', ')}
              </div>
            )}

            {missionTasks.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <div style={{ fontSize: 10.5, color: t.textDim, textTransform: 'uppercase', letterSpacing: .5, fontWeight: 700, marginBottom: 8 }}>Mission tasks</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {missionTasks.map((task) => (
                    <button key={task.id} onClick={() => onOpenChore?.(task)} style={{
                      display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', cursor: 'pointer',
                      background: t.chipBg, border: `1px solid ${t.border}`, borderRadius: 10, padding: '10px 12px',
                    }}>
                      <div style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor(task.status), flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12.5, color: t.text, fontWeight: 600 }}>{task.title}</div>
                        <div style={{ fontSize: 10.5, color: t.textDim, fontFamily: 'JetBrains Mono, monospace' }}>{task.by} · {task.status}</div>
                      </div>
                      <div style={{ fontSize: 10.5, color: t.textMuted }}>{task.artifacts?.length || 0} art</div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Chat: talk to conductor and let missions continue in the background ──────
function WindmillChat({ projectId, tasks, missions, t }) {
  const [msgs, setMsgs] = React.useState([]);
  const [val, setVal] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [queued, setQueued] = React.useState(null);
  const endRef = React.useRef(null);
  const projectMissions = React.useMemo(
    () => missions.filter((mission) => mission.projectId === projectId).slice(0, 3),
    [missions, projectId]
  );
  const tasksById = React.useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);

  React.useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs]);

  React.useEffect(() => {
    let cancelled = false;
    setMsgs([]);
    if (!projectId) return () => { cancelled = true; };

    window.GApi.getMessages('conductor', projectId, 50)
      .then((res) => {
        if (cancelled) return;
        const history = (res.messages || [])
          .filter((msg) => msg.role === 'user' || msg.role === 'assistant')
          .map((msg) => ({
            id: msg.id,
            role: msg.role,
            text: msg.text,
            ts: msg.ts,
            provider: msg.provider,
          }));
        setMsgs(history);
      })
      .catch(() => {
        if (!cancelled) setMsgs([]);
      });

    return () => { cancelled = true; };
  }, [projectId]);

  React.useEffect(() => {
    if (!busy && queued) { const msg = queued; setQueued(null); doSend(msg); }
  }, [busy]);

  const doSend = async (text) => {
    if (!text || !projectId) return;
    setMsgs((m) => [...m, { role: 'user', text, ts: Date.now() }]);
    setBusy(true);
    try {
      const res = await window.GApi.sendMessage('conductor', text, projectId);
      const msg = res.message || res;
      setMsgs((m) => [...m, { role: 'assistant', text: msg.text || msg.reply || '(no reply)', ts: Date.now(), provider: msg.provider }]);
    } catch (err) {
      setMsgs((m) => [...m, { role: 'error', text: err.message, ts: Date.now() }]);
    } finally { setBusy(false); }
  };

  const send = () => {
    const text = val.trim();
    if (!text) return;
    setVal('');
    if (busy) { setQueued(text); }
    else { doSend(text); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0, background: t.surface, borderRadius: 12, border: `1px solid ${t.border}`, overflow: 'hidden', minHeight: 400 }}>
      <div style={{ padding: '10px 14px', borderBottom: `1px solid ${t.border}`, fontSize: 11, color: t.textDim, fontWeight: 600 }}>
        🎼 CONDUCTOR — mission orchestration chat
      </div>
      {projectMissions.length > 0 && (
        <div style={{ padding: '10px 14px', borderBottom: `1px solid ${t.border}`, background: t.chipBg }}>
          <div style={{ fontSize: 10.5, color: t.textDim, textTransform: 'uppercase', letterSpacing: .5, fontWeight: 700, marginBottom: 8 }}>Live missions</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {projectMissions.map((mission) => {
              const missionTasks = (mission.taskIds || []).map((id) => tasksById.get(id)).filter(Boolean);
              const done = missionTasks.filter((task) => task.status === 'done').length;
              const progress = missionTasks.length ? Math.round((done / missionTasks.length) * 100) : (mission.progress_pct || 0);
              const blocked = missionTasks.some((task) => ['needs-human', 'failed', 'blocked', 'tribunal'].includes(task.status));
              const tone = blocked ? t.red : progress === 100 ? t.green : t.orange;
              return (
                <div key={mission.id} style={{ minWidth: 180, flex: '1 1 180px', padding: '9px 10px', borderRadius: 10, border: `1px solid ${tone}44`, background: `${tone}12` }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <div style={{ width: 7, height: 7, borderRadius: '50%', background: tone, flexShrink: 0 }} />
                    <div style={{ fontSize: 11.5, color: t.text, fontWeight: 600 }}>{mission.goal?.slice(0, 48)}</div>
                  </div>
                  <div style={{ fontSize: 10, color: t.textDim, marginTop: 4 }}>{mission.id} · {progress}% · {missionTasks.length || mission.taskIds?.length || 0} tasks</div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <div style={{ flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 10, minHeight: 260 }}>
        {msgs.length === 0 && (
          <div style={{ fontSize: 12, color: t.textMuted, fontStyle: 'italic', textAlign: 'center', paddingTop: 24 }}>
            Talk to Conductor like an operator: ask for a fix or conversion, and he will turn it into a persistent mission with background execution.
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
            <div style={{
              maxWidth: '85%', padding: '9px 13px', borderRadius: 10, fontSize: 12.5, lineHeight: 1.5,
              background: m.role === 'user' ? `${t.purple}22` : m.role === 'error' ? `${t.red}11` : t.chipBg,
              border: `1px solid ${m.role === 'user' ? t.purple + '44' : m.role === 'error' ? t.red + '33' : t.border}`,
              color: m.role === 'error' ? t.red : t.text,
              whiteSpace: 'pre-wrap',
            }}>{m.text}</div>
            {m.provider && <div style={{ fontSize: 9, color: t.textMuted, marginTop: 2 }}>{m.provider}</div>}
          </div>
        ))}
        {busy && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: t.orange, animation: 'g-pulse 1s ease-in-out infinite' }} />
            <div style={{ fontSize: 11, color: t.textDim }}>Conductor thinking…{queued ? ` (next: "${queued.slice(0, 30)}…")` : ''}</div>
          </div>
        )}
        <div ref={endRef} />
      </div>
      <div style={{ padding: '10px 12px', borderTop: `1px solid ${t.border}`, display: 'flex', gap: 8 }}>
        <input value={val} onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && send()}
          placeholder={busy ? 'Conductor thinking… (type to queue)' : 'Ask conductor to fix, convert, or orchestrate work…'}
          style={{ flex: 1, padding: '9px 12px', borderRadius: 8, border: `1px solid ${t.border}`, background: t.chipBg, color: t.text, fontSize: 13, outline: 'none' }} />
        <button onClick={send} style={{
          padding: '9px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 700,
          background: busy ? `${t.orange}33` : `linear-gradient(135deg, ${t.orange}, ${t.purple})`,
          color: busy ? t.orange : '#fff',
        }}>{busy ? '…' : '↑'}</button>
      </div>
    </div>
  );
}

// Topological-ish layered layout: each node sits in `depth` layer = max(deps)+1.
function buildDagLayout(tasks) {
  if (!tasks.length) return { layers: [], byId: new Map() };
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const depth = new Map();
  const visiting = new Set();
  function compute(id) {
    if (depth.has(id)) return depth.get(id);
    if (visiting.has(id)) return 0; // cycle protection
    visiting.add(id);
    const t = byId.get(id);
    const deps = (t?.depends_on || []).filter((d) => byId.has(d));
    const d = deps.length ? 1 + Math.max(...deps.map(compute)) : 0;
    visiting.delete(id);
    depth.set(id, d);
    return d;
  }
  for (const t of tasks) compute(t.id);
  const maxDepth = Math.max(0, ...depth.values());
  const layers = Array.from({ length: maxDepth + 1 }, () => []);
  for (const t of tasks) layers[depth.get(t.id) || 0].push(t);
  // Stable sort within layer so it doesn't dance on each re-render
  layers.forEach((layer) => layer.sort((a, b) => (a.created_at || 0) - (b.created_at || 0)));
  return { layers, byId };
}

function DagSVG({ layout, tasks, statusColor, t, mode, onOpenChore }) {
  const NODE_W = 200, NODE_H = 56, COL_GAP = 70, ROW_GAP = 14, PADDING = 12;
  const positions = new Map();
  layout.layers.forEach((layer, ci) => {
    layer.forEach((task, ri) => {
      positions.set(task.id, {
        x: PADDING + ci * (NODE_W + COL_GAP),
        y: PADDING + ri * (NODE_H + ROW_GAP),
      });
    });
  });
  const maxRows = Math.max(1, ...layout.layers.map((l) => l.length));
  const totalW = PADDING * 2 + layout.layers.length * (NODE_W + COL_GAP);
  const totalH = PADDING * 2 + maxRows * (NODE_H + ROW_GAP);

  return (
    <div style={{ overflow: 'auto', maxHeight: 600 }}>
      <svg width={totalW} height={totalH} style={{ display: 'block' }}>
        {/* edges */}
        {tasks.flatMap((task) =>
          (task.depends_on || []).filter((d) => positions.has(d)).map((from) => {
            const a = positions.get(from);
            const b = positions.get(task.id);
            if (!a || !b) return null;
            const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2;
            const x2 = b.x, y2 = b.y + NODE_H / 2;
            const cx = (x1 + x2) / 2;
            const path = `M${x1},${y1} C${cx},${y1} ${cx},${y2} ${x2},${y2}`;
            return <path key={`${from}->${task.id}`} d={path} stroke={t.border} strokeWidth={1.2} fill="none" />;
          })
        )}
        {/* nodes */}
        {tasks.map((task) => {
          const p = positions.get(task.id);
          if (!p) return null;
          const c = statusColor(task.status);
          const running = task.status === 'running';
          return (
            <g key={task.id} transform={`translate(${p.x}, ${p.y})`} style={{ cursor: 'pointer' }} onClick={() => onOpenChore?.(task)}>
              <rect width={NODE_W} height={NODE_H} rx={8} ry={8}
                fill={mode === 'light' ? `${c}11` : `${c}22`}
                stroke={c} strokeWidth={running ? 2 : 1}
                style={running ? { animation: 'g-pulse 2s ease-in-out infinite' } : undefined}
              />
              <text x={10} y={18} fontSize={9.5} fill={c} fontFamily="JetBrains Mono, monospace" fontWeight={600}>
                {(task.by || '?').toUpperCase()} · {task.status}
              </text>
              <text x={10} y={36} fontSize={11.5} fill={t.text} fontFamily="Inter, sans-serif" fontWeight={600}>
                {(task.title || '').slice(0, 28)}{(task.title || '').length > 28 ? '…' : ''}
              </text>
              <text x={10} y={50} fontSize={9} fill={t.textDim} fontFamily="JetBrains Mono, monospace">
                {task.id} · {(task.artifacts?.length || 0)} artifact{task.artifacts?.length === 1 ? '' : 's'}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}



function G_Records({ projectId, recentTraces = [], selectedRecordPath }) {
  const { t, mode } = useG();
  const layout = useGLayout();
  const [records, setRecords] = React.useState([]);
  const [mission, setMission] = React.useState(null);
  const [open, setOpen] = React.useState(null);
  const [vaultTab, setVaultTab] = React.useState('reqs');

  React.useEffect(() => {
    if (!projectId) return;
    window.GApi?.vaultRecords?.(projectId).then((r) => setRecords(r.records || [])).catch(console.error);
    window.GApi?.recordsMission?.(projectId).then(setMission).catch(console.error);
  }, [projectId]);

  const viewNote = async (notePath) => {
    try {
      const note = await window.GApi.vaultNote(notePath);
      setOpen(note);
    } catch (err) { alert('open failed: ' + err.message); }
  };

  React.useEffect(() => {
    if (selectedRecordPath) viewNote(selectedRecordPath);
  }, [selectedRecordPath]);

  async function handleRetry(taskId) {
    try {
      await window.GApi.retryTask(taskId);
      window.GApi?.recordsMission?.(projectId).then(setMission).catch(() => {});
    } catch (e) { alert('retry failed: ' + e.message); }
  }

  const categorized = React.useMemo(() => {
    const cats = { reqs: [], decisions: [], runs: [], agents: [], other: [] };
    for (const r of records) {
      if (r.path.startsWith('reqs/') || r.path.includes('/reqs/')) cats.reqs.push(r);
      else if (r.path.startsWith('decisions/') || r.path.includes('/decisions/')) cats.decisions.push(r);
      else if (r.path.startsWith('runs/') || r.path.includes('/runs/')) cats.runs.push(r);
      else if (r.path.startsWith('agents/') || r.path.includes('/agents/')) cats.agents.push(r);
      else cats.other.push(r);
    }
    return cats;
  }, [records]);

  const agentClr = (by) => {
    const map = { forge: t.orange, aria: t.purple, hunter: t.red, delphi: '#4f9ef8', scribe: '#4ade80', conductor: t.textDim, vince: t.orange, ingo: t.purple, william: t.red, max: t.red };
    return map[(by || '').toLowerCase()] || t.textDim;
  };

  const statusClr = { 'needs-human': t.orange, 'failed': t.red, 'tribunal': '#f59e0b' };
  const kindIcon  = { tribunal: '⚖️', done: '✅', completed: '✅', escalated: '🚨', requeued: '🔄', cancelled: '⛔', audited: '🔍' };

  function relTime(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }

  const sp = mission?.sprint;
  const pct = sp && sp.total > 0 ? Math.round((sp.done / sp.total) * 100) : 0;

  const vaultTabs = [
    { id: 'reqs',      label: `Reqs (${categorized.reqs.length})` },
    { id: 'decisions', label: `Decisions (${categorized.decisions.length})` },
    { id: 'runs',      label: `Run logs (${categorized.runs.length})` },
    { id: 'agents',    label: `Agent memory (${categorized.agents.length})` },
  ];
  const vaultRows = vaultTab === 'reqs' ? categorized.reqs
    : vaultTab === 'decisions' ? categorized.decisions
    : vaultTab === 'runs' ? categorized.runs
    : categorized.agents;

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: layout.isMobile ? 14 : 18 }}>
      {/* Header */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontFamily: 'Fraunces, serif', fontSize: 22, fontWeight: 600, color: t.text, letterSpacing: -.3 }}>Record room</div>
        <div style={{ fontSize: 12, color: t.textDim, fontStyle: 'italic', marginTop: 2 }}>Mission trace · sprint health · vault docs</div>
      </div>

      {/* Sprint health bar */}
      {sp && (
        <div style={{ background: t.surface, border: `1px solid ${t.border}`, borderRadius: 12, padding: '12px 16px', marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            <div style={{ fontFamily: 'Fraunces, serif', fontSize: 13, fontWeight: 600, color: t.text, flexShrink: 0 }}>Sprint health</div>
            <div style={{ flex: 1, minWidth: 100, height: 6, background: t.border, borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ width: `${pct}%`, height: '100%', background: pct === 100 ? '#4ade80' : t.orange, borderRadius: 3, transition: 'width .4s' }} />
            </div>
            <div style={{ fontSize: 11, color: t.textDim, whiteSpace: 'nowrap' }}>{sp.done}/{sp.total} done ({pct}%)</div>
            {sp.running > 0 && <div style={{ fontSize: 11, color: t.purple, background: `${t.purple}22`, padding: '2px 8px', borderRadius: 10 }}>{sp.running} running</div>}
            {sp.queued  > 0 && <div style={{ fontSize: 11, color: t.textDim, background: t.chipBg, padding: '2px 8px', borderRadius: 10 }}>{sp.queued} queued</div>}
            {sp.blocked > 0 && <div style={{ fontSize: 11, color: t.red, background: `${t.red}22`, padding: '2px 8px', borderRadius: 10 }}>{sp.blocked} blocked</div>}
            {sp.review  > 0 && <div style={{ fontSize: 11, color: t.orange, background: `${t.orange}22`, padding: '2px 8px', borderRadius: 10 }}>{sp.review} review</div>}
          </div>
        </div>
      )}

      {/* Blockers + Sprint log */}
      <div style={{ display: 'grid', gridTemplateColumns: layout.stackPanels ? '1fr' : '1fr 1fr', gap: 16, marginBottom: 16 }}>

        {/* BLOCKERS */}
        <div style={{ background: t.surface, border: `1px solid ${t.border}`, borderRadius: 12, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: `1px solid ${t.border}` }}>
            <div style={{ fontFamily: 'Fraunces, serif', fontSize: 14, fontWeight: 600, color: t.text }}>Blockers</div>
            {mission?.blockers?.length > 0 && (
              <div style={{ fontSize: 10, color: t.red, background: `${t.red}22`, padding: '2px 8px', borderRadius: 10 }}>{mission.blockers.length}</div>
            )}
          </div>

          {/* Running (live pulse) */}
          {(mission?.running || []).map((r) => (
            <div key={r.id} style={{ display: 'flex', alignItems: 'center', padding: '8px 16px', borderBottom: `1px solid ${t.border}`, gap: 8 }}>
              <div style={{ width: 6, height: 6, borderRadius: 3, background: t.purple, flexShrink: 0, animation: 'g-pulse 2s ease-in-out infinite' }} />
              <div style={{ fontSize: 10.5, color: t.textDim, fontFamily: 'JetBrains Mono, monospace', width: 54, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{(r.by || '?').slice(0, 7)}</div>
              <div style={{ fontSize: 11.5, color: t.text, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</div>
              <div style={{ fontSize: 10, color: t.purple, flexShrink: 0 }}>running</div>
            </div>
          ))}

          {!mission && (
            <div style={{ padding: 20, color: t.textDim, fontSize: 11, fontStyle: 'italic', textAlign: 'center' }}>Loading…</div>
          )}
          {mission && mission.blockers?.length === 0 && (mission.running || []).length === 0 && (
            <div style={{ padding: 20, color: '#4ade80', fontSize: 11, textAlign: 'center' }}>✓ No blockers — pipeline is clear.</div>
          )}

          {(mission?.blockers || []).map((b) => (
            <div key={b.id} style={{ padding: '12px 16px', borderBottom: `1px solid ${t.border}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5, flexWrap: 'wrap' }}>
                <div style={{ fontSize: 10, fontFamily: 'JetBrains Mono, monospace', color: agentClr(b.by), background: `${agentClr(b.by)}22`, padding: '2px 6px', borderRadius: 6 }}>{(b.by || '?').toUpperCase()}</div>
                <div style={{ fontSize: 10, color: statusClr[b.status] || t.red, background: `${statusClr[b.status] || t.red}18`, padding: '2px 6px', borderRadius: 6 }}>{b.status}</div>
                {b.attempts > 0 && <div style={{ fontSize: 10, color: t.textDim }}>{b.attempts} attempt{b.attempts !== 1 ? 's' : ''}</div>}
                <div style={{ marginLeft: 'auto', fontSize: 10, color: t.textDim }}>{relTime(b.updated_at)}</div>
              </div>
              <div style={{ fontSize: 12, color: t.text, fontWeight: 500, marginBottom: 5, lineHeight: 1.4 }}>{b.title}</div>
              {b.lastError && (
                <div style={{ fontSize: 10.5, color: t.red, background: `${t.red}10`, borderRadius: 6, padding: '4px 8px', fontFamily: 'JetBrains Mono, monospace', marginBottom: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 62, overflow: 'hidden' }}>
                  {b.lastError.slice(0, 200)}{b.lastError.length > 200 ? '…' : ''}
                </div>
              )}
              <button onClick={() => handleRetry(b.id)} style={{ fontSize: 10, padding: '3px 10px', cursor: 'pointer', background: 'transparent', border: `1px solid ${t.orange}`, color: t.orange, borderRadius: 6 }}>re-queue</button>
            </div>
          ))}
        </div>

        {/* SPRINT LOG */}
        <div style={{ background: t.surface, border: `1px solid ${t.border}`, borderRadius: 12, overflow: 'hidden' }}>
          <div style={{ padding: '12px 16px', borderBottom: `1px solid ${t.border}` }}>
            <div style={{ fontFamily: 'Fraunces, serif', fontSize: 14, fontWeight: 600, color: t.text }}>Sprint log</div>
            <div style={{ fontSize: 10, color: t.textDim, marginTop: 2 }}>tribunal · milestones · escalations</div>
          </div>
          {mission && (mission?.significant || []).length === 0 && (
            <div style={{ padding: 20, color: t.textDim, fontSize: 11, fontStyle: 'italic', textAlign: 'center' }}>No significant events yet.</div>
          )}
          {(mission?.significant || []).map((ev, i) => (
            <div key={i} style={{ display: 'flex', gap: 10, padding: '10px 16px', borderBottom: `1px solid ${t.border}`, alignItems: 'flex-start' }}>
              <div style={{ fontSize: 14, flexShrink: 0, marginTop: 1 }}>{kindIcon[ev.kind] || '📋'}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2, flexWrap: 'wrap' }}>
                  <div style={{ fontSize: 10, fontFamily: 'JetBrains Mono, monospace', color: t.textDim }}>{ev.kind}</div>
                  <div style={{ fontSize: 10, color: agentClr(ev.by), fontFamily: 'JetBrains Mono, monospace' }}>{ev.by}</div>
                  <div style={{ marginLeft: 'auto', fontSize: 10, color: t.textDim, whiteSpace: 'nowrap' }}>{relTime(ev.ts)}</div>
                </div>
                <div style={{ fontSize: 11.5, color: t.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: ev.note ? 2 : 0 }}>{ev.title}</div>
                {ev.note && <div style={{ fontSize: 10.5, color: t.textDim, lineHeight: 1.4 }}>{ev.note.slice(0, 130)}</div>}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* VAULT NOTES */}
      <div style={{ background: t.surface, border: `1px solid ${t.border}`, borderRadius: 12, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', borderBottom: `1px solid ${t.border}`, padding: '0 4px' }}>
          {vaultTabs.map((tab) => (
            <button key={tab.id} onClick={() => setVaultTab(tab.id)} style={{
              padding: '10px 12px', fontSize: 11.5, cursor: 'pointer', background: 'transparent',
              border: 'none', borderBottom: `2px solid ${vaultTab === tab.id ? t.orange : 'transparent'}`,
              color: vaultTab === tab.id ? t.orange : t.textDim, fontFamily: 'inherit', transition: 'color .15s',
            }}>{tab.label}</button>
          ))}
        </div>
        {vaultRows.map((r) => (
          <div key={r.path} onClick={() => viewNote(r.path)}
            style={{ display: 'flex', alignItems: 'center', padding: '10px 16px', fontSize: 11.5, borderBottom: `1px solid ${t.border}`, cursor: 'pointer' }}
            onMouseEnter={(e) => e.currentTarget.style.background = t.chipBg}
            onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
            <div style={{ color: (vaultTab === 'reqs' || vaultTab === 'decisions') ? t.orange : t.purple, fontFamily: 'JetBrains Mono, monospace', width: 140, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.id || r.type}</div>
            <div style={{ color: t.text, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</div>
            <div style={{ color: t.textDim, fontSize: 10, flexShrink: 0 }}>{(r.size / 1024).toFixed(1)} KB</div>
          </div>
        ))}
        {vaultRows.length === 0 && (
          <div style={{ padding: 16, color: t.textDim, fontSize: 11, fontStyle: 'italic' }}>No {vaultTab} found for this project.</div>
        )}
      </div>

      {/* Note viewer modal */}
      {open && (
        <div onClick={() => setOpen(null)} style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', backdropFilter: 'blur(4px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200,
        }}>
          <div onClick={(e) => e.stopPropagation()} style={{
            background: t.surfaceSolid || t.surface, color: t.text, borderRadius: 14, border: `1px solid ${t.border}`,
            padding: 20, width: layout.isMobile ? 'calc(100vw - 24px)' : '90%', maxWidth: 880, maxHeight: '85vh', overflow: 'auto',
            boxShadow: '0 20px 60px rgba(0,0,0,.4)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
              <div>
                <div style={{ fontFamily: 'Fraunces, serif', fontSize: 18, fontWeight: 600 }}>{open.frontmatter?.title || open.path}</div>
                <div style={{ fontSize: 10, color: t.textDimmer, fontFamily: 'JetBrains Mono, monospace', marginTop: 3 }}>{open.path}</div>
              </div>
              <button onClick={() => setOpen(null)} style={{ background: t.chipBg, border: `1px solid ${t.border}`, color: t.text, borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 11 }}>close</button>
            </div>
            {open.frontmatter && Object.keys(open.frontmatter).length > 0 && (
              <div style={{ padding: 10, borderRadius: 8, background: t.chipBg, marginBottom: 12, fontSize: 11, fontFamily: 'JetBrains Mono, monospace', color: t.textDim }}>
                {Object.entries(open.frontmatter).map(([k, v]) => (
                  <div key={k}><span style={{ color: t.orange }}>{k}:</span> {Array.isArray(v) ? v.join(', ') : String(v)}</div>
                ))}
              </div>
            )}
            <pre style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, lineHeight: 1.6, color: t.text, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {open.body || '(empty)'}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

// ============== SETTINGS ==============
function G_Settings() {
  const { t, mode, setMode } = useG();
  const layout = useGLayout();
  const [density, setDensity] = React.useState('standard');
  const [metaphor, setMetaphor] = React.useState(true);
  const [notifs, setNotifs] = React.useState({ chores: true, tools: true, pings: false });

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: layout.isMobile ? 14 : 18, maxWidth: 820 }}>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontFamily: 'Fraunces, serif', fontSize: 22, fontWeight: 600, color: t.text, letterSpacing: -.3 }}>Settings</div>
        <div style={{ fontSize: 12, color: t.textDim, fontStyle: 'italic', marginTop: 2 }}>Set the homestead to your taste.</div>
      </div>

      <G_Panel title="Dawn & dusk" sub="how the porch looks to you" accent={t.orange} style={{ marginBottom: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: layout.isMobile ? '1fr' : '1fr 1fr', gap: 10 }}>
          {[
            { id: 'dark', l: 'Dusk', sub: 'purple + orange, liquid gradients', emoji: '🌆' },
            { id: 'light', l: 'Dawn', sub: 'white + orange, sun-washed', emoji: '☀️' },
          ].map((m) => (
            <button key={m.id} onClick={() => setMode(m.id)} style={{
              padding: 14, borderRadius: 10, textAlign: 'left', cursor: 'pointer',
              background: mode === m.id ? (mode === 'light' ? 'rgba(234,90,28,.08)' : 'linear-gradient(135deg, rgba(255,138,76,.18), rgba(168,85,247,.12))') : t.surface2,
              border: `1px solid ${mode === m.id ? t.borderHot : t.border}`,
              display: 'flex', gap: 12, alignItems: 'center',
            }}>
              <div style={{ fontSize: 28 }}>{m.emoji}</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: 'Fraunces, serif', fontSize: 13.5, color: t.text, fontWeight: 600 }}>{m.l}</div>
                <div style={{ fontSize: 11, color: t.textDim, fontStyle: 'italic' }}>{m.sub}</div>
              </div>
              {mode === m.id && <div style={{ width: 18, height: 18, borderRadius: 9, background: t.orange, display: 'flex', alignItems: 'center', justifyContent: 'center', color: mode === 'light' ? '#fff' : '#1a0f06' }}><GIcon d={G_ICONS.check2} size={11} stroke={2.5}/></div>}
            </button>
          ))}
        </div>
      </G_Panel>

      <G_Panel title="Density" accent={t.purple} style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 6 }}>
          {['comfortable', 'standard', 'compact'].map((d) => (
            <button key={d} onClick={() => setDensity(d)} style={{
              flex: 1, padding: 10, borderRadius: 8, cursor: 'pointer',
              background: density === d ? t.chipBg : 'transparent',
              border: `1px solid ${density === d ? t.borderHot : t.border}`,
              color: density === d ? t.text : t.textDim, fontSize: 12, textTransform: 'capitalize',
            }}>{d}</button>
          ))}
        </div>
      </G_Panel>

      <G_Panel title="Language of the land" sub="talk like a homesteader" accent={t.orange} style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12.5, color: t.text, fontWeight: 500 }}>Homestead metaphor</div>
            <div style={{ fontSize: 11, color: t.textDim, fontStyle: 'italic', marginTop: 2 }}>Projects become fields, agents are hands, MCPs are tools. Turn this off for plain terms (projects, agents, connectors, tasks).</div>
          </div>
          <button onClick={() => setMetaphor(!metaphor)} style={{ width: 44, height: 24, borderRadius: 12, border: 'none', background: metaphor ? t.orange : t.chipBg, position: 'relative', cursor: 'pointer', flexShrink: 0 }}>
            <div style={{ position: 'absolute', top: 2, left: metaphor ? 22 : 2, width: 20, height: 20, borderRadius: 10, background: '#fff', transition: 'left .2s', boxShadow: '0 2px 6px rgba(0,0,0,.3)' }}/>
          </button>
        </div>
      </G_Panel>

      <G_Panel title="Bells & hollers" sub="notifications" accent={t.purple} style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {[
            { k: 'chores', l: 'Chore state changes', sub: 'when anything moves on the board' },
            { k: 'tools', l: 'Tool hollers', sub: 'when an MCP misbehaves' },
            { k: 'pings', l: 'Social pings', sub: 'when a hand @mentions you' },
          ].map((x) => (
            <div key={x.k} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 0' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, color: t.text, fontWeight: 500 }}>{x.l}</div>
                <div style={{ fontSize: 10.5, color: t.textDim, fontStyle: 'italic' }}>{x.sub}</div>
              </div>
              <button onClick={() => setNotifs({ ...notifs, [x.k]: !notifs[x.k] })} style={{ width: 38, height: 20, borderRadius: 10, border: 'none', background: notifs[x.k] ? t.orange : t.chipBg, position: 'relative', cursor: 'pointer' }}>
                <div style={{ position: 'absolute', top: 2, left: notifs[x.k] ? 20 : 2, width: 16, height: 16, borderRadius: 8, background: '#fff', transition: 'left .2s', boxShadow: '0 2px 4px rgba(0,0,0,.3)' }}/>
              </button>
            </div>
          ))}
        </div>
      </G_Panel>

      <G_Panel title="Account" accent={t.orange}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '4px 0' }}>
          <div style={{ width: 40, height: 40, borderRadius: 20, background: `linear-gradient(135deg, ${t.orange}, ${t.purple})`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 600, color: '#fff' }}>JP</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, color: t.text, fontWeight: 600 }}>Jorge Paula</div>
            <div style={{ fontSize: 11, color: t.textDim, fontFamily: 'JetBrains Mono, monospace' }}>jorge@aumovio.internal · windows · single-seat</div>
          </div>
          <div style={{ padding: '7px 14px', borderRadius: 7, background: t.chipBg, color: t.textDim, border: `1px solid ${t.border}`, fontSize: 11.5 }}>Local workspace</div>
        </div>
      </G_Panel>
    </div>
  );
}

Object.assign(window, { G_Workshop, G_Shed, G_Windmill, G_Records, G_Settings });
