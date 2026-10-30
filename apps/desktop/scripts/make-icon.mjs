// Draws the app icon from the title-bar brand mark (app.css `.mark`: a 16 px square with a 1 px
// ink-3 border and an ink square inset 4 px inside it) on the dark canvas tile, and writes
// build/icon.ico (16-256 px, PNG frames) and build/icon.png (512 px). Colors come from the dark
// tokens, so the icon matches the title bar. Re-run with `pnpm icon` after the mark changes.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";

const here = import.meta.dirname;
const root = join(here, "..", "..", "..");
const dark = JSON.parse(readFileSync(join(root, "design", "tokens", "dark.json"), "utf8"));
const token = (path) => path.split(".").reduce((o, k) => o[k], dark).$value;
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const CANVAS = rgb(token("color.bg.canvas"));
const BORDER = rgb(token("color.ink.muted"));
const INK = rgb(token("color.ink.primary"));

// The mark in its own 16-unit space, as rectangles painted in order.
const MARK = [
  { x: 0, y: 0, w: 16, h: 16, c: BORDER },
  { x: 1, y: 1, w: 14, h: 14, c: CANVAS },
  { x: 5, y: 5, w: 6, h: 6, c: INK },
];
/** Share of the tile the mark spans; the rest is canvas, so the icon reads as one tile at 16 px. */
const MARK_SPAN = 0.75;
const SAMPLES = 4;

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const unit = (size * MARK_SPAN) / 16;
  const origin = (size - unit * 16) / 2;
  const colorAt = (x, y) => {
    let c = CANVAS;
    const u = (x - origin) / unit;
    const v = (y - origin) / unit;
    for (const r of MARK) if (u >= r.x && u < r.x + r.w && v >= r.y && v < r.y + r.h) c = r.c;
    return c;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sum = [0, 0, 0];
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const c = colorAt(x + (sx + 0.5) / SAMPLES, y + (sy + 0.5) / SAMPLES);
          for (let i = 0; i < 3; i++) sum[i] += c[i];
        }
      }
      const o = (y * size + x) * 4;
      for (let i = 0; i < 3; i++) px[o + i] = Math.round(sum[i] / (SAMPLES * SAMPLES));
      px[o + 3] = 255;
    }
  }
  return png(size, px);
}

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA, no interlace
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/** ICO with PNG frames (Windows Vista and later read these at every size). */
function ico(frames) {
  const header = Buffer.alloc(6 + 16 * frames.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  frames.forEach(({ size, data }, i) => {
    const e = 6 + i * 16;
    header.writeUInt8(size >= 256 ? 0 : size, e);
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...frames.map((f) => f.data)]);
}

const out = join(here, "..", "build");
mkdirSync(out, { recursive: true });
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
writeFileSync(join(out, "icon.ico"), ico(sizes.map((size) => ({ size, data: render(size) }))));
writeFileSync(join(out, "icon.png"), render(512));
console.log(`wrote ${join(dirname(out), "build")}/icon.ico (${sizes.join(", ")} px) and icon.png (512 px)`);
