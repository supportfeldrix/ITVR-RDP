import React, { useCallback, useEffect, useRef, useState } from 'react';
import { loadIronRdp } from './rdp/ironrdp.js';
import { SCANCODES } from './rdp/scancodes.js';

const even = (n) => Math.max(2, Math.floor(n / 2) * 2);

function errText(e) {
  if (!e) return 'Unknown error';
  try {
    if (typeof e.backtrace === 'function') {
      const kind = typeof e.kind === 'function' ? e.kind() : '';
      const kinds = ['General', 'WrongPassword', 'LogonFailure', 'AccessDenied', 'RDCleanPath', 'ProxyConnect', 'NegotiationFailure'];
      const k = kinds[kind] || 'Error';
      if (k === 'WrongPassword' || k === 'LogonFailure') return 'Logon failed: wrong username or password.';
      if (k === 'AccessDenied') return 'Access denied by the server.';
      if (k === 'RDCleanPath' || k === 'ProxyConnect') return 'Could not reach the server (check host, port, firewall, or certificate).';
      return `${k}: ${e.backtrace().split('\n')[0]}`;
    }
  } catch { /* fall through */ }
  return String(e.message || e);
}

// One embedded RDP session. Stays mounted while hidden so it survives tab switches.
export default function RdpTab({ tab, active, onStatus }) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const sessionRef = useRef(null);
  const ironRef = useRef(null);
  const [state, setState] = useState('connecting'); // connecting | connected | closed
  const [message, setMessage] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [scale, setScale] = useState(tab.conn.smartSizing ? 'fit' : 'resize');

  const status = useCallback((s, msg = '') => {
    setState(s);
    setMessage(msg);
    onStatus(tab.key, s);
  }, [onStatus, tab.key]);

  const send = useCallback((events) => {
    const s = sessionRef.current;
    const iron = ironRef.current;
    if (!s || !iron) return;
    try {
      const tx = new iron.InputTransaction();
      for (const ev of events) tx.addEvent(ev);
      s.applyInputs(tx);
    } catch { /* ignore input errors while (dis)connecting */ }
  }, []);

  // ---- connect / reconnect ----
  useEffect(() => {
    let cancelled = false;
    let session;
    let ticket = '';
    status('connecting', `Connecting to ${tab.conn.host}…`);

    (async () => {
      try {
        const iron = await loadIronRdp();
        ironRef.current = iron;
        const info = tab.quick
          ? { ...(await window.api.rdpPrepareQuick(tab.conn.host, tab.conn.port)), username: tab.promptUser || tab.conn.username, domain: '', password: '' }
          : await window.api.rdpPrepare(tab.conn.id, { username: tab.promptUser, password: tab.password });
        ticket = info.ticket;
        if (cancelled) return;
        if (info.viaGateway) status('connecting', `Connecting to ${tab.conn.host} via gateway ${info.viaGateway}…`);

        const password = tab.password || info.password;
        let username = info.username || '';
        let domain = info.domain || '';
        // Accept DOMAIN\user typed into the username field.
        if (!domain && username.includes('\\')) [domain, username] = username.split('\\', 2);

        const wrap = wrapRef.current;
        const fixed = !tab.conn.dynamicResolution && tab.conn.width && tab.conn.height;
        const w = fixed ? even(tab.conn.width) : even(wrap.clientWidth || 1280);
        const h = fixed ? even(tab.conn.height) : even(wrap.clientHeight || 720);

        const b = new iron.SessionBuilder();
        b.username(username);
        b.password(password || '');
        if (domain) b.serverDomain(domain);
        b.destination(info.destination);
        b.proxyAddress(info.proxyAddress);
        b.authToken('local');
        b.desktopSize(new iron.DesktopSize(w, h));
        b.renderCanvas(canvasRef.current);
        b.extension(new iron.Extension('enable_credssp', true));
        b.extension(new iron.Extension('display_control', true));
        b.setCursorStyleCallbackContext(canvasRef.current);
        b.setCursorStyleCallback((style) => { if (canvasRef.current) canvasRef.current.style.cursor = style || 'default'; });

        if (tab.conn.redirectClipboard !== false) {
          b.remoteClipboardChangedCallback((data) => {
            try {
              const item = data.items().find((i) => i.mimeType() === 'text/plain');
              if (item) navigator.clipboard.writeText(String(item.value())).catch(() => {});
            } catch { /* ignore */ }
          });
          b.forceClipboardUpdateCallback(async () => pushClipboard());
        }

        session = await b.connect();
        if (cancelled) { session.shutdown(); return; }
        sessionRef.current = session;
        const ds = session.desktopSize();
        canvasRef.current.width = ds.width;
        canvasRef.current.height = ds.height;
        status('connected');
        canvasRef.current.focus();

        session.run()
          .then((t) => { if (!cancelled) status('closed', `Session ended: ${t.reason()}`); })
          .catch((e) => { if (!cancelled) status('closed', errText(e)); })
          .finally(() => { sessionRef.current = null; });
      } catch (e) {
        if (cancelled) return;
        // Prefer the proxy's precise reason (gateway sign-in, policy denial, certificate change).
        let detail = '';
        if (ticket) detail = await window.api.rdpError(ticket).catch(() => '');
        const prep = String(e?.message || '').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
        status('closed', detail || (typeof e?.backtrace === 'function' ? errText(e) : prep || errText(e)));
      }
    })();

    return () => {
      cancelled = true;
      try { sessionRef.current?.shutdown(); } catch { /* ignore */ }
      sessionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  async function pushClipboard() {
    const s = sessionRef.current;
    const iron = ironRef.current;
    if (!s || !iron) return;
    const data = new iron.ClipboardData();
    try {
      const text = await navigator.clipboard.readText();
      if (text) data.addText('text/plain', text);
    } catch { /* clipboard not readable */ }
    try { await s.onClipboardPaste(data); } catch { /* ignore */ }
  }

  // ---- dynamic resolution: follow the tab size like RDM's "adapt to window" ----
  useEffect(() => {
    if (tab.conn.dynamicResolution === false) return undefined;
    let timer;
    const ro = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const s = sessionRef.current;
        const wrap = wrapRef.current;
        if (!s || !wrap || !wrap.offsetParent || scale !== 'resize') return;
        const w = even(wrap.clientWidth);
        const h = even(wrap.clientHeight);
        if (w < 200 || h < 200) return;
        if (w === canvasRef.current.width && h === canvasRef.current.height) return;
        try {
          s.resize(w, h);
          canvasRef.current.width = w;
          canvasRef.current.height = h;
        } catch { /* server may not support display control */ }
      }, 400);
    });
    ro.observe(wrapRef.current);
    return () => { clearTimeout(timer); ro.disconnect(); };
  }, [tab.conn.dynamicResolution, scale]);

  // ---- input ----
  useEffect(() => {
    const c = canvasRef.current;
    const iron = () => ironRef.current;
    const pos = (e) => {
      const r = c.getBoundingClientRect();
      // Account for object-fit: contain letterboxing.
      const ratio = Math.min(r.width / c.width, r.height / c.height);
      const ox = (r.width - c.width * ratio) / 2;
      const oy = (r.height - c.height * ratio) / 2;
      const x = Math.round((e.clientX - r.left - ox) / ratio);
      const y = Math.round((e.clientY - r.top - oy) / ratio);
      return [Math.min(c.width - 1, Math.max(0, x)), Math.min(c.height - 1, Math.max(0, y))];
    };
    const key = (down) => (e) => {
      const sc = SCANCODES[e.code];
      if (sc === undefined || !iron()) return;
      e.preventDefault();
      e.stopPropagation();
      send([down ? iron().DeviceEvent.keyPressed(sc) : iron().DeviceEvent.keyReleased(sc)]);
    };
    const onMove = (e) => iron() && send([iron().DeviceEvent.mouseMove(...pos(e))]);
    const onDown = (e) => {
      e.preventDefault();
      c.focus();
      if (iron()) send([iron().DeviceEvent.mouseMove(...pos(e)), iron().DeviceEvent.mouseButtonPressed(e.button)]);
    };
    const onUp = (e) => { e.preventDefault(); if (iron()) send([iron().DeviceEvent.mouseButtonReleased(e.button)]); };
    const onWheel = (e) => {
      e.preventDefault();
      if (!iron()) return;
      const ev = [];
      if (e.deltaY) ev.push(iron().DeviceEvent.wheelRotations(true, e.deltaY > 0 ? -1 : 1, 1));
      if (e.deltaX) ev.push(iron().DeviceEvent.wheelRotations(false, e.deltaX > 0 ? -1 : 1, 1));
      send(ev);
    };
    const onBlur = () => { try { sessionRef.current?.releaseAllInputs(); } catch { /* ignore */ } };
    const onFocus = () => { if (tab.conn.redirectClipboard !== false) pushClipboard(); };
    const noMenu = (e) => e.preventDefault();
    const kd = key(true);
    const ku = key(false);

    c.addEventListener('keydown', kd);
    c.addEventListener('keyup', ku);
    c.addEventListener('mousemove', onMove);
    c.addEventListener('mousedown', onDown);
    c.addEventListener('mouseup', onUp);
    c.addEventListener('wheel', onWheel, { passive: false });
    c.addEventListener('contextmenu', noMenu);
    c.addEventListener('blur', onBlur);
    c.addEventListener('focus', onFocus);
    return () => {
      c.removeEventListener('keydown', kd);
      c.removeEventListener('keyup', ku);
      c.removeEventListener('mousemove', onMove);
      c.removeEventListener('mousedown', onDown);
      c.removeEventListener('mouseup', onUp);
      c.removeEventListener('wheel', onWheel);
      c.removeEventListener('contextmenu', noMenu);
      c.removeEventListener('blur', onBlur);
      c.removeEventListener('focus', onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [send]);

  useEffect(() => {
    if (active && state === 'connected') requestAnimationFrame(() => canvasRef.current?.focus());
  }, [active, state]);

  const ctrlAltDel = () => {
    const i = ironRef.current;
    if (!i) return;
    send([i.DeviceEvent.keyPressed(0x1d), i.DeviceEvent.keyPressed(0x38), i.DeviceEvent.keyPressed(0xe053)]);
    setTimeout(() => send([i.DeviceEvent.keyReleased(0xe053), i.DeviceEvent.keyReleased(0x38), i.DeviceEvent.keyReleased(0x1d)]), 80);
    canvasRef.current?.focus();
  };
  const sendWinKey = () => {
    const i = ironRef.current;
    if (!i) return;
    send([i.DeviceEvent.keyPressed(0xe05b)]);
    setTimeout(() => send([i.DeviceEvent.keyReleased(0xe05b)]), 50);
    canvasRef.current?.focus();
  };
  const disconnect = () => {
    try { sessionRef.current?.shutdown(); } catch { /* ignore */ }
  };
  const fullscreen = () => wrapRef.current?.parentElement?.requestFullscreen?.();

  return (
    <div className="session" style={{ display: active ? 'flex' : 'none' }}>
      <div className="session-bar">
        <span className={`dot ${state}`} />
        <span className="session-title">{tab.conn.name} <span className="muted">{tab.conn.host}</span></span>
        <div className="spacer" />
        <button onClick={ctrlAltDel} disabled={state !== 'connected'} title="Send Ctrl+Alt+Del">Ctrl+Alt+Del</button>
        <button onClick={sendWinKey} disabled={state !== 'connected'} title="Send Windows key">Win</button>
        <select value={scale} onChange={(e) => setScale(e.target.value)} title="Display mode" aria-label="Display mode">
          <option value="resize">Adapt resolution</option>
          <option value="fit">Smart sizing (scale)</option>
          <option value="actual">Actual size</option>
        </select>
        <button onClick={fullscreen} title="Full screen">⛶</button>
        {state === 'connected'
          ? <button className="danger" onClick={disconnect}>Disconnect</button>
          : <button className="primary" onClick={() => setAttempt((a) => a + 1)} disabled={state === 'connecting'}>Reconnect</button>}
      </div>
      <div className={`rdp-wrap scale-${scale}`} ref={wrapRef}>
        <canvas ref={canvasRef} tabIndex={0} className="rdp-canvas" style={{ visibility: state === 'connected' ? 'visible' : 'hidden' }} />
        {state !== 'connected' && (
          <div className="rdp-overlay">
            {state === 'connecting' && <div className="spinner" aria-hidden="true" />}
            <div>{message}</div>
            {state === 'closed' && <button className="primary" onClick={() => setAttempt((a) => a + 1)}>Reconnect</button>}
          </div>
        )}
      </div>
    </div>
  );
}
