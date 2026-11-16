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
// APP_EXE=path\to\packaged.exe tests the packaged build instead of the dev tree.
const flags = [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`];
const app = process.env.APP_EXE
  ? spawn(process.env.APP_EXE, flags, { stdio: ['ignore', 'pipe', 'pipe'] })
  : spawn(electron, [path.join(__dirname, '..'), ...flags], { stdio: ['ignore', 'pipe', 'pipe'] });
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
  assert.ok(await waitFor('(() => { const i = document.querySelector(".brand img.logo"); return !!i && i.complete && i.naturalWidth > 0; })()'), 'logo image did not load');
  step('app starts and renders (logo loaded)');

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

  // ---- split view ----
  const quickOpen = async (host) => {
    await js(`(() => { const i = document.getElementById('quick-host'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'u@${host}'); i.dispatchEvent(new Event('input', { bubbles: true })); i.form.requestSubmit(); return true; })()`);
    assert.ok(await waitFor('!!document.querySelector(".modal input[type=password]")'));
    await js(`document.querySelector('.modal').requestSubmit()`);
    await sleep(400);
  };
  const visibleSessions = () => js(`[...document.querySelectorAll('.panes > .session')].filter((s) => s.style.display !== 'none').map((s) => s.querySelector('.session-title').childNodes[0].textContent.trim())`);
  const layoutBtn = (n) => js(`document.querySelectorAll('.layout-switch button')[${[1, 2, 4].indexOf(n)}].click()`);

  // Two sessions are already open from the steps above (gateway entry + quick 127.0.0.1:3389).
  assert.strictEqual(await js(`document.querySelectorAll('.panes > .session').length`), 2, 'expected 2 open sessions before split tests');
  // Mark the first session's DOM node; if split view remounted it, the mark would be gone.
  await js(`document.querySelectorAll('.panes > .session')[0].__itvrMark = 'same-node'; true`);

  await layoutBtn(4);
  await sleep(300);
  assert.ok(await js('!!document.querySelector(".panes.split.split-4")'), '4-pane grid not shown');
  assert.strictEqual((await visibleSessions()).length, 2, 'both open sessions should be on screen');
  assert.strictEqual(await js('document.querySelectorAll(".pane-empty").length'), 2, 'two empty panes expected');
  const cells = await js(`[...document.querySelectorAll('.panes > .pane')].map((p) => p.style.gridColumn + '/' + p.style.gridRow).sort().join(' ')`);
  assert.strictEqual(cells, '1/1 1/2 2/1 2/2', `grid cells: ${cells}`);
  assert.strictEqual(await js(`document.querySelectorAll('.panes > .session')[0].__itvrMark`), 'same-node', 'session was remounted when entering split view');
  step('4-pane view: 2 sessions + 2 empty panes, sessions not remounted');

  // Opening another session fills an empty pane and gets focus.
  await quickOpen('127.0.0.1:3392');
  assert.strictEqual((await visibleSessions()).length, 3);
  assert.strictEqual(await js('document.querySelectorAll(".pane-empty").length'), 1);
  assert.ok(await js(`document.querySelector('.pane-focused .session-title')?.textContent.includes('3392')`), 'new session should be in the focused pane');
  step('new session fills an empty pane and is focused');

  // Clicking a pane focuses it.
  await js(`(() => { const p = [...document.querySelectorAll('.panes > .session')].find((s) => s.style.display !== 'none' && !s.classList.contains('pane-focused')); p.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return true; })()`);
  await sleep(200);
  assert.strictEqual(await js('document.querySelectorAll(".pane-focused").length'), 1, 'exactly one focused pane');
  step('clicking a pane moves focus to it');

  // 2-pane view keeps two, the third stays open (hidden) and can be shown via its tab.
  await layoutBtn(2);
  await sleep(300);
  assert.ok(await js('!!document.querySelector(".panes.split-2")'));
  assert.strictEqual((await visibleSessions()).length, 2);
  assert.strictEqual(await js('document.querySelectorAll(".pane-empty").length'), 0);
  const hiddenName = await js(`[...document.querySelectorAll('.tabbar .tab')].slice(1).find((t) => !t.classList.contains('active') && !t.classList.contains('shown'))?.innerText`);
  assert.ok(hiddenName, 'one session tab should be off screen');
  await js(`[...document.querySelectorAll('.tabbar .tab')].slice(1).find((t) => !t.classList.contains('active') && !t.classList.contains('shown')).click()`);
  await sleep(300);
  assert.ok(await js(`document.querySelector('.pane-focused .session-title')?.textContent.trim().length > 0`));
  assert.strictEqual((await visibleSessions()).length, 2);
  step('2-pane view; clicking an off-screen tab shows it in the focused pane');

  // Closing a session in split view refills the pane with an off-screen one.
  await js(`document.querySelector('.tabbar .tab.active .x').click()`);
  await sleep(300);
  assert.strictEqual((await visibleSessions()).length, 2, 'freed pane should be refilled');
  step('closing a tab refills its pane');

  // Back to single view: exactly one session visible, session nodes still the same.
  await layoutBtn(1);
  await sleep(300);
  assert.ok(!(await js('!!document.querySelector(".panes.split")')));
  assert.strictEqual((await visibleSessions()).length, 1);
  assert.strictEqual(await js(`[...document.querySelectorAll('.panes > .session')].some((s) => s.__itvrMark === 'same-node')`), true, 'session remounted on leaving split view');
  assert.strictEqual(await js(`localStorage.getItem('itvr.layout')`), '1');
  step('single view restored without remounting sessions');

  // ---- clipboard bridge (main process, not navigator.clipboard) ----
  const clip = await js(`(async () => { const s = 'ITVR clip test é ✓ ' + Date.now(); await window.api.clipboardWrite(s); const back = await window.api.clipboardRead(); return { ok: back === s }; })()`);
  assert.strictEqual(clip.ok, true, 'clipboard write/read round trip through the main process failed');
  step('clipboard round trip through the main process');

  // ---- multi-execute, end to end with a real in-process SSH server ----
  const received = [];
  const hostKey = require('crypto').generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
  const sshServer = new (require('ssh2').Server)({ hostKeys: [hostKey] }, (client) => {
    const rec = { data: '' };
    received.push(rec);
    client.on('authentication', (ctx) => ctx.accept());
    client.on('ready', () => client.on('session', (accept) => {
      const session = accept();
      session.on('pty', (acc) => acc && acc());
      session.on('window-change', (acc) => acc && acc());
      session.on('shell', (acc) => { const st = acc(); st.write('$ '); st.on('data', (d) => { rec.data += d.toString(); st.write(d); }); });
    }));
    client.on('error', () => {});
  });
  await new Promise((r) => sshServer.listen(0, '127.0.0.1', r));
  const sshPort = sshServer.address().port;

  await js(`(async () => { const a = window.api; for (const n of ['Multi A', 'Multi B', 'Multi C']) await a.save({ type: 'ssh', name: n, host: '127.0.0.1', port: ${sshPort}, username: 'u', password: 'p' }); return true; })()`);
  await call('Page.reload');
  await sleep(1500);
  assert.ok(await waitFor('!!document.querySelector(".tree .node")'));
  await js(`window.confirm = () => true; document.querySelector('.layout-switch button:nth-child(2)').click(); true`); // 2-pane view
  await sleep(300);
  const treeRoot = await js(`!![...document.querySelectorAll('.node .label')].find((l) => l.textContent === 'Multi A')`);
  assert.ok(treeRoot, 'SSH test entries missing from the tree');
  const openEntry = async (name) => js(`[...document.querySelectorAll('.node .label')].find((l) => l.textContent === ${JSON.stringify(name)}).closest('.node').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await openEntry('Multi A');
  assert.ok(await waitFor(`document.querySelectorAll('.tabbar .dot.connected').length >= 1`, 15000), 'first SSH session did not connect');
  await openEntry('Multi B');
  assert.ok(await waitFor(`document.querySelectorAll('.tabbar .dot.connected').length >= 2`, 15000), 'second SSH session did not connect');
  assert.strictEqual(received.length, 2, 'fake server should have two connections');

  // multi-execute is offered and needs confirmation (confirm is auto-accepted in this test)
  assert.ok(await js(`!document.querySelector('.layout-switch .multi-toggle').disabled`), 'multi-execute button should be enabled with 2 connected panes');
  await js(`document.querySelector('.layout-switch .multi-toggle').click(); true`);
  assert.ok(await waitFor(`!!document.querySelector('.multi-banner')`), 'multi-execute banner not shown');
  assert.ok(await js(`document.querySelectorAll('.pane-multi').length === 2`), 'both panes should be marked');
  assert.ok(await js(`document.querySelector('.multi-banner').innerText.includes('2 included sessions')`));

  // Type like a person: one real key event per character, then Enter.
  const typeInFocused = async (text) => {
    await js(`document.querySelector('.pane-focused .xterm-helper-textarea').focus(); true`);
    const key = (ch) => (ch === ' ' ? { key: ' ', code: 'Space', vk: 32 } : { key: ch, code: /[a-z]/i.test(ch) ? `Key${ch.toUpperCase()}` : `Digit${ch}`, vk: ch.toUpperCase().charCodeAt(0) });
    for (const ch of text) {
      const k = key(ch);
      await call('Input.dispatchKeyEvent', { type: 'keyDown', key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, text: ch });
      await call('Input.dispatchKeyEvent', { type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.vk });
    }
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  };
  const pasteInFocused = async (text) => js(`(() => {
    const ta = document.querySelector('.pane-focused .xterm-helper-textarea'); ta.focus();
    const dt = new DataTransfer(); dt.setData('text/plain', ${JSON.stringify(text)});
    ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return true; })()`);
  const everyone = async (needle) => { for (let i = 0; i < 40; i++) { if (received.every((r) => r.data.includes(needle))) return true; await sleep(250); } return false; };  await typeInFocused('echo one');
  assert.ok(await everyone('echo one'), `both servers should receive the typed text. Got: ${JSON.stringify(received.map((r) => r.data))}`);
  assert.ok(received.every((r) => (r.data.match(/echo one/g) || []).length === 1), 'text must arrive exactly once per session (no echo loops)');
  step('multi-execute: typing in one SSH pane reaches both servers exactly once');

  await pasteInFocused('pasted-text');
  assert.ok(await everyone('pasted-text'), `pasted text should reach both servers. Got: ${JSON.stringify(received.map((r) => r.data))}`);
  assert.ok(received.every((r) => (r.data.match(/pasted-text/g) || []).length === 1), 'pasted text must arrive exactly once per session');
  step('multi-execute: pasting in one SSH pane reaches both servers exactly once');

  // Stop: input must go to the focused session only again
  await js(`document.querySelector('.multi-banner button').click(); true`); // Stop
  assert.ok(await waitFor(`!document.querySelector('.multi-banner')`));
  await typeInFocused('echo solo');
  await sleep(1200);
  const solo = received.map((r) => r.data.includes('echo solo'));
  assert.strictEqual(solo.filter(Boolean).length, 1, `after Stop only the focused session may receive input, got ${JSON.stringify(solo)}`);
  step('stopping multi-execute returns to single-pane input');

  // it switches itself off when fewer than two sessions are on screen
  await js(`document.querySelector('.layout-switch .multi-toggle').click(); true`);
  assert.ok(await waitFor(`!!document.querySelector('.multi-banner')`));
  await js(`document.querySelector('.layout-switch button:nth-child(1)').click(); true`); // back to single view
  assert.ok(await waitFor(`!document.querySelector('.multi-banner')`), 'multi-execute must turn off when leaving split view');
  step('multi-execute turns itself off when leaving split view');
  sshServer.close();

  const real = errors.filter((e) => !/Autofill|DevTools/.test(e));
  assert.deepStrictEqual(real, [], `renderer errors: ${real.join(' | ')}`);
  step('no renderer errors');
  console.log('Smoke tests passed');
  ws.close();
  finish(0);
})().catch((e) => { console.error('SMOKE FAIL:', e.message || e); console.log(mainLog.trim().split('\n').slice(-12).join('\n')); finish(1); });
