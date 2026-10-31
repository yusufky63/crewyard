import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

// Checks the committed output of `pnpm icon` (make-icon.mjs): electron-builder packs these files as
// they are, so a broken .icns would only show on a Mac.
const build = join(import.meta.dirname, "..", "build");

interface Png {
  width: number;
  height: number;
  /** RGBA at (x, y). */
  pixel(x: number, y: number): number[];
}

/** Reads the PNGs make-icon.mjs writes: 8-bit RGBA, one IDAT, every row with filter 0. */
function readPng(buf: Buffer): Png {
  expect(buf.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  for (let o = 8; o < buf.length; ) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString("ascii", o + 4, o + 8);
    const data = buf.subarray(o + 8, o + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      expect([...data.subarray(8, 13)]).toEqual([8, 6, 0, 0, 0]);
    } else if (type === "IDAT") idat.push(data);
    o += 12 + len;
  }
  const rows = inflateSync(Buffer.concat(idat));
  const stride = width * 4 + 1;
  return {
    width,
    height,
    pixel: (x, y) => {
      expect(rows[y * stride]).toBe(0);
      const o = y * stride + 1 + x * 4;
      return [...rows.subarray(o, o + 4)];
    },
  };
}

// Apple's ICNS element types for PNG data and the pixel size each one must hold.
const ICNS_SIZES: Record<string, number> = { icp4: 16, ic11: 32, icp5: 32, ic12: 64, ic07: 128, ic13: 256, ic08: 256, ic14: 512, ic09: 512, ic10: 1024 };

describe("macOS icon (build/icon.icns)", () => {
  const file = readFileSync(join(build, "icon.icns"));
  const elements = new Map<string, Buffer>();
  for (let o = 8; o < file.length; ) {
    const len = file.readUInt32BE(o + 4);
    elements.set(file.toString("ascii", o, o + 4), file.subarray(o + 8, o + len));
    o += len;
  }

  it("is a well-formed icns whose length matches the file", () => {
    expect(file.toString("ascii", 0, 4)).toBe("icns");
    expect(file.readUInt32BE(4)).toBe(file.length);
  });

  it("holds every size from 16 to 1024 px, each at the size its type declares", () => {
    expect([...elements.keys()].sort()).toEqual(Object.keys(ICNS_SIZES).sort());
    for (const [type, data] of elements) {
      const png = readPng(data);
      expect([png.width, png.height], type).toEqual([ICNS_SIZES[type], ICNS_SIZES[type]]);
    }
  });

  it("sits on Apple's grid: transparent margin and corners, opaque tile", () => {
    const png = readPng(elements.get("ic10")!);
    expect(png.pixel(0, 0)[3]).toBe(0);
    expect(png.pixel(512, 40)[3]).toBe(0); // the top margin
    expect(png.pixel(110, 110)[3]).toBe(0); // the rounded corner
    expect(png.pixel(512, 150)[3]).toBe(255); // inside the tile, above the mark
    expect(png.pixel(512, 512)[3]).toBe(255);
  });
});

describe("Linux icons (build/icons)", () => {
  it("has a square PNG for each hicolor size, named <size>x<size>.png", () => {
    for (const size of [16, 24, 32, 48, 64, 128, 256, 512]) {
      const png = readPng(readFileSync(join(build, "icons", `${size}x${size}.png`)));
      expect([png.width, png.height]).toEqual([size, size]);
      expect(png.pixel(0, 0)[3]).toBe(255);
    }
  });

  it("draws the same 512 px tile as icon.png", () => {
    expect(readFileSync(join(build, "icons", "512x512.png"))).toEqual(readFileSync(join(build, "icon.png")));
  });
});
