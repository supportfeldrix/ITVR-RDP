import React, { useState } from 'react';

// Manage shared credential entries: one saved login reused by many connections.
export default function CredentialsModal({ credentials, onChanged, onClose }) {
  const [editing, setEditing] = useState(null);
  const [err, setErr] = useState('');

  const remove = async (c) => {
    const msg = c.usage
      ? `"${c.name}" is used by ${c.usage} entr${c.usage === 1 ? 'y' : 'ies'}. They will ask for credentials until you pick another. Delete it?`
      : `Delete "${c.name}"?`;
    if (!window.confirm(msg)) return;
    await window.api.credDelete(c.id);
    onChanged();
  };

  const save = async (payload) => {
    try {
      await window.api.credSave(payload);
      setEditing(null);
      setErr('');
      onChanged();
    } catch (e) {
      setErr(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    }
  };

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="modal wide" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Credentials">
        <h2>Shared credentials</h2>
        <p className="hint">Save a login once and link it from any number of RDP or SSH entries. Changing the password here updates all of them.</p>

        {!editing && (
          <>
            <table className="cred-table">
              <thead><tr><th>Name</th><th>Account</th><th>Password</th><th>Used by</th><th /></tr></thead>
              <tbody>
                {credentials.length === 0 && <tr><td colSpan={5} className="muted">No shared credentials yet.</td></tr>}
                {credentials.map((c) => (
                  <tr key={c.id}>
                    <td>{c.name}</td>
                    <td>{c.domain ? `${c.domain}\\` : ''}{c.username || '-'}</td>
                    <td>{c.hasPassword ? 'Saved' : <span className="muted">None</span>}</td>
                    <td>{c.usage}</td>
                    <td className="row-actions">
                      <button onClick={() => setEditing(c)}>Edit</button>
                      <button className="danger" onClick={() => remove(c)}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {err && <div className="error" role="alert">{err}</div>}
            <div className="actions">
              <button onClick={() => setEditing({ name: '', username: '', domain: '' })}>＋ New credential</button>
              <div className="spacer" />
              <button className="primary" onClick={onClose}>Close</button>
            </div>
          </>
        )}

        {editing && <CredForm initial={editing} onSave={save} onCancel={() => { setEditing(null); setErr(''); }} err={err} />}
      </div>
    </div>
  );
}

function CredForm({ initial, onSave, onCancel, err }) {
  const [c, setC] = useState({ ...initial });
  const [password, setPassword] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const set = (k, v) => setC((p) => ({ ...p, [k]: v }));
  const pickKey = async () => { const p = await window.api.pickKey(); if (p) set('privateKeyPath', p); };

  return (
    <form
      className="cred-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!c.name.trim()) return;
        const payload = { ...c };
        if (password) payload.password = password;
        if (passphrase) payload.keyPassphrase = passphrase;
        onSave(payload);
      }}
    >
      <label>Name<input autoFocus value={c.name || ''} onChange={(e) => set('name', e.target.value)} placeholder="e.g. FNB admin" /></label>
      <div className="row">
        <label className="grow">Username<input value={c.username || ''} onChange={(e) => set('username', e.target.value)} autoComplete="off" /></label>
        <label className="grow">Domain<input value={c.domain || ''} onChange={(e) => set('domain', e.target.value)} /></label>
      </div>
      <label>Password {initial.hasPassword && <em>(saved, leave blank to keep)</em>}
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
      </label>
      <label>SSH private key (optional)
        <div className="row">
          <input className="grow" value={c.privateKeyPath || ''} onChange={(e) => set('privateKeyPath', e.target.value)} />
          <button type="button" onClick={pickKey}>Browse</button>
        </div>
      </label>
      <label>Key passphrase {initial.hasPassphrase && <em>(saved, leave blank to keep)</em>}
        <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoComplete="new-password" />
      </label>
      <label>Notes<textarea rows={2} value={c.notes || ''} onChange={(e) => set('notes', e.target.value)} /></label>
      {err && <div className="error" role="alert">{err}</div>}
      <div className="actions">
        <button type="button" onClick={onCancel}>Back</button>
        <button type="submit" className="primary">Save</button>
      </div>
    </form>
  );
}
