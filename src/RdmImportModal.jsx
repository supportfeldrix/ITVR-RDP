import React, { useState } from 'react';

// Step 1 picks the file and shows what would be imported; step 2 commits it.
export default function RdmImportModal({ onDone, onClose }) {
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const clean = (e) => String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  const pick = async () => {
    setBusy(true);
    setErr('');
    try {
      const r = await window.api.rdmPreview();
      if (r.ok) setPreview(r);
    } catch (e) {
      setErr(clean(e));
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    setBusy(true);
    try {
      const r = await window.api.rdmCommit(preview.token);
      onDone(r);
    } catch (e) {
      setErr(clean(e));
      setBusy(false);
    }
  };

  const s = preview?.summary;
  const skipped = s ? Object.entries(s.skipped) : [];

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Import from Remote Desktop Manager">
        <h2>Import from Remote Desktop Manager</h2>
        {!preview && (
          <>
            <p className="hint">
              In RDM choose <b>File &gt; Export &gt; Export All Entries</b> and save as <b>.rdm / .xml</b> (or JSON / CSV).
              Select that file here. Nothing is changed until you confirm.
            </p>
            {err && <div className="error" role="alert">{err}</div>}
            <div className="actions">
              <button onClick={onClose}>Cancel</button>
              <button className="primary" onClick={pick} disabled={busy}>{busy ? 'Reading…' : 'Choose file…'}</button>
            </div>
          </>
        )}
        {preview && (
          <>
            <div className="hint">File: <b>{preview.file}</b></div>
            <dl className="summary">
              <dt>RDP entries</dt><dd>{s.rdp}</dd>
              <dt>SSH entries</dt><dd>{s.ssh}</dd>
              <dt>Folders</dt><dd>{s.folders}</dd>
              <dt>Shared credentials</dt><dd>{s.credentials}</dd>
            </dl>
            {skipped.length > 0 && (
              <div className="hint">Skipped (not supported): {skipped.map(([k, v]) => `${v} × ${k}`).join(', ')}</div>
            )}
            <div className="hint">Everything is added inside a new folder named “RDM import …”. {s.passwordsNote}</div>
            {err && <div className="error" role="alert">{err}</div>}
            <div className="actions">
              <button onClick={onClose}>Cancel</button>
              <button onClick={pick} disabled={busy}>Choose another…</button>
              <button className="primary" onClick={commit} disabled={busy || (s.rdp + s.ssh === 0 && s.credentials === 0)}>{busy ? 'Importing…' : 'Import'}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
