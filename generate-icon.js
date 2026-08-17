/* ================================================================
   Generate a simple 32x32 purple app icon as PNG
   Pure Node.js — zero dependencies (uses built-in zlib)
   Usage: node generate-icon.js
   ================================================================ */

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcData = Buffer.concat([typeBytes, data]);
  const crcVal = Buffer.alloc(4);
  crcVal.writeUInt32BE(crc32(crcData), 0);
  return Buffer.concat([len, typeBytes, data, crcVal]);
}

function generateIcon(size, r, g, b, alpha) {
  // Build raw pixel data (filter byte + RGB per row)
  const rawData = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    const rowOffset = y * (1 + size * 4);
    rawData[rowOffset] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const cx = x - size / 2 + 0.5;
      const cy = y - size / 2 + 0.5;
      const dist = Math.sqrt(cx * cx + cy * cy);
      const radius = size / 2 - 1;

      const px = rowOffset + 1 + x * 4;
      if (dist < radius - 0.5) {
        rawData[px] = r;     rawData[px + 1] = g;
        rawData[px + 2] = b; rawData[px + 3] = alpha;
      } else if (dist < radius + 0.5) {
        // Anti-aliased edge
        const a = Math.round(alpha * Math.max(0, radius + 0.5 - dist));
        rawData[px] = r;     rawData[px + 1] = g;
        rawData[px + 2] = b; rawData[px + 3] = a;
      } else {
        rawData[px] = rawData[px + 1] = rawData[px + 2] = rawData[px + 3] = 0;
      }
    }
  }

  // DEFLATE compress the raw data
  const compressed = zlib.deflateSync(rawData);

  // Build PNG file
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = ihdr[11] = ihdr[12] = 0;

  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// Generate and save
const sizes = [32, 192, 512];
const outDir = path.join(__dirname, 'assets');

sizes.forEach(size => {
  const png = generateIcon(size, 99, 102, 241, 255);
  const fname = size === 32 ? 'tray-icon.png' : `icon-${size}.png`;
  fs.writeFileSync(path.join(outDir, fname), png);
  console.log(`  ✓ ${fname} (${size}×${size}, ${png.length} bytes)`);
});

// Also save a copy as icon.png for electron-builder
const appIcon = generateIcon(256, 99, 102, 241, 255);
fs.writeFileSync(path.join(outDir, 'icon.png'), appIcon);
console.log(`  ✓ icon.png (256×256, ${appIcon.length} bytes)`);
console.log('\nIcons generated in assets/');
