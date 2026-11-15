'use strict';
// RD Gateway client ([MS-TSGU] over the HTTPS WebSocket transport).
//
//   TLS -> HTTP "RDG_OUT_DATA" with Upgrade: websocket + NTLM sign-in -> 101
//       -> RDG packets inside binary WebSocket frames:
//          HANDSHAKE -> TUNNEL_CREATE -> TUNNEL_AUTH -> CHANNEL_CREATE -> DATA...
//
// connect() resolves to a Duplex stream that behaves like a TCP socket to the
// target RDP server, so the rest of the app (X.224, TLS, CredSSP) is unchanged.
// Packet layouts follow [MS-TSGU] and the FreeRDP implementation (Apache-2.0).
//
// Supported: Windows Server 2016+ gateways with NTLM (or Negotiate falling back to
// NTLM) authentication. Not supported: legacy two-channel HTTP, RPC-over-HTTP,
// Kerberos-only, smart card and Entra ID (OAuth) gateway sign-in.
const tls = require('tls');
const net = require('net');
const crypto = require('crypto');
const { Duplex } = require('stream');
const ntlm = require('./ntlm');
const store = require('./store');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const PKT = { HANDSHAKE_REQ: 1, HANDSHAKE_RES: 2, TUNNEL_CREATE: 4, TUNNEL_RES: 5, TUNNEL_AUTH: 6, TUNNEL_AUTH_RES: 7, CHANNEL_CREATE: 8, CHANNEL_RES: 9, DATA: 10, SERVICE_MSG: 11, REAUTH: 12, KEEPALIVE: 13, CLOSE: 0x10, CLOSE_RES: 0x11 };
const MAX_DATA = 32 * 1024;
const STEP_TIMEOUT = 20000;

// Partial HRESULT table for common gateway policy failures; others show the hex code.
const HRESULTS = {
  0x80070005: 'Access denied by the gateway.',
  0x800759da: 'The gateway denied access (resource authorization policy, RAP). Your account is not allowed to reach this server.',
  0x800759dc: 'The gateway could not connect to the target server.',
  0x800759ed: 'The gateway denied access (quarantine / health check).',
};
const hr = (code) => `0x${(code >>> 0).toString(16).padStart(8, '0')}`;
const failed = (code) => (code >>> 0) >= 0x80000000;
function gwError(code, what) {
  return new Error(`${what}: ${HRESULTS[code >>> 0] || `gateway returned error ${hr(code)}`}`);
}

// ------------------------------------------------------------------ buffered reader
class Reader {
  constructor(sock) {
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.waiter = null;
    this.error = null;
    sock.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.pump(); });
    const fail = (e) => { this.error = this.error || e || new Error('Gateway connection closed'); this.pump(); };
    sock.on('error', fail);
    sock.on('close', () => fail(new Error('Gateway connection closed')));
    sock.on('end', () => fail(new Error('Gateway connection closed')));
  }
  pump() {
    const w = this.waiter;
    if (!w) return;
    let res;
    try { res = w.parse(this.buf); } catch (e) { this.waiter = null; clearTimeout(w.timer); return w.reject(e); }
    if (res) {
      this.buf = this.buf.subarray(res.consumed);
      this.waiter = null;
      clearTimeout(w.timer);
      w.resolve(res.value);
    } else if (this.error) {
      this.waiter = null;
      clearTimeout(w.timer);
      w.reject(this.error);
    }
  }
  next(parse, timeout = STEP_TIMEOUT) {
    return new Promise((resolve, reject) => {
      const timer = timeout ? setTimeout(() => { this.waiter = null; reject(new Error('Timed out waiting for the gateway')); }, timeout) : null;
      this.waiter = { parse, resolve, reject, timer };
      this.pump();
    });
  }
}

function parseHttp(buf) {
  const end = buf.indexOf('\r\n\r\n');
  if (end < 0) return null;
  const lines = buf.subarray(0, end).toString('latin1').split('\r\n');
  const m = /^HTTP\/1\.[01] (\d{3})/.exec(lines[0]);
  if (!m) throw new Error('Unexpected response from the gateway (not HTTP)');
  const headers = {};
  for (const l of lines.slice(1)) {
    const i = l.indexOf(':');
    if (i < 0) continue;
    const k = l.slice(0, i).trim().toLowerCase();
    (headers[k] ||= []).push(l.slice(i + 1).trim());
  }
  const status = Number(m[1]);
  const len = status === 101 ? 0 : Number((headers['content-length'] || ['0'])[0]) || 0;
  if (buf.length < end + 4 + len) return null;
  return { value: { status, headers }, consumed: end + 4 + len };
}

function parseFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0], b1 = buf[1];
  let len = b1 & 0x7f;
  let off = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); off = 10; }
  let mask = null;
  if (b1 & 0x80) { if (buf.length < off + 4) return null; mask = buf.subarray(off, off + 4); off += 4; }
  if (len > 16 * 1024 * 1024) throw new Error('Gateway sent an oversized frame');
  if (buf.length < off + len) return null;
  let payload = Buffer.from(buf.subarray(off, off + len));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  return { value: { fin: !!(b0 & 0x80), opcode: b0 & 0x0f, payload }, consumed: off + len };
}

function frame(opcode, payload) {
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x80 | opcode, 0x80 | len])
    : len < 65536 ? Buffer.from([0x80 | opcode, 0x80 | 126, len >> 8, len & 0xff])
      : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | opcode; h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(len), 2); return h; })();
  const mask = crypto.randomBytes(4);
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
  return Buffer.concat([head, mask, body]);
}

// ------------------------------------------------------------------ session
class Session {
  constructor(sock) {
    this.sock = sock;
    this.r = new Reader(sock);
    this.rdg = Buffer.alloc(0); // reassembled RDG byte stream from WebSocket messages
    this.msgParts = [];
  }
  sendWs(opcode, payload) { return new Promise((res, rej) => this.sock.write(frame(opcode, payload), (e) => (e ? rej(e) : res()))); }
  sendPacket(type, body = Buffer.alloc(0)) {
    const h = Buffer.alloc(8);
    h.writeUInt16LE(type, 0);
    h.writeUInt32LE(8 + body.length, 4);
    return this.sendWs(0x2, Buffer.concat([h, body]));
  }
  async nextWsData(timeout) {
    for (;;) {
      const f = await this.r.next(parseFrame, timeout);
      if (f.opcode === 0x8) throw new Error('Gateway closed the connection');
      if (f.opcode === 0x9) { await this.sendWs(0xa, f.payload); continue; } // ping -> pong
      if (f.opcode === 0xa) continue;
      this.msgParts.push(f.payload);
      if (f.fin) { const m = Buffer.concat(this.msgParts); this.msgParts = []; return m; }
    }
  }
  async nextPacket(timeout = STEP_TIMEOUT) {
    for (;;) {
      if (this.rdg.length >= 8) {
        const len = this.rdg.readUInt32LE(4);
        if (len < 8 || len > 16 * 1024 * 1024) throw new Error('Gateway sent a malformed packet');
        if (this.rdg.length >= len) {
          const pkt = { type: this.rdg.readUInt16LE(0), body: Buffer.from(this.rdg.subarray(8, len)) };
          this.rdg = this.rdg.subarray(len);
          return pkt;
        }
      }
      this.rdg = Buffer.concat([this.rdg, await this.nextWsData(timeout)]);
    }
  }
  async expect(type, what) {
    for (;;) {
      const p = await this.nextPacket();
      if (p.type === type) return p.body;
      if (p.type === PKT.SERVICE_MSG || p.type === PKT.KEEPALIVE) continue;
      if (p.type === PKT.CLOSE) throw new Error(`${what}: the gateway closed the connection`);
      throw new Error(`${what}: unexpected gateway packet type ${p.type}`);
    }
  }
}

// ------------------------------------------------------------------ http + ntlm
function buildRequest(host, port, key, auth) {
  const id = () => `{${crypto.randomUUID().toUpperCase()}}`;
  return Buffer.from([
    'RDG_OUT_DATA /remoteDesktopGateway/ HTTP/1.1',
    `Host: ${port === 443 ? host : `${host}:${port}`}`,
    'Accept: */*',
    'Cache-Control: no-cache',
    'Pragma: no-cache',
    'User-Agent: MS-RDGateway/1.0',
    'Connection: Upgrade',
    'Upgrade: websocket',
    'Sec-WebSocket-Version: 13',
    `Sec-WebSocket-Key: ${key}`,
    `RDG-Connection-Id: ${id()}`,
    `RDG-Correlation-Id: ${id()}`,
    'Content-Length: 0',
    ...(auth ? [`Authorization: ${auth}`] : []),
    '', '',
  ].join('\r\n'), 'latin1');
}

const tokenFor = (headers, scheme) => {
  for (const h of headers['www-authenticate'] || []) {
    const m = new RegExp(`^${scheme}\\s+([A-Za-z0-9+/=]+)`, 'i').exec(h);
    if (m) return Buffer.from(m[1], 'base64');
  }
  return null;
};
const offers = (headers, scheme) => (headers['www-authenticate'] || []).some((h) => h.toLowerCase().startsWith(scheme.toLowerCase()));

async function signIn(sess, { host, port, username, domain, password }) {
  const key = crypto.randomBytes(16).toString('base64');
  const send = async (auth) => {
    await new Promise((res, rej) => sess.sock.write(buildRequest(host, port, key, auth), (e) => (e ? rej(e) : res())));
    return sess.r.next(parseHttp);
  };

  let scheme = 'NTLM';
  let res = await send(`NTLM ${ntlm.negotiateMessage().toString('base64')}`);
  if (res.status === 101) return verifyUpgrade(res, key);
  if (res.status !== 401) throw new Error(`Gateway sign-in failed: HTTP ${res.status}${res.status === 404 ? ' (RD Gateway not found at that address)' : ''}`);

  let challenge = tokenFor(res.headers, 'NTLM');
  if (!challenge && offers(res.headers, 'Negotiate')) {
    scheme = 'Negotiate';
    res = await send(`Negotiate ${ntlm.negotiateMessage().toString('base64')}`);
    if (res.status === 101) return verifyUpgrade(res, key);
    challenge = tokenFor(res.headers, 'Negotiate');
  }
  if (!challenge) throw new Error('Gateway does not offer NTLM sign-in (Kerberos-only, smart card or Entra ID gateways are not supported).');

  const type3 = ntlm.authenticateMessage(challenge, { username, domain: domain || '', password, workstation: 'ITVR-RDP' });
  res = await send(`${scheme} ${type3.toString('base64')}`);
  if (res.status === 401) throw new Error('Gateway sign-in failed: wrong username or password.');
  if (res.status === 403) throw new Error('Gateway sign-in failed: access forbidden (account not allowed on this gateway).');
  if (res.status !== 101) throw new Error(`Gateway did not upgrade to WebSocket (HTTP ${res.status}). It may only support the legacy transport.`);
  return verifyUpgrade(res, key);
}

function verifyUpgrade(res, key) {
  const want = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  const got = (res.headers['sec-websocket-accept'] || [])[0];
  if (got !== want) throw new Error('Gateway returned an invalid WebSocket handshake');
}

// ------------------------------------------------------------------ RDG protocol
const u16z = (s) => Buffer.from(`${s}\0`, 'utf16le'); // UTF-16LE with terminating NUL

async function openTunnel(sess, target, clientName) {
  // 1. handshake
  const hs = Buffer.alloc(6);
  hs.writeUInt8(1, 0); hs.writeUInt8(0, 1); hs.writeUInt16LE(0, 2); hs.writeUInt16LE(0, 4); // ver 1.0, client ver 0, ext auth none
  await sess.sendPacket(PKT.HANDSHAKE_REQ, hs);
  let b = await sess.expect(PKT.HANDSHAKE_RES, 'Gateway handshake');
  if (b.length < 10) throw new Error('Gateway handshake: short response');
  if (failed(b.readUInt32LE(0))) throw gwError(b.readUInt32LE(0), 'Gateway handshake');

  // 2. tunnel create (capabilities: quarantine SOH | consent sign | service messages)
  const tc = Buffer.alloc(8);
  tc.writeUInt32LE(0x1 | 0x4 | 0x8, 0);
  await sess.sendPacket(PKT.TUNNEL_CREATE, tc);
  b = await sess.expect(PKT.TUNNEL_RES, 'Gateway tunnel');
  if (b.length < 10) throw new Error('Gateway tunnel: short response');
  const tErr = b.readUInt32LE(2);
  if (failed(tErr)) throw gwError(tErr, 'Gateway tunnel');

  // 3. tunnel authorize (identify this client)
  const name = u16z(clientName);
  const ta = Buffer.alloc(4 + name.length);
  ta.writeUInt16LE(0, 0);
  ta.writeUInt16LE(name.length, 2);
  name.copy(ta, 4);
  await sess.sendPacket(PKT.TUNNEL_AUTH, ta);
  b = await sess.expect(PKT.TUNNEL_AUTH_RES, 'Gateway authorization');
  if (b.length < 8) throw new Error('Gateway authorization: short response');
  const aErr = b.readUInt32LE(0);
  if (failed(aErr) && (aErr >>> 0) !== 0x800759ed) throw gwError(aErr, 'Gateway authorization');

  // 4. channel create (the target host:port, protocol 3 = TCP/RDP)
  const host = u16z(target.host);
  const cc = Buffer.alloc(8 + host.length);
  cc.writeUInt8(1, 0); cc.writeUInt8(0, 1);
  cc.writeUInt16LE(target.port, 2);
  cc.writeUInt16LE(3, 4);
  cc.writeUInt16LE(host.length, 6);
  host.copy(cc, 8);
  await sess.sendPacket(PKT.CHANNEL_CREATE, cc);
  b = await sess.expect(PKT.CHANNEL_RES, 'Gateway channel');
  if (b.length < 8) throw new Error('Gateway channel: short response');
  const cErr = b.readUInt32LE(0);
  if (failed(cErr)) throw gwError(cErr, 'Gateway channel');
}

class TunnelStream extends Duplex {
  constructor(sess) {
    super();
    this.sess = sess;
    this.wake = null;
    this.pumping = this.pump();
  }
  async pump() {
    try {
      for (;;) {
        const p = await this.sess.nextPacket(0);
        if (p.type === PKT.DATA) {
          const n = p.body.readUInt16LE(0);
          if (!this.push(p.body.subarray(2, 2 + n))) await new Promise((r) => { this.wake = r; });
        } else if (p.type === PKT.KEEPALIVE) {
          await this.sess.sendPacket(PKT.KEEPALIVE);
        } else if (p.type === PKT.CLOSE) {
          const status = Buffer.alloc(4);
          await this.sess.sendPacket(PKT.CLOSE_RES, status).catch(() => {});
          break;
        }
      }
      this.push(null);
    } catch (e) {
      this.destroy(e);
    }
  }
  _read() { if (this.wake) { const w = this.wake; this.wake = null; w(); } }
  async _write(chunk, _enc, cb) {
    try {
      for (let o = 0; o < chunk.length; o += MAX_DATA) {
        const part = chunk.subarray(o, o + MAX_DATA);
        const h = Buffer.alloc(2);
        h.writeUInt16LE(part.length, 0);
        await this.sess.sendPacket(PKT.DATA, Buffer.concat([h, part]));
      }
      cb();
    } catch (e) { cb(e); }
  }
  _destroy(err, cb) {
    this.sess.sock.destroy();
    cb(err);
  }
  // Mimic net.Socket bits that tls.connect() touches.
  setTimeout() { return this; }
  setNoDelay() { return this; }
  setKeepAlive() { return this; }
  ref() { return this; }
  unref() { return this; }
}

/**
 * Opens a tunnel through an RD Gateway to target.host:target.port.
 * @param {{host:string,port:number,username:string,domain?:string,password:string}} gw
 * @param {{host:string,port:number}} target
 * @returns {Promise<import('stream').Duplex>}
 */
async function connect(gw, target) {
  let username = gw.username || '';
  let domain = gw.domain || '';
  if (!domain && username.includes('\\')) [domain, username] = username.split('\\', 2);
  if (!username) throw new Error('Gateway sign-in needs a username.');

  const sock = await new Promise((resolve, reject) => {
    const s = tls.connect({ host: gw.host, port: gw.port, servername: net.isIP(gw.host) ? undefined : gw.host, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] });
    const timer = setTimeout(() => { s.destroy(); reject(new Error(`Timed out connecting to gateway ${gw.host}:${gw.port}`)); }, STEP_TIMEOUT);
    s.once('secureConnect', () => { clearTimeout(timer); resolve(s); });
    s.once('error', (e) => { clearTimeout(timer); reject(new Error(`Cannot reach gateway ${gw.host}:${gw.port} (${e.code || e.message})`)); });
  });

  try {
    // Pin the gateway certificate on first use, like the RDP server certificate.
    const fp = sock.getPeerCertificate().fingerprint256;
    const pin = `gw:${gw.host}:${gw.port}`;
    const known = store.getKnownHost(pin);
    if (fp && !known) store.setKnownHost(pin, fp);
    else if (fp && known !== fp) throw new Error(`The certificate of gateway ${gw.host} has changed. Use "Forget pinned certificate" if this is expected.`);

    const sess = new Session(sock);
    await signIn(sess, { host: gw.host, port: gw.port, username, domain, password: gw.password || '' });
    await openTunnel(sess, target, 'ITVR-RDP');
    return new TunnelStream(sess);
  } catch (e) {
    sock.destroy();
    throw e;
  }
}

module.exports = { connect, _test: { parseHttp, parseFrame, frame, Session, TunnelStream, openTunnel, signIn, PKT } };
