import React, { useState } from 'react';
import TerminalTab from './TerminalTab.jsx';
import SftpPanel from './SftpPanel.jsx';

// SSH tab: terminal on the left, optional SFTP file explorer on the right.
// `pane` (split view) carries the grid placement, focus/drop handlers and classes.
// `bus` + `multi` connect it to multi-execute (type once, send to several sessions).
export default function SshSession({ tab, active, focused = active, onStatus, onSession, pane, bus, multi }) {
  const [showFiles, setShowFiles] = useState(false);
  const { className: paneClass = '', style: paneStyle, ...paneEvents } = pane || {};

  return (
    <div className={`session ${paneClass}`} style={{ display: active ? 'flex' : 'none', ...paneStyle }} {...paneEvents}>
      <div className="session-bar">
        <span className={`dot ${tab.status}`} />
        <span className="session-title" title={`${tab.conn.name} (${tab.conn.host})`}>{tab.conn.name} <span className="muted">{tab.conn.host}</span></span>
        <div className="spacer" />
        {multi?.active && (
          <button className={`multi-btn${multi.included ? ' on' : ''}`} onClick={multi.toggle} aria-pressed={multi.included}
            title={multi.included ? 'This pane receives multi-execute input. Click to exclude it.' : 'This pane is excluded from multi-execute. Click to include it.'}>
            {multi.included ? '⇉ In multi-execute' : '✕ Excluded'}
          </button>
        )}
        <button onClick={() => setShowFiles((v) => !v)} disabled={tab.status !== 'connected'} aria-pressed={showFiles} title="Browse remote files (SFTP)">
          {showFiles ? 'Hide files' : 'Files (SFTP)'}
        </button>
      </div>
      <div className="ssh-body">
        <TerminalTab tab={tab} active={active} focused={focused} onStatus={onStatus} onSession={onSession} bus={bus} />
        {showFiles && tab.sessionId && <SftpPanel sessionId={tab.sessionId} onClose={() => setShowFiles(false)} />}
      </div>
    </div>
  );
}
