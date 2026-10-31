// Electron main script used by shots.mjs: scales PNG screenshots down and encodes them as WebP with
// Chromium's own encoder, so the site needs no image library of its own. Run as
//   electron webp-encode.cjs <jobs.json>
// where jobs.json is [{ "input": "a.png", "output": "a.webp", "width": 1920, "quality": 0.86 }].
// It writes <jobs.json>.result.json with each output's width and height, then quits.
const { app, BrowserWindow } = require("electron");
const { readFileSync, writeFileSync } = require("node:fs");

const jobsFile = process.argv[process.argv.length - 1];

// Runs inside a blank page: draw the PNG scaled with high-quality smoothing, encode as WebP.
const ENCODE = `async (png, width, quality) => {
  const img = new Image();
  img.src = "data:image/png;base64," + png;
  await img.decode();
  const scale = Math.min(1, width / img.naturalWidth);
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext("2d");
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.drawImage(img, 0, 0, w, h);
  const url = canvas.toDataURL("image/webp", quality);
  if (!url.startsWith("data:image/webp")) throw new Error("this Chromium cannot encode WebP");
  return { width: w, height: h, data: url.slice(url.indexOf(",") + 1) };
}`;

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  let code = 0;
  try {
    const jobs = JSON.parse(readFileSync(jobsFile, "utf8"));
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await win.loadURL("data:text/html;charset=utf-8,<!doctype html><title>encode</title>");
    const results = [];
    for (const job of jobs) {
      const png = readFileSync(job.input).toString("base64");
      const out = await win.webContents.executeJavaScript(`(${ENCODE})(${JSON.stringify(png)}, ${Number(job.width)}, ${Number(job.quality)})`);
      writeFileSync(job.output, Buffer.from(out.data, "base64"));
      results.push({ output: job.output, width: out.width, height: out.height });
    }
    writeFileSync(`${jobsFile}.result.json`, JSON.stringify(results));
  } catch (err) {
    console.error(err);
    code = 1;
  }
  app.exit(code);
});
