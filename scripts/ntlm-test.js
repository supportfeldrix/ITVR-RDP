// Verifies the NTLM helper against published test vectors (RFC 1320, MS-NLMP 4.2.4).
const assert = require('assert');
const n = require('../electron/ntlm');
const hex = (b) => b.toString('hex');

assert.strictEqual(hex(n.md4('')), '31d6cfe0d16ae931b73c59d7e0c089c0');
assert.strictEqual(hex(n.md4('abc')), 'a448017aaf21d8525fc10ae87aa6729d');
assert.strictEqual(hex(n.md4('message digest')), 'd9130a8164549fe818874806e1c7014b');
assert.strictEqual(hex(n.md4('12345678901234567890123456789012345678901234567890123456789012345678901234567890')), 'e33b4ddc9c38f2199c3e7b164fcc0536');
assert.strictEqual(hex(n.ntHash('Password')), 'a4f49c406510bdcab6824ee7c30fd852');
assert.strictEqual(hex(n.ntowfv2('Password', 'User', 'Domain')), '0c868a403bfd7a93a3001ef22ef02e3f');

// MS-NLMP 4.2.4.2.2: NTLMv2 response with fixed challenges and zero time.
const u16 = (s) => Buffer.from(s, 'utf16le');
const av = (id, v) => { const h = Buffer.alloc(4); h.writeUInt16LE(id, 0); h.writeUInt16LE(v.length, 2); return Buffer.concat([h, v]); };
const targetInfo = Buffer.concat([av(2, u16('Domain')), av(1, u16('Server')), Buffer.alloc(4)]);
const r = n.ntlmv2Response({
  password: 'Password', user: 'User', domain: 'Domain',
  serverChallenge: Buffer.from('0123456789abcdef', 'hex'),
  clientChallenge: Buffer.from('aaaaaaaaaaaaaaaa', 'hex'),
  timestamp: Buffer.alloc(8),
  targetInfo,
});
assert.strictEqual(hex(r.proof), '68cd0ab851e51c96aabc927bebef6a1c');

// Round-trip: build a challenge and make sure the authenticate message parses structurally.
const info = targetInfo;
const ch = Buffer.alloc(56 + info.length);
Buffer.from('NTLMSSP\0').copy(ch, 0);
ch.writeUInt32LE(2, 8);
ch.writeUInt32LE(0xe2898215 >>> 0, 20);
Buffer.from('0123456789abcdef', 'hex').copy(ch, 24);
ch.writeUInt16LE(info.length, 40); ch.writeUInt16LE(info.length, 42); ch.writeUInt32LE(56, 44);
info.copy(ch, 56);
const t3 = n.authenticateMessage(ch, { username: 'User', domain: 'Domain', password: 'Password' });
assert.strictEqual(t3.subarray(0, 8).toString('latin1'), 'NTLMSSP\0');
assert.strictEqual(t3.readUInt32LE(8), 3);
const userLen = t3.readUInt16LE(36), userOff = t3.readUInt32LE(40);
assert.strictEqual(t3.subarray(userOff, userOff + userLen).toString('utf16le'), 'User');
console.log('NTLM tests passed');
