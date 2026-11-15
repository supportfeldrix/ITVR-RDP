'use strict';
const { app, BrowserWindow, ipcMain, dialog, protocol, net: enet } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const store = require('./store');
const rdp = require('./rdp');
const rdpProxy = require('./rdpProxy');
const ssh = require('./ssh');
const sftp = require('./sftp');
const rdmImport = require('./rdmImport');

const isDev = process.argv.includes('--dev');
const DIST = path.join(__dirname, '..', 'dist');
let win;

// app:// serves the built UI. A privileged standard scheme lets the WASM
// module load with fetch(), which file:// does not support reliably.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    title: 'ITVR RDP',
    backgroundColor: '#1b1d22',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    if (!(url.startsWith('app://') || (isDev && url.startsWith('http://localhost:5173')))) e.preventDefault();
  });
  if (isDev) win.loadURL('http://localhost:5173');
  else win.loadURL('app://itvr/index.html');
}

app.whenReady().then(async () => {
  protocol.handle('app', (req) => {
    const rel = decodeURIComponent(new URL(req.url).pathname);
    const file = path.normalize(path.join(DIST, rel));
    if (!file.startsWith(DIST)) return new Response('Forbidden', { status: 403 });
    return enet.fetch(pathToFileURL(file).toString());
  });
  await rdpProxy.start();
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('window-all-closed', () => {
  ssh.closeAll();
  rdpProxy.stop();
  if (process.platform !== 'darwin') app.quit();
});

// ---- IPC: connections ----
ipcMain.handle('conn:list', () => store.list());
ipcMain.handle('conn:save', (_e, input) => store.save(input || {}));
ipcMain.handle('conn:delete', (_e, id) => store.remove(String(id)));
ipcMain.handle('conn:forgetCert', (_e, id) => {
  const s = store.getSecret(String(id));
  if (!s) return;
  store.setKnownHost(`${s.item.type === 'rdp' ? 'rdp:' : ''}${s.item.host}:${s.item.port}`, undefined);
  if (s.gateway) store.setKnownHost(`gw:${s.gateway.host}:${s.gateway.port}`, undefined);
});

// ---- IPC: shared credentials ----
ipcMain.handle('cred:list', () => store.listCredentials());
ipcMain.handle('cred:save', (_e, input) => store.saveCredential(input || {}));
ipcMain.handle('cred:delete', (_e, id) => store.removeCredential(String(id)));

// ---- IPC: import / export ----
ipcMain.handle('conn:export', async () => {
  const { filePath } = await dialog.showSaveDialog(win, {
    defaultPath: 'itvr-connections.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (!filePath) return { ok: false };
  // Secrets (passwords, key passphrases) are never exported.
  fs.writeFileSync(filePath, JSON.stringify(store.exportBundle(), null, 2));
  return { ok: true };
});

ipcMain.handle('conn:import', async () => {
  const { filePaths } = await dialog.showOpenDialog(win, { filters: [{ name: 'ITVR RDP export', extensions: ['json'] }], properties: ['openFile'] });
  if (!filePaths?.[0]) return { ok: false };
  const data = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'));
  // Accept the old v1 format ({items}) and v2 ({items, credentials}).
  const r = store.importBundle({ items: data.items, credentials: data.credentials });
  return { ok: true, ...r };
});

// RDM import is two-step: parse + preview, then commit the parsed bundle held here.
const pendingImports = new Map();
ipcMain.handle('rdm:preview', async () => {
  const { filePaths } = await dialog.showOpenDialog(win, {
    title: 'Import from Remote Desktop Manager',
    filters: [{ name: 'RDM export', extensions: ['rdm', 'xml', 'json', 'csv'] }, { name: 'All files', extensions: ['*'] }],
    properties: ['openFile'],
  });
  if (!filePaths?.[0]) return { ok: false };
  const file = filePaths[0];
  if (fs.statSync(file).size > 100 * 1024 * 1024) throw new Error('File is too large (limit 100 MB).');
  const { bundle, summary } = rdmImport.parse(fs.readFileSync(file, 'utf8'), path.basename(file));
  const token = require('crypto').randomUUID();
  pendingImports.set(token, bundle);
  setTimeout(() => pendingImports.delete(token), 10 * 60 * 1000);
  return { ok: true, token, file: path.basename(file), summary };
});
ipcMain.handle('rdm:commit', (_e, token) => {
  const bundle = pendingImports.get(String(token));
  if (!bundle) throw new Error('Import expired. Please select the file again.');
  pendingImports.delete(String(token));
  return store.importBundle(bundle);
});

ipcMain.handle('dialog:pickKey', async () => {
  const { filePaths } = await dialog.showOpenDialog(win, { properties: ['openFile'] });
  return filePaths?.[0] || null;
});

// ---- IPC: RDP ----
// Embedded session: returns a one-time proxy ticket plus the credentials the
// WASM client needs for CredSSP/NLA. Credentials only live in that tab's memory.
// `override` carries credentials typed in the prompt for entries with no saved password.
ipcMain.handle('rdp:prepare', (_e, id, override) => {
  const s = store.getSecret(String(id));
  if (!s || s.item.type !== 'rdp') throw new Error('Connection not found');
  const password = (override && typeof override.password === 'string' && override.password) || s.password;
  const username = (override && typeof override.username === 'string' && override.username) || s.item.username;

  let gw = null;
  if (s.gateway) {
    gw = { ...s.gateway };
    if (gw.sameAsConnection) { gw.password = password; gw.username = username; }
    if (!gw.password) throw new Error(`No password is saved for the RD Gateway sign-in${gw.credentialName ? ` (credential "${gw.credentialName}")` : ''}. Edit the entry or credential and set one.`);
  }
  const { ticket, proxyAddress, destination } = rdpProxy.issueTicket(s.item.host, s.item.port, gw);
  return { ticket, proxyAddress, destination, username, domain: s.item.domain, password, viaGateway: gw ? gw.host : '' };
});

// Why the last proxy attempt for this ticket failed (gateway sign-in, policy, certificate...).
ipcMain.handle('rdp:error', (_e, ticket) => rdpProxy.takeError(String(ticket)));

// Quick connect: ad-hoc host typed in the status bar (nothing saved).
ipcMain.handle('rdp:prepareQuick', (_e, host, port) => {
  const h = String(host || '').trim().replace(/[\r\n\0\s]/g, '');
  const p = Number(port) || 3389;
  if (!h || h.length > 255 || p < 1 || p > 65535) throw new Error('Invalid host');
  return rdpProxy.issueTicket(h, p);
});

// External client (mstsc / Microsoft Remote Desktop), kept as a fallback.
ipcMain.handle('rdp:launch', (_e, id, override) => {
  const s = store.getSecret(String(id));
  if (!s || s.item.type !== 'rdp') throw new Error('Connection not found');
  return rdp.launch(s.item, (typeof override === 'string' && override) || s.password);
});

// ---- IPC: SSH ----
ipcMain.handle('ssh:open', async (e, { id, cols, rows, password, passphrase, username }) => {
  const s = store.getSecret(String(id));
  if (!s || s.item.type !== 'ssh') throw new Error('Connection not found');
  return ssh.open({
    sender: e.sender,
    item: { ...s.item, username: (typeof username === 'string' && username) || s.item.username },
    password: password || s.password,
    passphrase: passphrase || s.passphrase,
    cols: Math.max(1, cols | 0) || 80,
    rows: Math.max(1, rows | 0) || 24,
  });
});
ipcMain.on('ssh:input', (_e, { sessionId, data }) => ssh.write(String(sessionId), String(data)));
ipcMain.on('ssh:resize', (_e, { sessionId, cols, rows }) => ssh.resize(String(sessionId), cols | 0, rows | 0));
ipcMain.on('ssh:close', (_e, sessionId) => ssh.close(String(sessionId)));

// ---- IPC: SFTP (rides on an open SSH tab) ----
const progress = (e, sessionId) => (file, n) => e.sender.isDestroyed() || e.sender.send('sftp:progress', { sessionId, file, n });
const arr = (v) => (Array.isArray(v) ? v.map(String) : []);

ipcMain.handle('sftp:list', (_e, sessionId, dir) => sftp.list(String(sessionId), dir));
ipcMain.handle('sftp:mkdir', (_e, sessionId, dir, name) => sftp.mkdir(String(sessionId), dir, name));
ipcMain.handle('sftp:rename', (_e, sessionId, dir, from, to) => sftp.rename(String(sessionId), dir, from, to));
ipcMain.handle('sftp:remove', (_e, sessionId, dir, names) => sftp.remove(String(sessionId), dir, arr(names)));

ipcMain.handle('sftp:download', async (e, sessionId, dir, names) => {
  const { filePaths } = await dialog.showOpenDialog(win, { title: 'Download to folder', properties: ['openDirectory', 'createDirectory'] });
  if (!filePaths?.[0]) return { ok: false };
  const n = await sftp.download(String(sessionId), dir, arr(names), filePaths[0], progress(e, sessionId));
  return { ok: true, count: n, folder: filePaths[0] };
});

ipcMain.handle('sftp:upload', async (e, sessionId, dir, kind) => {
  const { filePaths } = await dialog.showOpenDialog(win, {
    title: kind === 'folder' ? 'Upload folder' : 'Upload files',
    properties: kind === 'folder' ? ['openDirectory'] : ['openFile', 'multiSelections'],
  });
  if (!filePaths?.length) return { ok: false };
  const n = await sftp.upload(String(sessionId), dir, filePaths, progress(e, sessionId));
  return { ok: true, count: n };
});

// Drag-and-drop from the OS: the renderer resolves dropped files to absolute paths.
ipcMain.handle('sftp:uploadPaths', async (e, sessionId, dir, paths) => {
  const n = await sftp.upload(String(sessionId), dir, arr(paths), progress(e, sessionId));
  return { ok: true, count: n };
});
