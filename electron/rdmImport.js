'use strict';
// Import from Devolutions Remote Desktop Manager exports.
// Supported: XML (.rdm / .xml; <ArrayOfConnection> or <RDMExport><Connections>), JSON, CSV.
// Imported: folders (Group paths), RDP and SSH entries, host, port, user, domain, notes,
// RD Gateway host, and linked Credential entries (name/user/domain).
// NOT imported: passwords. RDM encrypts them with its own keys, so credentials come in
// without a password and ITVR RDP prompts on first use (or you set it once on the
// shared credential).
const { XMLParser } = require('fast-xml-parser');

const MAX_ENTRIES = 20000;
const RDP_TYPES = new Set(['rdpconfigured', 'rdp', 'rdpgateway', 'remotedesktop', 'rdsgateway']);
const SSH_TYPES = new Set(['sshshell', 'ssh', 'sshgateway', 'sshtunnel']);
const GROUP_TYPES = new Set(['group', 'folder']);
const CRED_TYPES = new Set(['credential', 'credentialentry']);

const asStr = (v) => (v === undefined || v === null || typeof v === 'object' ? '' : String(v).trim());

// Depth-first search for the first non-empty scalar under a key matching `re`.
function find(node, re, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return '';
  for (const [k, v] of Object.entries(node)) {
    if (re.test(k)) {
      const s = asStr(v);
      if (s) return s;
    }
  }
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') {
      const r = find(Array.isArray(v) ? v[0] : v, re, depth + 1);
      if (r) return r;
    }
  }
  return '';
}

function splitHost(raw) {
  let h = asStr(raw).replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/.*$/, '');
  let port = 0;
  const m = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(h);
  if (m) { h = m[1]; port = Number(m[2]); }
  return { host: h.replace(/[\r\n\0\s]/g, ''), port };
}

function normalizeConnection(c) {
  const type = asStr(c.ConnectionType || c.Type || c.type).toLowerCase().replace(/[\s_-]/g, '');
  const { host, port: urlPort } = splitHost(c.Url || c.Host || c.HostName || c.Computer || c.Hostname || find(c, /^(url|host|hostname|computer)$/i));
  const port = Number(find(c, /^(port|hostport|rdpport|sshport)$/i)) || urlPort || 0;
  return {
    id: asStr(c.ID || c.Id || c.id),
    type,
    name: asStr(c.Name || c.name) || host || 'Untitled',
    group: asStr(c.Group || c.group || c.Folder),
    host,
    port,
    username: asStr(c.UserName || c.Username || c.User) || find(c.Credentials || c, /^user(name)?$/i),
    domain: asStr(c.Domain) || find(c.Credentials || c, /^domain$/i),
    credentialRef: asStr(c.CredentialConnectionID || c.CredentialId),
    description: asStr(c.Description || c.description),
    gateway: find(c, /^(rdp)?gateway(host)?name$/i),
    favorite: /^(true|1)$/i.test(asStr(c.Favorite)),
  };
}

// ------------------------------------------------------------------ readers
function readXml(text) {
  const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: true,
    isArray: (name) => name === 'Connection',
    processEntities: true,
    maxNestedTags: 64,
  });
  const doc = parser.parse(text);
  const list = doc?.ArrayOfConnection?.Connection || doc?.RDMExport?.Connections?.Connection || doc?.Connections?.Connection || [];
  return list;
}

function readJson(text) {
  const doc = JSON.parse(text);
  if (Array.isArray(doc)) return doc;
  return doc.Connections || doc.connections || doc.Items || [];
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',' || ch === ';' || ch === '\t') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function readCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const head = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const col = (...names) => head.findIndex((h) => names.includes(h));
  const ix = { name: col('name', 'session', 'entry'), group: col('group', 'folder', 'path'), host: col('host', 'url', 'computer', 'hostname', 'server', 'address'), type: col('connectiontype', 'type', 'protocol', 'kind'), user: col('username', 'user', 'login'), domain: col('domain'), port: col('port'), desc: col('description', 'notes', 'comment') };
  if (ix.host < 0) throw new Error('CSV needs a Host (or Url / Computer) column.');
  return lines.slice(1).map((l) => {
    const r = parseCsvLine(l);
    const g = (i) => (i >= 0 ? (r[i] || '').trim() : '');
    const t = g(ix.type).toLowerCase();
    return { ConnectionType: t.includes('ssh') ? 'SSHShell' : 'RDPConfigured', Name: g(ix.name), Group: g(ix.group), Url: g(ix.host), UserName: g(ix.user), Domain: g(ix.domain), Port: g(ix.port), Description: g(ix.desc) };
  });
}

function readAny(text, filename = '') {
  const t = text.replace(/^\uFEFF/, '').trimStart();
  if (t.startsWith('<')) return readXml(t);
  if (t.startsWith('{') || t.startsWith('[')) return readJson(t);
  if (/\.csv$/i.test(filename) || t.includes(',') || t.includes(';')) return readCsv(t);
  throw new Error('Unrecognized file. Export from RDM as XML (.rdm / .xml), JSON or CSV.');
}

// ------------------------------------------------------------------ convert
/**
 * @returns {{ bundle: {items: object[], credentials: object[]}, summary: object }}
 */
function parse(text, filename, { wrapFolder = true } = {}) {
  const raw = readAny(text, filename);
  if (raw.length > MAX_ENTRIES) throw new Error(`File has ${raw.length} entries; the limit is ${MAX_ENTRIES}.`);

  const items = [];
  const credentials = [];
  const credIdBySource = new Map();
  const skipped = {};
  const folderByPath = new Map();
  let seq = 0;
  const nextId = (p) => `${p}${++seq}`;

  const root = wrapFolder
    ? { id: nextId('f'), type: 'folder', parentId: null, name: `RDM import ${new Date().toISOString().slice(0, 10)}` }
    : null;
  if (root) items.push(root);

  const folderFor = (groupPath) => {
    const parts = groupPath.split(/[\\/]/).map((s) => s.trim()).filter(Boolean);
    let parent = root ? root.id : null;
    let acc = '';
    for (const part of parts) {
      acc = `${acc}\\${part}`;
      if (!folderByPath.has(acc)) {
        const f = { id: nextId('f'), type: 'folder', parentId: parent, name: part };
        folderByPath.set(acc, f.id);
        items.push(f);
      }
      parent = folderByPath.get(acc);
    }
    return parent;
  };

  const conns = raw.map(normalizeConnection);

  // pass 1: credential entries
  for (const c of conns) {
    if (!CRED_TYPES.has(c.type)) continue;
    const id = nextId('c');
    credentials.push({ id, name: c.name, username: c.username, domain: c.domain, notes: c.description });
    if (c.id) credIdBySource.set(c.id, id);
  }

  // pass 2: folders, then sessions
  for (const c of conns) {
    if (GROUP_TYPES.has(c.type)) folderFor(c.group ? `${c.group}\\${c.name}` : c.name);
  }
  let rdp = 0, ssh = 0, folders = 0;
  for (const c of conns) {
    if (GROUP_TYPES.has(c.type) || CRED_TYPES.has(c.type)) continue;
    const kind = RDP_TYPES.has(c.type) ? 'rdp' : SSH_TYPES.has(c.type) ? 'ssh' : null;
    if (!kind) {
      const label = c.type || 'unknown';
      skipped[label] = (skipped[label] || 0) + 1;
      continue;
    }
    if (!c.host) { skipped['no host'] = (skipped['no host'] || 0) + 1; continue; }
    const entry = {
      id: nextId('e'),
      type: kind,
      parentId: folderFor(c.group),
      name: c.name,
      host: c.host,
      port: c.port || (kind === 'ssh' ? 22 : 3389),
      username: c.username,
      domain: kind === 'rdp' ? c.domain : '',
      notes: c.description,
      favorite: c.favorite,
      credentialId: c.credentialRef && credIdBySource.get(c.credentialRef) ? credIdBySource.get(c.credentialRef) : '',
    };
    if (kind === 'rdp' && c.gateway) { entry.gateway = splitHost(c.gateway).host; entry.gatewayPort = splitHost(c.gateway).port || 443; }
    items.push(entry);
    if (kind === 'rdp') rdp++; else ssh++;
  }
  folders = items.filter((i) => i.type === 'folder').length - (root ? 1 : 0);

  return {
    bundle: { items, credentials },
    summary: { total: raw.length, rdp, ssh, folders, credentials: credentials.length, skipped, passwordsNote: 'Passwords are not imported (RDM encrypts them with its own keys).' },
  };
}

module.exports = { parse };
