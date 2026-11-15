// Tests electron/sftp.js against an in-process ssh2 SFTP server backed by a temp folder.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { Server, Client, utils } = require('ssh2');
const { STATUS_CODE, OPEN_MODE } = utils.sftp;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'itvr-sftp-'));
const root = path.join(tmp, 'remote');
const localSrc = path.join(tmp, 'local-src');
const localDst = path.join(tmp, 'local-dst');
[root, localSrc, localDst].forEach((d) => fs.mkdirSync(d, { recursive: true }));

let theClient;
const sessionObj = { get client() { return theClient; }, sftp: null };
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === './ssh') return { get: (id) => (id === 'S1' ? sessionObj : null) };
  return origLoad.call(this, req, ...rest);
};
const sftp = require('../electron/sftp');

// ---------------------------------------------------------------- fake server
const real = (v) => {
  const p = path.join(root, path.posix.normalize(`/${v}`));
  if (!p.startsWith(root)) throw new Error('escape');
  return p;
};
const virt = (p) => `/${path.relative(root, p).split(path.sep).join('/')}`.replace(/\/$/, '') || '/';
const attrsOf = (st) => ({ mode: st.mode, uid: 0, gid: 0, size: st.size, atime: Math.floor(st.atimeMs / 1000), mtime: Math.floor(st.mtimeMs / 1000) });
const fail = (s, id, e) => s.status(id, e && e.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE);

function onSftp(s) {
  const handles = new Map();
  let n = 0;
  const newHandle = (o) => { const b = Buffer.alloc(4); b.writeUInt32BE(++n); handles.set(b.toString('hex'), o); return b; };
  const get = (b) => handles.get(b.toString('hex'));

  s.on('REALPATH', (id, p) => { const v = virt(real(p === '.' ? '/' : p)); s.name(id, [{ filename: v, longname: v, attrs: {} }]); });
  s.on('STAT', (id, p) => { try { s.attrs(id, attrsOf(fs.statSync(real(p)))); } catch (e) { fail(s, id, e); } });
  s.on('LSTAT', (id, p) => { try { s.attrs(id, attrsOf(fs.lstatSync(real(p)))); } catch (e) { fail(s, id, e); } });
  s.on('FSTAT', (id, h) => { const o = get(h); try { s.attrs(id, attrsOf(fs.fstatSync(o.fd))); } catch (e) { fail(s, id, e); } });
  s.on('OPENDIR', (id, p) => { try { fs.readdirSync(real(p)); s.handle(id, newHandle({ dir: real(p), sent: false })); } catch (e) { fail(s, id, e); } });
  s.on('READDIR', (id, h) => {
    const o = get(h);
    if (o.sent) return s.status(id, STATUS_CODE.EOF);
    o.sent = true;
    const list = fs.readdirSync(o.dir).map((f) => ({ filename: f, longname: f, attrs: attrsOf(fs.statSync(path.join(o.dir, f))) }));
    list.length ? s.name(id, list) : s.status(id, STATUS_CODE.EOF);
  });
  s.on('OPEN', (id, p, flags) => {
    try {
      const f = flags & OPEN_MODE.WRITE ? (flags & OPEN_MODE.TRUNC ? 'w' : 'r+') : 'r';
      const fd = fs.openSync(real(p), flags & OPEN_MODE.CREAT && !fs.existsSync(real(p)) ? 'w' : f);
      s.handle(id, newHandle({ fd }));
    } catch (e) { fail(s, id, e); }
  });
  s.on('READ', (id, h, off, len) => {
    const o = get(h);
    const buf = Buffer.alloc(len);
    const r = fs.readSync(o.fd, buf, 0, len, off);
    r === 0 ? s.status(id, STATUS_CODE.EOF) : s.data(id, buf.subarray(0, r));
  });
  s.on('WRITE', (id, h, off, data) => { fs.writeSync(get(h).fd, data, 0, data.length, off); s.status(id, STATUS_CODE.OK); });
  s.on('CLOSE', (id, h) => { const o = get(h); if (o?.fd !== undefined) fs.closeSync(o.fd); handles.delete(h.toString('hex')); s.status(id, STATUS_CODE.OK); });
  s.on('MKDIR', (id, p) => { try { fs.mkdirSync(real(p)); s.status(id, STATUS_CODE.OK); } catch (e) { fail(s, id, e); } });
  s.on('RMDIR', (id, p) => { try { fs.rmdirSync(real(p)); s.status(id, STATUS_CODE.OK); } catch (e) { fail(s, id, e); } });
  s.on('REMOVE', (id, p) => { try { fs.unlinkSync(real(p)); s.status(id, STATUS_CODE.OK); } catch (e) { fail(s, id, e); } });
  s.on('RENAME', (id, a, b) => { try { fs.renameSync(real(a), real(b)); s.status(id, STATUS_CODE.OK); } catch (e) { fail(s, id, e); } });
  s.on('SETSTAT', (id) => s.status(id, STATUS_CODE.OK));
  s.on('FSETSTAT', (id) => s.status(id, STATUS_CODE.OK));
}

const hostKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
const server = new Server({ hostKeys: [hostKey] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (accept) => accept().on('sftp', (acc) => onSftp(acc()))));
  c.on('error', () => {});
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  theClient = new Client();
  await new Promise((res, rej) => theClient.on('ready', res).on('error', rej).connect({ host: '127.0.0.1', port: server.address().port, username: 'u', password: 'p' }));

  fs.writeFileSync(path.join(root, 'a.txt'), 'hello');
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'sub', 'b.txt'), 'bee');

  // browse
  let r = await sftp.list('S1', '.');
  assert.strictEqual(r.path, '/');
  assert.deepStrictEqual(r.entries.map((e) => [e.name, e.isDir]).sort(), [['a.txt', false], ['sub', true]]);
  assert.strictEqual(r.entries.find((e) => e.name === 'a.txt').size, 5);
  r = await sftp.list('S1', '/sub');
  assert.strictEqual(r.path, '/sub');
  assert.deepStrictEqual(r.entries.map((e) => e.name), ['b.txt']);
  await assert.rejects(sftp.list('NOPE', '.'), /not connected/);

  // mkdir + rename
  await sftp.mkdir('S1', '/', 'newdir');
  assert.ok(fs.statSync(path.join(root, 'newdir')).isDirectory());
  await sftp.rename('S1', '/', 'newdir', 'renamed');
  assert.ok(fs.existsSync(path.join(root, 'renamed')));
  assert.ok(!fs.existsSync(path.join(root, 'newdir')));

  // upload a nested tree, including a file larger than one SFTP packet
  fs.mkdirSync(path.join(localSrc, 'proj', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(localSrc, 'proj', 'one.txt'), 'one');
  fs.writeFileSync(path.join(localSrc, 'proj', 'deep', 'big.bin'), crypto.randomBytes(300000));
  fs.writeFileSync(path.join(localSrc, 'solo.txt'), 'solo');
  const seen = [];
  const count = await sftp.upload('S1', '/renamed', [path.join(localSrc, 'proj'), path.join(localSrc, 'solo.txt')], (f) => seen.push(f));
  assert.strictEqual(count, 3);
  assert.ok(seen.includes('big.bin'));
  assert.ok(fs.readFileSync(path.join(root, 'renamed', 'proj', 'deep', 'big.bin')).equals(fs.readFileSync(path.join(localSrc, 'proj', 'deep', 'big.bin'))));
  assert.strictEqual(fs.readFileSync(path.join(root, 'renamed', 'solo.txt'), 'utf8'), 'solo');
  // uploading again into existing folders is fine (overwrite)
  await sftp.upload('S1', '/renamed', [path.join(localSrc, 'proj')]);
  await assert.rejects(sftp.upload('S1', '/', ['relative/path']), /Invalid local path/);

  // download a folder and a file
  const dl = await sftp.download('S1', '/renamed', ['proj', 'solo.txt'], localDst);
  assert.strictEqual(dl, 3);
  assert.ok(fs.readFileSync(path.join(localDst, 'proj', 'deep', 'big.bin')).equals(fs.readFileSync(path.join(localSrc, 'proj', 'deep', 'big.bin'))));
  assert.strictEqual(fs.readFileSync(path.join(localDst, 'solo.txt'), 'utf8'), 'solo');

  // names that try to escape are rejected
  for (const bad of ['../x', 'a/b', '..', '.', '']) {
    await assert.rejects(sftp.mkdir('S1', '/', bad), /Invalid file name/);
    await assert.rejects(sftp.remove('S1', '/', [bad]), /Invalid file name/);
  }
  await assert.rejects(sftp.rename('S1', '/', 'a.txt', '../evil'), /Invalid file name/);

  // recursive delete
  await sftp.remove('S1', '/', ['renamed', 'a.txt']);
  assert.ok(!fs.existsSync(path.join(root, 'renamed')));
  assert.ok(!fs.existsSync(path.join(root, 'a.txt')));
  assert.ok(fs.existsSync(path.join(root, 'sub', 'b.txt')), 'unrelated data untouched');

  console.log('SFTP tests passed');
})().then(() => cleanup(0)).catch((e) => { console.error('SFTP TEST FAIL', e); cleanup(1); });

function cleanup(code) {
  try { theClient?.end(); server.close(); } catch { /* ignore */ }
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(code);
}
