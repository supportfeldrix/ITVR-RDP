// Protocol test for electron/gateway.js using an in-process fake RD Gateway
// (plain TCP; TLS is orthogonal). The fake verifies the NTLMv2 proof for real.
// Run: node scripts/gateway-test.js
const assert = require('assert');
const net = require('net');
const crypto = require('crypto');
const ntlm = require('../electron/ntlm');

// gateway.js requires ./store, which requires electron; stub it for plain node.
const Module = require('module');
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'electron') return { app: { getPath: () => require('os').tmpdir() }, safeStorage: {} };
  return origLoad.call(this, req, ...rest);
};
const gw = require('../electron/gateway');
const { parseHttp, parseFrame, frame, Session, TunnelStream, openTunnel, signIn } = gw._test;

const u16 = (s) => Buffer.from(s, 'utf16le');
const av = (id, v) => { const h = Buffer.alloc(4); h.writeUInt16LE(id, 0); h.writeUInt16LE(v.length, 2); return Buffer.concat([h, v]); };
const targetInfo = Buffer.concat([av(2, u16('CORP')), av(1, u16('GW01')), av(7, Buffer.alloc(8, 1)), Buffer.alloc(4)]);
const serverChallenge = crypto.randomBytes(8);
const USER = 'jsmith', DOMAIN = 'CORP', PASS = 'S3cret!pass';

function type2() {
  const ch = Buffer.alloc(56 + targetInfo.length);
  Buffer.from('NTLMSSP\0').copy(ch, 0);
  ch.writeUInt32LE(2, 8);
  ch.writeUInt32LE(0xe2898215 >>> 0, 20);
  serverChallenge.copy(ch, 24);
  ch.writeUInt16LE(targetInfo.length, 40); ch.writeUInt16LE(targetInfo.length, 42); ch.writeUInt32LE(56, 44);
  targetInfo.copy(ch, 56);
  return ch;
}
function verifyType3(t3) {
  const f = (o) => t3.subarray(t3.readUInt32LE(o + 4), t3.readUInt32LE(o + 4) + t3.readUInt16LE(o));
  const nt = f(20);
  const user = f(36).toString('utf16le');
  const domain = f(28).toString('utf16le');
  assert.strictEqual(user, USER);
  assert.strictEqual(domain, DOMAIN);
  const proof = nt.subarray(0, 16);
  const blob = nt.subarray(16);
  const expect = crypto.createHmac('md5', ntlm.ntowfv2(PASS, USER, DOMAIN)).update(Buffer.concat([serverChallenge, blob])).digest();
  return proof.equals(expect);
}

const sframe = (opcode, payload) => { // unmasked server frame
  const h = payload.length < 126 ? Buffer.from([0x80 | opcode, payload.length]) : Buffer.from([0x80 | opcode, 126, payload.length >> 8, payload.length & 255]);
  return Buffer.concat([h, payload]);
};
const pkt = (type, body = Buffer.alloc(0)) => { const h = Buffer.alloc(8); h.writeUInt16LE(type, 0); h.writeUInt32LE(8 + body.length, 4); return Buffer.concat([h, body]); };

function parseReq(buf) {
  const end = buf.indexOf('\r\n\r\n');
  if (end < 0) return null;
  const lines = buf.subarray(0, end).toString('latin1').split('\r\n');
  assert.ok(/^RDG_OUT_DATA \/remoteDesktopGateway\/ HTTP\/1\.1$/.test(lines[0]), 'request line');
  const headers = {};
  for (const l of lines.slice(1)) { const i = l.indexOf(':'); (headers[l.slice(0, i).trim().toLowerCase()] ||= []).push(l.slice(i + 1).trim()); }
  return { value: { headers }, consumed: end + 4 };
}

function startFakeGateway({ tunnelError = 0, badPassword = false } = {}) {
  const state = { channel: null, sawProofOk: false, echoed: 0 };
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    let stage = 'http1';
    let key = '';
    let rdg = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (stage === 'http1' || stage === 'http2') {
          const r = parseReq(buf);
          if (!r) return;
          buf = buf.subarray(r.consumed);
          const hdrs = r.value.headers;
          key = hdrs['sec-websocket-key'][0];
          const auth = hdrs.authorization[0];
          const token = Buffer.from(auth.split(' ')[1], 'base64');
          if (stage === 'http1') {
            assert.strictEqual(token.readUInt32LE(8), 1);
            sock.write(`HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: NTLM ${type2().toString('base64')}\r\nContent-Length: 0\r\nConnection: keep-alive\r\n\r\n`);
            stage = 'http2';
          } else {
            state.sawProofOk = verifyType3(token);
            if (!state.sawProofOk || badPassword) { sock.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: NTLM\r\nContent-Length: 0\r\n\r\n'); stage = 'dead'; return; }
            const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
            sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
            stage = 'ws';
          }
        } else if (stage === 'ws') {
          const f = parseFrame(buf);
          if (!f) return;
          buf = buf.subarray(f.consumed);
          assert.ok(buf !== undefined);
          rdg = Buffer.concat([rdg, f.value.payload]);
          while (rdg.length >= 8 && rdg.length >= rdg.readUInt32LE(4)) {
            const len = rdg.readUInt32LE(4);
            const type = rdg.readUInt16LE(0);
            const body = rdg.subarray(8, len);
            rdg = rdg.subarray(len);
            handle(type, body);
          }
        } else return;
      }
    });
    sock.on('error', () => {});
    const send = (p) => sock.write(sframe(0x2, p));
    function handle(type, body) {
      if (type === 1) { const b = Buffer.alloc(10); b.writeUInt16LE(1, 4); send(pkt(2, b)); }
      else if (type === 4) {
        const b = Buffer.alloc(18);
        b.writeUInt16LE(1, 0); b.writeUInt32LE(tunnelError >>> 0, 2); b.writeUInt16LE(0x3, 6); // tunnelId + caps present
        send(pkt(5, b));
      } else if (type === 6) {
        assert.strictEqual(body.subarray(4).toString('utf16le').replace(/\0$/, ''), 'ITVR-RDP');
        const b = Buffer.alloc(12); b.writeUInt16LE(0x1, 4); // redirection flags present
        send(pkt(7, b));
      } else if (type === 8) {
        assert.strictEqual(body.readUInt8(0), 1);
        assert.strictEqual(body.readUInt16LE(4), 3);
        state.channel = { port: body.readUInt16LE(2), host: body.subarray(8, 8 + body.readUInt16LE(6)).toString('utf16le').replace(/\0$/, '') };
        const b = Buffer.alloc(12); b.writeUInt16LE(0x1, 4);
        send(pkt(9, b));
      } else if (type === 10) {
        const n = body.readUInt16LE(0);
        state.echoed += n;
        const b = Buffer.alloc(2 + n); b.writeUInt16LE(n, 0); body.subarray(2, 2 + n).copy(b, 2);
        send(pkt(10, b));
      } else if (type === 0x10) { /* client closed */ }
    }
    // After a short delay, send a keepalive to make sure the client answers it.
    setTimeout(() => stage === 'ws' && send(pkt(13)), 300);
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({ server, port: server.address().port, state })));
}

async function openClient(port) {
  const sock = net.createConnection({ host: '127.0.0.1', port });
  await new Promise((r) => sock.once('connect', r));
  const sess = new Session(sock);
  await signIn(sess, { host: '127.0.0.1', port, username: USER, domain: DOMAIN, password: PASS });
  return sess;
}

(async () => {
  // 1. happy path with echo of a payload bigger than one RDG data packet
  {
    const { server, port, state } = await startFakeGateway();
    const sess = await openClient(port);
    await openTunnel(sess, { host: 'rdp-target.corp.local', port: 3390 }, 'ITVR-RDP');
    assert.deepStrictEqual(state.channel, { port: 3390, host: 'rdp-target.corp.local' });
    assert.ok(state.sawProofOk, 'NTLMv2 proof must verify');

    const tun = new TunnelStream(sess);
    const payload = crypto.randomBytes(100000);
    const got = [];
    let total = 0;
    const done = new Promise((res) => tun.on('data', (d) => { got.push(d); total += d.length; if (total >= payload.length) res(); }));
    tun.write(payload);
    await done;
    assert.ok(Buffer.concat(got).equals(payload), 'echoed bytes must match');
    assert.strictEqual(state.echoed, payload.length);
    await new Promise((r) => setTimeout(r, 400)); // let the keepalive round-trip happen without error
    tun.destroy();
    server.close();
    console.log('ok  sign-in + tunnel + 100 kB echo + keepalive');
  }
  // 2. wrong password is rejected by the gateway
  {
    const { server, port } = await startFakeGateway({ badPassword: true });
    await assert.rejects(openClient(port), /wrong username or password/);
    server.close();
    console.log('ok  wrong password message');
  }
  // 3. gateway policy denial maps to a readable message
  {
    const { server, port } = await startFakeGateway({ tunnelError: 0x800759da });
    const sess = await openClient(port);
    await assert.rejects(openTunnel(sess, { host: 'x', port: 3389 }, 'ITVR-RDP'), /resource authorization policy/);
    sess.sock.destroy();
    server.close();
    console.log('ok  RAP denial message');
  }
  console.log('Gateway tests passed');
  process.exit(0);
})().catch((e) => { console.error('GATEWAY TEST FAIL', e); process.exit(1); });
