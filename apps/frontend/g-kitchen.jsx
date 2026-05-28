// Gavirila v2 — Kitchen table (chat with a hand) + global drawer.
// Agents now use Gemini function-calling to query vault, DB, and trace graph.

function G_ToolDetails({ toolCalls }) {
  const { t } = useG();
  const [open, setOpen] = React.useState(false);
  if (!toolCalls || !toolCalls.length) return null;
  return (
    <div style={{ marginTop: 2 }}>
      <button onClick={() => setOpen(!open)} style={{
        background: 'transparent', border: 'none', cursor: 'pointer',
        color: t.textDimmer, fontSize: 10, padding: '2px 0',
        display: 'flex', alignItems: 'center', gap: 4,
        fontFamily: 'JetBrains Mono, monospace',
      }}>
        <GIcon d={open ? G_ICONS.chevD : G_ICONS.chevR} size={8}/>
        {toolCalls.length} tool call{toolCalls.length > 1 ? 's' : ''} — {open ? 'hide' : 'show'} details
      </button>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
          {toolCalls.map((tc, i) => (
            <div key={i} style={{
              padding: '6px 8px', borderRadius: 6,
              background: t.chipBg, border: `1px solid ${t.border}`,
              fontSize: 10, fontFamily: 'JetBrains Mono, monospace',
              color: t.textDim, lineHeight: 1.5,
            }}>
              <div style={{ color: t.orange, fontWeight: 600, marginBottom: 2 }}>
                <GIcon d={G_ICONS.zap} size={8}/> {tc.name}
              </div>
              <div style={{ color: t.textDimmer }}>
                args: {JSON.stringify(tc.args || {}).slice(0, 120)}
              </div>
              {tc.result && (
                <div style={{ marginTop: 3, color: t.green, whiteSpace: 'pre-wrap', maxHeight: 100, overflow: 'auto' }}>
                  → {typeof tc.result === 'string' ? tc.result.slice(0, 200) : JSON.stringify(tc.result).slice(0, 200)}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function G_MsgBubble({ m, hand }) {
  const { t, mode } = useG();
  const isLight = mode === 'light';
  const isUser = m.role === 'user';
  const isSystem = m.role === 'system';

  if (isSystem) {
    return (
      <div style={{ textAlign: 'center', fontSize: 10.5, color: t.textDimmer, fontStyle: 'italic', padding: '6px 0', fontFamily: 'JetBrains Mono, monospace' }}>
        — {m.text} —
      </div>
    );
  }

  // Task-execution activity: compact strip, not a full chat bubble.
  // These are background task rounds — real tool calls or thinking text from the runner.
  if (m.source === 'task_execution') {
    const toolList = (m.tools || []).join('  ·  ');
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '3px 6px', borderRadius: 6,
        background: 'rgba(255,255,255,.03)', border: `1px solid ${t.border}`, opacity: 0.72 }}>
        <span style={{ fontSize: 9, color: t.textDimmer, fontFamily: 'JetBrains Mono, monospace', flexShrink: 0 }}>task</span>
        <span style={{ fontSize: 9.5, color: toolList ? t.orange : t.textDim, fontFamily: 'JetBrains Mono, monospace',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
          {toolList || m.text?.slice(0, 120) || '…'}
        </span>
        {m.liveTask && <span style={{ fontSize: 8, color: t.green, flexShrink: 0 }}>⚡</span>}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', gap: 10, flexDirection: isUser ? 'row-reverse' : 'row', animation: 'g-fade-in .3s ease-out' }}>
      <div style={{
        width: 30, height: 30, borderRadius: 8, flexShrink: 0,
        background: isUser
          ? `linear-gradient(135deg, ${t.orange}, ${t.purple})`
          : `linear-gradient(135deg, ${t.orange}44, ${t.purple}44)`,
        border: `1px solid ${t.border}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: isUser ? 11 : 15, fontWeight: 600, color: '#fff',
      }}>{isUser ? 'JP' : hand.emoji}</div>
      <div style={{ maxWidth: '76%', display: 'flex', flexDirection: 'column', gap: 4, alignItems: isUser ? 'flex-end' : 'flex-start' }}>
        <div style={{ fontSize: 10, color: t.textDimmer, padding: '0 2px', fontFamily: 'Fraunces, serif', fontStyle: 'italic', display: 'flex', gap: 5, alignItems: 'center' }}>
          {isUser ? 'you' : `${hand.name} · ${hand.role}`}
          {m.liveTask && <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 5, background: t.orange + '22', color: t.orange, fontStyle: 'normal', fontFamily: 'JetBrains Mono, monospace' }}>⚡ live</span>}
        </div>
        <div style={{
          padding: '10px 13px', borderRadius: 11,
          background: isUser
            ? `linear-gradient(135deg, ${t.orange}, ${t.orangeHot})`
            : (isLight ? 'rgba(255,255,255,.85)' : 'rgba(255,255,255,.05)'),
          color: isUser ? (isLight ? '#fff' : '#1a0f06') : t.text,
          border: isUser ? 'none' : `1px solid ${t.border}`,
          fontSize: 12.5, lineHeight: 1.5, textWrap: 'pretty',
          boxShadow: isUser ? `0 4px 14px ${t.orange}33` : 'none',
          whiteSpace: 'pre-wrap',
        }}>
          {m.thinking ? (
            <div style={{ display: 'flex', gap: 4, alignItems: 'center', padding: '2px 0' }}>
              <div style={{ width: 5, height: 5, borderRadius: 3, background: t.orange, animation: 'g-bounce 1.4s infinite .0s' }}/>
              <div style={{ width: 5, height: 5, borderRadius: 3, background: t.orange, animation: 'g-bounce 1.4s infinite .2s' }}/>
              <div style={{ width: 5, height: 5, borderRadius: 3, background: t.orange, animation: 'g-bounce 1.4s infinite .4s' }}/>
            </div>
          ) : m.text}
        </div>
        {m.tools && m.tools.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
              {m.tools.map((tc, i) => (
                <div key={i} style={{
                  fontSize: 10, padding: '3px 8px', borderRadius: 5,
                  background: t.chipBg, color: t.orange,
                  fontFamily: 'JetBrains Mono, monospace',
                  border: `1px solid ${t.borderHot}`,
                  display: 'flex', alignItems: 'center', gap: 5,
                }}>
                  <GIcon d={G_ICONS.zap} size={9}/> {tc}
                </div>
              ))}
            </div>
            {m.toolCalls && m.toolCalls.length > 0 && (
              <G_ToolDetails toolCalls={m.toolCalls} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function G_ChatInput({ onSend, disabled, hand, compact = false }) {
  const { t, mode } = useG();
  const [val, setVal] = React.useState('');
  const [queued, setQueued] = React.useState(null); // message queued while busy

  // When busy clears, fire the queued message
  React.useEffect(() => {
    if (!disabled && queued) {
      const msg = queued;
      setQueued(null);
      onSend(msg);
    }
  }, [disabled]);

  const send = () => {
    if (!val.trim()) return;
    if (disabled) {
      setQueued(val.trim()); // queue it — will fire when busy clears
      setVal('');
    } else {
      onSend(val.trim());
      setVal('');
    }
  };

  return (
    <div style={{ padding: compact ? 10 : 14, borderTop: compact ? `1px solid ${t.border}` : 'none' }}>
      {queued && (
        <div style={{ fontSize: 11, color: t.orange, padding: '3px 10px 5px', fontFamily: 'JetBrains Mono, monospace' }}>
          Queued: "{queued.slice(0, 40)}{queued.length > 40 ? '…' : ''}" — will send when agent responds
        </div>
      )}
      <div style={{
        display: 'flex', alignItems: 'flex-end', gap: 8, padding: 10, borderRadius: 12,
        background: mode === 'light' ? 'rgba(255,255,255,.85)' : 'rgba(255,255,255,.04)',
        border: `1px solid ${disabled ? t.border : t.borderStrong || t.border}`,
        transition: 'border-color .15s',
        opacity: disabled ? 0.75 : 1,
      }}>
        <button style={{ width: 26, height: 26, borderRadius: 6, background: 'transparent', border: 'none', color: t.textDim, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <GIcon d={G_ICONS.attach} size={13}/>
        </button>
        <textarea
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder={disabled ? `${hand.name} is thinking… (type to queue)` : `Pass ${hand.name} a note…`}
          rows={1}
          style={{
            flex: 1, background: 'transparent', border: 'none', outline: 'none',
            color: t.text, fontSize: 13, lineHeight: 1.5, resize: 'none',
            fontFamily: 'inherit', minHeight: 22, maxHeight: 120,
          }}
        />
        <button onClick={send} disabled={!val.trim() && !queued} style={{
          width: 30, height: 30, borderRadius: 8, border: 'none',
          background: val.trim() ? `linear-gradient(135deg, ${t.orange}, ${t.orangeHot})` : t.chipBg,
          color: val.trim() ? (mode === 'light' ? '#fff' : '#1a0f06') : t.textMuted,
          cursor: val.trim() ? 'pointer' : 'default',
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          boxShadow: val.trim() ? `0 4px 12px ${t.orange}44` : 'none',
        }}>
          {disabled ? <GDot color={t.orange} pulse size={6} /> : <GIcon d={G_ICONS.send} size={13}/>}
        </button>
      </div>
    </div>
  );
}

// Chat hook — proxies to /api/agents/:id/messages so every reply goes
// through the backend's LLM router (Gemini / Aumovio / Anthropic / canned
// fallback). Falls back to a friendly offline message if the server is
// unreachable so the demo never goes silent.
function useG_Chat(hand, projectId) {
  const [msgs, setMsgs] = React.useState([]);
  const [busy, setBusy] = React.useState(false);
  const [totalCount, setTotalCount] = React.useState(0);
  const [loadedCount, setLoadedCount] = React.useState(0);
  const [loadingOlder, setLoadingOlder] = React.useState(false);

  const CHAT_PAGE = 50;

  const applyHistory = (res) => {
    const history = (res.messages || []).map(m => ({
      ...m,
      id: m.id || `${Date.now()}-${Math.random()}`,
      role: m.role || 'assistant',
      text: m.text || ''
    }));
    const sys = { id: 's1', role: 'system', text: `chat · ${hand.id} · project ${projectId}` };
    setMsgs([sys, ...history]);
    setLoadedCount(history.length);
    setTotalCount(res.total || history.length);
  };

  // Load history on agent/project switch
  React.useEffect(() => {
    if (!hand.id || !projectId) { setMsgs([]); setTotalCount(0); setLoadedCount(0); return; }
    setMsgs([]);
    setTotalCount(0);
    setLoadedCount(0);
    window.GApi.getMessages(hand.id, projectId, CHAT_PAGE).then(applyHistory)
      .catch(err => console.warn('[chat] history fetch failed', err));
  }, [hand.id, projectId]);

  // Subscribe to real-time WS chat:reply events
  React.useEffect(() => {
    if (!hand.id || !projectId) return;
    const off = window.GApi.subscribeChatReply(hand.id, projectId, (m) => {
      setMsgs((prev) => {
        if (prev.some((x) => x.id === m.id)) return prev;
        return [...prev, { ...m, role: m.role || 'assistant', liveTask: true }];
      });
      setTotalCount(c => c + 1);
      setLoadedCount(c => c + 1);
    });
    return off;
  }, [hand.id, projectId]);

  // Load an additional page of older messages
  const loadOlder = React.useCallback(async () => {
    if (loadingOlder || !hand.id || !projectId) return;
    const nextLimit = loadedCount + CHAT_PAGE;
    setLoadingOlder(true);
    try {
      const res = await window.GApi.getMessages(hand.id, projectId, nextLimit);
      applyHistory(res);
    } catch (err) {
      console.warn('[chat] loadOlder failed', err);
    } finally {
      setLoadingOlder(false);
    }
  }, [hand.id, projectId, loadedCount, loadingOlder]);

  const send = React.useCallback(async (text) => {
    if (!projectId) {
      setMsgs((prev) => [...prev, { id: `e-${Date.now()}`, role: 'assistant',
        text: 'Pick a project first — agents only work inside one project.' }]);
      return;
    }
    const myId = `u-${Date.now()}`;
    setMsgs((prev) => [...prev, { id: myId, role: 'user', text }]);
    setBusy(true);
    const thinkingId = `t-${Date.now()}`;
    setMsgs((prev) => [...prev, { id: thinkingId, role: 'assistant', thinking: true }]);
    try {
      const out = await window.GApi.sendMessage(hand.id, text, projectId);
      const m = out.message;
      setMsgs((prev) => prev.filter((x) => x.id !== thinkingId).concat({
        id: m.id, role: 'assistant', text: m.text, tools: m.tools,
        toolCalls: m.toolCalls, provider: m.provider, model: m.model, tier: m.tier,
      }));
    } catch (err) {
      setMsgs((prev) => prev.filter((x) => x.id !== thinkingId).concat({
        id: `e-${Date.now()}`, role: 'assistant',
        text: `(${hand.name} · error) ${err.message || 'network'}`,
      }));
    } finally {
      setBusy(false);
    }
  }, [hand, projectId]);

  const hasMore = totalCount > loadedCount;
  return { msgs, setMsgs, busy, send, hasMore, loadOlder, loadingOlder, totalCount, loadedCount };
}

function G_Kitchen({ agents, projectId, selectedHandId }) {
  const { t, mode } = useG();
  const layout = useGLayout();
  const hands = agents && agents.length > 0 ? agents : (window.G_HANDS || []);
  const [handId, setHandId] = React.useState(hands[0]?.id || 'aria');
  const [showAgentForm, setShowAgentForm] = React.useState(false);
  const [showExec, setShowExec] = React.useState(false);
  const hand = hands.find((h) => h.id === handId) || hands[0] || {};

  React.useEffect(() => {
    if (selectedHandId && hands.some((h) => h.id === selectedHandId)) setHandId(selectedHandId);
  }, [hands, selectedHandId]);

  React.useEffect(() => {
    if (!hands.some((h) => h.id === handId)) setHandId(hands[0]?.id || 'aria');
  }, [handId, hands]);

  const chat = useG_Chat(hand, projectId);

  // Scroll to bottom on new messages, but NOT when loading older (would jump to top)
  const scrollRef = React.useRef(null);
  const preventScrollRef = React.useRef(false);
  React.useEffect(() => {
    if (preventScrollRef.current) { preventScrollRef.current = false; return; }
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [chat.msgs]);

  // Load older preserving scroll position
  const handleLoadOlder = async () => {
    const el = scrollRef.current;
    const prevHeight = el ? el.scrollHeight : 0;
    preventScrollRef.current = true;
    await chat.loadOlder();
    if (el) requestAnimationFrame(() => { el.scrollTop = el.scrollHeight - prevHeight; });
  };

  return (
    <div style={{ flex: 1, display: 'flex', minHeight: 0, flexDirection: layout.isMobile ? 'column' : 'row' }}>
      {/* Hand picker */}
      {layout.isMobile ? (
        <div style={{ flexShrink: 0, borderBottom: `1px solid ${t.border}`, padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ fontFamily: 'Fraunces, serif', fontSize: 13, color: t.text, fontWeight: 600 }}>Hands at the table</div>
            <div style={{ flex: 1 }} />
            <button onClick={() => setShowAgentForm(true)} style={{
              padding: '7px 12px', borderRadius: 8, border: `1px solid ${t.border}`,
              background: t.chipBg, color: t.text, cursor: 'pointer', fontSize: 11.5,
              display: 'flex', alignItems: 'center', gap: 6,
            }}>
              <GIcon d={G_ICONS.plus} size={10} /> New hand
            </button>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <div style={{ display: 'flex', gap: 8, minWidth: 'max-content' }}>
              {hands.map((h) => (
                <button key={h.id} onClick={() => setHandId(h.id)} style={{
                  minWidth: 180, display: 'flex', alignItems: 'center', gap: 10, padding: 10, borderRadius: 9,
                  background: handId === h.id ? (mode === 'light' ? 'rgba(234,90,28,.08)' : 'rgba(255,255,255,.04)') : 'transparent',
                  border: handId === h.id ? `1px solid ${t.borderHot}` : `1px solid ${t.border}`,
                  cursor: 'pointer', textAlign: 'left', color: t.text,
                }}>
                  <div style={{ width: 34, height: 34, borderRadius: 8, background: `linear-gradient(135deg, ${t.orange}44, ${t.purple}44)`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 17, border: `1px solid ${t.border}`, flexShrink: 0 }}>{h.emoji}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, color: t.text, fontFamily: 'Fraunces, serif', fontWeight: 600 }}>{h.name}</div>
                    <div style={{ fontSize: 10.5, color: t.textDim, fontStyle: 'italic', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.role}</div>
                  </div>
                  <GDot color={h.warn ? t.yellow : h.busy ? t.green : t.textMuted} pulse={h.busy} size={7}/>
                </button>
              ))}
            </div>
          </div>
          <div style={{ padding: 10, borderRadius: 9, background: t.chipBg, border: `1px solid ${t.border}`, fontSize: 11, color: t.textDim, fontStyle: 'italic', lineHeight: 1.4 }}>
            <div style={{ fontSize: 9.5, color: t.orange, fontWeight: 700, letterSpacing: .5, textTransform: 'uppercase', marginBottom: 4, fontStyle: 'normal' }}>tip</div>
            Hit {layout.kbdLabel} J to throw open the global kitchen drawer from anywhere.
          </div>
        </div>
      ) : (
        <div style={{ width: 240, flexShrink: 0, borderRight: `1px solid ${t.border}`, padding: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ fontFamily: 'Fraunces, serif', fontSize: 13, color: t.text, fontWeight: 600, padding: '4px 8px 10px' }}>Hands at the table</div>
          {hands.map((h) => (
            <button key={h.id} onClick={() => setHandId(h.id)} style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: 10, borderRadius: 9,
              background: handId === h.id ? (mode === 'light' ? 'rgba(234,90,28,.08)' : 'rgba(255,255,255,.04)') : 'transparent',
              border: handId === h.id ? `1px solid ${t.borderHot}` : `1px solid transparent`,
              cursor: 'pointer', textAlign: 'left', width: '100%', position: 'relative',
            }}>
              <div style={{ width: 34, height: 34, borderRadius: 8, background: `linear-gradient(135deg, ${t.orange}44, ${t.purple}44)`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 17, border: `1px solid ${t.border}`, flexShrink: 0 }}>{h.emoji}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, color: t.text, fontFamily: 'Fraunces, serif', fontWeight: 600 }}>{h.name}</div>
                <div style={{ fontSize: 10.5, color: t.textDim, fontStyle: 'italic', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.role}</div>
              </div>
              <GDot color={h.warn ? t.yellow : h.busy ? t.green : t.textMuted} pulse={h.busy} size={7}/>
            </button>
          ))}

          <div style={{ flex: 1 }} />
          <button onClick={() => setShowAgentForm(true)} style={{
            padding: '8px 12px', borderRadius: 8, border: 'none', cursor: 'pointer',
            background: t.chipBg, color: t.text, border: `1px solid ${t.border}`,
            fontSize: 12, fontWeight: 500, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            marginBottom: 8,
          }}>
            <GIcon d={G_ICONS.plus} size={11} /> New hand
          </button>
          <div style={{ padding: 10, borderRadius: 9, background: t.chipBg, border: `1px solid ${t.border}`, fontSize: 11, color: t.textDim, fontStyle: 'italic', lineHeight: 1.4 }}>
            <div style={{ fontSize: 9.5, color: t.orange, fontWeight: 700, letterSpacing: .5, textTransform: 'uppercase', marginBottom: 4, fontStyle: 'normal' }}>tip</div>
            Hit {layout.kbdLabel} J to throw open the global kitchen drawer from anywhere.
          </div>
        </div>
      )}

      {/* Chat */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div style={{ minHeight: 54, flexShrink: 0, padding: layout.isMobile ? '10px 14px' : '0 18px', display: 'flex', alignItems: 'center', gap: 12, borderBottom: `1px solid ${t.border}`, flexWrap: layout.isMobile ? 'wrap' : 'nowrap' }}>
          <div style={{ width: 34, height: 34, borderRadius: 8, background: `linear-gradient(135deg, ${t.orange}44, ${t.purple}44)`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 17, border: `1px solid ${t.border}` }}>{hand.emoji}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: 'Fraunces, serif', fontSize: 14, color: t.text, fontWeight: 600 }}>{hand.name}</div>
            <div style={{ fontSize: 11, color: t.textDim, fontStyle: 'italic', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{hand.task}</div>
          </div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
            {(hand.mcps || []).map((m, i) => (
              <div key={i} style={{ fontSize: 10, padding: '3px 8px', borderRadius: 5, background: t.chipBg, color: t.textDim, fontFamily: 'JetBrains Mono, monospace', border: `1px solid ${t.border}` }}>{m}</div>
            ))}
            {(() => {
              const execCount = chat.msgs.filter(m => m.source === 'task_execution').length;
              if (!execCount) return null;
              return (
                <button onClick={() => setShowExec(x => !x)} style={{
                  padding: '3px 8px', borderRadius: 5, border: `1px solid ${showExec ? t.orange : t.border}`,
                  background: showExec ? t.orange + '18' : t.chipBg, color: showExec ? t.orange : t.textDimmer,
                  fontSize: 9.5, cursor: 'pointer', fontFamily: 'JetBrains Mono, monospace',
                  display: 'flex', alignItems: 'center', gap: 4,
                }}>
                  🔧 {execCount} {showExec ? 'hide' : 'show'}
                </button>
              );
            })()}
          </div>
        </div>
        <div ref={scrollRef} style={{ flex: 1, overflow: 'auto', padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {chat.hasMore && (
            <button onClick={handleLoadOlder} disabled={chat.loadingOlder} style={{
              alignSelf: 'center', padding: '5px 14px', borderRadius: 20,
              background: 'transparent', border: `1px solid ${t.border}`,
              color: t.textDimmer, fontSize: 10.5, cursor: chat.loadingOlder ? 'default' : 'pointer',
              fontFamily: 'JetBrains Mono, monospace', opacity: chat.loadingOlder ? .5 : 1,
            }}>
              {chat.loadingOlder ? '⟳ loading…' : `↑ ${chat.totalCount - chat.loadedCount} older messages`}
            </button>
          )}
          {chat.msgs.filter(m => showExec || m.source !== 'task_execution').map((m) => <G_MsgBubble key={m.id} m={m} hand={hand}/>)}
        </div>
        <G_ChatInput onSend={(t) => chat.send(t)} disabled={chat.busy} hand={hand} />
      </div>

      {/* Global drawer placeholder if needed, though handled in G_Drawer normally */}
      {showAgentForm && <G_AgentFormModal onClose={() => setShowAgentForm(false)} onCreated={(a) => { setHandId(a.id); setShowAgentForm(false); window.GApi?.fetchState?.(); }} />}
    </div>
  );
}

// ----- Agent creation modal -----
function G_AgentFormModal({ onClose, onCreated }) {
  const { t, mode } = useG();
  const layout = useGLayout();
  const isLight = mode === 'light';
  const [name, setName] = React.useState('');
  const [role, setRole] = React.useState('');
  const [system_prompt, setSystemPrompt] = React.useState('');
  const [emoji, setEmoji] = React.useState('🤖');
  const [saving, setSaving] = React.useState(false);

  async function handleSubmit() {
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      const res = await fetch('/api/agents', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, role, system_prompt, emoji, tier: 'strong', memory_scope: 'project' }),
      });
      const agent = await res.json();
      if (agent.id) onCreated?.(agent);
      else alert(agent.error || 'Failed');
    } catch (e) { alert(e.message); }
    setSaving(false);
  }

  const inputStyle = {
    padding: '8px 10px', borderRadius: 7, border: `1px solid ${t.border}`,
    background: t.chipBg, color: t.text, fontSize: 12.5, fontFamily: 'inherit', outline: 'none', width: '100%',
  };

  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 200, background: 'rgba(0,0,0,.5)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ width: layout.isMobile ? 'calc(100vw - 24px)' : 480, maxWidth: 480, padding: 24, borderRadius: 16, background: t.surface, border: `1px solid ${t.borderStrong}`, boxShadow: t.shadow, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <div style={{ fontFamily: 'Fraunces, serif', fontSize: 20, fontWeight: 600, color: t.text, flex: 1 }}>Hire a new hand</div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: t.textDim, cursor: 'pointer' }}><GIcon d={G_ICONS.x} size={14}/></button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr', gap: 12 }}>
          <div>
            <div style={{ fontSize: 10.5, color: t.textDim, textTransform: 'uppercase', letterSpacing: .5, fontWeight: 600, marginBottom: 4 }}>Emoji</div>
            <input value={emoji} onChange={e => setEmoji(e.target.value)} style={{ ...inputStyle, textAlign: 'center', fontSize: 16 }} />
          </div>
          <div>
            <div style={{ fontSize: 10.5, color: t.textDim, textTransform: 'uppercase', letterSpacing: .5, fontWeight: 600, marginBottom: 4 }}>Name</div>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Scribe" style={inputStyle} autoFocus />
          </div>
        </div>
        <div>
          <div style={{ fontSize: 10.5, color: t.textDim, textTransform: 'uppercase', letterSpacing: .5, fontWeight: 600, marginBottom: 4 }}>Role</div>
          <input value={role} onChange={e => setRole(e.target.value)} placeholder="e.g. Technical writer" style={inputStyle} />
        </div>
        <div>
          <div style={{ fontSize: 10.5, color: t.textDim, textTransform: 'uppercase', letterSpacing: .5, fontWeight: 600, marginBottom: 4 }}>System Prompt</div>
          <textarea value={system_prompt} onChange={e => setSystemPrompt(e.target.value)} placeholder="You are Scribe, an expert in documentation..." rows={5} style={{ ...inputStyle, resize: 'vertical' }}/>
        </div>
        <button onClick={handleSubmit} disabled={saving || !name.trim()} style={{
          padding: '10px 18px', borderRadius: 9, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600,
          background: `linear-gradient(135deg, ${t.orange}, ${t.orangeHot})`,
          color: isLight ? '#fff' : '#1a0f06', opacity: saving ? .5 : 1,
          boxShadow: `0 6px 20px ${t.orange}44`,
        }}>{saving ? 'Hiring…' : 'Hire hand'}</button>
      </div>
    </div>
  );
}

// Global drawer — Manager chat (cross-project oversight, no execution tools).
// Use this to ask things like "what's stuck", "summarize all projects",
// "which agent should I poke next".
function useG_Manager() {
  const [msgs, setMsgs] = React.useState([
    { id: 's1', role: 'system', text: 'manager · cross-project advisor · read-only' },
    { id: 'a0', role: 'assistant', text: 'Ask me about your projects. I see the full picture but I won\'t touch anything.' },
  ]);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    window.GApi?.managerHistory?.().then((res) => {
      const history = (res?.messages || []).map((m) => ({ id: m.id, role: m.role, text: m.text }));
      if (history.length) setMsgs([{ id: 's1', role: 'system', text: 'manager · cross-project advisor' }, ...history]);
    }).catch(() => {});
  }, []);

  const send = React.useCallback(async (text) => {
    setMsgs((prev) => [...prev, { id: `u-${Date.now()}`, role: 'user', text }]);
    const tid = `t-${Date.now()}`;
    setMsgs((prev) => [...prev, { id: tid, role: 'assistant', thinking: true }]);
    setBusy(true);
    try {
      const out = await window.GApi.managerSend(text);
      const m = out.message;
      setMsgs((prev) => prev.filter((x) => x.id !== tid).concat({
        id: m.id, role: 'assistant', text: m.text, provider: m.provider, model: m.model,
      }));
    } catch (err) {
      setMsgs((prev) => prev.filter((x) => x.id !== tid).concat({
        id: `e-${Date.now()}`, role: 'assistant', text: `(manager error) ${err.message}`,
      }));
    } finally { setBusy(false); }
  }, []);

  return { msgs, busy, send };
}

function G_Drawer({ open, onClose }) {
  const { t, mode } = useG();
  const layout = useGLayout();
  const hand = { id: 'manager', name: 'Manager', emoji: '🧭', role: 'cross-project advisor' };
  const chat = useG_Manager();
  const scrollRef = React.useRef(null);
  React.useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [chat.msgs, open]);

  return (
    <>
      {open && <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.3)', zIndex: 20, animation: 'g-fade-in .2s' }}/>}
      <div style={{
        position: 'absolute', top: 0, right: 0, bottom: 0, width: layout.isMobile ? Math.min(layout.width, 420) : 380, maxWidth: '100%', zIndex: 21,
        background: mode === 'light' ? 'rgba(255,251,245,.96)' : 'rgba(14,6,24,.9)',
        backdropFilter: 'blur(40px)',
        borderLeft: `1px solid ${t.borderStrong}`,
        boxShadow: open ? '-20px 0 60px rgba(0,0,0,.3)' : 'none',
        transform: open ? 'translateX(0)' : 'translateX(100%)',
        transition: 'transform .3s cubic-bezier(.4,.2,.2,1)',
        display: 'flex', flexDirection: 'column',
        pointerEvents: open ? 'auto' : 'none',
      }}>
        <div style={{ height: 48, flexShrink: 0, padding: '0 14px', display: 'flex', alignItems: 'center', gap: 10, borderBottom: `1px solid ${t.border}` }}>
          <div style={{ width: 28, height: 28, borderRadius: 7, background: `linear-gradient(135deg, ${t.orange}44, ${t.purple}44)`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, border: `1px solid ${t.border}` }}>{hand.emoji}</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: 'Fraunces, serif', fontSize: 13, color: t.text, fontWeight: 600 }}>Kitchen · {hand.name}</div>
            <div style={{ fontSize: 10, color: t.textDim, fontStyle: 'italic' }}>quick drawer</div>
          </div>
          <button onClick={onClose} style={{ width: 26, height: 26, borderRadius: 13, background: t.chipBg, border: `1px solid ${t.border}`, color: t.textDim, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <GIcon d={G_ICONS.x} size={10}/>
          </button>
        </div>
        <div ref={scrollRef} style={{ flex: 1, overflow: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {chat.msgs.map((m) => <G_MsgBubble key={m.id} m={m} hand={hand}/>)}
        </div>
        <G_ChatInput onSend={chat.send} disabled={chat.busy} hand={hand} compact/>
      </div>
    </>
  );
}

Object.assign(window, { G_Kitchen, G_Drawer, G_MsgBubble, G_ChatInput, G_ToolDetails, useG_Chat });
