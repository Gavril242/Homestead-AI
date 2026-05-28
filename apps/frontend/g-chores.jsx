// Gavirila v2 — Chore board (interactive kanban with click-to-advance)
// plus the chore creation flow and LIVE ticket detail panel.

const G_COLS = [
  { id: 'queued', t: 'In the queue', emoji: '📋', color: null },
  { id: 'running', t: 'Underway', emoji: '🔨', color: 'orange' },
  { id: 'review', t: 'In review', emoji: '🔍', color: 'yellow' },
  { id: 'done', t: 'Put away', emoji: '✓', color: 'green' },
];

function G_Chores({ chores, setChores, onAssignChat, onOpenChore, onCreateChore }) {
  const { t, mode } = useG();
  const layout = useGLayout();
  const [filter, setFilter] = React.useState('all');
  const [draggedId, setDraggedId] = React.useState(null);
  const [hoverCol, setHoverCol] = React.useState(null);
  const singleColumn = layout.isMobile;
  const boardColumns = singleColumn ? 1 : (layout.isTablet ? 2 : 4);
  const columnWidth = layout.isTablet ? 300 : 280;

  const advance = (c) => {
    const order = ['queued', 'running', 'review', 'done'];
    const next = order[Math.min(order.indexOf(c.status) + 1, order.length - 1)];
    setChores((all) => all.map((x) => x.id === c.id ? { ...x, status: next } : x));
    window.GApi?.patchTask?.(c.id, { status: next }).catch(() => {});
  };

  const moveTo = (id, statusId) => {
    setChores((all) => all.map((x) => x.id === id ? { ...x, status: statusId } : x));
    window.GApi?.patchTask?.(id, { status: statusId }).catch(() => {});
  };

  const colorFor = (name) => ({ orange: t.orange, yellow: t.yellow, green: t.green, red: t.red }[name] || t.textDim);

  return (
    <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', padding: layout.isMobile ? 14 : 18, gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontFamily: 'Fraunces, serif', fontSize: 22, fontWeight: 600, color: t.text, letterSpacing: -.3 }}>Chore board</div>
          <div style={{ fontSize: 12, color: t.textDim, fontStyle: 'italic', marginTop: 2 }}>Click a card to see details, or drag it where it belongs.</div>
        </div>
        <div style={{ flex: 1, minWidth: 0 }} />
        <div style={{ display: 'flex', gap: 4, padding: 3, borderRadius: 9, background: t.chipBg, border: `1px solid ${t.border}` }}>
          {['all', 'mine', 'aria', 'forge', 'vince'].map((f) => (
            <button key={f} onClick={() => setFilter(f)} style={{
              padding: '6px 12px', borderRadius: 6, border: 'none', cursor: 'pointer',
              background: filter === f ? t.orange : 'transparent',
              color: filter === f ? (mode === 'light' ? '#fff' : '#1a0f06') : t.textDim,
              fontSize: 11.5, fontWeight: 500, fontFamily: 'inherit', textTransform: 'capitalize',
            }}>{f}</button>
          ))}
        </div>
        <button onClick={onCreateChore} style={{
          padding: '8px 14px', borderRadius: 8, border: 'none', cursor: 'pointer',
          background: `linear-gradient(135deg, ${t.orange}, ${t.orangeHot})`,
          color: mode === 'light' ? '#fff' : '#1a0f06', fontSize: 12, fontWeight: 600,
          display: 'flex', alignItems: 'center', gap: 6, boxShadow: `0 4px 14px ${t.orange}44`,
        }}>
          <GIcon d={G_ICONS.plus} size={11} stroke={2.4} /> New chore
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowX: singleColumn ? 'hidden' : 'auto', overflowY: 'hidden' }}>
        <div style={{ display: 'grid', gridTemplateColumns: singleColumn ? '1fr' : `repeat(${boardColumns}, minmax(${columnWidth}px, ${layout.isTablet ? 360 : 420}px))`, gap: 10, minHeight: '100%', height: '100%', minWidth: singleColumn ? 0 : boardColumns * columnWidth + (boardColumns - 1) * 10 }}>
          {G_COLS.map((col) => {
            const items = chores.filter((c) => c.status === col.id && (filter === 'all' || (filter === 'mine' ? (c.by || '').toLowerCase() === 'human' : (c.by || '').toLowerCase() === filter)));
            const isHover = hoverCol === col.id;
            return (
              <div key={col.id}
                onDragOver={(e) => { e.preventDefault(); setHoverCol(col.id); }}
                onDragLeave={() => setHoverCol((h) => h === col.id ? null : h)}
                onDrop={() => { if (draggedId) moveTo(draggedId, col.id); setDraggedId(null); setHoverCol(null); }}
                style={{
                  display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0, height: '100%',
                  background: isHover ? `${colorFor(col.color) || t.orange}11` : t.surface,
                  backdropFilter: 'blur(24px)',
                  border: `1px solid ${isHover ? colorFor(col.color) || t.borderHot : t.border}`,
                  borderRadius: 12, padding: 10, transition: 'all .15s',
                }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '2px 4px 10px', flexShrink: 0 }}>
                  <span style={{ fontSize: 14 }}>{col.emoji}</span>
                  <div style={{ fontSize: 12.5, color: t.text, fontWeight: 600, fontFamily: 'Fraunces, serif' }}>{col.t}</div>
                  <div style={{ fontSize: 10.5, color: t.textDimmer, fontVariantNumeric: 'tabular-nums', fontFamily: 'JetBrains Mono, monospace' }}>{items.length}</div>
                  <div style={{ flex: 1 }} />
                  {col.color && <div style={{ width: 5, height: 5, borderRadius: 3, background: colorFor(col.color), boxShadow: `0 0 6px ${colorFor(col.color)}` }} />}
                </div>
                <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {items.map((c) => (
                    <G_ChoreCard key={c.id} c={c} onAdvance={() => advance(c)} onDrag={() => setDraggedId(c.id)} onChat={() => onAssignChat && onAssignChat(c)} onOpen={() => onOpenChore && onOpenChore(c)} />
                  ))}
                  {items.length === 0 && (
                    <div style={{ padding: '20px 10px', fontSize: 11, color: t.textMuted, fontStyle: 'italic', textAlign: 'center', border: `1px dashed ${t.border}`, borderRadius: 8 }}>nothin' here yet</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function G_ChoreCard({ c, onAdvance, onDrag, onChat, onOpen }) {
  const { t, mode } = useG();
  const [hover, setHover] = React.useState(false);
  return (
    <div draggable onDragStart={onDrag} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      onClick={() => onOpen ? onOpen() : onAdvance()}
      style={{
        flex: '0 0 auto',
        padding: '10px 12px', borderRadius: 8,
        background: t.surface2, border: `1px solid ${hover ? t.borderHot : t.border}`,
        cursor: 'pointer', position: 'relative', overflow: 'hidden', transition: 'all .15s',
        transform: hover ? 'translateY(-1px)' : 'none',
        boxShadow: hover ? `0 6px 18px ${mode === 'light' ? 'rgba(168,48,8,.1)' : 'rgba(0,0,0,.4)'}` : 'none',
      }}>
      <div style={{ fontSize: 12, color: t.text, lineHeight: 1.4, marginBottom: 7, fontWeight: 500, wordBreak: 'break-word' }}>{c.title}</div>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        <GTag color={t.orange}>{c.tag}</GTag>
        {c.trig && <GTag color={t.purple}>{c.trig}</GTag>}
        {c.depends_on && c.depends_on.length > 0 && <GTag color={t.purple}>🔒 {c.depends_on.length}</GTag>}
        <div style={{ flex: 1 }} />
        <div style={{ fontSize: 10, color: t.textDimmer, fontStyle: 'italic', whiteSpace: 'nowrap' }}>{c.by}</div>
      </div>
      {c.outcome && (
        <div style={{ fontSize: 10, fontFamily: 'JetBrains Mono, monospace', color: t.textDim, background: t.chipBg, padding: '4px 7px', borderRadius: 5, border: `1px solid ${t.border}`, wordBreak: 'break-word', marginTop: 6 }}>{c.outcome}</div>
      )}
      {hover && (
        <div style={{ position: 'absolute', top: 6, right: 6, display: 'flex', gap: 4 }}>
          <button onClick={(e) => { e.stopPropagation(); onAdvance && onAdvance(); }} title="Nudge forward" style={{ width: 22, height: 22, borderRadius: 5, background: t.surfaceRaised, border: `1px solid ${t.border}`, color: t.textDim, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <GIcon d={G_ICONS.chevR} size={10}/>
          </button>
          <button onClick={(e) => { e.stopPropagation(); onChat && onChat(); }} title="Chat" style={{ width: 22, height: 22, borderRadius: 5, background: t.surfaceRaised, border: `1px solid ${t.border}`, color: t.textDim, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <GIcon d={G_ICONS.chat} size={10}/>
          </button>
        </div>
      )}
    </div>
  );
}

// ----- LIVE Chore detail: fetches real data, shows history, artifacts, messages, retry -----
function G_ChoreDetail({ chore, onClose }) {
  const { t, mode } = useG();
  const layout = useGLayout();
  const [task, setTask] = React.useState(chore);
  const [comment, setComment] = React.useState('');
  const [sending, setSending] = React.useState(false);
  const [busyAction, setBusyAction] = React.useState(false);

  const c = task;
  const history = c.history || [];
  const comments = c.comments || [];
  const messages = c.messages || [];
  const artifacts = c.artifacts || [];
  const acceptance = c.acceptance || [];
  const dependsOn = c.depends_on || [];
  const statusColor = {
    queued: t.textDim, running: t.orange, review: t.yellow, done: t.green,
    failed: t.red, 'needs-info': t.yellow, 'needs-human': t.red, cancelled: t.textMuted,
  }[c.status] || t.textDim;

  const hand = (window.G_HANDS || []).find(h => (h.name||'').toLowerCase() === (c.by||'').toLowerCase()) || { id: c.by?.toLowerCase() || 'forge', name: c.by || 'Agent' };

  // Live-refresh: WebSocket listener + interval fallback
  React.useEffect(() => {
    let cancelled = false;
    const refetch = () => window.GApi.getTask(chore.id).then(d => { if (!cancelled && d.id) setTask(d); }).catch(() => {});
    refetch();
    const off = window.GApi.subscribe?.((msg) => {
      if (!msg) return;
      const isUs = msg.task?.id === chore.id || msg.taskId === chore.id;
      if (isUs && (msg.kind === 'task:update' || msg.kind === 'task:artifact' || msg.kind === 'task:message')) refetch();
    });
    const iv = setInterval(refetch, 4000);
    return () => { cancelled = true; off?.(); clearInterval(iv); };
  }, [chore.id]);

  const postComment = async () => {
    if (!comment.trim() || sending) return;
    setSending(true);
    try {
      const updated = await window.GApi.addTaskComment(c.id, comment);
      if (updated?.id) setTask(updated);
      else window.GApi.getTask(c.id).then(d => { if (d?.id) setTask(d); }).catch(() => {});
      setComment('');
    } catch (e) { alert('Send failed: ' + e.message); }
    setSending(false);
  };

  const retry = async () => {
    setBusyAction(true);
    try { const u = await window.GApi.retryTask(c.id); if (u?.id) setTask(u); }
    catch (e) { alert('Retry failed: ' + e.message); }
    finally { setBusyAction(false); }
  };
  const cancel = async () => {
    if (!confirm('Cancel this task?')) return;
    setBusyAction(true);
    try { const u = await window.GApi.cancelTask(c.id); if (u?.id) setTask(u); }
    catch (e) { alert('Cancel failed: ' + e.message); }
    finally { setBusyAction(false); }
  };
  const audit = async () => {
    setBusyAction(true);
    try {
      const r = await window.GApi.auditTask(c.id);
      if (r?.task?.id) setTask(r.task);
    } catch (e) { alert('Audit failed: ' + e.message); }
    finally { setBusyAction(false); }
  };

  // Build a unified timeline: artifacts + messages + history, sorted by ts.
  const timeline = React.useMemo(() => {
    const events = [];
    for (const a of artifacts) events.push({ ...a, _kind: 'artifact' });
    for (const m of messages) events.push({ ...m, _kind: 'message' });
    for (const h of history) events.push({ ...h, _kind: 'history' });
    return events.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  }, [artifacts, messages, history]);

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <button onClick={onClose} style={{ padding: '7px 10px', borderRadius: 7, background: t.chipBg, color: t.textDim, border: `1px solid ${t.border}`, cursor: 'pointer', fontSize: 11.5, display: 'flex', alignItems: 'center', gap: 6 }}>
          <GIcon d={G_ICONS.chevL} size={11}/> Back
        </button>
        <div style={{ fontSize: 10, color: t.textDimmer, fontFamily: 'JetBrains Mono, monospace' }}>{c.id}</div>
        <GTag color={t.orange}>{c.tag}</GTag>
        <GTag color={statusColor} solid>{c.status}</GTag>
        {dependsOn.length > 0 && <GTag color={t.purple}>🔒 deps: {dependsOn.length}</GTag>}
        {c.attempts > 1 && <GTag color={t.yellow}>attempt {c.attempts}</GTag>}
        <div style={{ flex: 1 }} />
        <button onClick={retry} disabled={busyAction || c.status === 'running'} style={{
          padding: '7px 12px', borderRadius: 7, border: `1px solid ${t.border}`,
          background: t.chipBg, color: t.text, fontSize: 11.5, cursor: 'pointer', fontWeight: 600,
          opacity: (busyAction || c.status === 'running') ? .4 : 1,
        }}>↻ Retry</button>
        <button onClick={audit} disabled={busyAction || (acceptance.length === 0)} title={acceptance.length === 0 ? 'no acceptance criteria' : 'fire the Gemma 4 jury'} style={{
          padding: '7px 12px', borderRadius: 7, border: `1px solid ${t.purple}55`,
          background: `${t.purple}11`, color: t.purple, fontSize: 11.5, cursor: 'pointer', fontWeight: 600,
          opacity: (busyAction || acceptance.length === 0) ? .4 : 1,
        }}>🛡 Audit</button>
        <button onClick={cancel} disabled={busyAction || c.status === 'cancelled' || c.status === 'done'} style={{
          padding: '7px 12px', borderRadius: 7, border: `1px solid ${t.red}55`,
          background: `${t.red}11`, color: t.red, fontSize: 11.5, cursor: 'pointer', fontWeight: 600,
          opacity: (busyAction || c.status === 'cancelled' || c.status === 'done') ? .4 : 1,
        }}>✕ Cancel</button>
      </div>

      {/* Title & desc */}
      <div style={{ fontFamily: 'Fraunces, serif', fontSize: 24, fontWeight: 500, color: t.text, letterSpacing: -.4 }}>{c.title}</div>
      <div style={{ fontSize: 12.5, color: t.textDim, lineHeight: 1.5, maxWidth: 720 }}>{c.desc || 'No description provided.'}</div>

      {dependsOn.length > 0 && (
        <div style={{ padding: 10, borderRadius: 8, background: `${t.purple}11`, border: `1px solid ${t.purple}33`, fontSize: 11, color: t.purple }}>
          <b style={{ fontWeight: 600 }}>Dependencies:</b> This task cannot start until the following tasks are marked <b>done</b>: {dependsOn.join(', ')}.
        </div>
      )}

      {/* Outcome / Changes */}
      {c.outcome && (
        <div style={{ padding: 12, borderRadius: 10, background: `${t.green}11`, border: `1px solid ${t.green}33` }}>
          <div style={{ fontSize: 10, color: t.green, textTransform: 'uppercase', fontWeight: 700, marginBottom: 8 }}>Outcome & Tools Called</div>
          <div style={{ fontSize: 11, color: t.text, fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'pre-wrap', lineHeight: 1.5, maxHeight: 300, overflow: 'auto' }}>
            {c.outcome.replace(/\\n/g, '\n')}
          </div>
        </div>
      )}

      {/* Error */}
      {c.error && (
        <div style={{ padding: 12, borderRadius: 10, background: `${t.red}11`, border: `1px solid ${t.red}33` }}>
          <div style={{ fontSize: 10, color: t.red, textTransform: 'uppercase', fontWeight: 700, marginBottom: 4 }}>Error</div>
          <div style={{ fontSize: 12, color: t.text, fontFamily: 'JetBrains Mono, monospace' }}>{c.error}</div>
        </div>
      )}

      {/* Acceptance criteria block (from goal→DAG planner) */}
      {acceptance.length > 0 && (
        <div style={{ padding: 12, borderRadius: 10, background: `${t.purple}10`, border: `1px solid ${t.purple}33` }}>
          <div style={{ fontSize: 10, color: t.purple, textTransform: 'uppercase', fontWeight: 700, marginBottom: 6 }}>Acceptance criteria</div>
          {acceptance.map((a, i) => (
            <div key={i} style={{ fontSize: 12, color: t.text, lineHeight: 1.5, paddingLeft: 14, position: 'relative' }}>
              <span style={{ position: 'absolute', left: 0 }}>·</span>{a}
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: layout.stackPanels ? '1fr' : '1.5fr 1fr', gap: 14 }}>
        {/* LEFT: unified live timeline */}
        <div style={{ padding: 14, borderRadius: 12, background: t.surface, border: `1px solid ${t.border}`, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontFamily: 'Fraunces, serif', fontSize: 14, fontWeight: 600, color: t.text }}>Live timeline</div>
            <div style={{ fontSize: 10, color: t.textDimmer }}>
              {artifacts.length} tools · {messages.length} messages · {history.length} events
            </div>
          </div>
          <div style={{ maxHeight: 480, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
            {timeline.length === 0 && <div style={{ fontSize: 11, color: t.textMuted, fontStyle: 'italic', padding: 12 }}>No activity yet — waiting for the runner to pick this up.</div>}
            {timeline.map((e, i) => {
              const isArtifact = e._kind === 'artifact';
              const isMessage = e._kind === 'message';
              const icon = isArtifact ? (e.ok === false ? '❌' : (e.summary?.match(/^[\p{Emoji}\p{So}]/u)?.[0] || '🔧'))
                : isMessage ? (e.kind === 'question' ? '❓' : e.kind === 'blocker' ? '🚧' : e.role === 'human' ? '🧑' : '💬')
                : (e.kind === 'started' ? '🚀' : e.kind === 'finished' ? '✅' : e.kind === 'failed' ? '⚠' : e.kind === 'requeued' ? '🔁' : '·');
              const tone = isArtifact && e.ok === false ? t.red
                : isMessage && e.kind === 'blocker' ? t.red
                : isMessage && e.kind === 'question' ? t.yellow
                : isArtifact ? t.orange
                : isMessage ? t.purple
                : t.textDim;
              return (
                <div key={i} style={{ display: 'flex', gap: 10, padding: '8px 4px', borderBottom: i < timeline.length - 1 ? `1px solid ${t.border}` : 'none' }}>
                  <div style={{ width: 26, fontSize: 13, textAlign: 'center', flexShrink: 0, color: tone }}>{icon}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 11.5, color: t.text, lineHeight: 1.5, wordBreak: 'break-word' }}>
                      {isArtifact && (
                        <span style={{ fontFamily: 'JetBrains Mono, monospace' }}>{e.summary?.replace(/^[\p{Emoji}\p{So}]\s*/u, '')}</span>
                      )}
                      {isMessage && (
                        <>
                          <b style={{ fontWeight: 600, color: e.role === 'human' ? t.orange : t.text }}>{e.by}</b>
                          {e.kind && e.kind !== 'comment' && <span style={{ color: tone, fontSize: 10, marginLeft: 6, padding: '1px 5px', borderRadius: 3, background: `${tone}22` }}>{e.kind}</span>}
                          <div style={{ marginTop: 3, color: t.textDim, whiteSpace: 'pre-wrap' }}>{e.text}</div>
                        </>
                      )}
                      {!isArtifact && !isMessage && (
                        <>
                          <b style={{ fontWeight: 600 }}>{e.by || 'system'}</b>
                          <span style={{ color: t.textDim }}> {e.kind}</span>
                          {e.note && <span style={{ color: t.textDim }}> — {e.note}</span>}
                        </>
                      )}
                    </div>
                    <div style={{ fontSize: 9.5, color: t.textDimmer, marginTop: 2, fontFamily: 'JetBrains Mono, monospace' }}>{e.ts ? new Date(e.ts).toLocaleTimeString() : ''}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* RIGHT: Info + Comments */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Assigned agent + task vitals */}
          <div style={{ padding: 14, borderRadius: 12, background: t.surface, border: `1px solid ${t.border}` }}>
            <div style={{ fontSize: 10.5, color: t.textDim, textTransform: 'uppercase', letterSpacing: .5, fontWeight: 600, marginBottom: 8 }}>Assigned</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 36, height: 36, borderRadius: 9, background: `linear-gradient(135deg, ${t.orange}44, ${t.purple}44)`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 }}>
                {hand.emoji || '🤖'}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: 'Fraunces, serif', fontSize: 13, color: t.text, fontWeight: 600 }}>{hand.name}</div>
                <div style={{ fontSize: 10.5, color: t.textDim, fontStyle: 'italic' }}>{hand.role || 'agent'}</div>
              </div>
            </div>
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${t.border}`, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 10.5 }}>
              <div><span style={{ color: t.textDim }}>created:</span> <span style={{ color: t.text }}>{c.created_at ? new Date(c.created_at).toLocaleString() : '—'}</span></div>
              <div><span style={{ color: t.textDim }}>updated:</span> <span style={{ color: t.text }}>{c.updated_at ? new Date(c.updated_at).toLocaleString() : '—'}</span></div>
              <div><span style={{ color: t.textDim }}>attempts:</span> <span style={{ color: t.text }}>{c.attempts || 0}</span></div>
              <div><span style={{ color: t.textDim }}>artifacts:</span> <span style={{ color: t.text }}>{artifacts.length}</span></div>
            </div>
          </div>

          {/* Conversation thread */}
          <div style={{ padding: 14, borderRadius: 12, background: t.surface, border: `1px solid ${t.border}`, flex: 1, display: 'flex', flexDirection: 'column' }}>
            <div style={{ fontSize: 10.5, color: t.textDim, textTransform: 'uppercase', letterSpacing: .5, fontWeight: 600, marginBottom: 8 }}>
              Conversation
              {c.status === 'needs-info' && <span style={{ color: t.yellow, marginLeft: 8 }}>· agent is waiting for you</span>}
            </div>
            <div style={{ flex: 1, maxHeight: 280, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
              {messages.length === 0 && comments.length === 0 && (
                <div style={{ fontSize: 11, color: t.textMuted, fontStyle: 'italic' }}>No messages yet. Reply to guide the agent — your message re-triggers the task.</div>
              )}
              {[...messages, ...comments.map((cm) => ({ ...cm, role: cm.by === 'human' ? 'human' : 'agent' }))].sort((a, b) => (a.ts || 0) - (b.ts || 0)).map((m, i) => {
                const isHuman = m.role === 'human' || m.by === 'human' || m.by === (window.G_ME || 'human');
                return (
                  <div key={i} style={{ padding: '8px 10px', borderRadius: 8,
                    background: isHuman ? `${t.orange}11` : (m.kind === 'question' ? `${t.yellow}11` : m.kind === 'blocker' ? `${t.red}11` : t.chipBg),
                    border: `1px solid ${isHuman ? t.orange + '33' : (m.kind === 'question' ? t.yellow + '33' : m.kind === 'blocker' ? t.red + '33' : t.border)}`,
                  }}>
                    <div style={{ fontSize: 10, color: isHuman ? t.orange : t.textDim, fontWeight: 600, marginBottom: 3, display: 'flex', justifyContent: 'space-between' }}>
                      <span>{m.by} {m.kind && m.kind !== 'comment' && `· ${m.kind}`}</span>
                      <span style={{ color: t.textDimmer }}>{new Date(m.ts).toLocaleTimeString()}</span>
                    </div>
                    <div style={{ fontSize: 12, color: t.text, lineHeight: 1.45, whiteSpace: 'pre-wrap' }}>{m.text}</div>
                    {m.options && m.options.length > 0 && (
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                        {m.options.map((opt, j) => (
                          <button key={j} onClick={() => { setComment(opt); }} style={{
                            padding: '4px 10px', borderRadius: 5, fontSize: 11, cursor: 'pointer',
                            background: t.chipBg, color: t.text, border: `1px solid ${t.border}`,
                          }}>{opt}</button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input value={comment} onChange={e => setComment(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && postComment()}
                placeholder={c.status === 'needs-info' ? 'Answer the agent…' : 'Reply or guide the agent…'}
                style={{ flex: 1, padding: '8px 10px', borderRadius: 7, border: `1px solid ${t.border}`, background: t.chipBg, color: t.text, fontSize: 12, fontFamily: 'inherit', outline: 'none' }} />
              <button onClick={postComment} disabled={sending || !comment.trim()} style={{
                padding: '8px 12px', borderRadius: 7, border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 600,
                background: t.orange, color: mode === 'light' ? '#fff' : '#1a0f06', opacity: sending ? .5 : 1,
              }}>{sending ? '…' : 'Send'}</button>
            </div>
            {c.status !== 'queued' && c.status !== 'running' && (
              <div style={{ fontSize: 10, color: t.textDimmer, marginTop: 6, fontStyle: 'italic' }}>
                Sending re-queues the task with your message as feedback.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ----- Chore creation modal -----
function G_ChoreFormModal({ projectId, onClose, onCreated }) {
  const { t, mode } = useG();
  const layout = useGLayout();
  const isLight = mode === 'light';
  const [title, setTitle] = React.useState('');
  const [desc, setDesc] = React.useState('');
  const [by, setBy] = React.useState('Forge');
  const [tag, setTag] = React.useState('task');
  const [saving, setSaving] = React.useState(false);

  async function handleSubmit() {
    if (!title.trim() || saving) return;
    setSaving(true);
    try {
      const res = await fetch('/api/tasks', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, desc, by, tag, project_id: projectId }),
      });
      const task = await res.json();
      if (task.id) onCreated?.(task);
      else alert(task.error || 'Failed');
    } catch (e) { alert(e.message); }
    setSaving(false);
  }

  const inputStyle = {
    padding: '8px 10px', borderRadius: 7, border: `1px solid ${t.border}`,
    background: t.chipBg, color: t.text, fontSize: 12.5, fontFamily: 'inherit', outline: 'none', width: '100%',
  };

  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 200, background: 'rgba(0,0,0,.5)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ width: layout.isMobile ? 'calc(100vw - 24px)' : 440, maxWidth: 440, padding: 24, borderRadius: 16, background: t.surface, border: `1px solid ${t.borderStrong}`, boxShadow: t.shadow, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <div style={{ fontFamily: 'Fraunces, serif', fontSize: 20, fontWeight: 600, color: t.text, flex: 1 }}>Post a new chore</div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: t.textDim, cursor: 'pointer' }}><GIcon d={G_ICONS.x} size={14}/></button>
        </div>
        <div>
          <div style={{ fontSize: 10.5, color: t.textDim, textTransform: 'uppercase', letterSpacing: .5, fontWeight: 600, marginBottom: 4 }}>Title</div>
          <input value={title} onChange={e => setTitle(e.target.value)} placeholder="What needs doing?" style={inputStyle} autoFocus/>
        </div>
        <div>
          <div style={{ fontSize: 10.5, color: t.textDim, textTransform: 'uppercase', letterSpacing: .5, fontWeight: 600, marginBottom: 4 }}>Description</div>
          <textarea value={desc} onChange={e => setDesc(e.target.value)} placeholder="Details, context, links…" rows={3} style={{ ...inputStyle, resize: 'vertical' }}/>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: layout.isMobile ? '1fr' : '1fr 1fr', gap: 12 }}>
          <div>
            <div style={{ fontSize: 10.5, color: t.textDim, textTransform: 'uppercase', letterSpacing: .5, fontWeight: 600, marginBottom: 4 }}>Assign to</div>
            <select value={by} onChange={e => setBy(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
              {['Forge', 'Aria', 'Vince', 'Hunter', 'Delphi', 'Ingo', 'Scribe', 'Conductor'].map(a => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
          <div>
            <div style={{ fontSize: 10.5, color: t.textDim, textTransform: 'uppercase', letterSpacing: .5, fontWeight: 600, marginBottom: 4 }}>Tag</div>
            <select value={tag} onChange={e => setTag(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
              {['task', 'bug', 'feature', 'test', 'doc', 'review', 'devops'].map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
        </div>
        <button onClick={handleSubmit} disabled={saving || !title.trim()} style={{
          padding: '10px 18px', borderRadius: 9, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600,
          background: `linear-gradient(135deg, ${t.orange}, ${t.orangeHot})`,
          color: isLight ? '#fff' : '#1a0f06', opacity: saving ? .5 : 1,
          boxShadow: `0 6px 20px ${t.orange}44`,
        }}>{saving ? 'Posting…' : 'Post chore'}</button>
      </div>
    </div>
  );
}

Object.assign(window, { G_Chores, G_ChoreCard, G_ChoreDetail, G_ChoreFormModal });
