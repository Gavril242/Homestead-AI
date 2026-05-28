// Gavirila v2 — Requirements Board
// Jira-style requirements with vault cross-linking and task coverage tracking.

const PRIORITY_COLORS = { high: '#ef4444', medium: '#f59e0b', low: '#6b7280' };
const STATUS_BADGE = {
  active: { bg: '#10b98122', fg: '#10b981', label: 'Active' },
  done:   { bg: '#6b728022', fg: '#9ca3af', label: 'Done'   },
  draft:  { bg: '#f59e0b22', fg: '#f59e0b', label: 'Draft'  },
};

function CoveragePill({ count, status, t }) {
  const colors = {
    queued:  { bg: t.chipBg, fg: t.textDim  },
    running: { bg: t.orange + '22', fg: t.orange },
    review:  { bg: t.purple + '22', fg: t.purple },
    done:    { bg: t.green  + '22', fg: t.green  },
  };
  const c = colors[status] || { bg: t.chipBg, fg: t.textDim };
  return (
    <span style={{
      padding: '2px 7px', borderRadius: 10, fontSize: 9.5, fontWeight: 700,
      background: c.bg, color: c.fg, fontFamily: 'JetBrains Mono, monospace',
    }}>
      {count} {status}
    </span>
  );
}

function ReqCard({ req, t, onEdit, onDelete }) {
  const [open, setOpen] = React.useState(false);
  const sb = STATUS_BADGE[req.status] || STATUS_BADGE.active;
  const cv = req.coverage || {};
  const hasAnyTasks = (cv.total || 0) > 0;

  return (
    <div style={{
      border: `1px solid ${t.border}`, borderRadius: 10, background: t.panelBg,
      overflow: 'hidden',
    }}>
      {/* Header row */}
      <div style={{
        display: 'flex', alignItems: 'flex-start', gap: 10,
        padding: '12px 14px', cursor: 'pointer',
      }} onClick={() => setOpen(!open)}>
        <GIcon d={open ? G_ICONS.chevD : G_ICONS.chevR} size={11} color={t.textDim} style={{ marginTop: 3, flexShrink: 0 }}/>

        {/* Priority dot */}
        <div style={{
          width: 8, height: 8, borderRadius: 4, marginTop: 5, flexShrink: 0,
          background: PRIORITY_COLORS[req.priority] || PRIORITY_COLORS.medium,
        }}/>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{
              fontSize: 10, fontFamily: 'JetBrains Mono, monospace', color: t.textDimmer,
              letterSpacing: 0.5,
            }}>{req.id}</span>
            <span style={{ fontSize: 13, fontWeight: 600, color: t.text }}>{req.title}</span>
            <span style={{
              fontSize: 9.5, padding: '1px 7px', borderRadius: 8,
              background: sb.bg, color: sb.fg,
            }}>{sb.label}</span>
          </div>
          {req.desc && !open && (
            <div style={{ fontSize: 11, color: t.textDim, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {req.desc}
            </div>
          )}
          {/* Coverage strip */}
          <div style={{ display: 'flex', gap: 5, marginTop: 6, flexWrap: 'wrap' }}>
            {!hasAnyTasks && <span style={{ fontSize: 10, color: t.textDimmer }}>no tasks linked yet</span>}
            {cv.queued  > 0 && <CoveragePill count={cv.queued}  status="queued"  t={t}/>}
            {cv.running > 0 && <CoveragePill count={cv.running} status="running" t={t}/>}
            {cv.review  > 0 && <CoveragePill count={cv.review}  status="review"  t={t}/>}
            {cv.done    > 0 && <CoveragePill count={cv.done}    status="done"    t={t}/>}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          <button onClick={(e) => { e.stopPropagation(); onEdit(req); }} style={{
            background: 'none', border: 'none', cursor: 'pointer', color: t.textDimmer, padding: 4,
          }} title="Edit">
            <GIcon d={G_ICONS.spark} size={12}/>
          </button>
          <button onClick={(e) => { e.stopPropagation(); onDelete(req); }} style={{
            background: 'none', border: 'none', cursor: 'pointer', color: t.textDimmer, padding: 4,
          }} title="Delete">
            <GIcon d={G_ICONS.trash} size={12}/>
          </button>
        </div>
      </div>

      {/* Expanded detail */}
      {open && (
        <div style={{ borderTop: `1px solid ${t.border}`, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {req.desc && (
            <div>
              <div style={{ fontSize: 10, fontWeight: 600, color: t.textDimmer, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>Description</div>
              <div style={{ fontSize: 12, color: t.text, lineHeight: 1.6 }}>{req.desc}</div>
            </div>
          )}

          {/* Acceptance criteria */}
          {(req.criteria || []).length > 0 && (
            <div>
              <div style={{ fontSize: 10, fontWeight: 600, color: t.textDimmer, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>
                Acceptance Criteria
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {req.criteria.map((c, i) => (
                  <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12, color: t.text }}>
                    <span style={{ color: t.green, flexShrink: 0, marginTop: 1 }}>◇</span>
                    {c}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Linked tasks */}
          {(cv.tasks || []).length > 0 && (
            <div>
              <div style={{ fontSize: 10, fontWeight: 600, color: t.textDimmer, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>
                Linked Tasks ({cv.total})
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {cv.tasks.map((task) => (
                  <div key={task.id} style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '5px 8px', borderRadius: 6, background: t.chipBg,
                    fontSize: 11,
                  }}>
                    <span style={{ fontFamily: 'JetBrains Mono, monospace', color: t.textDimmer, fontSize: 9.5 }}>{task.id}</span>
                    <span style={{ flex: 1, color: t.text }}>{task.title}</span>
                    <span style={{ fontSize: 9.5, color: t.textDimmer }}>{task.by}</span>
                    <span style={{
                      fontSize: 9, padding: '1px 7px', borderRadius: 8,
                      background: task.status === 'done' ? t.green + '22' : task.status === 'running' ? t.orange + '22' : t.chipBg,
                      color: task.status === 'done' ? t.green : task.status === 'running' ? t.orange : t.textDim,
                    }}>{task.status}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Vault note hint */}
          <div style={{ fontSize: 10, color: t.textDimmer, fontFamily: 'JetBrains Mono, monospace' }}>
            vault: projects/{req.project_id}/reqs/{req.id}.md
          </div>
        </div>
      )}
    </div>
  );
}

function ReqForm({ t, onSave, onCancel, initial = null }) {
  const [title, setTitle]       = React.useState(initial?.title || '');
  const [desc, setDesc]         = React.useState(initial?.desc || '');
  const [priority, setPriority] = React.useState(initial?.priority || 'medium');
  const [criteria, setCriteria] = React.useState((initial?.criteria || []).join('\n'));
  const [saving, setSaving]     = React.useState(false);

  const isEdit = !!initial;

  const inp = {
    background: 'transparent', border: `1px solid ${t.border}`, borderRadius: 6,
    color: t.text, padding: '6px 9px', fontSize: 12, width: '100%', boxSizing: 'border-box',
    outline: 'none', fontFamily: 'inherit',
  };

  const handleSave = async () => {
    if (!title.trim()) return;
    setSaving(true);
    await onSave({
      title: title.trim(),
      desc: desc.trim(),
      priority,
      criteria: criteria.split('\n').map((s) => s.trim()).filter(Boolean),
    });
    setSaving(false);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: t.text }}>
        {isEdit ? `Edit ${initial.id}` : 'New Requirement'}
      </div>

      <input value={title} onChange={(e) => setTitle(e.target.value)}
        placeholder="Title *" style={inp}/>

      <textarea value={desc} onChange={(e) => setDesc(e.target.value)}
        placeholder="Description" rows={2}
        style={{ ...inp, resize: 'vertical', lineHeight: 1.5 }}/>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span style={{ fontSize: 11, color: t.textDim }}>Priority:</span>
        {['high', 'medium', 'low'].map((p) => (
          <button key={p} onClick={() => setPriority(p)} style={{
            padding: '3px 10px', borderRadius: 12, fontSize: 11, cursor: 'pointer',
            border: 'none',
            background: priority === p ? (PRIORITY_COLORS[p] + '33') : t.chipBg,
            color: priority === p ? PRIORITY_COLORS[p] : t.textDim,
            fontWeight: priority === p ? 700 : 400,
          }}>{p}</button>
        ))}
      </div>

      <div>
        <div style={{ fontSize: 10, color: t.textDimmer, marginBottom: 4 }}>
          Acceptance Criteria (one per line)
        </div>
        <textarea value={criteria} onChange={(e) => setCriteria(e.target.value)}
          placeholder="User can register with email and password&#10;Password is hashed with bcrypt&#10;Invalid credentials return 401" rows={4}
          style={{ ...inp, resize: 'vertical', lineHeight: 1.6, fontFamily: 'JetBrains Mono, monospace', fontSize: 11 }}/>
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={handleSave} disabled={!title.trim() || saving} style={{
          padding: '6px 16px', borderRadius: 6, border: 'none', cursor: 'pointer',
          background: t.green, color: '#fff', fontSize: 12, fontWeight: 600,
          opacity: (!title.trim() || saving) ? 0.5 : 1,
        }}>
          {saving ? 'Saving…' : (isEdit ? 'Save' : 'Create')}
        </button>
        <button onClick={onCancel} style={{
          padding: '6px 14px', borderRadius: 6, border: `1px solid ${t.border}`,
          background: 'none', cursor: 'pointer', color: t.textDim, fontSize: 12,
        }}>Cancel</button>
      </div>
    </div>
  );
}

function G_Reqs({ projectId, tasks = [], reqs: initialReqs = [] }) {
  const { t }                   = useG();
  const layout                  = useGLayout();
  const [reqs, setReqs]         = React.useState(initialReqs);
  const [showNew, setShowNew]   = React.useState(false);
  const [editReq, setEditReq]   = React.useState(null);
  const [loading, setLoading]   = React.useState(false);
  const [filter, setFilter]     = React.useState('all'); // all | active | done | draft

  // Load reqs with coverage from API (fresher than bootstrap state)
  const load = React.useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/reqs`);
      if (res.ok) setReqs(await res.json());
    } finally { setLoading(false); }
  }, [projectId]);

  React.useEffect(() => { load(); }, [load]);

  const handleCreate = async (data) => {
    const res = await fetch(`/api/projects/${projectId}/reqs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (res.ok) { setShowNew(false); await load(); }
  };

  const handleEdit = async (data) => {
    const res = await fetch(`/api/reqs/${editReq.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (res.ok) { setEditReq(null); await load(); }
  };

  const handleDelete = async (req) => {
    if (!confirm(`Delete ${req.id} "${req.title}"?`)) return;
    await fetch(`/api/reqs/${req.id}`, { method: 'DELETE' });
    await load();
  };

  const handleStatusToggle = async (req) => {
    const next = req.status === 'done' ? 'active' : 'done';
    await fetch(`/api/reqs/${req.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: next }),
    });
    await load();
  };

  const visible = reqs.filter((r) => filter === 'all' || r.status === filter);

  // Summary stats
  const stats = {
    total:   reqs.length,
    active:  reqs.filter((r) => r.status === 'active').length,
    done:    reqs.filter((r) => r.status === 'done').length,
    covered: reqs.filter((r) => (r.coverage?.total || 0) > 0).length,
  };

  if (!projectId) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: t.textDimmer }}>
        Select a project to view requirements.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0, height: '100%', overflow: 'hidden' }}>
      {/* Page header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: layout.isMobile ? '14px' : '16px 20px',
        flexWrap: 'wrap',
        borderBottom: `1px solid ${t.border}`, flexShrink: 0,
      }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: t.text }}>Requirements</div>
          <div style={{ fontSize: 11, color: t.textDimmer }}>
            {stats.total} total · {stats.active} active · {stats.covered} with tasks
          </div>
        </div>

        {/* Filter tabs */}
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {['all', 'active', 'done', 'draft'].map((f) => (
            <button key={f} onClick={() => setFilter(f)} style={{
              padding: '4px 10px', borderRadius: 8, fontSize: 11, cursor: 'pointer',
              border: 'none',
              background: filter === f ? t.orange + '33' : t.chipBg,
              color: filter === f ? t.orange : t.textDim,
              fontWeight: filter === f ? 700 : 400,
            }}>{f}</button>
          ))}
        </div>

        <button onClick={() => { setShowNew(true); setEditReq(null); }} style={{
          padding: '6px 14px', borderRadius: 8, border: 'none', cursor: 'pointer',
          background: t.orange, color: '#fff', fontSize: 12, fontWeight: 600,
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <GIcon d={G_ICONS.plus} size={12}/>
          New Req
        </button>
      </div>

      {/* Main content */}
      <div style={{ flex: 1, overflow: 'auto', padding: layout.isMobile ? 14 : '16px 20px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {/* New / edit form */}
        {(showNew || editReq) && (
          <div style={{
            border: `1px solid ${t.orange}44`, borderRadius: 10, padding: '14px 16px',
            background: t.surface,
          }}>
            {showNew && (
              <ReqForm t={t} onSave={handleCreate} onCancel={() => setShowNew(false)}/>
            )}
            {editReq && (
              <ReqForm t={t} initial={editReq} onSave={handleEdit} onCancel={() => setEditReq(null)}/>
            )}
          </div>
        )}

        {loading && !reqs.length && (
          <div style={{ textAlign: 'center', color: t.textDimmer, padding: 30 }}>Loading…</div>
        )}

        {!loading && !visible.length && (
          <div style={{
            textAlign: 'center', color: t.textDimmer, padding: '40px 20px',
            border: `1px dashed ${t.border}`, borderRadius: 12,
          }}>
            {reqs.length === 0
              ? 'No requirements yet. Create one to start tracking deliverables.'
              : `No ${filter} requirements.`}
          </div>
        )}

        {visible.map((req) => (
          <ReqCard key={req.id} req={req} t={t}
            onEdit={(r) => { setEditReq(r); setShowNew(false); }}
            onDelete={handleDelete}
          />
        ))}
      </div>
    </div>
  );
}
