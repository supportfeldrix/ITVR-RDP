import React, { useState } from 'react';

const blank = (type, parentId) => ({
  type,
  parentId: parentId || null,
  name: '',
  host: '',
  port: type === 'ssh' ? 22 : 3389,
  credentialId: '',
  username: '',
  domain: '',
  gateway: '',
  gatewayPort: 443,
  gatewayCredentialId: '',
  fullscreen: false,
  width: 1920,
  height: 1080,
  multimon: false,
  redirectClipboard: true,
  redirectDrives: false,
  dynamicResolution: true,
  smartSizing: false,
  openExternal: false,
  privateKeyPath: '',
  notes: '',
  tags: [],
  favorite: false,
});

export default function EditorModal({ initial, folders, credentials, onSave, onCancel, onManageCredentials }) {
  const [c, setC] = useState(() => ({ ...blank(initial.type, initial.parentId), ...initial }));
  // password fields are write-only: undefined = keep existing, string = replace
  const [password, setPassword] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [tags, setTags] = useState((initial.tags || []).join(', '));
  const [err, setErr] = useState('');
  const set = (k, v) => setC((p) => ({ ...p, [k]: v }));
  const isNew = !initial.id;
  const isFolder = c.type === 'folder';
  const shared = !!c.credentialId;

  const submit = async (e) => {
    e.preventDefault();
    if (!c.name.trim()) return setErr('Name is required');
    if (!isFolder && !c.host.trim()) return setErr('Host is required');
    if (c.gateway && !c.gateway.trim()) return setErr('Gateway host is invalid');
    const payload = { ...c, tags: tags.split(',').map((t) => t.trim()).filter(Boolean) };
    if (password) payload.password = password;
    if (passphrase) payload.keyPassphrase = passphrase;
    try {
      await onSave(payload);
    } catch (ex) {
      setErr(String(ex.message || ex));
    }
  };

  const pickKey = async () => {
    const p = await window.api.pickKey();
    if (p) set('privateKeyPath', p);
  };

  const credOptions = (
    <>
      <option value="">Custom (stored on this entry)</option>
      {credentials.map((cr) => <option key={cr.id} value={cr.id}>{cr.name}{cr.username ? ` (${cr.domain ? `${cr.domain}\\` : ''}${cr.username})` : ''}</option>)}
    </>
  );

  return (
    <div className="overlay" onMouseDown={onCancel}>
      <form className="modal" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>{isNew ? 'New' : 'Edit'} {isFolder ? 'folder' : c.type.toUpperCase() + ' entry'}</h2>

        <label>Name<input autoFocus value={c.name} onChange={(e) => set('name', e.target.value)} /></label>

        <label>Folder
          <select value={c.parentId || ''} onChange={(e) => set('parentId', e.target.value || null)}>
            <option value="">(root)</option>
            {folders.filter((f) => f.id !== c.id).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </label>

        {!isFolder && (
          <>
            <div className="row">
              <label className="grow">Host<input value={c.host} onChange={(e) => set('host', e.target.value)} placeholder="server.example.com" /></label>
              <label className="narrow">Port<input type="number" value={c.port} onChange={(e) => set('port', e.target.value)} /></label>
            </div>

            <fieldset>
              <legend>Credentials</legend>
              <label>Use
                <div className="row">
                  <select className="grow" value={c.credentialId} onChange={(e) => set('credentialId', e.target.value)}>{credOptions}</select>
                  <button type="button" onClick={onManageCredentials}>Manage…</button>
                </div>
              </label>
              {shared ? (
                <div className="hint">Username, domain and password come from the shared credential. Change it once to update every entry that uses it.</div>
              ) : (
                <>
                  <div className="row">
                    <label className="grow">Username<input value={c.username} onChange={(e) => set('username', e.target.value)} autoComplete="off" /></label>
                    {c.type === 'rdp' && <label className="grow">Domain<input value={c.domain} onChange={(e) => set('domain', e.target.value)} /></label>}
                  </div>
                  <label>Password {initial.hasPassword && !initial.credentialId && <em>(saved, leave blank to keep)</em>}
                    <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
                  </label>
                </>
              )}
            </fieldset>
          </>
        )}

        {c.type === 'ssh' && (
          <>
            <label>Private key file
              <div className="row">
                <input className="grow" value={c.privateKeyPath} onChange={(e) => set('privateKeyPath', e.target.value)} placeholder="Optional" />
                <button type="button" onClick={pickKey}>Browse</button>
              </div>
            </label>
            <label>Key passphrase {initial.hasPassphrase && <em>(saved, leave blank to keep)</em>}
              <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoComplete="new-password" />
            </label>
          </>
        )}

        {c.type === 'rdp' && (
          <>
            <fieldset>
              <legend>RD Gateway</legend>
              <div className="row">
                <label className="grow">Gateway host<input value={c.gateway} onChange={(e) => set('gateway', e.target.value)} placeholder="Optional, e.g. rdgw.corp.example.com" /></label>
                <label className="narrow">Port<input type="number" value={c.gatewayPort} onChange={(e) => set('gatewayPort', e.target.value)} /></label>
              </div>
              {c.gateway && (
                <label>Gateway sign-in
                  <select value={c.gatewayCredentialId} onChange={(e) => set('gatewayCredentialId', e.target.value)}>
                    <option value="">Same as the connection credentials</option>
                    {credentials.map((cr) => <option key={cr.id} value={cr.id}>{cr.name}</option>)}
                  </select>
                </label>
              )}
              {c.gateway && <div className="hint">Embedded sessions use the HTTPS WebSocket transport with NTLM sign-in (Windows Server 2016 or later).</div>}
            </fieldset>

            <label>Display
              <select value={c.openExternal ? 'external' : 'embedded'} onChange={(e) => set('openExternal', e.target.value === 'external')}>
                <option value="embedded">Embedded (tab inside ITVR RDP)</option>
                <option value="external">External ({window.api.platform === 'darwin' ? 'Microsoft Remote Desktop' : 'mstsc'})</option>
              </select>
            </label>
            <div className="checks">
              <label><input type="checkbox" checked={c.dynamicResolution !== false} onChange={(e) => set('dynamicResolution', e.target.checked)} /> Adapt resolution to tab size</label>
              <label><input type="checkbox" checked={!!c.smartSizing} onChange={(e) => set('smartSizing', e.target.checked)} /> Smart sizing (scale)</label>
              <label><input type="checkbox" checked={c.redirectClipboard} onChange={(e) => set('redirectClipboard', e.target.checked)} /> Clipboard</label>
            </div>
            {(c.dynamicResolution === false || c.openExternal) && (
              <div className="row">
                <label className="narrow">Width<input type="number" value={c.width} onChange={(e) => set('width', e.target.value)} /></label>
                <label className="narrow">Height<input type="number" value={c.height} onChange={(e) => set('height', e.target.value)} /></label>
              </div>
            )}
            {c.openExternal && (
              <div className="checks">
                <label><input type="checkbox" checked={c.fullscreen} onChange={(e) => set('fullscreen', e.target.checked)} /> Full screen</label>
                <label><input type="checkbox" checked={c.multimon} onChange={(e) => set('multimon', e.target.checked)} /> Multi-monitor</label>
                <label><input type="checkbox" checked={c.redirectDrives} onChange={(e) => set('redirectDrives', e.target.checked)} /> Local drives</label>
              </div>
            )}
          </>
        )}

        {!isFolder && <label>Tags<input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="prod, windows" /></label>}
        {!isFolder && <label>Notes<textarea rows={3} value={c.notes} onChange={(e) => set('notes', e.target.value)} /></label>}

        {err && <div className="error" role="alert">{err}</div>}
        <div className="actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="submit" className="primary">Save</button>
        </div>
      </form>
    </div>
  );
}
