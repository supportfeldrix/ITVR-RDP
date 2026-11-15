'use strict';
// Minimal NTLMv2 client (MS-NLMP) used to authenticate to an RD Gateway over HTTP.
// Node's OpenSSL build has no MD4, so a small pure-JS MD4 (RFC 1320) is included.
const crypto = require('crypto');

// ---------------------------------------------------------------- MD4
function md4(input) {
  const msg = Buffer.from(input);
  const bitLen = msg.length * 8;
  const padLen = ((msg.length + 8) >> 6 << 6) + 64;
  const buf = Buffer.alloc(padLen);
  msg.copy(buf);
  buf[msg.length] = 0x80;
  buf.writeUInt32LE(bitLen >>> 0, padLen - 8);
  buf.writeUInt32LE(Math.floor(bitLen / 0x100000000), padLen - 4);

  let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
  const rol = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0;
  const F = (x, y, z) => ((x & y) | (~x & z)) >>> 0;
  const G = (x, y, z) => ((x & y) | (x & z) | (y & z)) >>> 0;
  const H = (x, y, z) => (x ^ y ^ z) >>> 0;

  for (let off = 0; off < padLen; off += 64) {
    const X = new Array(16);
    for (let i = 0; i < 16; i++) X[i] = buf.readUInt32LE(off + i * 4);
    const [aa, bb, cc, dd] = [a, b, c, d];
    const r1 = (p, q, r, s, k, sh) => rol((p + F(q, r, s) + X[k]) >>> 0, sh);
    for (const i of [0, 4, 8, 12]) {
      a = r1(a, b, c, d, i, 3); d = r1(d, a, b, c, i + 1, 7); c = r1(c, d, a, b, i + 2, 11); b = r1(b, c, d, a, i + 3, 19);
    }
    const r2 = (p, q, r, s, k, sh) => rol((p + G(q, r, s) + X[k] + 0x5a827999) >>> 0, sh);
    for (const i of [0, 1, 2, 3]) {
      a = r2(a, b, c, d, i, 3); d = r2(d, a, b, c, i + 4, 5); c = r2(c, d, a, b, i + 8, 9); b = r2(b, c, d, a, i + 12, 13);
    }
    const r3 = (p, q, r, s, k, sh) => rol((p + H(q, r, s) + X[k] + 0x6ed9eba1) >>> 0, sh);
    for (const i of [0, 2, 1, 3]) {
      a = r3(a, b, c, d, i, 3); d = r3(d, a, b, c, i + 8, 9); c = r3(c, d, a, b, i + 4, 11); b = r3(b, c, d, a, i + 12, 15);
    }
    a = (a + aa) >>> 0; b = (b + bb) >>> 0; c = (c + cc) >>> 0; d = (d + dd) >>> 0;
  }
  const out = Buffer.alloc(16);
  out.writeUInt32LE(a, 0); out.writeUInt32LE(b, 4); out.writeUInt32LE(c, 8); out.writeUInt32LE(d, 12);
  return out;
}

const hmacMd5 = (key, data) => crypto.createHmac('md5', key).update(data).digest();
const utf16 = (s) => Buffer.from(s, 'utf16le');

// ---------------------------------------------------------------- NTLM
const SIG = Buffer.from('NTLMSSP\0', 'ascii');
const F_UNICODE = 0x00000001;
const F_REQUEST_TARGET = 0x00000004;
const F_NTLM = 0x00000200;
const F_ALWAYS_SIGN = 0x00008000;
const F_EXTENDED_SESSION = 0x00080000;
const F_TARGET_INFO = 0x00800000;
const F_128 = 0x20000000;
const FLAGS = (F_UNICODE | F_REQUEST_TARGET | F_NTLM | F_ALWAYS_SIGN | F_EXTENDED_SESSION | F_TARGET_INFO | F_128) >>> 0;

function negotiateMessage() {
  const m = Buffer.alloc(32);
  SIG.copy(m, 0);
  m.writeUInt32LE(1, 8);
  m.writeUInt32LE(FLAGS, 12);
  // domain and workstation fields left empty (len 0, offset 32)
  m.writeUInt32LE(32, 20);
  m.writeUInt32LE(32, 28);
  return m;
}

function field(buf, off) {
  const len = buf.readUInt16LE(off);
  const ptr = buf.readUInt32LE(off + 4);
  if (ptr + len > buf.length) throw new Error('Malformed NTLM challenge');
  return buf.subarray(ptr, ptr + len);
}

function parseChallenge(token) {
  if (token.length < 48 || !token.subarray(0, 8).equals(SIG) || token.readUInt32LE(8) !== 2) throw new Error('Not an NTLM challenge');
  const info = field(token, 40);
  let timestamp = null;
  for (let o = 0; o + 4 <= info.length; ) {
    const id = info.readUInt16LE(o);
    const len = info.readUInt16LE(o + 2);
    if (id === 0) break;
    if (id === 7 && len === 8) timestamp = Buffer.from(info.subarray(o + 4, o + 12));
    o += 4 + len;
  }
  return { serverChallenge: Buffer.from(token.subarray(24, 32)), targetInfo: Buffer.from(info), timestamp, flags: token.readUInt32LE(20) };
}

const ntHash = (password) => md4(utf16(password));
const ntowfv2 = (password, user, domain) => hmacMd5(ntHash(password), utf16(user.toUpperCase() + domain));

function filetimeNow() {
  const t = BigInt(Date.now()) * 10000n + 116444736000000000n;
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(t);
  return b;
}

function ntlmv2Response({ password, user, domain, serverChallenge, targetInfo, timestamp, clientChallenge }) {
  const cc = clientChallenge || crypto.randomBytes(8);
  const blob = Buffer.concat([
    Buffer.from([1, 1, 0, 0, 0, 0, 0, 0]),
    timestamp || filetimeNow(),
    cc,
    Buffer.alloc(4),
    targetInfo,
    Buffer.alloc(4),
  ]);
  const proof = hmacMd5(ntowfv2(password, user, domain), Buffer.concat([serverChallenge, blob]));
  return { ntResponse: Buffer.concat([proof, blob]), proof };
}

function authenticateMessage(challengeToken, { username, domain, password, workstation }) {
  const ch = parseChallenge(challengeToken);
  const { ntResponse } = ntlmv2Response({ password, user: username, domain, ...ch });
  const lm = Buffer.alloc(24);
  const parts = [lm, ntResponse, utf16(domain), utf16(username), utf16(workstation || 'ITVR')];
  const base = 64;
  const hdr = Buffer.alloc(base);
  SIG.copy(hdr, 0);
  hdr.writeUInt32LE(3, 8);
  let ptr = base;
  const slots = [12, 20, 28, 36, 44]; // LM, NT, domain, user, workstation
  parts.forEach((p, i) => {
    hdr.writeUInt16LE(p.length, slots[i]);
    hdr.writeUInt16LE(p.length, slots[i] + 2);
    hdr.writeUInt32LE(ptr, slots[i] + 4);
    ptr += p.length;
  });
  // encrypted random session key: empty (no key exchange negotiated)
  hdr.writeUInt32LE(ptr, 56);
  hdr.writeUInt32LE((ch.flags & FLAGS) >>> 0 || FLAGS, 60);
  return Buffer.concat([hdr, ...parts]);
}

module.exports = { md4, ntHash, ntowfv2, ntlmv2Response, negotiateMessage, authenticateMessage, parseChallenge };
