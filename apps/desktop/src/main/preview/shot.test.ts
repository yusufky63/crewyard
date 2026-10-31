import { describe, expect, it } from "vitest";
import type { Rectangle, WebContents } from "electron";
import { captureShot, pickBox, SHOT_LIMITS, shotName, shotRect, shotSize } from "./shot.ts";

const VIEW = { width: 800, height: 600 };

describe("pickBox", () => {
  it("reads the element's box from the picker's answer", () => {
    expect(pickBox({ x: 10.5, y: -4, width: 132, height: 34, html: "<b></b>" })).toEqual({ x: 10.5, y: -4, width: 132, height: 34 });
  });

  it("refuses a box the page shaped wrongly", () => {
    expect(pickBox(null)).toBeNull();
    expect(pickBox({ x: "1", y: 0, width: 10, height: 10 })).toBeNull();
    expect(pickBox({ x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 10 })).toBeNull();
    expect(pickBox({ x: 0, y: 0, width: 0, height: 10 })).toBeNull();
    expect(pickBox({ x: Number.NaN, y: 0, width: 5, height: 10 })).toBeNull();
  });
});

describe("shotRect", () => {
  it("grows a fractional box to whole pixels", () => {
    expect(shotRect({ x: 10.4, y: 20.6, width: 100.2, height: 30.1 }, 1, VIEW)).toEqual({ x: 10, y: 20, width: 101, height: 31 });
  });

  it("clamps to the visible part of the view", () => {
    // Scrolled half above the top and running off the right edge.
    expect(shotRect({ x: 700, y: -50, width: 300, height: 100 }, 1, VIEW)).toEqual({ x: 700, y: 0, width: 100, height: 50 });
    // Larger than the view in both directions.
    expect(shotRect({ x: -10, y: -10, width: 5000, height: 5000 }, 1, VIEW)).toEqual({ x: 0, y: 0, width: 800, height: 600 });
  });

  it("gives null when nothing of the element is in sight", () => {
    expect(shotRect({ x: 0, y: 700, width: 100, height: 40 }, 1, VIEW)).toBeNull();
    expect(shotRect({ x: -200, y: 10, width: 100, height: 40 }, 1, VIEW)).toBeNull();
    expect(shotRect({ x: 900, y: 10, width: 100, height: 40 }, 1, VIEW)).toBeNull();
  });

  it("applies the page zoom and ignores a nonsense one", () => {
    expect(shotRect({ x: 10, y: 10, width: 50, height: 20 }, 2, VIEW)).toEqual({ x: 20, y: 20, width: 100, height: 40 });
    expect(shotRect({ x: 10, y: 10, width: 50, height: 20 }, Number.NaN, VIEW)).toEqual({ x: 10, y: 10, width: 50, height: 20 });
    expect(shotRect({ x: 10, y: 10, width: 50, height: 20 }, 0, VIEW)).toEqual({ x: 10, y: 10, width: 50, height: 20 });
  });
});

describe("shotSize", () => {
  it("leaves an image within the cap alone", () => {
    expect(shotSize(264, 68, SHOT_LIMITS.edge)).toEqual({ width: 264, height: 68 });
  });

  it("scales the longest edge down to the cap, keeping the ratio", () => {
    expect(shotSize(3136, 400, 1568)).toEqual({ width: 1568, height: 200 });
    expect(shotSize(200, 4000, 1000)).toEqual({ width: 50, height: 1000 });
    expect(shotSize(10000, 1, 100)).toEqual({ width: 100, height: 1 });
  });
});

describe("shotName", () => {
  it("names the file after the local time of the pick", () => {
    expect(shotName(new Date(2026, 9, 31, 14, 2, 3))).toBe("pick-20261031-140203.png");
  });
});

/** A NativeImage stand-in whose PNG is as many bytes as it has pixels. */
function image(width: number, height: number, bytesPerPixel = 1) {
  return {
    isEmpty: () => width === 0 || height === 0,
    getSize: () => ({ width, height }),
    resize: (s: { width: number; height: number }) => image(s.width, s.height, bytesPerPixel),
    toPNG: () => Buffer.alloc(Math.round(width * height * bytesPerPixel)),
  };
}

function contents(img: ReturnType<typeof image>, destroyed = false) {
  const asked: Rectangle[] = [];
  const wc = {
    isDestroyed: () => destroyed,
    capturePage: async (r: Rectangle) => {
      asked.push(r);
      return img;
    },
  } as unknown as WebContents;
  return { wc, asked };
}

describe("captureShot", () => {
  const rect = { x: 1, y: 2, width: 3, height: 4 };

  it("captures only the rectangle it was given", async () => {
    const { wc, asked } = contents(image(264, 68));
    const png = await captureShot(wc, rect);
    expect(asked).toEqual([rect]);
    expect(png?.length).toBe(264 * 68);
  });

  it("scales a large capture down to the edge cap", async () => {
    const { wc } = contents(image(3136, 100));
    expect((await captureShot(wc, rect))?.length).toBe(1568 * 50);
  });

  it("shrinks until the PNG fits the size cap", async () => {
    // 1568 x 1568 at 4 bytes a pixel is about 9.8 MB; 0.7 of the edge is still over, 0.49 fits.
    const { wc } = contents(image(1568, 1568, 4));
    const png = await captureShot(wc, rect);
    expect(png).not.toBeNull();
    expect(png!.length).toBeLessThanOrEqual(SHOT_LIMITS.bytes);
  });

  it("gives up rather than send an image over the cap", async () => {
    const { wc } = contents(image(1568, 1568, 400));
    expect(await captureShot(wc, rect)).toBeNull();
  });

  it("gives null for an empty capture or a page that is gone", async () => {
    expect(await captureShot(contents(image(0, 0)).wc, rect)).toBeNull();
    const gone = contents(image(10, 10), true);
    expect(await captureShot(gone.wc, rect)).toBeNull();
    expect(gone.asked).toEqual([]);
  });
});
