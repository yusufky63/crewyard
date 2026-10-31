// Draws the app icon from the title-bar brand mark (app.css `.mark`: a 16 px square with a 1 px
// ink-3 border and an ink square inset 4 px inside it) on the dark canvas tile, and writes:
//   build/icon.ico    Windows, 16-256 px PNG frames
//   build/icon.png    512 px, the same square tile
//   build/icon.icns   macOS, 16-1024 px PNG entries, the tile on Apple's app-icon grid (rounded,
//                     with the transparent margin the Dock expects)
//   build/icons/      Linux hicolor set, <size>x<size>.png, the square tile
// Colors come from the dark tokens, so the icon matches the title bar. Every size is drawn, not
// scaled, and the output is byte-for-byte reproducible: re-run with `pnpm icon` after the mark
// changes and commit what it writes. No image library or platform tool is needed (iconutil would
// tie the .icns to a Mac).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
// Apple's macOS app-icon grid: an 824 px tile on a 1024 px canvas, corners of about 185 px. A
// full-bleed square would sit larger than every other icon in the Dock and Finder.
const MAC_TILE = 824 / 1024;
const MAC_RADIUS = 185 / 824;

/**
 * One icon as a PNG. "square" fills the canvas with the tile (Windows, Linux, icon.png); "macos"
 * draws a rounded tile on a transparent canvas. The mark always spans MARK_SPAN of the tile.
 */
function render(size, shape = "square") {
  const px = Buffer.alloc(size * size * 4);
  const tile = shape === "macos" ? size * MAC_TILE : size;
  const inset = (size - tile) / 2;
  const radius = shape === "macos" ? tile * MAC_RADIUS : 0;
  const unit = (tile * MARK_SPAN) / 16;
  const origin = inset + (tile - unit * 16) / 2;
  const inTile = (x, y) => {
    const tx = x - inset;
    const ty = y - inset;
    if (tx < 0 || ty < 0 || tx >= tile || ty >= tile) return false;
    if (radius === 0) return true;
    const cx = Math.min(Math.max(tx, radius), tile - radius);
    const cy = Math.min(Math.max(ty, radius), tile - radius);
    return (tx - cx) ** 2 + (ty - cy) ** 2 <= radius ** 2;
  };
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
      let covered = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const sxp = x + (sx + 0.5) / SAMPLES;
          const syp = y + (sy + 0.5) / SAMPLES;
          if (!inTile(sxp, syp)) continue;
          const c = colorAt(sxp, syp);
          for (let i = 0; i < 3; i++) sum[i] += c[i];
          covered++;
        }
      }
      // Color is the average over the samples inside the tile and alpha is their share, so the
      // square tile (every sample inside) comes out exactly as it always has.
      const o = (y * size + x) * 4;
      for (let i = 0; i < 3; i++) px[o + i] = covered ? Math.round(sum[i] / covered) : 0;
      px[o + 3] = Math.round((covered / (SAMPLES * SAMPLES)) * 255);
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

// ICNS element types that carry PNG data (macOS 10.7 and later), with the pixel size each holds.
// The pairs mirror an .iconset folder: icon_16x16 (icp4), icon_16x16@2x (ic11), icon_32x32 (icp5),
// icon_32x32@2x (ic12), icon_128x128 (ic07), @2x (ic13), icon_256x256 (ic08), @2x (ic14),
// icon_512x512 (ic09), @2x (ic10).
const ICNS_TYPES = [
  ["icp4", 16],
  ["ic11", 32],
  ["icp5", 32],
  ["ic12", 64],
  ["ic07", 128],
  ["ic13", 256],
  ["ic08", 256],
  ["ic14", 512],
  ["ic09", 512],
  ["ic10", 1024],
];

/** ICNS: "icns" and the file length, then one (type, length incl. 8-byte header, data) element per size. */
function icns(elements) {
  const parts = elements.map(({ type, data }) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, "ascii");
    head.writeUInt32BE(8 + data.length, 4);
    return Buffer.concat([head, data]);
  });
  const head = Buffer.alloc(8);
  head.write("icns", 0, "ascii");
  head.writeUInt32BE(8 + parts.reduce((n, p) => n + p.length, 0), 4);
  return Buffer.concat([head, ...parts]);
}

const out = join(here, "..", "build");
mkdirSync(out, { recursive: true });
const icoSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
writeFileSync(join(out, "icon.ico"), ico(icoSizes.map((size) => ({ size, data: render(size) }))));
writeFileSync(join(out, "icon.png"), render(512));

const macBySize = new Map();
const mac = (size) => macBySize.get(size) ?? macBySize.set(size, render(size, "macos")).get(size);
writeFileSync(join(out, "icon.icns"), icns(ICNS_TYPES.map(([type, size]) => ({ type, data: mac(size) }))));

// electron-builder reads a folder of <size>x<size>.png for linux.icon and installs each into the
// hicolor theme; some docks ignore a lone large PNG, so every common size is drawn.
const linuxSizes = [16, 24, 32, 48, 64, 128, 256, 512];
mkdirSync(join(out, "icons"), { recursive: true });
for (const size of linuxSizes) writeFileSync(join(out, "icons", `${size}x${size}.png`), render(size));

console.log(`wrote ${out}: icon.ico (${icoSizes.join(", ")} px), icon.png (512 px), icon.icns (${[...macBySize.keys()].join(", ")} px), icons/ (${linuxSizes.join(", ")} px)`);
