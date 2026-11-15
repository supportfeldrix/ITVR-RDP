'use strict';
// SFTP over an existing SSH tab connection (no second login).
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const posix = path.posix;
const ssh = require('./ssh');

const MAX_DEPTH = 32;

function sftpFor(sessionId) {
  const s = ssh.get(String(sessionId));
  if (!s) return Promise.reject(new Error('The SSH session is not connected.'));
  if (s.sftp) return s.sftp;
  s.sftp = new Promise((resolve, reject) => {
    s.client.sftp((err, sftp) => {
      if (err) { s.sftp = null; return reject(new Error(`SFTP is not available on this server (${err.message})`)); }
      sftp.on('close', () => { s.sftp = null; });
      resolve(sftp);
    });
  });
  return s.sftp;
}

const call = (fn) => new Promise((resolve, reject) => fn((err, res) => (err ? reject(new Error(err.message || String(err))) : resolve(res))));
const remoteName = (n) => {
  if (typeof n !== 'string' || !n || n.includes('/') || n.includes('\0') || n === '.' || n === '..') throw new Error('Invalid file name');
  return n;
};
const rpath = (p) => {
  if (typeof p !== 'string' || !p || p.includes('\0')) throw new Error('Invalid path');
  return p;
};
const isDirMode = (mode) => (mode & 0o170000) === 0o040000;

async function list(sessionId, dir) {
  const sftp = await sftpFor(sessionId);
  const real = await call((cb) => sftp.realpath(rpath(dir || '.'), cb));
  const rows = await call((cb) => sftp.readdir(real, cb));
  const entries = rows
    .filter((r) => r.filename !== '.' && r.filename !== '..')
    .map((r) => ({
      name: r.filename,
      size: r.attrs.size,
      mtime: r.attrs.mtime * 1000,
      mode: r.attrs.mode,
      isDir: isDirMode(r.attrs.mode),
      isLink: (r.attrs.mode & 0o170000) === 0o120000,
    }));
  return { path: real, entries };
}

async function mkdir(sessionId, dir, name) {
  const sftp = await sftpFor(sessionId);
  await call((cb) => sftp.mkdir(posix.join(rpath(dir), remoteName(name)), cb));
}

async function rename(sessionId, dir, from, to) {
  const sftp = await sftpFor(sessionId);
  await call((cb) => sftp.rename(posix.join(rpath(dir), remoteName(from)), posix.join(rpath(dir), remoteName(to)), cb));
}

async function removeRecursive(sftp, p, depth = 0) {
  if (depth > MAX_DEPTH) throw new Error('Folder is nested too deeply');
  const st = await call((cb) => sftp.lstat(p, cb));
  if (!isDirMode(st.mode)) return call((cb) => sftp.unlink(p, cb));
  const rows = await call((cb) => sftp.readdir(p, cb));
  for (const r of rows) if (r.filename !== '.' && r.filename !== '..') await removeRecursive(sftp, posix.join(p, r.filename), depth + 1);
  return call((cb) => sftp.rmdir(p, cb));
}

async function remove(sessionId, dir, names) {
  const sftp = await sftpFor(sessionId);
  for (const n of names) await removeRecursive(sftp, posix.join(rpath(dir), remoteName(n)));
}

async function downloadTree(sftp, remote, local, onFile, depth = 0) {
  if (depth > MAX_DEPTH) throw new Error('Folder is nested too deeply');
  const st = await call((cb) => sftp.stat(remote, cb));
  if (isDirMode(st.mode)) {
    await fsp.mkdir(local, { recursive: true });
    const rows = await call((cb) => sftp.readdir(remote, cb));
    for (const r of rows) {
      if (r.filename === '.' || r.filename === '..') continue;
      // Never let a hostile server name escape the destination folder.
      const safe = path.basename(r.filename);
      if (safe !== r.filename || safe === '' ) continue;
      await downloadTree(sftp, posix.join(remote, r.filename), path.join(local, safe), onFile, depth + 1);
    }
  } else {
    onFile(posix.basename(remote));
    await call((cb) => sftp.fastGet(remote, local, {}, cb));
  }
}

/** Download files/folders from `dir` into a local folder chosen by the caller. */
async function download(sessionId, dir, names, localDir, onFile) {
  const sftp = await sftpFor(sessionId);
  let count = 0;
  for (const n of names) {
    const safe = path.basename(remoteName(n));
    await downloadTree(sftp, posix.join(rpath(dir), n), path.join(localDir, safe), (f) => { count++; onFile?.(f, count); });
  }
  return count;
}

async function uploadTree(sftp, local, remote, onFile, depth = 0) {
  if (depth > MAX_DEPTH) throw new Error('Folder is nested too deeply');
  const st = await fsp.stat(local);
  if (st.isDirectory()) {
    try {
      await call((cb) => sftp.mkdir(remote, cb));
    } catch (mkErr) {
      // Fine if the folder already exists; otherwise report the original error.
      const existing = await call((cb) => sftp.stat(remote, cb)).catch(() => null);
      if (!existing || !isDirMode(existing.mode)) throw mkErr;
    }
    for (const child of await fsp.readdir(local)) await uploadTree(sftp, path.join(local, child), posix.join(remote, child), onFile, depth + 1);
  } else if (st.isFile()) {
    onFile(path.basename(local));
    await call((cb) => sftp.fastPut(local, remote, {}, cb));
  }
}

async function upload(sessionId, dir, localPaths, onFile) {
  const sftp = await sftpFor(sessionId);
  let count = 0;
  for (const lp of localPaths) {
    if (typeof lp !== 'string' || !path.isAbsolute(lp)) throw new Error('Invalid local path');
    await uploadTree(sftp, lp, posix.join(rpath(dir), path.basename(lp)), (f) => { count++; onFile?.(f, count); });
  }
  return count;
}

module.exports = { list, mkdir, rename, remove, download, upload };
