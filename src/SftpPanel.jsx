import React, { useCallback, useEffect, useRef, useState } from 'react';

const clean = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const fmtSize = (n) => {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
};
const fmtDate = (ms) => new Date(ms).toLocaleString([], { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const parentOf = (p) => (p === '/' ? '/' : p.replace(/\/[^/]+\/?$/, '') || '/');

// Remote file explorer for an open SSH session (SFTP over the same connection).
export default function SftpPanel({ sessionId, onClose }) {
  const [cwd, setCwd] = useState('');
  const [addr, setAddr] = useState('');
  const [entries, setEntries] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [namePrompt, setNamePrompt] = useState(null); // { mode: 'mkdir' | 'rename', value }
  const [over, setOver] = useState(false);
  const [sort, setSort] = useState({ key: 'name', dir: 1 });
  const lastClick = useRef(null);

  const load = useCallback(async (dir) => {
    setBusy(true);
    setError('');
    try {
      const r = await window.api.sftpList(sessionId, dir);
      setCwd(r.path);
      setAddr(r.path);
      setEntries(r.entries);
      setSelected(new Set());
    } catch (e) {
      setError(clean(e));
    } finally {
      setBusy(false);
    }
  }, [sessionId]);

  useEffect(() => { load('.'); }, [load]);
  useEffect(() => window.api.onSftpProgress((p) => { if (p.sessionId === sessionId) setStatus(`Transferring ${p.file} (${p.n})…`); }), [sessionId]);

  const rows = [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    const k = sort.key;
    const av = k === 'name' ? a.name.toLowerCase() : a[k];
    const bv = k === 'name' ? b.name.toLowerCase() : b[k];
    return (av < bv ? -1 : av > bv ? 1 : 0) * sort.dir;
  });
  const names = [...selected];
  const only = names.length === 1 ? entries.find((e) => e.name === names[0]) : null;

  const run = async (label, fn) => {
    setBusy(true);
    setError('');
    setStatus(label);
    try {
      const r = await fn();
      await load(cwd);
      return r;
    } catch (e) {
      setError(clean(e));
    } finally {
      setBusy(false);
    }
    return null;
  };

  const click = (e, entry) => {
    const next = new Set(e.ctrlKey || e.metaKey ? selected : []);
    if (e.shiftKey && lastClick.current) {
      const a = rows.findIndex((r) => r.name === lastClick.current);
      const b = rows.findIndex((r) => r.name === entry.name);
      rows.slice(Math.min(a, b), Math.max(a, b) + 1).forEach((r) => next.add(r.name));
    } else if ((e.ctrlKey || e.metaKey) && selected.has(entry.name)) next.delete(entry.name);
    else next.add(entry.name);
    lastClick.current = entry.name;
    setSelected(next);
  };

  const download = async () => {
    const r = await run('Downloading…', () => window.api.sftpDownload(sessionId, cwd, names));
    if (r?.ok) setStatus(`Downloaded ${r.count} file${r.count === 1 ? '' : 's'} to ${r.folder}`);
    else if (r) setStatus('');
  };
  const upload = async (kind) => {
    const r = await run('Uploading…', () => window.api.sftpUpload(sessionId, cwd, kind));
    if (r?.ok) setStatus(`Uploaded ${r.count} file${r.count === 1 ? '' : 's'}`);
    else if (r) setStatus('');
  };
  const remove = async () => {
    if (!window.confirm(`Delete ${names.length === 1 ? `"${names[0]}"` : `${names.length} items`} from the server? This cannot be undone.`)) return;
    await run('Deleting…', () => window.api.sftpRemove(sessionId, cwd, names));
    setStatus('Deleted');
  };
  const submitName = async (e) => {
    e.preventDefault();
    const { mode, value } = namePrompt;
    const v = value.trim();
    setNamePrompt(null);
    if (!v) return;
    if (mode === 'mkdir') await run('Creating folder…', () => window.api.sftpMkdir(sessionId, cwd, v));
    else await run('Renaming…', () => window.api.sftpRename(sessionId, cwd, names[0], v));
    setStatus('');
  };

  const onDrop = async (e) => {
    e.preventDefault();
    setOver(false);
    const paths = [...e.dataTransfer.files].map((f) => window.api.pathForFile(f)).filter(Boolean);
    if (!paths.length) return;
    const r = await run('Uploading…', () => window.api.sftpUploadPaths(sessionId, cwd, paths));
    if (r?.ok) setStatus(`Uploaded ${r.count} file${r.count === 1 ? '' : 's'}`);
  };

  const th = (key, label) => (
    <th onClick={() => setSort((s) => ({ key, dir: s.key === key ? -s.dir : 1 }))} aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      {label}{sort.key === key ? (sort.dir === 1 ? ' ▴' : ' ▾') : ''}
    </th>
  );

  return (
    <aside className={`sftp ${over ? 'drop' : ''}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop} aria-label="Remote files">
      <div className="sftp-head">
        <strong>Remote files</strong>
        <div className="spacer" />
        <button onClick={onClose} aria-label="Close file panel" title="Close">×</button>
      </div>
      <form className="sftp-path" onSubmit={(e) => { e.preventDefault(); load(addr); }}>
        <button type="button" onClick={() => load(parentOf(cwd))} disabled={busy || cwd === '/'} title="Up one level" aria-label="Up one level">↑</button>
        <input value={addr} onChange={(e) => setAddr(e.target.value)} aria-label="Remote path" spellCheck={false} />
        <button type="submit" disabled={busy} title="Go">→</button>
        <button type="button" onClick={() => load(cwd)} disabled={busy} title="Refresh" aria-label="Refresh">⟳</button>
      </form>
      <div className="sftp-tools">
        <button onClick={() => upload('files')} disabled={busy} title="Upload files">⇧ Files</button>
        <button onClick={() => upload('folder')} disabled={busy} title="Upload a folder">⇧ Folder</button>
        <button onClick={download} disabled={busy || !names.length} title="Download selected">⇩ Download</button>
        <button onClick={() => setNamePrompt({ mode: 'mkdir', value: '' })} disabled={busy} title="New folder">＋ Folder</button>
        <button onClick={() => setNamePrompt({ mode: 'rename', value: only?.name || '' })} disabled={busy || !only} title="Rename">Rename</button>
        <button className="danger" onClick={remove} disabled={busy || !names.length} title="Delete selected">Delete</button>
      </div>
      {namePrompt && (
        <form className="sftp-name" onSubmit={submitName}>
          <input autoFocus value={namePrompt.value} onChange={(e) => setNamePrompt({ ...namePrompt, value: e.target.value })} placeholder={namePrompt.mode === 'mkdir' ? 'New folder name' : 'New name'} aria-label="Name" />
          <button type="submit" className="primary">OK</button>
          <button type="button" onClick={() => setNamePrompt(null)}>Cancel</button>
        </form>
      )}
      <div className="sftp-list">
        <table>
          <thead><tr>{th('name', 'Name')}{th('size', 'Size')}{th('mtime', 'Modified')}</tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name} className={selected.has(r.name) ? 'sel' : ''}
                onClick={(e) => click(e, r)}
                onDoubleClick={() => r.isDir && load(`${cwd === '/' ? '' : cwd}/${r.name}`)}>
                <td title={r.name}><span className={`fi ${r.isDir ? 'dir' : ''}`} aria-hidden="true">{r.isDir ? '📁' : r.isLink ? '🔗' : '📄'}</span>{r.name}</td>
                <td className="num">{r.isDir ? '' : fmtSize(r.size)}</td>
                <td>{fmtDate(r.mtime)}</td>
              </tr>
            ))}
            {!rows.length && !busy && !error && <tr><td colSpan={3} className="muted">Empty folder. Drop files here to upload.</td></tr>}
          </tbody>
        </table>
      </div>
      {error && <div className="sftp-msg error" role="alert">{error}</div>}
      {!error && <div className="sftp-msg muted" role="status">{busy ? 'Working…' : status || `${entries.length} items${names.length ? ` · ${names.length} selected` : ''}`}</div>}
    </aside>
  );
}
