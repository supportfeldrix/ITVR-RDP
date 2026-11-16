import React, { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

// One SSH session rendered in an xterm.js terminal. Stays mounted while hidden
// so the session survives tab switches.
export default function TerminalTab({ tab, active, focused = active, onStatus, onSession, bus }) {
  const hostRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const sessionRef = useRef(null);

  useEffect(() => {
    const term = new Terminal({
      fontFamily: 'Cascadia Mono, Menlo, Consolas, monospace',
      fontSize: 14,
      cursorBlink: true,
      scrollback: 10000,
      theme: { background: '#16171b' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    let offData = () => {};
    let offClosed = () => {};
    let offBus = () => {};
    let disposed = false;

    // Multi-execute mirrors only what the user typed or pasted. xterm also reports automatic replies to
    // the server's terminal queries through onData; those must stay with their own session.
    let lastUserInput = 0;
    const markUser = () => { lastUserInput = performance.now(); };
    const host = hostRef.current;
    for (const ev of ['keydown', 'input', 'paste', 'compositionend']) host.addEventListener(ev, markUser, true);

    window.api
      .sshOpen({ id: tab.conn.id, cols: term.cols, rows: term.rows, password: tab.password, username: tab.promptUser })
      .then(({ sessionId }) => {
        if (disposed) return window.api.sshClose(sessionId);
        sessionRef.current = sessionId;
        onSession?.(tab.key, sessionId);
        onStatus(tab.key, 'connected');
        offData = window.api.onSshData((p) => p.sessionId === sessionId && term.write(p.data));
        offClosed = window.api.onSshClosed((p) => {
          if (p.sessionId !== sessionId) return;
          term.write(`\r\n\x1b[33m[Session closed${p.error ? ': ' + p.error : ''}]\x1b[0m\r\n`);
          onStatus(tab.key, 'closed');
        });
        term.onData((d) => {
          window.api.sshInput(sessionId, d);
          if (bus && performance.now() - lastUserInput < 150) bus.emit(tab.key, { kind: 'text', data: d });
        });
        if (bus) offBus = bus.register(tab.key, (e) => { if (e.kind === 'text' && sessionRef.current) window.api.sshInput(sessionRef.current, e.data); });
        term.onResize(({ cols, rows }) => window.api.sshResize(sessionId, cols, rows));
        window.api.sshResize(sessionId, term.cols, term.rows);
      })
      .catch((e) => {
        term.write(`\x1b[31mConnection failed: ${String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}\x1b[0m\r\n`);
        onStatus(tab.key, 'closed');
      });

    const ro = new ResizeObserver(() => {
      if (hostRef.current?.offsetParent) fit.fit();
    });
    ro.observe(hostRef.current);

    return () => {
      disposed = true;
      for (const ev of ['keydown', 'input', 'paste', 'compositionend']) host.removeEventListener(ev, markUser, true);
      offBus();
      ro.disconnect();
      offData();
      offClosed();
      if (sessionRef.current) window.api.sshClose(sessionRef.current);
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Visible: re-fit to the (possibly new) pane size. Focused: take the keyboard.
  useEffect(() => {
    if (active) requestAnimationFrame(() => fitRef.current?.fit());
  }, [active]);
  useEffect(() => {
    if (focused) requestAnimationFrame(() => termRef.current?.focus());
  }, [focused]);

  return <div className="terminal-host" ref={hostRef} style={{ display: active ? 'block' : 'none' }} />;
}
