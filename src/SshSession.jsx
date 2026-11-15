import React, { useState } from 'react';
import TerminalTab from './TerminalTab.jsx';
import SftpPanel from './SftpPanel.jsx';

// SSH tab: terminal on the left, optional SFTP file explorer on the right.
export default function SshSession({ tab, active, onStatus, onSession }) {
  const [showFiles, setShowFiles] = useState(false);

  return (
    <div className="session" style={{ display: active ? 'flex' : 'none' }}>
      <div className="session-bar">
        <span className={`dot ${tab.status}`} />
        <span className="session-title">{tab.conn.name} <span className="muted">{tab.conn.host}</span></span>
        <div className="spacer" />
        <button onClick={() => setShowFiles((v) => !v)} disabled={tab.status !== 'connected'} aria-pressed={showFiles} title="Browse remote files (SFTP)">
          {showFiles ? 'Hide files' : 'Files (SFTP)'}
        </button>
      </div>
      <div className="ssh-body">
        <TerminalTab tab={tab} active={active} onStatus={onStatus} onSession={onSession} />
        {showFiles && tab.sessionId && <SftpPanel sessionId={tab.sessionId} onClose={() => setShowFiles(false)} />}
      </div>
    </div>
  );
}
