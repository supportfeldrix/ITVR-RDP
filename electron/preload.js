'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel) => (cb) => {
  const h = (_e, p) => cb(p);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,

  // entries
  list: () => ipcRenderer.invoke('conn:list'),
  save: (c) => ipcRenderer.invoke('conn:save', c),
  remove: (id) => ipcRenderer.invoke('conn:delete', id),
  forgetCert: (id) => ipcRenderer.invoke('conn:forgetCert', id),
  exportAll: () => ipcRenderer.invoke('conn:export'),
  importAll: () => ipcRenderer.invoke('conn:import'),
  pickKey: () => ipcRenderer.invoke('dialog:pickKey'),

  // shared credentials
  credList: () => ipcRenderer.invoke('cred:list'),
  credSave: (c) => ipcRenderer.invoke('cred:save', c),
  credDelete: (id) => ipcRenderer.invoke('cred:delete', id),

  // RDM import
  rdmPreview: () => ipcRenderer.invoke('rdm:preview'),
  rdmCommit: (token) => ipcRenderer.invoke('rdm:commit', token),

  // RDP
  rdpPrepare: (id, override) => ipcRenderer.invoke('rdp:prepare', id, override),
  rdpPrepareQuick: (host, port) => ipcRenderer.invoke('rdp:prepareQuick', host, port),
  rdpError: (ticket) => ipcRenderer.invoke('rdp:error', ticket),
  rdpLaunch: (id, password) => ipcRenderer.invoke('rdp:launch', id, password),

  // SSH
  sshOpen: (opts) => ipcRenderer.invoke('ssh:open', opts),
  sshInput: (sessionId, data) => ipcRenderer.send('ssh:input', { sessionId, data }),
  sshResize: (sessionId, cols, rows) => ipcRenderer.send('ssh:resize', { sessionId, cols, rows }),
  sshClose: (sessionId) => ipcRenderer.send('ssh:close', sessionId),
  onSshData: on('ssh:data'),
  onSshClosed: on('ssh:closed'),

  // SFTP
  sftpList: (sid, dir) => ipcRenderer.invoke('sftp:list', sid, dir),
  sftpMkdir: (sid, dir, name) => ipcRenderer.invoke('sftp:mkdir', sid, dir, name),
  sftpRename: (sid, dir, from, to) => ipcRenderer.invoke('sftp:rename', sid, dir, from, to),
  sftpRemove: (sid, dir, names) => ipcRenderer.invoke('sftp:remove', sid, dir, names),
  sftpDownload: (sid, dir, names) => ipcRenderer.invoke('sftp:download', sid, dir, names),
  sftpUpload: (sid, dir, kind) => ipcRenderer.invoke('sftp:upload', sid, dir, kind),
  sftpUploadPaths: (sid, dir, paths) => ipcRenderer.invoke('sftp:uploadPaths', sid, dir, paths),
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
  onSftpProgress: on('sftp:progress'),
});
