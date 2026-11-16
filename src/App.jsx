import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createInputBus } from './inputBus.mjs';
import RdpTab from './RdpTab.jsx';
import EditorModal from './EditorModal.jsx';
import SshSession from './SshSession.jsx';
import CredentialsModal from './CredentialsModal.jsx';
import RdmImportModal from './RdmImportModal.jsx';
import logoUrl from './assets/logo.png';

const TypeIcon = ({ type, open }) => {
  if (type === 'folder') return <span className="ti folder" aria-hidden="true">{open ? '▾' : '▸'}<span className="fold-ico" /></span>;
  return <span className={`ti badge-${type}`} aria-hidden="true">{type === 'ssh' ? '>_' : '⧉'}</span>;
};

const LAYOUTS = [1, 2, 4];
const DRAG_TYPE = 'application/x-itvr-tab';
const cell = (slot) => ({ gridColumn: (slot % 2) + 1, gridRow: Math.floor(slot / 2) + 1 });

// Keeps sessions already on screen where they are, makes sure `prefer` is shown,
// then fills empty slots with the remaining open sessions in tab order.
function arrange(n, tabList, current, prefer) {
  const open = new Set(tabList.map((t) => t.key));
  const slots = [0, 1, 2, 3].map((i) => (i < n && open.has(current[i]) ? current[i] : null));
  const shown = () => slots.slice(0, n);
  if (prefer && open.has(prefer) && !shown().includes(prefer)) {
    const e = shown().indexOf(null);
    slots[e >= 0 ? e : 0] = prefer;
  }
  for (const t of tabList) {
    if (shown().includes(t.key)) continue;
    const e = shown().indexOf(null);
    if (e < 0) break;
    slots[e] = t.key;
  }
  return slots;
}

const LayoutIcon = ({ n }) => (
  <svg width="16" height="12" viewBox="0 0 16 12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4">
    <rect x="0.7" y="0.7" width="14.6" height="10.6" rx="1.5" />
    {n >= 2 && <line x1="8" y1="0.7" x2="8" y2="11.3" />}
    {n === 4 && <line x1="0.7" y1="6" x2="15.3" y2="6" />}
  </svg>
);

export default function App() {
  const [items, setItems] = useState([]);
  const [credentials, setCredentials] = useState([]);
  const [showCreds, setShowCreds] = useState(false);
  const [showRdm, setShowRdm] = useState(false);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('');
  const [navMode, setNavMode] = useState('tree'); // tree | favorites
  const [expanded, setExpanded] = useState({ __root: true });
  const [selectedId, setSelectedId] = useState(null);
  const [editing, setEditing] = useState(null);
  const [tabs, setTabs] = useState([]);
  const [activeTab, setActiveTab] = useState('dashboard');
  const [pwPrompt, setPwPrompt] = useState(null);
  const [menu, setMenu] = useState(null);
  const [newMenu, setNewMenu] = useState(false);
  const [quick, setQuick] = useState({ host: '', type: 'rdp' });
  const [toast, setToast] = useState('');
  // Split view: 1, 2 (side by side) or 4 (2x2) panes. panes[i] = tab key shown in slot i.
  const [layout, setLayout] = useState(() => (LAYOUTS.includes(Number(localStorage.getItem('itvr.layout'))) ? Number(localStorage.getItem('itvr.layout')) : 1));
  const [panes, setPanes] = useState([null, null, null, null]);
  const [focusPane, setFocusPane] = useState(0);
  const [dropSlot, setDropSlot] = useState(-1);
  // Multi-execute: keyboard input in the focused pane is mirrored to the other included panes.
  const [multiExec, setMultiExec] = useState(false);
  const [excluded, setExcluded] = useState([]); // tab keys left out of multi-execute

  const reload = useCallback(async () => {
    const [list, creds] = await Promise.all([window.api.list(), window.api.credList()]);
    setItems(list);
    setCredentials(creds);
  }, []);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    const close = () => { setMenu(null); setNewMenu(false); };
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, []);

  const flash = (m) => { setToast(m); setTimeout(() => setToast(''), 5000); };
  const selected = items.find((i) => i.id === selectedId);
  const folders = useMemo(() => items.filter((i) => i.type === 'folder'), [items]);
  const entries = items.filter((i) => i.type !== 'folder');

  const byParent = useMemo(() => {
    const m = {};
    for (const i of items) (m[i.parentId || 'root'] ||= []).push(i);
    for (const k in m) m[k].sort((a, b) => (a.type === 'folder' ? 0 : 1) - (b.type === 'folder' ? 0 : 1) || a.name.localeCompare(b.name));
    return m;
  }, [items]);

  const q = (search || filter).trim().toLowerCase();
  const matches = useMemo(() => {
    if (navMode === 'favorites') return items.filter((i) => i.favorite && i.type !== 'folder');
    if (!q) return null;
    return items.filter((i) => i.type !== 'folder' && [i.name, i.host, i.username, ...(i.tags || [])].join(' ').toLowerCase().includes(q));
  }, [items, q, navMode]);

  const pathOf = (item) => {
    const parts = [];
    for (let p = items.find((i) => i.id === item?.parentId); p; p = items.find((i) => i.id === p.parentId)) parts.unshift(p.name);
    return parts;
  };

  // ---- sessions ----
  const split = layout > 1;
  const showGrid = split && activeTab !== 'dashboard';

  // Sessions that take part: on screen, connected and not excluded.
  const visibleKeys = showGrid ? panes.slice(0, layout).filter(Boolean) : [];
  const participants = visibleKeys.filter((k) => !excluded.includes(k) && tabs.find((t) => t.key === k)?.status === 'connected');
  const multiRef = useRef({ on: false, keys: [] });
  multiRef.current = { on: multiExec && showGrid, keys: participants };
  const bus = useMemo(() => createInputBus(() => multiRef.current), []);

  // Safety: multi-execute switches itself off as soon as it could no longer reach two sessions.
  useEffect(() => {
    if (multiExec && (!showGrid || participants.length < 2)) {
      setMultiExec(false);
      flash('Multi-execute turned off: fewer than two connected sessions are on screen.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [multiExec, showGrid, participants.length]);

  const toggleMulti = () => {
    if (multiExec) return setMultiExec(false);
    if (participants.length < 2) return flash('Multi-execute needs two or more connected sessions on screen. Pick the 2 or 4 pane view first.');
    const ok = window.confirm(
      `Multi-execute sends everything you type in the focused pane to ${participants.length - 1} other session${participants.length > 2 ? 's' : ''}.\n\n`
      + 'Keyboard only (RDP to RDP, SSH to SSH). Be careful on production servers.\n\nTurn it on?',
    );
    if (ok) setMultiExec(true);
  };

  const openTab = (conn, extra = {}) => {
    const key = `${conn.id || conn.host}-${Date.now()}`;
    setTabs((t) => [...t, { key, conn, status: 'connecting', ...extra }]);
    if (split) {
      // New session goes into the first empty pane, otherwise into the focused one.
      const empty = panes.slice(0, layout).indexOf(null);
      const slot = empty >= 0 ? empty : focusPane;
      setPanes((p) => p.map((k, i) => (i === slot ? key : k)));
      setFocusPane(slot);
    }
    setActiveTab(key);
  };

  // Tab click: in split view, focus the pane already showing it, or show it in the focused pane.
  const showTab = (key) => {
    if (!split || key === 'dashboard') return setActiveTab(key);
    const at = panes.slice(0, layout).indexOf(key);
    if (at >= 0) setFocusPane(at);
    else setPanes((p) => p.map((k, i) => (i === focusPane ? key : k)));
    setActiveTab(key);
  };

  // Drop a tab on a pane; if it was already in another pane, the two swap.
  const placeInPane = (slot, key) => {
    setPanes((p) => {
      const n = [...p];
      const from = n.slice(0, layout).indexOf(key);
      if (from >= 0) n[from] = n[slot];
      n[slot] = key;
      return n;
    });
    setFocusPane(slot);
    setActiveTab(key);
  };

  const changeLayout = (n) => {
    localStorage.setItem('itvr.layout', String(n));
    const focusedKey = activeTab !== 'dashboard' && activeTab !== '__grid' ? activeTab : null;
    setLayout(n);
    if (n === 1) {
      setActiveTab(focusedKey || tabs[0]?.key || 'dashboard');
      return;
    }
    const slots = arrange(n, tabs, panes, focusedKey);
    const f = Math.max(0, slots.indexOf(focusedKey));
    setPanes(slots);
    setFocusPane(f);
    setActiveTab(slots[f] || '__grid');
  };

  const paneProps = (slot, key) => ({
    className: `pane${slot === focusPane ? ' pane-focused' : ''}${dropSlot === slot ? ' pane-drop' : ''}${multiExec && key && participants.includes(key) ? ' pane-multi' : ''}`,
    style: cell(slot),
    onMouseDownCapture: () => {
      if (slot !== focusPane) setFocusPane(slot);
      setActiveTab(key || '__grid');
    },
    onDragOver: (e) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (dropSlot !== slot) setDropSlot(slot);
    },
    onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDropSlot(-1); },
    onDrop: (e) => {
      const k = e.dataTransfer.getData(DRAG_TYPE);
      setDropSlot(-1);
      if (k && tabs.some((t) => t.key === k)) { e.preventDefault(); placeInPane(slot, k); }
    },
  });

  const connect = async (conn, { external = false } = {}) => {
    if (!conn || conn.type === 'folder') return;
    if (conn.type === 'rdp' && (external || conn.openExternal)) {
      try {
        const r = await window.api.rdpLaunch(conn.id);
        flash(`Launched ${r.client}${r.note ? '. ' + r.note : ''}`);
      } catch (e) {
        flash(`Launch failed: ${e.message}`);
      }
      return;
    }
    const needsPw = conn.type === 'rdp' ? !conn.hasPassword : !conn.hasPassword && !conn.privateKeyPath;
    if (needsPw) return setPwPrompt({ conn, value: '', user: conn.effectiveUsername || conn.username || '' });
    openTab(conn);
  };

  const quickConnect = (e) => {
    e.preventDefault();
    const raw = quick.host.trim();
    if (!raw) return;
    let user = '';
    let hostPart = raw;
    if (raw.includes('@')) [user, hostPart] = [raw.slice(0, raw.lastIndexOf('@')), raw.slice(raw.lastIndexOf('@') + 1)];
    const [host, port] = hostPart.split(':');
    const conn = { id: null, type: quick.type, name: hostPart, host, port: Number(port) || (quick.type === 'ssh' ? 22 : 3389), username: user, redirectClipboard: true, dynamicResolution: true };
    if (quick.type === 'ssh') return flash('Quick SSH needs a saved entry. Use New > SSH.');
    setPwPrompt({ conn, value: '', user, quick: true });
  };

  const save = async (c) => {
    const saved = await window.api.save(c);
    setEditing(null);
    await reload();
    setSelectedId(saved.id);
    if (saved.parentId) setExpanded((e) => ({ ...e, [saved.parentId]: true }));
  };

  const remove = async (c) => {
    const what = c.type === 'folder' ? `folder "${c.name}" and everything in it` : `"${c.name}"`;
    if (!window.confirm(`Delete ${what}?`)) return;
    await window.api.remove(c.id);
    if (selectedId === c.id) setSelectedId(null);
    reload();
  };

  const toggleFav = async (c) => { await window.api.save({ ...c, favorite: !c.favorite }); reload(); };

  const closeTab = (key) => {
    const idx = tabs.findIndex((x) => x.key === key);
    const next = tabs.filter((x) => x.key !== key);
    setTabs(next);
    if (split) {
      // Refill the freed pane with a session that is open but not on screen.
      const freed = panes.map((k) => (k === key ? null : k));
      const slot = panes.indexOf(key);
      if (slot >= 0 && slot < layout) {
        const hidden = next.find((t) => !freed.slice(0, layout).includes(t.key));
        if (hidden) freed[slot] = hidden.key;
      }
      setPanes(freed);
      if (activeTab === key) setActiveTab(freed[focusPane] || '__grid');
    } else if (activeTab === key) {
      setActiveTab((next[idx - 1] || next[idx])?.key || 'dashboard');
    }
  };
  const setStatus = useCallback((key, status) => setTabs((t) => t.map((x) => (x.key === key ? { ...x, status } : x))), []);
  const setSession = useCallback((key, sessionId) => setTabs((t) => t.map((x) => (x.key === key ? { ...x, sessionId } : x))), []);

  const newIn = (type) => {
    const parentId = selected?.type === 'folder' ? selected.id : selected?.parentId || null;
    setEditing({ type, parentId });
  };

  // ---- tree ----
  const renderNode = (c, depth) => {
    const open = expanded[c.id];
    return (
      <div key={c.id} role="treeitem" aria-expanded={c.type === 'folder' ? !!open : undefined} aria-selected={selectedId === c.id}>
        <div
          className={`node ${selectedId === c.id ? 'sel' : ''}`}
          style={{ paddingLeft: 6 + depth * 16 }}
          onClick={() => { setSelectedId(c.id); if (c.type === 'folder') setExpanded((e) => ({ ...e, [c.id]: !e[c.id] })); }}
          onDoubleClick={() => connect(c)}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setSelectedId(c.id); setMenu({ x: e.clientX, y: e.clientY, item: c }); }}
        >
          <TypeIcon type={c.type} open={open} />
          <span className="label">{c.name}</span>
          {c.favorite && <span className="fav" aria-label="favorite">★</span>}
        </div>
        {c.type === 'folder' && open && (byParent[c.id] || []).map((ch) => renderNode(ch, depth + 1))}
      </div>
    );
  };

  const tabIcon = (t) => <span className={`tab-ico badge-${t.conn.type}`}>{t.conn.type === 'ssh' ? '>_' : '⧉'}</span>;

  return (
    <div className="shell">
      {/* ---------- top toolbar ---------- */}
      <header className="topbar">
        <div className="brand"><img className="logo" src={logoUrl} alt="" width="26" height="26" />ITVR RDP</div>
        <div className="tool-group">
          <div className="dropdown">
            <button className="tbtn" onClick={(e) => { e.stopPropagation(); setNewMenu((v) => !v); }} title="New entry">＋ New ▾</button>
            {newMenu && (
              <div className="menu" style={{ top: 34, left: 0 }}>
                <button onClick={() => newIn('rdp')}><TypeIcon type="rdp" /> RDP (Microsoft Remote Desktop)</button>
                <button onClick={() => newIn('ssh')}><TypeIcon type="ssh" /> SSH Shell</button>
                <hr />
                <button onClick={() => newIn('folder')}><span className="fold-ico" /> Folder</button>
              </div>
            )}
          </div>
          <button className="tbtn" disabled={!selected} onClick={() => setEditing(selected)} title="Edit entry">✎ Edit</button>
          <button className="tbtn" disabled={!selected || selected.type === 'folder'} onClick={() => setEditing({ ...selected, id: undefined, name: `${selected.name} (copy)`, hasPassword: false })} title="Duplicate">⧉ Duplicate</button>
          <button className="tbtn" disabled={!selected} onClick={() => remove(selected)} title="Delete">🗑 Delete</button>
        </div>
        <div className="search-wrap">
          <input className="search" placeholder="Search everywhere" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search everywhere" />
        </div>
        <div className="tool-group">
          <button className="tbtn" onClick={() => setShowCreds(true)} title="Shared credentials">🔑 Credentials</button>
          <button className="tbtn" onClick={() => setShowRdm(true)} title="Import from Remote Desktop Manager">Import RDM</button>
          <button className="tbtn" onClick={async () => { const r = await window.api.importAll().catch((e) => flash(String(e.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))); if (r?.ok) { flash(`Imported ${r.entries} entries, ${r.folders} folders, ${r.credentials} credentials`); reload(); } }} title="Import an ITVR RDP export">Import</button>
          <button className="tbtn" onClick={() => window.api.exportAll()} title="Export entries (no passwords)">Export</button>
        </div>
      </header>

      <div className="body">
        {/* ---------- navigation ---------- */}
        <aside className="nav">
          <div className="nav-rail">
            <button className={navMode === 'tree' ? 'on' : ''} onClick={() => setNavMode('tree')} title="Navigation" aria-label="Navigation">☰</button>
            <button className={navMode === 'favorites' ? 'on' : ''} onClick={() => setNavMode('favorites')} title="Favorites" aria-label="Favorites">☆</button>
          </div>
          <div className="nav-panel">
            <div className="nav-head">{navMode === 'tree' ? 'Navigation' : 'Favorites'}</div>
            <div className="nav-col">Name</div>
            <div className="tree" role="tree" onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, item: null }); }}>
              {matches ? (
                matches.length ? matches.map((c) => renderNode(c, 0)) : <div className="empty">{navMode === 'favorites' ? 'No favorites yet. Right-click an entry > Add to favorites.' : 'No matches.'}</div>
              ) : (
                <>
                  <div className={`node root ${!selectedId ? 'sel' : ''}`} onClick={() => { setSelectedId(null); setExpanded((e) => ({ ...e, __root: !e.__root })); }}>
                    <span className="ti">{expanded.__root ? '▾' : '▸'}</span><span className="ws-dot" /> <span className="label">Local workspace</span>
                  </div>
                  {expanded.__root && (byParent.root || []).map((c) => renderNode(c, 1))}
                </>
              )}
            </div>
            <input className="filter" placeholder="Filter entries" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter entries" />
          </div>
        </aside>

        {/* ---------- content ---------- */}
        <main className="content">
          <div className="tabrow">
            <div className="tabbar" role="tablist">
              <div role="tab" aria-selected={activeTab === 'dashboard'} className={`tab ${activeTab === 'dashboard' ? 'active' : ''}`} onClick={() => setActiveTab('dashboard')}>
                <span className="tab-ico">⌂</span> Dashboard
              </div>
              {tabs.map((t) => {
                const onScreen = showGrid && panes.slice(0, layout).includes(t.key);
                return (
                  <div key={t.key} role="tab" aria-selected={activeTab === t.key}
                    className={`tab ${activeTab === t.key ? 'active' : ''} ${onScreen && activeTab !== t.key ? 'shown' : ''}`}
                    onClick={() => showTab(t.key)}
                    onAuxClick={(e) => e.button === 1 && closeTab(t.key)}
                    draggable={split}
                    onDragStart={(e) => { e.dataTransfer.setData(DRAG_TYPE, t.key); e.dataTransfer.effectAllowed = 'move'; }}
                    onDragEnd={() => setDropSlot(-1)}
                    title={`${t.conn.name} (${t.conn.host})${split ? ' · drag onto a pane' : ''}`}>
                    <span className={`dot ${t.status}`} />{tabIcon(t)} {t.conn.name}
                    <button className="x" onClick={(e) => { e.stopPropagation(); closeTab(t.key); }} aria-label={`Close ${t.conn.name}`}>×</button>
                  </div>
                );
              })}
            </div>
            <div className="layout-switch" role="group" aria-label="Split view">
              {LAYOUTS.map((n) => (
                <button key={n} className={layout === n ? 'on' : ''} aria-pressed={layout === n} onClick={() => changeLayout(n)}
                  title={n === 1 ? 'Single view' : n === 2 ? 'Split view: 2 side by side' : 'Split view: 4 (2 x 2)'}>
                  <LayoutIcon n={n} />
                </button>
              ))}
              <button className={`multi-toggle${multiExec ? ' on' : ''}`} onClick={toggleMulti} aria-pressed={multiExec} disabled={!split && !multiExec}
                title={split ? 'Multi-execute: type once, send to all included panes' : 'Multi-execute needs the 2 or 4 pane view'}>
                ⇉ Multi
              </button>
            </div>
          </div>

          {multiExec && showGrid && (
            <div className="multi-banner" role="status">
              <span><strong>Multi-execute is ON.</strong> Keys typed in the focused pane go to all {participants.length} included sessions (RDP to RDP, SSH to SSH). Mouse is not shared.</span>
              <button onClick={() => setMultiExec(false)}>Stop</button>
            </div>
          )}

          <div className={`panes${showGrid ? ` split split-${layout}` : ''}`}>
            {activeTab === 'dashboard' && (
              <Dashboard
                selected={selected}
                path={selected ? pathOf(selected) : []}
                entries={selected?.type === 'folder' ? byParent[selected.id] || [] : !selected ? byParent.root || [] : []}
                sessions={tabs}
                onConnect={connect}
                onEdit={setEditing}
                onSelect={(c) => setSelectedId(c.id)}
                onFav={toggleFav}
                onNew={newIn}
                onForgetCert={async (c) => { await window.api.forgetCert(c.id); flash('Pinned certificate removed. It will be trusted again on next connect.'); }}
              />
            )}
            {showGrid && panes.slice(0, layout).map((k, slot) => (k ? null : (
              <EmptyPane key={`empty-${slot}`} pane={paneProps(slot, null)}
                hidden={tabs.filter((t) => !panes.slice(0, layout).includes(t.key))}
                onPick={(key) => placeInPane(slot, key)} />
            )))}
            {/* Sessions always render in this one keyed list, so moving them between
                single view and split panes never remounts (and never disconnects) them. */}
            {tabs.map((t) => {
              const slot = showGrid ? panes.slice(0, layout).indexOf(t.key) : -1;
              const visible = showGrid ? slot >= 0 : activeTab === t.key;
              const focused = visible && (!showGrid || slot === focusPane);
              const pane = showGrid && slot >= 0 ? paneProps(slot, t.key) : undefined;
              const multi = {
                active: multiExec && showGrid && slot >= 0,
                included: !excluded.includes(t.key),
                toggle: () => setExcluded((x) => (x.includes(t.key) ? x.filter((k) => k !== t.key) : [...x, t.key])),
              };
              return t.conn.type === 'ssh'
                ? <SshSession key={t.key} tab={t} active={visible} focused={focused} pane={pane} bus={bus} multi={multi} onStatus={setStatus} onSession={setSession} />
                : <RdpTab key={t.key} tab={t} active={visible} focused={focused} pane={pane} bus={bus} multi={multi} onStatus={setStatus} />;
            })}
          </div>
        </main>
      </div>

      {/* ---------- status bar ---------- */}
      <footer className="statusbar">
        <span>{entries.length} entries</span>
        <span className="sep" />
        <span>{tabs.length} open session{tabs.length === 1 ? '' : 's'}</span>
        <form className="quick" onSubmit={quickConnect}>
          <label htmlFor="quick-host">Connect</label>
          <select value={quick.type} onChange={(e) => setQuick({ ...quick, type: e.target.value })} aria-label="Protocol">
            <option value="rdp">RDP</option>
            <option value="ssh">SSH</option>
          </select>
          <input id="quick-host" placeholder="Host or IP address (user@host:port)" value={quick.host} onChange={(e) => setQuick({ ...quick, host: e.target.value })} />
          <button type="submit" className="go" aria-label="Quick connect">→</button>
        </form>
        <div className="spacer" />
        <span className="muted">Local · Not synced</span>
      </footer>

      {/* ---------- context menu ---------- */}
      {menu && (
        <div className="menu" style={{ top: menu.y, left: menu.x }} onClick={(e) => e.stopPropagation()}>
          {menu.item && menu.item.type !== 'folder' && (
            <>
              <button className="strong" onClick={() => { setMenu(null); connect(menu.item); }}>Open session</button>
              {menu.item.type === 'rdp' && <button onClick={() => { setMenu(null); connect(menu.item, { external: true }); }}>Open in external client</button>}
              <hr />
              <button onClick={() => { setMenu(null); toggleFav(menu.item); }}>{menu.item.favorite ? 'Remove from favorites' : 'Add to favorites'}</button>
              <button onClick={() => { setMenu(null); navigator.clipboard.writeText(menu.item.host); flash('Host copied'); }}>Copy host</button>
            </>
          )}
          {menu.item && <button onClick={() => { setMenu(null); setEditing(menu.item); }}>Edit…</button>}
          {menu.item && menu.item.type !== 'folder' && <button onClick={() => { setMenu(null); setEditing({ ...menu.item, id: undefined, name: `${menu.item.name} (copy)`, hasPassword: false }); }}>Duplicate</button>}
          {(!menu.item || menu.item.type === 'folder') && (
            <>
              <button onClick={() => { setMenu(null); setEditing({ type: 'rdp', parentId: menu.item?.id || null }); }}>New RDP entry</button>
              <button onClick={() => { setMenu(null); setEditing({ type: 'ssh', parentId: menu.item?.id || null }); }}>New SSH entry</button>
              <button onClick={() => { setMenu(null); setEditing({ type: 'folder', parentId: menu.item?.id || null }); }}>New folder</button>
            </>
          )}
          {menu.item && <><hr /><button className="danger" onClick={() => { setMenu(null); remove(menu.item); }}>Delete</button></>}
        </div>
      )}

      {editing && <EditorModal initial={editing} folders={folders} credentials={credentials} onSave={save} onCancel={() => setEditing(null)} onManageCredentials={() => setShowCreds(true)} />}

      {showCreds && <CredentialsModal credentials={credentials} onChanged={reload} onClose={() => setShowCreds(false)} />}

      {showRdm && (
        <RdmImportModal
          onClose={() => setShowRdm(false)}
          onDone={(r) => { setShowRdm(false); setExpanded((e) => ({ ...e, __root: true })); flash(`Imported ${r.entries} entries, ${r.folders} folders, ${r.credentials} credentials`); reload(); }}
        />
      )}

      {pwPrompt && (
        <div className="overlay" onMouseDown={() => setPwPrompt(null)}>
          <form className="modal small" onMouseDown={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              const { conn, value, user, quick: isQuick } = pwPrompt;
              setPwPrompt(null);
              openTab(conn, { password: value, promptUser: user, quick: !!isQuick });
            }}>
            <h2>Credentials for {pwPrompt.conn.host}</h2>
            <label>Username (DOMAIN\user)
              <input autoFocus={!pwPrompt.user} value={pwPrompt.user} onChange={(e) => setPwPrompt({ ...pwPrompt, user: e.target.value })} disabled={!pwPrompt.quick && !!(pwPrompt.conn.effectiveUsername || pwPrompt.conn.username)} />
            </label>
            <label>Password
              <input autoFocus={!!pwPrompt.user} type="password" value={pwPrompt.value} onChange={(e) => setPwPrompt({ ...pwPrompt, value: e.target.value })} />
            </label>
            <div className="actions">
              <button type="button" onClick={() => setPwPrompt(null)}>Cancel</button>
              <button type="submit" className="primary">Connect</button>
            </div>
          </form>
        </div>
      )}

      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

function EmptyPane({ pane, hidden, onPick }) {
  const { className = '', ...rest } = pane;
  return (
    <div className={`${className} pane-empty`} {...rest}>
      <div className="pane-empty-title">Empty pane</div>
      {hidden.length > 0 ? (
        <select value="" onChange={(e) => e.target.value && onPick(e.target.value)} aria-label="Show an open session in this pane">
          <option value="">Show an open session…</option>
          {hidden.map((t) => <option key={t.key} value={t.key}>{t.conn.name} ({t.conn.host})</option>)}
        </select>
      ) : (
        <div className="muted">Double-click an entry in the tree to connect here.</div>
      )}
      <div className="muted small">or drag a tab onto this pane</div>
    </div>
  );
}

function Dashboard({ selected, path, entries: children, sessions, onConnect, onEdit, onSelect, onFav, onNew, onForgetCert }) {
  if (!selected || selected.type === 'folder') {
    return (
      <div className="dash">
        <div className="dash-head">
          <h1>{selected ? selected.name : 'Local workspace'}</h1>
          <div className="actions left">
            <button onClick={() => onNew('rdp')}>＋ RDP</button>
            <button onClick={() => onNew('ssh')}>＋ SSH</button>
            <button onClick={() => onNew('folder')}>＋ Folder</button>
          </div>
        </div>
        {children.length === 0 && <div className="empty big">This folder is empty. Right-click in the navigation tree to add entries.</div>}
        <div className="grid">
          {children.map((c) => (
            <div key={c.id} className="card" onClick={() => onSelect(c)} onDoubleClick={() => (c.type === 'folder' ? onSelect(c) : onConnect(c))}>
              <TypeIcon type={c.type} />
              <div className="card-text">
                <div className="card-name">{c.name}</div>
                <div className="muted">{c.type === 'folder' ? 'Folder' : `${c.type.toUpperCase()} · ${c.host}`}</div>
              </div>
            </div>
          ))}
        </div>
        {sessions.length > 0 && (
          <>
            <h3>Open sessions</h3>
            <ul className="muted">{sessions.map((s) => <li key={s.key}>{s.conn.name} ({s.conn.host}) · {s.status}</li>)}</ul>
          </>
        )}
      </div>
    );
  }

  const c = selected;
  return (
    <div className="dash">
      <div className="dash-head">
        <div className="crumbs">{['Local workspace', ...path].join('  ›  ')}</div>
        <h1><TypeIcon type={c.type} /> {c.name} <button className="star" onClick={() => onFav(c)} aria-label="Toggle favorite">{c.favorite ? '★' : '☆'}</button></h1>
        <div className="actions left">
          <button className="primary big" onClick={() => onConnect(c)}>▶ Open session</button>
          {c.type === 'rdp' && <button onClick={() => onConnect(c, { external: true })}>Open external</button>}
          <button onClick={() => onEdit(c)}>Edit</button>
        </div>
      </div>
      <div className="props">
        <div className="prop-group">
          <h3>General</h3>
          <dl>
            <dt>Type</dt><dd>{c.type === 'rdp' ? 'RDP (Microsoft Remote Desktop)' : 'SSH Shell'}</dd>
            <dt>Host</dt><dd>{c.host}</dd>
            <dt>Port</dt><dd>{c.port}</dd>
            {c.tags?.length > 0 && <><dt>Tags</dt><dd>{c.tags.join(', ')}</dd></>}
          </dl>
        </div>
        <div className="prop-group">
          <h3>Credentials</h3>
          <dl>
            {c.credentialName && <><dt>Shared credential</dt><dd>{c.credentialName}</dd></>}
            <dt>Username</dt><dd>{c.effectiveDomain ? `${c.effectiveDomain}\\` : ''}{c.effectiveUsername || '(prompt)'}</dd>
            <dt>Password</dt><dd>{c.hasPassword ? '•••••••• (encrypted)' : 'Not saved (prompt)'}</dd>
            {c.privateKeyPath && <><dt>Private key</dt><dd>{c.privateKeyPath}</dd></>}
          </dl>
        </div>
        {c.type === 'rdp' && (
          <div className="prop-group">
            <h3>Display</h3>
            <dl>
              <dt>Mode</dt><dd>{c.openExternal ? 'External client' : 'Embedded tab'}</dd>
              {c.gateway && <><dt>RD Gateway</dt><dd>{c.gateway}{c.gatewayPort && c.gatewayPort !== 443 ? `:${c.gatewayPort}` : ''} ({c.gatewayCredentialName ? `credential: ${c.gatewayCredentialName}` : 'same sign-in'})</dd></>}
              <dt>Resolution</dt><dd>{c.dynamicResolution !== false ? 'Adapt to tab size' : `${c.width} × ${c.height}`}</dd>
              <dt>Clipboard</dt><dd>{c.redirectClipboard !== false ? 'Enabled' : 'Disabled'}</dd>
            </dl>
            <button className="link" onClick={() => onForgetCert(c)}>Forget pinned certificate</button>
          </div>
        )}
        {c.notes && (
          <div className="prop-group wide">
            <h3>Notes</h3>
            <div className="pre">{c.notes}</div>
          </div>
        )}
      </div>
    </div>
  );
}
