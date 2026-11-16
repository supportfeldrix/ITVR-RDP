// Builds unsigned macOS app bundles (zip) from Windows, where electron-builder refuses
// to target macOS. The app is platform-neutral JavaScript (no native modules), so we take
// the official Electron macOS release and drop our packed app into it.
//
//   npm run dist:mac-from-win     (runs vite build + electron-builder --win --dir first)
//
// Output per arch: release/ITVR RDP-<version>-mac-<arch>.zip containing
//   ITVR RDP.app, Install ITVR RDP.command, READ ME FIRST.txt
//
// The zip is copied entry by entry (never extracted on Windows) so the framework symlinks
// and executable bits inside the .app survive. Changing the bundle breaks Electron's
// signature, so the included installer re-signs it ad hoc (codesign --sign -), which macOS
// accepts for locally built apps without an Apple Developer account.
'use strict';
const fs = require('fs');
const path = require('path');
const yauzl = require('yauzl');
const yazl = require('yazl');
const { downloadArtifact } = require('@electron/get');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
const ELECTRON_VERSION = require(path.join(ROOT, 'node_modules', 'electron', 'package.json')).version;
const PRODUCT = pkg.productName;
const APP_ID = pkg.build.appId;
const RESOURCES = path.join(ROOT, 'release', 'win-unpacked', 'resources');
const ICNS = path.join(ROOT, 'build', 'icon.icns');
const ARCHES = process.argv.slice(2).length ? process.argv.slice(2) : ['arm64', 'x64'];

const S_IFLNK = 0o120000;
const S_IFDIR = 0o040000;

function plistSet(xml, key, value) {
  const re = new RegExp(`(<key>${key}</key>\\s*<string>)[^<]*(</string>)`);
  if (re.test(xml)) return xml.replace(re, `$1${value}$2`);
  return xml.replace(/<\/dict>\s*<\/plist>\s*$/, `\t<key>${key}</key>\n\t<string>${value}</string>\n</dict>\n</plist>\n`);
}

// Read an Electron mac zip into an ordered list of { name, mode, isDir, isLink, data }.
function readZip(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      const entries = [];
      zip.on('entry', (e) => {
        const mode = (e.externalFileAttributes >>> 16) & 0xffff;
        const isDir = /\/$/.test(e.fileName) || (mode & 0o170000) === S_IFDIR;
        const isLink = (mode & 0o170000) === S_IFLNK;
        if (isDir) { entries.push({ name: e.fileName.replace(/\/$/, ''), mode, isDir: true }); return zip.readEntry(); }
        zip.openReadStream(e, (er, rs) => {
          if (er) return reject(er);
          const bufs = [];
          rs.on('data', (d) => bufs.push(d));
          rs.on('end', () => { entries.push({ name: e.fileName, mode, isLink, data: Buffer.concat(bufs) }); zip.readEntry(); });
          rs.on('error', reject);
        });
      });
      zip.on('end', () => resolve(entries));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

function addFile(zip, name, data, mode) {
  zip.addBuffer(data, name, { mode, mtime: new Date('2020-01-01') });
}

async function buildArch(arch) {
  console.log(`\n== macOS ${arch} ==`);
  const zipPath = await downloadArtifact({ version: ELECTRON_VERSION, platform: 'darwin', artifactName: 'electron', arch });
  const entries = await readZip(zipPath);

  const appName = `${PRODUCT}.app`;
  const out = new yazl.ZipFile();
  let renamedBinary = false;

  for (const e of entries) {
    // Electron.app/... -> ITVR RDP.app/...
    let name = e.name.replace(/^Electron\.app/, appName);
    // Electron.app/Contents/MacOS/Electron -> .../MacOS/ITVR RDP
    if (name === `${appName}/Contents/MacOS/Electron`) { name = `${appName}/Contents/MacOS/${PRODUCT}`; renamedBinary = true; }

    if (e.isDir) continue; // yazl recreates directories from file paths

    if (e.isLink) { out.addBuffer(e.data, name, { mode: e.mode, mtime: new Date('2020-01-01') }); continue; }

    if (name.endsWith('/Contents/Info.plist') && name.startsWith(`${appName}/`) && !name.includes('Frameworks/')) {
      let xml = e.data.toString('utf8');
      xml = plistSet(xml, 'CFBundleName', PRODUCT);
      xml = plistSet(xml, 'CFBundleDisplayName', PRODUCT);
      xml = plistSet(xml, 'CFBundleExecutable', PRODUCT);
      xml = plistSet(xml, 'CFBundleIdentifier', APP_ID);
      xml = plistSet(xml, 'CFBundleIconFile', 'icon.icns');
      addFile(out, name, Buffer.from(xml, 'utf8'), e.mode);
      continue;
    }
    // Helper apps keep their stock "Electron Helper*" names (Electron looks for those first)
    // but their bundle ids/labels should belong to this app, as in a normally packaged build.
    if (/^.+\.app\/Contents\/Frameworks\/Electron Helper[^/]*\.app\/Contents\/Info\.plist$/.test(name)) {
      let xml = e.data.toString('utf8').replace(/com\.github\.Electron/g, APP_ID);
      for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
        xml = xml.replace(new RegExp(`(<key>${key}</key>\\s*<string>)Electron( Helper[^<]*</string>)`), `$1${PRODUCT}$2`);
      }
      addFile(out, name, Buffer.from(xml, 'utf8'), e.mode);
      continue;
    }
    // Replace the default icon.
    if (name === `${appName}/Contents/Resources/electron.icns`) {
      addFile(out, `${appName}/Contents/Resources/icon.icns`, fs.readFileSync(ICNS), e.mode);
      continue;
    }
    addFile(out, name, e.data, e.mode);
  }

  if (!renamedBinary) throw new Error('Did not find the Electron binary to rename; aborting.');

  // Our application code, as app.asar + unpacked native dir, exactly as electron-builder produced for Windows.
  const resBase = `${appName}/Contents/Resources`;
  addFile(out, `${resBase}/app.asar`, fs.readFileSync(path.join(RESOURCES, 'app.asar')), 0o644);
  const unpacked = path.join(RESOURCES, 'app.asar.unpacked');
  if (fs.existsSync(unpacked)) {
    for (const rel of walk(unpacked)) {
      addFile(out, `${resBase}/app.asar.unpacked/${rel.replace(/\\/g, '/')}`, fs.readFileSync(path.join(unpacked, rel)), 0o644);
    }
  }

  // Helper files alongside the app.
  const installer = [
    '#!/bin/bash',
    '# Installs ITVR RDP into /Applications and clears the quarantine flag.',
    'set -e',
    'cd "$(dirname "$0")"',
    'APP="ITVR RDP.app"',
    'DEST="/Applications/$APP"',
    'echo "Installing $APP to /Applications ..."',
    'rm -rf "$DEST"',
    'cp -R "$APP" "$DEST"',
    'xattr -cr "$DEST" || true',
    '# Re-sign ad hoc so Gatekeeper runs the modified bundle (no Apple account needed).',
    'codesign --force --deep --sign - "$DEST" || true',
    'echo "Done. Launching..."',
    'open "$DEST"',
  ].join('\n') + '\n';
  addFile(out, `Install ${PRODUCT}.command`, Buffer.from(installer, 'utf8'), 0o755);

  const readme = [
    `${PRODUCT} for macOS`,
    '',
    'This build is not signed with an Apple Developer certificate, so macOS Gatekeeper',
    'will block it until you allow it. Two ways to run it:',
    '',
    'EASIEST',
    `  Double-click "Install ${PRODUCT}.command". If macOS blocks it, right-click it,`,
    '  choose Open, then Open again. It copies the app to /Applications and launches it.',
    '',
    'MANUAL',
    `  1. Drag "${PRODUCT}.app" to /Applications.`,
    '  2. In Terminal run these two commands:',
    `       xattr -cr "/Applications/${PRODUCT}.app"`,
    `       codesign --force --deep --sign - "/Applications/${PRODUCT}.app"`,
    '     (the second one is required on Apple Silicon Macs, otherwise the app is killed on launch)',
    `  3. Right-click the app > Open > Open.`,
    '',
    'If macOS says the app "is damaged", the quarantine flag is the cause; the xattr',
    'command clears it. codesign comes with the free Xcode Command Line Tools',
    '(run "xcode-select --install" if the Mac asks for them).',
    '',
    'RDP sessions render inside the app. "Open external" uses Microsoft Remote Desktop,',
    'which you can install from the Mac App Store.',
  ].join('\n') + '\n';
  addFile(out, 'READ ME FIRST.txt', Buffer.from(readme, 'utf8'), 0o644);

  const outPath = path.join(ROOT, 'release', `${PRODUCT}-${pkg.version}-mac-${arch}.zip`);
  await new Promise((resolve, reject) => {
    out.outputStream.pipe(fs.createWriteStream(outPath)).on('close', resolve).on('error', reject);
    out.end();
  });
  console.log(`wrote ${path.relative(ROOT, outPath)} (${(fs.statSync(outPath).size / 1048576).toFixed(1)} MB)`);
}

function walk(dir, base = '') {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = path.join(base, name);
    if (fs.statSync(full).isDirectory()) out.push(...walk(full, rel));
    else out.push(rel);
  }
  return out;
}

(async () => {
  if (!fs.existsSync(path.join(RESOURCES, 'app.asar'))) {
    console.error('release/win-unpacked/resources/app.asar not found. Run the Windows --dir build first.');
    process.exit(1);
  }
  if (!fs.existsSync(ICNS)) { console.error('build/icon.icns not found.'); process.exit(1); }
  for (const arch of ARCHES) await buildArch(arch);
  console.log('\nmacOS bundles done.');
})().catch((e) => { console.error('mac build failed:', e.message); process.exit(1); });
