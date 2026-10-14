import { mkdirSync, writeFileSync } from 'node:fs';

// Original telemetry glyph, generated locally without external assets.
const size = 32;
const pixels = Buffer.alloc(size * size * 4);
for (let y = 4; y < 28; y++) {
  for (let x = 4; x < 28; x++) {
    const accent = (x >= 7 && x < 11) || (x >= 14 && x < 25 && y >= 13 && y < 18);
    const index = ((size - 1 - y) * size + x) * 4;
    pixels.set(accent ? [87, 119, 217, 255] : [31, 24, 20, 255], index);
  }
}
const mask = Buffer.alloc(size * size / 8);
const dib = Buffer.alloc(40);
dib.writeUInt32LE(40, 0);
dib.writeInt32LE(size, 4);
dib.writeInt32LE(size * 2, 8);
dib.writeUInt16LE(1, 12);
dib.writeUInt16LE(32, 14);
dib.writeUInt32LE(pixels.length + mask.length, 20);
const header = Buffer.alloc(22);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);
header[6] = size;
header[7] = size;
header.writeUInt16LE(1, 10);
header.writeUInt16LE(32, 12);
header.writeUInt32LE(dib.length + pixels.length + mask.length, 14);
header.writeUInt32LE(header.length, 18);
mkdirSync('src-tauri/icons', { recursive: true });
writeFileSync('src-tauri/icons/icon.ico', Buffer.concat([header, dib, pixels, mask]));
