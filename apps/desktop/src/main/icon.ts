// The tray icon is the title-bar mark (a hairline square with a filled core, app.css `.mark`)
// drawn in code, so no binary asset is needed and it can follow the taskbar's light or dark theme.
// An amber dot in the corner means something needs you. Colors are the token values (DESIGN.md §3).

const INK = { dark: [0xed, 0xed, 0xef], light: [0x11, 0x11, 0x13] } as const;
const FRAME = { dark: [0x8c, 0x8c, 0x95], light: [0x62, 0x62, 0x6b] } as const;
const WARN = { dark: [0xf0, 0xb4, 0x4c], light: [0x93, 0x56, 0x00] } as const;

/** BGRA pixels, as nativeImage.createFromBitmap expects them. */
export function drawMark(size: number, opts: { dark: boolean; badge: boolean }): Buffer {
  const theme = opts.dark ? "dark" : "light";
  const buf = Buffer.alloc(size * size * 4);
  const put = (x: number, y: number, [r, g, b]: readonly number[]) => {
    const i = (y * size + x) * 4;
    buf[i] = b ?? 0;
    buf[i + 1] = g ?? 0;
    buf[i + 2] = r ?? 0;
    buf[i + 3] = 255;
  };
  const line = Math.max(1, Math.round(size / 16));
  const inset = Math.round(size / 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const edge = x < line || y < line || x >= size - line || y >= size - line;
      const core = x >= inset && y >= inset && x < size - inset && y < size - inset;
      if (edge) put(x, y, FRAME[theme]);
      else if (core) put(x, y, INK[theme]);
    }
  }
  if (opts.badge) {
    const r = size * 0.22;
    const c = size - r - 0.5;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const d = Math.hypot(x + 0.5 - c - 0.5, y + 0.5 - c - 0.5);
        if (d <= r) put(x, y, WARN[theme]);
      }
    }
  }
  return buf;
}
