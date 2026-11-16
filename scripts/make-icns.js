// Packs PNGs into a macOS .icns file (PNG-compressed icon entries, macOS 10.7+).
// Usage: node scripts/make-icns.js <dir with 16.png 32.png 64.png 128.png 256.png 512.png 1024.png> <out.icns>
const fs = require('fs');
const path = require('path');

const [dir, out] = process.argv.slice(2);
if (!dir || !out) {
  console.error('usage: node scripts/make-icns.js <png-dir> <out.icns>');
  process.exit(2);
}

// [icns type, png pixel size]
const ENTRIES = [
  ['icp4', 16], ['icp5', 32], ['icp6', 64],
  ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024],
  ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512],
];

const chunks = ENTRIES.map(([type, size]) => {
  const png = fs.readFileSync(path.join(dir, `${size}.png`));
  if (png.readUInt32BE(0) !== 0x89504e47) throw new Error(`${size}.png is not a PNG`);
  const head = Buffer.alloc(8);
  head.write(type, 0, 'ascii');
  head.writeUInt32BE(png.length + 8, 4);
  return Buffer.concat([head, png]);
});
const body = Buffer.concat(chunks);
const header = Buffer.alloc(8);
header.write('icns', 0, 'ascii');
header.writeUInt32BE(body.length + 8, 4);
fs.writeFileSync(out, Buffer.concat([header, body]));
console.log(`wrote ${out} (${ENTRIES.length} images, ${body.length + 8} bytes)`);
