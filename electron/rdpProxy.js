'use strict';
// Local RDCleanPath proxy for the embedded IronRDP (WASM) client.
// Adapted from openif/irdp (MIT) web/lib/rdp-proxy.js.
//
// Renderer (WASM) --ws://127.0.0.1:<port>/<ticket>--> this proxy --TCP+TLS--> RDP server
//
// Security:
//  - Binds to 127.0.0.1 only, on a random port.
//  - Each connection needs a one-time ticket issued by the main process for a
//    saved connection; the destination is fixed by the ticket, not the renderer.
//  - Server TLS certificates are pinned on first use (like mstsc's "remember").
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const store = require('./store');
const gateway = require('./gateway');

const VERSION_1 = 3390;
const TAG_SEQUENCE = 0x30, TAG_INTEGER = 0x02, TAG_OCTET_STRING = 0x04, TAG_UTF8STRING = 0x0c;
const TICKET_TTL_MS = 60000;

// ---------- minimal ASN.1 DER ----------
function derLen(n) {
  if (n < 0x80) return Buffer.from([n]);
  const b = [];
  for (let t = n; t > 0; t >>= 8) b.unshift(t & 0xff);
  return Buffer.from([0x80 | b.length, ...b]);
}
const derWrap = (tag, content) => Buffer.concat([Buffer.from([tag]), derLen(content.length), content]);
function derInt(v) {
  const b = [];
  for (let t = v; t > 0; t >>= 8) b.unshift(t & 0xff);
  if (!b.length) b.push(0);
  if (b[0] & 0x80) b.unshift(0);
  return derWrap(TAG_INTEGER, Buffer.from(b));
}
const derCtx = (n, c) => derWrap(0xa0 + n, c);

function derTLV(buf, off) {
  if (off + 2 > buf.length) throw new Error('Truncated DER');
  const tag = buf[off];
  let len = buf[off + 1];
  let hdr = 2;
  if (len & 0x80) {
    const nb = len & 0x7f;
    if (nb > 4) throw new Error('DER length too large');
    len = 0;
    for (let i = 0; i < nb; i++) len = len * 256 + buf[off + 2 + i];
    hdr += nb;
  }
  if (off + hdr + len > buf.length) throw new Error('Truncated DER');
  return { tag, value: buf.subarray(off + hdr, off + hdr + len), total: hdr + len };
}
function derChildren(buf) {
  const out = [];
  for (let o = 0; o < buf.length; ) {
    const t = derTLV(buf, o);
    out.push(t);
    o += t.total;
  }
  return out;
}
const derIntVal = (b) => b.reduce((a, x) => a * 256 + x, 0);

function parseRequest(data) {
  const outer = derTLV(data, 0);
  if (outer.tag !== TAG_SEQUENCE) throw new Error('Bad RDCleanPath request');
  const r = {};
  for (const c of derChildren(outer.value)) {
    const inner = derTLV(c.value, 0);
    switch (c.tag & 0x1f) {
      case 0: r.version = derIntVal(inner.value); break;
      case 2: r.destination = inner.value.toString('utf8'); break;
      case 3: r.proxyAuth = inner.value.toString('utf8'); break;
      case 6: r.x224 = Buffer.from(inner.value); break;
      default: break;
    }
  }
  if (r.version !== VERSION_1) throw new Error(`Unsupported RDCleanPath version ${r.version}`);
  if (!r.x224) throw new Error('Missing X.224 request');
  return r;
}

function buildResponse(serverAddr, x224, certs) {
  return derWrap(TAG_SEQUENCE, Buffer.concat([
    derCtx(0, derInt(VERSION_1)),
    derCtx(6, derWrap(TAG_OCTET_STRING, x224)),
    derCtx(7, derWrap(TAG_SEQUENCE, Buffer.concat(certs.map((c) => derWrap(TAG_OCTET_STRING, c))))),
    derCtx(9, derWrap(TAG_UTF8STRING, Buffer.from(serverAddr, 'utf8'))),
  ]));
}

function buildError(code, http) {
  const e = [derCtx(0, derInt(code))];
  if (http) e.push(derCtx(1, derInt(http)));
  return derWrap(TAG_SEQUENCE, Buffer.concat([derCtx(0, derInt(VERSION_1)), derCtx(1, derWrap(TAG_SEQUENCE, Buffer.concat(e)))]));
}

// ---------- network ----------
function readTpkt(sock, timeoutMs) {
  // Read exactly one TPKT frame (X.224 Connection Confirm).
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => done(new Error('Timed out waiting for X.224 confirm')), timeoutMs);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= 4) {
        const len = buf.readUInt16BE(2);
        if (buf.length >= len) {
          if (buf.length > len) sock.unshift(buf.subarray(len));
          done(null, buf.subarray(0, len));
        }
      }
    };
    const onErr = (e) => done(e);
    const onEnd = () => done(new Error('Server closed the connection during negotiation'));
    function done(err, val) {
      clearTimeout(timer);
      sock.off('data', onData).off('error', onErr).off('end', onEnd);
      sock.pause();
      err ? reject(err) : resolve(Buffer.from(val));
    }
    sock.on('data', onData).on('error', onErr).on('end', onEnd);
  });
}

function certChain(peer) {
  const out = [];
  const seen = new Set();
  for (let c = peer; c && c.raw && !seen.has(c.fingerprint256); c = c.issuerCertificate) {
    seen.add(c.fingerprint256);
    out.push(Buffer.from(c.raw));
    if (c.issuerCertificate === c) break;
  }
  return out;
}

async function handshake(host, port, x224, gw) {
  // Either a direct TCP connection or a tunnel through an RD Gateway; both are duplex streams.
  const tcp = gw
    ? await gateway.connect(gw, { host, port })
    : await new Promise((resolve, reject) => {
      const s = net.createConnection({ host, port, timeout: 15000 });
      s.once('connect', () => { s.setTimeout(0); resolve(s); });
      s.once('timeout', () => { s.destroy(); reject(new Error(`Timed out connecting to ${host}:${port}`)); });
      s.once('error', (e) => reject(new Error(`Cannot reach ${host}:${port} (${e.code || e.message})`)));
    });

  try {
    tcp.write(x224);
    const confirm = await readTpkt(tcp, 15000);

    // Negotiation failure (type 0x03) means the server refused TLS/NLA; pass it through.
    const tlsSock = await new Promise((resolve, reject) => {
      const t = tls.connect({ socket: tcp, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false }, () => resolve(t));
      t.once('error', (e) => reject(new Error(`TLS handshake failed: ${e.message}`)));
    });
    const peer = tlsSock.getPeerCertificate(true);
    return { confirm, tlsSock, peer };
  } catch (e) {
    tcp.destroy(); // never leave a half-open socket or gateway tunnel behind
    throw e;
  }
}

// ---------- server ----------
let wss;
let port;
const tickets = new Map(); // ticket -> { host, port, gateway, expires }
const lastErrors = new Map(); // ticket -> message for the renderer (cleared when read)

function start() {
  if (wss) return Promise.resolve(port);
  return new Promise((resolve, reject) => {
    wss = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 64 * 1024 * 1024 });
    wss.on('listening', () => { port = wss.address().port; resolve(port); });
    wss.on('error', reject);
    wss.on('connection', onConnection);
  });
}

function issueTicket(host, p, gw = null) {
  const ticket = crypto.randomBytes(24).toString('hex');
  tickets.set(ticket, { host, port: p, gateway: gw, expires: Date.now() + TICKET_TTL_MS });
  return { ticket, proxyAddress: `ws://127.0.0.1:${port}/${ticket}`, destination: `${host}:${p}` };
}

function onConnection(ws, req) {
  const ticket = (req.url || '').replace(/^\//, '').split('?')[0];
  const t = tickets.get(ticket);
  tickets.delete(ticket); // one-time use
  if (t) t.id = ticket;
  if (!t || t.expires < Date.now()) {
    ws.close(1008, 'Invalid ticket');
    return;
  }

  ws.once('message', async (data) => {
    let tlsSock;
    try {
      // Destination comes from the ticket; the one in the request is ignored.
      const req = parseRequest(Buffer.from(data));
      const hs = await handshake(t.host, t.port, req.x224, t.gateway);
      tlsSock = hs.tlsSock;

      // Certificate pinning (trust on first use)
      const fp = hs.peer && hs.peer.fingerprint256;
      const key = `rdp:${t.host}:${t.port}`;
      const known = store.getKnownHost(key);
      if (fp && !known) store.setKnownHost(key, fp);
      else if (fp && known !== fp) {
        throw Object.assign(new Error(`Server certificate for ${t.host} changed. Expected ${known}, got ${fp}. Remove the pinned certificate if this is expected.`), { http: 495 });
      }

      ws.send(buildResponse(`${t.host}:${t.port}`, hs.confirm, certChain(hs.peer)));
      relay(ws, tlsSock);
    } catch (e) {
      if (tlsSock) tlsSock.destroy();
      console.error('[rdp-proxy]', e.message);
      lastErrors.set(t.id, e.message);
      setTimeout(() => lastErrors.delete(t.id), 120000);
      try { ws.send(buildError(1, e.http || 502)); } catch {}
      try { ws.close(1011, e.message.slice(0, 120)); } catch {}
    }
  });
}

function relay(ws, sock) {
  sock.on('data', (d) => ws.readyState === 1 && ws.send(d));
  sock.resume();
  ws.on('message', (d) => !sock.destroyed && sock.write(d));
  const end = () => {
    if (!sock.destroyed) sock.destroy();
    if (ws.readyState === 1) ws.close();
  };
  sock.on('end', end).on('close', end).on('error', end);
  ws.on('close', end).on('error', end);
}

function stop() {
  if (wss) wss.close();
  wss = null;
}

// Reason the proxy refused/failed a connection (gateway sign-in, policy, certificate...).
function takeError(ticket) {
  const m = lastErrors.get(ticket);
  lastErrors.delete(ticket);
  return m || '';
}

module.exports = { start, stop, issueTicket, takeError };
