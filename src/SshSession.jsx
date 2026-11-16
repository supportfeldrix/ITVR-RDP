import React, { useState } from 'react';
import TerminalTab from './TerminalTab.jsx';
import SftpPanel from './SftpPanel.jsx';

// SSH tab: terminal on the left, optional SFTP file explorer on the right.
// `pane` (split view) carries the grid placement, focus/drop handlers and classes.
export default function SshSession({ tab, active, focused = active, onStatus, onSession, pane }) {
  const [showFiles, setShowFiles] = useState(false);
  const { className: paneClass = '', style: paneStyle, ...paneEvents } = pane || {};

  return (
    <div className={`session ${paneClass}`} style={{ display: active ? 'flex' : 'none', ...paneStyle }} {...paneEvents}>
      <div className="session-bar">
        <span className={`dot ${tab.status}`} />
        <span className="session-title" title={`${tab.conn.name} (${tab.conn.host})`}>{tab.conn.name} <span className="muted">{tab.conn.host}</span></span>
        <div className="spacer" />
        <button onClick={() => setShowFiles((v) => !v)} disabled={tab.status !== 'connected'} aria-pressed={showFiles} title="Browse remote files (SFTP)">
          {showFiles ? 'Hide files' : 'Files (SFTP)'}
        </button>
      </div>
      <div className="ssh-body">
        <TerminalTab tab={tab} active={active} focused={focused} onStatus={onStatus} onSession={onSession} />
        {showFiles && tab.sessionId && <SftpPanel sessionId={tab.sessionId} onClose={() => setShowFiles(false)} />}
      </div>
    </div>
  );
}
