// Multi-execute routing: keyboard input typed in one session is mirrored to the others.
//
// Events:
//   { kind: 'key',  down: boolean, sc: number, paste?: boolean }   RDP key press/release (scancode)
//   { kind: 'text', data: string }                                   SSH terminal input
// RDP only mirrors to RDP and SSH only to SSH (a receiver ignores the other kind).
//
// `getState()` returns { on: boolean, keys: string[] } where keys are the session tab keys that
// currently take part (visible, connected, not excluded). Nothing is sent unless the source is
// itself in `keys`, so an excluded pane never sends and never receives.
export function createInputBus(getState) {
  const receivers = new Map(); // tab key -> (event) => void

  return {
    register(key, handler) {
      receivers.set(key, handler);
      return () => { if (receivers.get(key) === handler) receivers.delete(key); };
    },
    // Number of sessions an event from `from` would reach right now (for the UI banner/tests).
    targets(from) {
      const { on, keys } = getState();
      if (!on || !keys.includes(from)) return [];
      return keys.filter((k) => k !== from && receivers.has(k));
    },
    emit(from, event) {
      for (const k of this.targets(from)) {
        try { receivers.get(k)(event); } catch { /* one failing session must not stop the others */ }
      }
    },
  };
}

// Ctrl/Cmd+V or Shift+Insert: the remote must see the *current* local clipboard first.
export const isPasteShortcut = (e) => ((e.ctrlKey || e.metaKey) && e.code === 'KeyV') || (e.shiftKey && e.code === 'Insert');

// On a Mac, Cmd stands in for Ctrl (Cmd+C/V/A/Z behave like Windows shortcuts on the remote).
// The Windows key is still available from the toolbar button.
export function scancodeFor(code, table, isMac) {
  if (isMac && (code === 'MetaLeft' || code === 'MetaRight')) return table.ControlLeft;
  return table[code];
}
