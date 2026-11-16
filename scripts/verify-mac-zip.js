// Structural checks on the generated macOS zips (we cannot run them on Windows).
// Usage: node scripts/verify-mac-zip.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const yauzl = require('yauzl');

const pkg = require('../package.json');
const P = pkg.productName;
const dir = path.join(__dirname, '..', 'release');

function read(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      const map = new Map();
      zip.on('entry', (e) => {
        const mode = (e.externalFileAttributes >>> 16) & 0xffff;
        const rec = { mode, size: e.uncompressedSize, data: null };
        map.set(e.fileName, rec);
        const needData = /Info\.plist$/.test(e.fileName) && !e.fileName.includes('Electron Framework') || /\.command$|\.txt$/.test(e.fileName) || (mode & 0o170000) === 0o120000;
        if (!needData || /\/$/.test(e.fileName)) return zip.readEntry();
        zip.openReadStream(e, (er, rs) => {
          if (er) return reject(er);
          const b = [];
          rs.on('data', (d) => b.push(d));
          rs.on('end', () => { rec.data = Buffer.concat(b); zip.readEntry(); });
        });
      });
      zip.on('end', () => resolve(map));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

(async () => {
  for (const arch of ['arm64', 'x64']) {
    const file = path.join(dir, `${P}-${pkg.version}-mac-${arch}.zip`);
    assert.ok(fs.existsSync(file), `${file} missing`);
    const z = await read(file);
    const app = `${P}.app`;
    const c = (name) => z.get(`${app}/${name}`);

    // main executable renamed and executable
    const bin = c(`Contents/MacOS/${P}`);
    assert.ok(bin, 'renamed main binary missing');
    assert.ok((bin.mode & 0o111) !== 0, 'main binary not executable');
    assert.ok(!c('Contents/MacOS/Electron'), 'old Electron binary name still present');

    // our code and icon
    assert.ok(c('Contents/Resources/app.asar')?.size > 1e6, 'app.asar missing/small');
    assert.ok(c('Contents/Resources/icon.icns')?.size > 1e5, 'icon.icns missing');
    assert.ok(!c('Contents/Resources/electron.icns'), 'default icon still present');
    assert.ok(c('Contents/Resources/app.asar.unpacked/node_modules/ssh2/package.json'), 'unpacked ssh2 missing');

    // Info.plist
    const plist = c('Contents/Info.plist').data.toString('utf8');
    for (const [k, v] of [['CFBundleExecutable', P], ['CFBundleName', P], ['CFBundleIdentifier', pkg.build.appId], ['CFBundleIconFile', 'icon.icns']]) {
      assert.ok(new RegExp(`<key>${k}</key>\\s*<string>${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</string>`).test(plist), `Info.plist ${k} != ${v}`);
    }

    // Helper apps: stock names (Electron's lookup) but our bundle ids
    const helperPlists = [...z.keys()].filter((n) => /Frameworks\/Electron Helper[^/]*\.app\/Contents\/Info\.plist$/.test(n));
    assert.strictEqual(helperPlists.length, 4, `expected 4 helper apps, found ${helperPlists.length}`);
    for (const n of helperPlists) {
      const x = z.get(n).data.toString('utf8');
      assert.ok(x.includes(`<string>${pkg.build.appId}.helper`), `${n} bundle id not rebranded`);
      assert.ok(!x.includes('com.github.Electron'), `${n} still has the Electron bundle id`);
    }

    // Framework symlinks survived (macOS frameworks are broken without them)
    const links = [...z.entries()].filter(([n, r]) => n.startsWith(`${app}/`) && (r.mode & 0o170000) === 0o120000);
    assert.ok(links.length >= 5, `expected framework symlinks, found ${links.length}`);
    const cur = z.get(`${app}/Contents/Frameworks/Electron Framework.framework/Versions/Current`);
    assert.ok(cur && (cur.mode & 0o170000) === 0o120000 && cur.data.toString() === 'A', 'Versions/Current symlink broken');

    // helpers
    const inst = z.get(`Install ${P}.command`);
    assert.ok(inst && (inst.mode & 0o111) !== 0, 'installer not executable');
    const script = inst.data.toString();
    assert.ok(script.startsWith('#!/bin/bash') && script.includes('xattr -cr') && script.includes('codesign'), 'installer content');
    assert.ok(!script.includes('\r'), 'installer has CRLF line endings');
    assert.ok(z.get('READ ME FIRST.txt'));

    // native arch of the Electron binary
    const sample = [...z.keys()].find((n) => n.includes('Electron Framework.framework/Versions/A/Electron Framework'));
    assert.ok(sample, 'Electron Framework binary missing');
    console.log(`ok  ${path.basename(file)}: ${z.size} entries, ${links.length} symlinks, binary + plist + icon + installer verified`);
  }
  console.log('Mac zip checks passed');
})().catch((e) => { console.error('VERIFY FAIL:', e.message); process.exit(1); });
