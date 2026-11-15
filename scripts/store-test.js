// Tests the entry/credential store: shared credentials, fallback on delete,
// import remapping and that secrets never leave the main process or exports.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itvr-store-'));
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'electron') {
    return {
      app: { getPath: () => dir },
      // reversible stand-in for DPAPI/Keychain so tests can assert on plaintext handling
      safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(`ENC:${s}`), decryptString: (b) => b.toString().replace(/^ENC:/, '') },
    };
  }
  return origLoad.call(this, req, ...rest);
};
const store = require('../electron/store');

try {
  const folder = store.save({ type: 'folder', name: 'PRF' });
  const cred = store.saveCredential({ name: 'FNB admin', username: 'svc_admin', domain: 'FNB', password: 'Old#Pass1' });
  assert.strictEqual(cred.hasPassword, true);
  assert.ok(!('passwordEnc' in cred) && !('password' in cred), 'credential public view must not carry secrets');

  const a = store.save({ type: 'rdp', name: 'srv-a', host: 'srv-a', parentId: folder.id, credentialId: cred.id });
  const b = store.save({ type: 'rdp', name: 'srv-b', host: 'srv-b', credentialId: cred.id, gateway: 'gw.corp', gatewayPort: 8443 });
  const own = store.save({ type: 'ssh', name: 'box', host: 'box', username: 'root', password: 'rootpw' });

  // entries reflect the shared credential
  let list = store.list();
  const la = list.find((i) => i.id === a.id);
  assert.strictEqual(la.effectiveUsername, 'svc_admin');
  assert.strictEqual(la.effectiveDomain, 'FNB');
  assert.strictEqual(la.hasPassword, true);
  assert.strictEqual(la.credentialName, 'FNB admin');
  assert.ok(!('passwordEnc' in la));
  assert.strictEqual(store.listCredentials().find((c) => c.id === cred.id).usage, 2);

  // one change updates every entry that uses it
  assert.strictEqual(store.getSecret(a.id).password, 'Old#Pass1');
  store.saveCredential({ id: cred.id, name: 'FNB admin', username: 'svc_admin', domain: 'FNB', password: 'New#Pass2' });
  assert.strictEqual(store.getSecret(a.id).password, 'New#Pass2');
  assert.strictEqual(store.getSecret(b.id).password, 'New#Pass2');
  // leaving the password field out keeps it
  store.saveCredential({ id: cred.id, name: 'FNB admin (renamed)', username: 'svc_admin', domain: 'FNB' });
  assert.strictEqual(store.getSecret(a.id).password, 'New#Pass2');

  // gateway resolution: same-as-connection by default, or its own credential
  let sb = store.getSecret(b.id);
  assert.strictEqual(sb.gateway.host, 'gw.corp');
  assert.strictEqual(sb.gateway.port, 8443);
  assert.strictEqual(sb.gateway.sameAsConnection, true);
  assert.strictEqual(sb.gateway.password, 'New#Pass2');
  const gwCred = store.saveCredential({ name: 'GW login', username: 'gwuser', domain: 'CORP', password: 'gwpw' });
  store.save({ ...b, gatewayCredentialId: gwCred.id });
  sb = store.getSecret(b.id);
  assert.strictEqual(sb.gateway.username, 'gwuser');
  assert.strictEqual(sb.gateway.password, 'gwpw');
  assert.strictEqual(sb.password, 'New#Pass2', 'target keeps its own credential');

  // secrets are never exported
  const exported = JSON.stringify(store.exportBundle());
  for (const secret of ['Old#Pass1', 'New#Pass2', 'gwpw', 'rootpw', 'ENC:']) assert.ok(!exported.includes(secret), `export leaked ${secret}`);
  assert.ok(!exported.toLowerCase().includes('passwordenc'));

  // an entry's own password survives an unrelated edit
  store.save({ ...own, name: 'box2' });
  assert.strictEqual(store.getSecret(own.id).password, 'rootpw');

  // deleting a credential makes entries fall back to prompting
  store.removeCredential(cred.id);
  list = store.list();
  assert.strictEqual(list.find((i) => i.id === a.id).credentialId, '');
  assert.strictEqual(list.find((i) => i.id === a.id).hasPassword, false);

  // import: ids remapped, credential links kept, folder tree kept, no secrets accepted
  const bundle = {
    items: [
      { id: 'f1', type: 'folder', name: 'Imported', parentId: null },
      { id: 'e1', type: 'rdp', name: 'imp-1', host: 'h1', parentId: 'f1', credentialId: 'c1', password: 'must-not-be-imported' },
      { id: 'e2', type: 'ssh', name: 'imp-2', host: 'h2', parentId: 'missing-folder', credentialId: 'nope' },
    ],
    credentials: [{ id: 'c1', name: 'Imp cred', username: 'u', domain: 'D' }],
  };
  const before = store.list().length;
  const res = store.importBundle(bundle);
  assert.deepStrictEqual(res, { entries: 2, folders: 1, credentials: 1 });
  assert.strictEqual(store.list().length, before + 3);
  const imp = store.list().find((i) => i.name === 'imp-1');
  const impF = store.list().find((i) => i.name === 'Imported');
  assert.strictEqual(imp.parentId, impF.id);
  assert.notStrictEqual(imp.id, 'e1');
  const impCred = store.listCredentials().find((c) => c.name === 'Imp cred');
  assert.strictEqual(imp.credentialId, impCred.id);
  assert.strictEqual(store.getSecret(imp.id).password, '', 'imports never carry passwords');
  assert.strictEqual(store.getSecret(imp.id).item.passwordEnc, '');
  const imp2 = store.list().find((i) => i.name === 'imp-2');
  assert.strictEqual(imp2.parentId, null, 'dangling parent becomes root');
  assert.strictEqual(imp2.credentialId, '', 'dangling credential link cleared');

  // folder delete cascades
  store.remove(impF.id);
  assert.ok(!store.list().some((i) => i.name === 'imp-1'));

  // hostile input is sanitised
  const evil = store.save({ type: 'rdp', name: 'x\r\ny', host: 'h\r\nfull address:s:evil', credentialId: '../../etc', port: 99999 });
  assert.ok(!/[\r\n]/.test(evil.name + evil.host));
  assert.strictEqual(evil.credentialId, '');
  assert.strictEqual(evil.port, 65535);

  console.log('Store tests passed');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
