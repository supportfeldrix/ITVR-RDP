// Tests the RDM importer on sample XML / JSON / CSV exports.
const assert = require('assert');
const { parse } = require('../electron/rdmImport');

const xml = `<?xml version="1.0" encoding="utf-8"?>
<RDMExport>
  <Connections>
    <Connection><ConnectionType>Group</ConnectionType><Name>CRO Windows Server</Name><ID>g1</ID></Connection>
    <Connection><ConnectionType>Group</ConnectionType><Name>PRF</Name><Group>CRO Windows Server</Group><ID>g2</ID></Connection>
    <Connection><ConnectionType>Credential</ConnectionType><Name>FNB admin</Name><ID>cred-1</ID>
      <Credentials><Domain>FNB</Domain><UserName>svc_admin</UserName><SafePassword>ENCRYPTED</SafePassword></Credentials></Connection>
    <Connection><ConnectionType>RDPConfigured</ConnectionType><Name>frm-rbtest01</Name><Group>CRO Windows Server\\PRF</Group>
      <Url>frm-rbtest01.fnb.co.za:3390</Url><CredentialConnectionID>cred-1</CredentialConnectionID><Description>Test server</Description>
      <RDP><GatewayHostname>gw.fnb.co.za</GatewayHostname></RDP></Connection>
    <Connection><ConnectionType>SSHShell</ConnectionType><Name>jenkins</Name><Group>Podman Servers</Group><Url>frm-rbautodev01</Url><UserName>f5151422</UserName></Connection>
    <Connection><ConnectionType>Website</ConnectionType><Name>Wiki</Name><Url>https://wiki</Url></Connection>
  </Connections>
  <Version>2</Version>
</RDMExport>`;

let r = parse(xml, 'x.rdm');
const byName = (n) => r.bundle.items.find((i) => i.name === n);
assert.strictEqual(r.summary.rdp, 1);
assert.strictEqual(r.summary.ssh, 1);
assert.strictEqual(r.summary.credentials, 1);
assert.deepStrictEqual(r.summary.skipped, { website: 1 });
const rdp = byName('frm-rbtest01');
assert.strictEqual(rdp.host, 'frm-rbtest01.fnb.co.za');
assert.strictEqual(rdp.port, 3390);
assert.strictEqual(rdp.gateway, 'gw.fnb.co.za');
assert.strictEqual(rdp.credentialId, r.bundle.credentials[0].id);
assert.strictEqual(r.bundle.credentials[0].username, 'svc_admin');
assert.strictEqual(r.bundle.credentials[0].domain, 'FNB');
assert.ok(!JSON.stringify(r.bundle).includes('ENCRYPTED'), 'passwords must not be imported');
// folder tree: import root > CRO Windows Server > PRF > entry
const prf = r.bundle.items.find((i) => i.name === 'PRF');
assert.strictEqual(rdp.parentId, prf.id);
const cro = r.bundle.items.find((i) => i.name === 'CRO Windows Server');
assert.strictEqual(prf.parentId, cro.id);
assert.ok(/^RDM import \d{4}-\d{2}-\d{2}$/.test(r.bundle.items.find((i) => i.id === cro.parentId).name));
assert.strictEqual(byName('jenkins').port, 22);

// ArrayOfConnection root (single-entry export)
r = parse('<ArrayOfConnection><Connection><ConnectionType>RDPConfigured</ConnectionType><Name>solo</Name><Url>10.0.0.5</Url></Connection></ArrayOfConnection>', 'x.xml', { wrapFolder: false });
assert.strictEqual(r.bundle.items.length, 1);
assert.strictEqual(r.bundle.items[0].parentId, null);

// JSON
r = parse(JSON.stringify([{ ConnectionType: 'SSHShell', Name: 'j', Url: 'box:2222', Group: 'A\\B' }]), 'x.json');
assert.strictEqual(r.summary.ssh, 1);
assert.strictEqual(r.bundle.items.find((i) => i.name === 'j').port, 2222);

// CSV
r = parse('Name,Group,Host,Type,Username\n"srv, one",Prod,10.1.1.1,RDP,admin\nlinux,Prod,10.1.1.2,SSH,root\n', 'hosts.csv');
assert.strictEqual(r.summary.rdp, 1);
assert.strictEqual(r.summary.ssh, 1);
assert.ok(r.bundle.items.some((i) => i.name === 'srv, one'));

// hostile / malformed input
assert.throws(() => parse('hello world', 'x.txt'), /Unrecognized/);
assert.throws(() => parse('Name,Group\na,b', 'x.csv'), /Host/);
console.log('RDM import tests passed');
