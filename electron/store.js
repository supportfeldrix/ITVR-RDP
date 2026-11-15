'use strict';
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Data lives in the per-user app data folder:
//   connections.json  entries + folders
//   credentials.json  shared credential entries (one AD login reused by many entries)
//   known_hosts.json  pinned SSH host keys / RDP + gateway certificates
// Secrets are encrypted with the OS keystore (DPAPI on Windows, Keychain on macOS).
function file(name) {
  return path.join(app.getPath('userData'), name);
}

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(name, data) {
  const target = file(name);
  const tmp = target + '.tmp';
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, target); // atomic replace
}

function encrypt(text) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS secure storage is not available; refusing to save password.');
  }
  return safeStorage.encryptString(text).toString('base64');
}

function decrypt(b64) {
  if (!b64) return '';
  try {
    return safeStorage.decryptString(Buffer.from(b64, 'base64'));
  } catch {
    return ''; // e.g. data copied from another user/machine; treated as "not saved"
  }
}

const str = (v, max = 512) => (typeof v === 'string' ? v.replace(/[\r\n\0]/g, '').slice(0, max) : '');
const num = (v, def, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : def;
};
const id = (v) => (typeof v === 'string' && /^[\w-]{1,64}$/.test(v) ? v : '');

// Write-only secret fields: undefined keeps the existing value, '' clears, text replaces.
function secretField(input, key, existing, encKey) {
  if (typeof input[key] === 'string') return input[key] ? encrypt(input[key]) : '';
  return existing?.[encKey] || '';
}

// ---------------------------------------------------------------- connections
function sanitize(input, existing) {
  const type = ['folder', 'rdp', 'ssh'].includes(input.type) ? input.type : 'rdp';
  const item = {
    id: existing?.id || crypto.randomUUID(),
    type,
    parentId: input.parentId || null,
    name: str(input.name, 128) || 'Untitled',
    favorite: !!input.favorite,
    tags: Array.isArray(input.tags) ? input.tags.map((t) => str(t, 32)).filter(Boolean).slice(0, 20) : [],
    notes: typeof input.notes === 'string' ? input.notes.slice(0, 4000) : '',
  };
  if (type === 'folder') return item;

  item.host = str(input.host, 255);
  item.port = num(input.port, type === 'ssh' ? 22 : 3389, 1, 65535);
  item.credentialId = id(input.credentialId); // '' = credentials stored on this entry
  item.username = str(input.username, 128);
  item.passwordEnc = secretField(input, 'password', existing, 'passwordEnc');

  if (type === 'rdp') {
    item.domain = str(input.domain, 128);
    item.gateway = str(input.gateway, 255).replace(/\s/g, '');
    item.gatewayPort = num(input.gatewayPort, 443, 1, 65535);
    item.gatewayCredentialId = id(input.gatewayCredentialId); // '' = same as the connection
    item.fullscreen = !!input.fullscreen;
    item.width = num(input.width, 1920, 640, 7680);
    item.height = num(input.height, 1080, 480, 4320);
    item.multimon = !!input.multimon;
    item.redirectClipboard = input.redirectClipboard !== false;
    item.redirectDrives = !!input.redirectDrives;
    item.dynamicResolution = input.dynamicResolution !== false; // follow tab size
    item.smartSizing = !!input.smartSizing; // scale instead of resize
    item.openExternal = !!input.openExternal; // mstsc / MS Remote Desktop instead of embedded tab
  } else {
    item.privateKeyPath = str(input.privateKeyPath, 1024);
    item.keyPassphraseEnc = secretField(input, 'keyPassphrase', existing, 'keyPassphraseEnc');
  }
  return item;
}

function loadAll() {
  const data = readJson('connections.json', { items: [] });
  return Array.isArray(data.items) ? data.items : [];
}
function saveAll(items) {
  writeJson('connections.json', { items });
}

// ---------------------------------------------------------------- credentials
function sanitizeCred(input, existing) {
  return {
    id: existing?.id || crypto.randomUUID(),
    name: str(input.name, 128) || 'Untitled credential',
    username: str(input.username, 128),
    domain: str(input.domain, 128),
    passwordEnc: secretField(input, 'password', existing, 'passwordEnc'),
    privateKeyPath: str(input.privateKeyPath, 1024),
    keyPassphraseEnc: secretField(input, 'keyPassphrase', existing, 'keyPassphraseEnc'),
    notes: typeof input.notes === 'string' ? input.notes.slice(0, 2000) : '',
  };
}
function loadCreds() {
  const data = readJson('credentials.json', { items: [] });
  return Array.isArray(data.items) ? data.items : [];
}
function saveCreds(items) {
  writeJson('credentials.json', { items });
}

function credToPublic(c, usage = 0) {
  const { passwordEnc, keyPassphraseEnc, ...rest } = c;
  return { ...rest, hasPassword: !!passwordEnc, hasPassphrase: !!keyPassphraseEnc, usage };
}

function listCredentials() {
  const items = loadAll();
  return loadCreds().map((c) => credToPublic(c, items.filter((i) => i.credentialId === c.id || i.gatewayCredentialId === c.id).length));
}

function saveCredential(input) {
  const creds = loadCreds();
  const idx = creds.findIndex((c) => c.id === input.id);
  const cred = sanitizeCred(input, idx >= 0 ? creds[idx] : null);
  if (idx >= 0) creds[idx] = cred;
  else creds.push(cred);
  saveCreds(creds);
  return credToPublic(cred);
}

// Entries that used the credential fall back to prompting.
function removeCredential(credId) {
  saveCreds(loadCreds().filter((c) => c.id !== credId));
  saveAll(loadAll().map((i) => ({
    ...i,
    credentialId: i.credentialId === credId ? '' : i.credentialId,
    gatewayCredentialId: i.gatewayCredentialId === credId ? '' : i.gatewayCredentialId,
  })));
}

// ---------------------------------------------------------------- resolution
function effective(item, creds) {
  const cred = item.credentialId ? creds.find((c) => c.id === item.credentialId) : null;
  if (!cred) return { cred: null, username: item.username, domain: item.domain || '', passwordEnc: item.passwordEnc, privateKeyPath: item.privateKeyPath, keyPassphraseEnc: item.keyPassphraseEnc };
  return { cred, username: cred.username, domain: cred.domain, passwordEnc: cred.passwordEnc, privateKeyPath: cred.privateKeyPath || item.privateKeyPath, keyPassphraseEnc: cred.keyPassphraseEnc || item.keyPassphraseEnc };
}

// Never send secrets to the renderer; only flags saying they exist.
function toPublic(item, creds) {
  const { passwordEnc, keyPassphraseEnc, ...rest } = item;
  if (item.type === 'folder') return rest;
  const eff = effective(item, creds);
  const gwCred = item.gatewayCredentialId ? creds.find((c) => c.id === item.gatewayCredentialId) : null;
  return {
    ...rest,
    hasPassword: !!eff.passwordEnc,
    hasPassphrase: !!eff.keyPassphraseEnc,
    effectiveUsername: eff.username,
    effectiveDomain: eff.domain,
    effectiveKeyPath: eff.privateKeyPath || '',
    credentialName: eff.cred ? eff.cred.name : '',
    gatewayCredentialName: gwCred ? gwCred.name : '',
  };
}

function list() {
  const creds = loadCreds();
  return loadAll().map((i) => toPublic(i, creds));
}

// Main-process only: resolved connection details including decrypted secrets.
function getSecret(connId) {
  const raw = loadAll().find((i) => i.id === connId);
  if (!raw) return null;
  const creds = loadCreds();
  const eff = effective(raw, creds);
  const item = { ...raw, username: eff.username, domain: eff.domain, privateKeyPath: eff.privateKeyPath };
  let gateway = null;
  if (raw.type === 'rdp' && raw.gateway) {
    const gc = raw.gatewayCredentialId ? creds.find((c) => c.id === raw.gatewayCredentialId) : null;
    gateway = gc
      ? { host: raw.gateway, port: raw.gatewayPort || 443, username: gc.username, domain: gc.domain, password: decrypt(gc.passwordEnc), credentialName: gc.name }
      : { host: raw.gateway, port: raw.gatewayPort || 443, username: eff.username, domain: eff.domain, password: decrypt(eff.passwordEnc), sameAsConnection: true };
  }
  return { item, password: decrypt(eff.passwordEnc), passphrase: decrypt(eff.keyPassphraseEnc), gateway };
}

function save(input) {
  const items = loadAll();
  const idx = items.findIndex((i) => i.id === input.id);
  const existing = idx >= 0 ? items[idx] : null;
  const item = sanitize(input, existing);
  if (item.parentId && !items.some((i) => i.id === item.parentId && i.type === 'folder')) item.parentId = null;
  if (item.parentId === item.id) item.parentId = null;
  if (idx >= 0) items[idx] = item;
  else items.push(item);
  saveAll(items);
  return toPublic(item, loadCreds());
}

function remove(connId) {
  const items = loadAll();
  const doomed = new Set([connId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const i of items) {
      if (i.parentId && doomed.has(i.parentId) && !doomed.has(i.id)) {
        doomed.add(i.id);
        grew = true;
      }
    }
  }
  saveAll(items.filter((i) => !doomed.has(i.id)));
}

// ---------------------------------------------------------------- import/export
// Bundle: { items: [...], credentials: [...] } with source ids; secrets are never
// imported. Ids are remapped so imports never collide with existing data.
function importBundle({ items: rawItems = [], credentials: rawCreds = [] }) {
  const items = loadAll();
  const creds = loadCreds();
  const idMap = new Map();
  const credMap = new Map();
  for (const c of rawCreds) credMap.set(c.id, crypto.randomUUID());
  for (const r of rawItems) idMap.set(r.id, crypto.randomUUID());

  for (const c of rawCreds) {
    creds.push(sanitizeCred({ ...c, password: undefined, keyPassphrase: undefined }, { id: credMap.get(c.id) }));
  }
  for (const r of rawItems) {
    const clean = sanitize({ ...r, password: undefined, keyPassphrase: undefined }, { id: idMap.get(r.id) });
    clean.parentId = r.parentId && idMap.has(r.parentId) ? idMap.get(r.parentId) : null;
    if (clean.type !== 'folder') {
      clean.credentialId = credMap.get(r.credentialId) || '';
      if (clean.type === 'rdp') clean.gatewayCredentialId = credMap.get(r.gatewayCredentialId) || '';
    }
    items.push(clean);
  }
  saveCreds(creds);
  saveAll(items);
  return { entries: rawItems.filter((r) => r.type !== 'folder').length, folders: rawItems.filter((r) => r.type === 'folder').length, credentials: rawCreds.length };
}

function exportBundle() {
  const strip = ({ passwordEnc, keyPassphraseEnc, ...rest }) => rest;
  return { format: 'itvr-rdp', version: 2, items: loadAll().map(strip), credentials: loadCreds().map(strip) };
}

// Pinned SSH host keys / certificates (trust on first use).
function getKnownHost(key) {
  return readJson('known_hosts.json', {})[key] || null;
}
function setKnownHost(key, fingerprint) {
  const all = readJson('known_hosts.json', {});
  if (fingerprint) all[key] = fingerprint;
  else delete all[key];
  writeJson('known_hosts.json', all);
}

module.exports = {
  list, save, remove, getSecret, importBundle, exportBundle,
  listCredentials, saveCredential, removeCredential,
  getKnownHost, setKnownHost,
};
