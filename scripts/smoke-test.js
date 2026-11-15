// End-to-end smoke test: launches the built app with a throwaway profile, drives the
// real UI and IPC through the Chrome DevTools protocol.
// Usage: npm run smoke
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const assert = require('assert');
const WebSocket = require('ws');

const PORT = 9600;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'itvr-smoke-'));
const electron = require('electron');
const app = spawn(electron, [path.join(__dirname, '..'), `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`], { stdio: ['ignore', 'pipe', 'pipe'] });
let mainLog = '';
app.stdout.on('data', (d) => (mainLog += d));
app.stderr.on('data', (d) => (mainLog += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((res, rej) => http.get(url, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res(JSON.parse(b))); }).on('error', rej));

function finish(code) {
  try { app.kill(); } catch { /* ignore */ }
  setTimeout(() => { fs.rmSync(profile, { recursive: true, force: true }); process.exit(code); }, 800);
}

(async () => {
  let page;
  for (let i = 0; i < 40 && !page; i++) {
    await sleep(500);
    try { page = (await getJson(`http://127.0.0.1:${PORT}/json`)).find((t) => t.type === 'page'); } catch { /* not up yet */ }
  }
  assert.ok(page, 'app window did not open');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.on('open', r));
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.on('message', (m) => {
    const msg = JSON.parse(m);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
  });
  const call = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const js = async (expr) => {
    const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'evaluate failed');
    return r.result?.result?.value;
  };
  const clickText = (sel, text) => js(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => e.textContent.includes(${JSON.stringify(text)})); if (!el) return false; el.click(); return true; })()`);
  const waitFor = async (expr, ms = 8000) => { for (let t = 0; t < ms; t += 250) { if (await js(expr)) return true; await sleep(250); } return false; };
  const step = (m) => console.log(`ok  ${m}`);

  await call('Runtime.enable');
  assert.ok(await waitFor('!!document.querySelector(".tree")'), 'UI did not render');
  assert.strictEqual(await js('document.title'), 'ITVR RDP');
  step('app starts and renders');

  // ---- shared credentials through the real IPC layer ----
  const r = await js(`(async () => {
    const api = window.api;
    const cred = await api.credSave({ name: 'T cred', username: 'tuser', domain: 'TD', password: 'pw1' });
    const e = await api.save({ type: 'rdp', name: 'T gateway rdp', host: '10.255.255.1', port: 3389, credentialId: cred.id, gateway: 'gw.invalid', gatewayPort: 443 });
    const p1 = await api.rdpPrepare(e.id);
    await api.credSave({ id: cred.id, name: 'T cred', username: 'tuser', domain: 'TD', password: 'pw2' });
    const p2 = await api.rdpPrepare(e.id);
    const list = await api.list();
    const item = list.find((i) => i.id === e.id);
    return { p1: { u: p1.username, d: p1.domain, pw: p1.password, gw: p1.viaGateway, hasTicket: !!p1.ticket }, p2pw: p2.password,
             leaks: JSON.stringify(list).includes('passwordEnc') || JSON.stringify(await api.credList()).includes('passwordEnc'),
             item: { eff: item.effectiveUsername, name: item.credentialName, hasPw: item.hasPassword }, usage: (await api.credList())[0].usage };
  })()`);
  assert.deepStrictEqual(r.p1, { u: 'tuser', d: 'TD', pw: 'pw1', gw: 'gw.invalid', hasTicket: true });
  assert.strictEqual(r.p2pw, 'pw2', 'changing the shared credential must update the entry');
  assert.strictEqual(r.leaks, false, 'renderer must never receive encrypted secrets');
  assert.deepStrictEqual(r.item, { eff: 'tuser', name: 'T cred', hasPw: true });
  assert.strictEqual(r.usage, 1);
  step('shared credential resolves for entry + gateway, single change updates it, no secret leakage');

  // a gateway entry without any password reports a clear error before connecting
  const noPw = await js(`(async () => { const e = await window.api.save({ type: 'rdp', name: 'T nopw', host: '10.255.255.2', gateway: 'gw.invalid', username: 'x' }); try { await window.api.rdpPrepare(e.id); return 'no error'; } catch (x) { return String(x.message); } })()`);
  assert.ok(/No password is saved for the RD Gateway/.test(noPw), noPw);
  step('missing gateway password is reported clearly');

  // The data above was seeded behind the UI's back, so reload the page to pick it up.
  await call('Page.reload');
  await sleep(1500);
  assert.ok(await waitFor('!!document.querySelector(".tree")'), 'UI did not re-render after reload');

  // ---- UI: credentials dialog lists the credential, RDM dialog opens ----
  assert.ok(await clickText('button.tbtn', 'Credentials'));
  assert.ok(await waitFor('!!document.querySelector(".cred-table") && document.querySelector(".cred-table").innerText.includes("T cred")'), 'credentials dialog');
  assert.ok(await clickText('.modal button', 'Close'));
  assert.ok(await clickText('button.tbtn', 'Import RDM'));
  assert.ok(await waitFor('document.querySelector(".modal")?.innerText.includes("Import from Remote Desktop Manager")'), 'RDM dialog');
  assert.ok(await clickText('.modal button', 'Cancel'));
  step('credentials + RDM import dialogs render');

  // ---- UI: editor shows the credential picker and gateway section ----
  await js(`(() => { const root = document.querySelector('.node.root'); if (!document.querySelector('.node:not(.root)')) root.click(); return true; })()`);
  assert.ok(await waitFor('!![...document.querySelectorAll(".node .label")].find((l) => l.textContent === "T gateway rdp")'));
  await js(`[...document.querySelectorAll('.node .label')].find((l) => l.textContent === 'T gateway rdp').closest('.node').click()`);
  assert.ok(await clickText('button.tbtn', 'Edit'));
  assert.ok(await waitFor('document.querySelector(".modal")?.innerText.includes("RD Gateway")'));
  const editorText = await js('document.querySelector(".modal").innerText');
  assert.ok(editorText.includes('T cred'), 'credential picker lists shared credential');
  assert.ok(editorText.includes('Gateway sign-in'));
  assert.ok(await clickText('.modal button', 'Cancel'));
  step('editor shows shared-credential picker and gateway sign-in');

  // ---- UI: opening the gateway entry surfaces the real reason it failed ----
  await js(`[...document.querySelectorAll('.node .label')].find((l) => l.textContent === 'T gateway rdp').closest('.node').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  assert.ok(await waitFor('!!document.querySelector(".rdp-overlay")?.innerText.match(/gateway|Gateway/)', 20000), 'gateway error not shown');
  const overlay = await js('document.querySelector(".rdp-overlay").innerText');
  assert.ok(/Cannot reach gateway gw\.invalid/.test(overlay), overlay);
  step(`gateway failure explained in the tab: "${overlay.split('\n')[0]}"`);

  // ---- quick connect still works (direct, refused) ----
  await js(`(() => { const i = document.getElementById('quick-host'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'testuser@127.0.0.1:3389'); i.dispatchEvent(new Event('input', { bubbles: true })); i.form.requestSubmit(); return true; })()`);
  assert.ok(await waitFor('!!document.querySelector(".modal input[type=password]")'));
  await js(`document.querySelector('.modal').requestSubmit()`);
  assert.ok(await waitFor('document.querySelector(".session[style*=flex] .rdp-overlay")?.innerText.includes("Could not reach the server") || document.querySelector(".session[style*=flex] .rdp-overlay")?.innerText.includes("Cannot reach")', 20000), 'direct failure');
  step('direct RDP failure path still reports an error');

  const real = errors.filter((e) => !/Autofill|DevTools/.test(e));
  assert.deepStrictEqual(real, [], `renderer errors: ${real.join(' | ')}`);
  step('no renderer errors');
  console.log('Smoke tests passed');
  ws.close();
  finish(0);
})().catch((e) => { console.error('SMOKE FAIL:', e.message || e); console.log(mainLog.trim().split('\n').slice(-12).join('\n')); finish(1); });
