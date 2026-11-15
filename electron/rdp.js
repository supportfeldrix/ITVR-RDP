'use strict';
const { app, shell } = require('electron');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const clean = (v) => String(v ?? '').replace(/[\r\n\0]/g, '');

function buildRdp(item) {
  const lines = [
    `full address:s:${clean(item.host)}:${Number(item.port) || 3389}`,
    `username:s:${clean(item.domain ? `${item.domain}\\${item.username}` : item.username)}`,
    `screen mode id:i:${item.fullscreen ? 2 : 1}`,
    `desktopwidth:i:${Number(item.width) || 1920}`,
    `desktopheight:i:${Number(item.height) || 1080}`,
    `use multimon:i:${item.multimon ? 1 : 0}`,
    `redirectclipboard:i:${item.redirectClipboard === false ? 0 : 1}`,
    `drivestoredirect:s:${item.redirectDrives ? '*' : ''}`,
    'prompt for credentials:i:0',
    'authentication level:i:2',
    'enablecredsspsupport:i:1',
    'smart sizing:i:1',
  ];
  if (item.gateway) {
    const gwPort = Number(item.gatewayPort) || 443;
    lines.push(`gatewayhostname:s:${clean(item.gateway)}${gwPort === 443 ? '' : `:${gwPort}`}`, 'gatewayusagemethod:i:1');
  }
  return lines.join('\r\n') + '\r\n';
}

function launch(item, password) {
  const dir = path.join(app.getPath('temp'), 'itvr-rdp');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const rdpFile = path.join(dir, `${crypto.randomUUID()}.rdp`);
  fs.writeFileSync(rdpFile, buildRdp(item), { mode: 0o600 });
  // Remove the temp file shortly after the client has read it.
  setTimeout(() => fs.rm(rdpFile, { force: true }, () => {}), 30000);

  if (process.platform === 'win32') {
    if (password) {
      // Saved to Windows Credential Manager so mstsc can sign in without a prompt.
      // spawnSync with an args array avoids shell injection; the password is
      // briefly visible in this process's command line.
      const user = item.domain ? `${item.domain}\\${item.username}` : item.username;
      spawnSync('cmdkey', [`/generic:TERMSRV/${item.host}`, `/user:${user}`, `/pass:${password}`], { windowsHide: true });
    }
    spawn('mstsc.exe', [rdpFile], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true, client: 'mstsc' };
  }

  if (process.platform === 'darwin') {
    // Opens in Microsoft Remote Desktop (or the default .rdp handler).
    // macOS clients do not accept a password through the .rdp file.
    spawn('open', [rdpFile], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true, client: 'Microsoft Remote Desktop', note: password ? 'Enter the password in the client.' : undefined };
  }

  const args = [`/v:${item.host}:${item.port}`, `/u:${item.username}`, '/cert:ignore', '+clipboard', '/dynamic-resolution'];
  if (item.domain) args.push(`/d:${item.domain}`);
  if (password) args.push(`/p:${password}`);
  spawn('xfreerdp', args, { detached: true, stdio: 'ignore' }).unref();
  return { ok: true, client: 'xfreerdp' };
}

module.exports = { launch, buildRdp, shell };
