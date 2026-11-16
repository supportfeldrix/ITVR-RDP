import React, { useCallback, useEffect, useRef, useState } from 'react';
import { loadIronRdp } from './rdp/ironrdp.js';
import { SCANCODES } from './rdp/scancodes.js';
import { isPasteShortcut, scancodeFor } from './inputBus.mjs';

const IS_MAC = window.api?.platform === 'darwin';

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
// `pane` (split view) carries the grid placement, focus/drop handlers and classes.
export default function RdpTab({ tab, active, focused = active, onStatus, pane, bus, multi }) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const sessionRef = useRef(null);
  const ironRef = useRef(null);
  const lastClipRef = useRef(''); // last text exchanged with the remote clipboard (stops echo loops)
  const queueRef = useRef(Promise.resolve()); // keeps key events in order while a clipboard sync is pending
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
              if (item) {
                const text = String(item.value());
                lastClipRef.current = text;
                window.api.clipboardWrite(text).catch(() => {});
              }
            } catch { /* ignore */ }
          });
          b.forceClipboardUpdateCallback(async () => syncClipboard());
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

  // Send the laptop clipboard to the remote when it has changed. Read through the main process
  // (always available), and never send an empty clipboard: that would wipe the remote's.
  async function syncClipboard() {
    if (tab.conn.redirectClipboard === false) return;
    const s = sessionRef.current;
    const iron = ironRef.current;
    if (!s || !iron) return;
    let text = '';
    try { text = await window.api.clipboardRead(); } catch { return; }
    if (!text || text === lastClipRef.current) return;
    try {
      const data = new iron.ClipboardData();
      data.addText('text/plain', text);
      await s.onClipboardPaste(data);
      lastClipRef.current = text;
    } catch { /* channel not ready yet; the next sync retries */ }
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

  // Press/release a key on this session. All keys go through one queue so that a paste shortcut can
  // wait for the clipboard sync without letting later keys (e.g. the Ctrl release) overtake it.
  const applyKey = useCallback((sc, down, paste) => {
    queueRef.current = queueRef.current.then(async () => {
      const iron = ironRef.current;
      if (!iron || !sessionRef.current) return;
      if (paste) await syncClipboard();
      send([down ? iron.DeviceEvent.keyPressed(sc) : iron.DeviceEvent.keyReleased(sc)]);
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [send]);

  // Multi-execute: keys typed in another RDP pane arrive here.
  useEffect(() => {
    if (!bus) return undefined;
    return bus.register(tab.key, (ev) => {
      if (ev.kind === 'key' && sessionRef.current) applyKey(ev.sc, ev.down, ev.paste);
    });
  }, [bus, tab.key, applyKey]);

  // Keep the remote clipboard current while this pane is in use, so right-click paste works too.
  useEffect(() => {
    if (!focused || state !== 'connected') return undefined;
    syncClipboard();
    const timer = setInterval(() => { if (document.hasFocus()) syncClipboard(); }, 1000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused, state]);

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
      const sc = scancodeFor(e.code, SCANCODES, IS_MAC);
      if (sc === undefined || !iron()) return;
      e.preventDefault();
      e.stopPropagation();
      const paste = down && isPasteShortcut(e);
      applyKey(sc, down, paste);
      if (bus) bus.emit(tab.key, { kind: 'key', down, sc, paste });
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
    const onFocus = () => { syncClipboard(); };
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

  // Only the focused pane takes the keyboard; others stay visible but idle.
  useEffect(() => {
    if (focused && state === 'connected') requestAnimationFrame(() => canvasRef.current?.focus());
  }, [focused, state]);

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

  const { className: paneClass = '', style: paneStyle, ...paneEvents } = pane || {};

  return (
    <div className={`session ${paneClass}`} style={{ display: active ? 'flex' : 'none', ...paneStyle }} {...paneEvents}>
      <div className="session-bar">
        <span className={`dot ${state}`} />
        <span className="session-title" title={`${tab.conn.name} (${tab.conn.host})`}>{tab.conn.name} <span className="muted">{tab.conn.host}</span></span>
        <div className="spacer" />
        {multi?.active && (
          <button className={`multi-btn${multi.included ? ' on' : ''}`} onClick={multi.toggle} aria-pressed={multi.included}
            title={multi.included ? 'This pane receives multi-execute input. Click to exclude it.' : 'This pane is excluded from multi-execute. Click to include it.'}>
            {multi.included ? '⇉ In multi-execute' : '✕ Excluded'}
          </button>
        )}
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
