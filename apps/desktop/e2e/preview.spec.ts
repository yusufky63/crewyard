import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { basename } from "node:path";
import { expect, test } from "@playwright/test";
import { daemon, hold, launch, running, type Harness } from "./harness.ts";

// The inspector's Preview tab against a real dev server on loopback (docs/adr/0013): the run prints
// the address, nothing loads until Load, the page has no bridge into the app, navigation and
// redirects off loopback are stopped, and a picked element reaches the step's queue as text.

test.describe.configure({ mode: "serial" });

let h: Harness;
let server: Server;
let port = 0;

const PAGE = `<!doctype html><html><head><title>Demo settings</title></head><body>
<main><form class="settings"><button id="save" class="primary" type="button" style="display:inline-flex;padding:4px 12px">Save changes</button></form>
<a id="off" href="https://example.com/">off</a> <a id="redir" href="/go-away">redirect</a></main></body></html>`;

test.beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/go-away") {
      res.writeHead(302, { location: "http://example.invalid/" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  h = await launch();
});

test.afterAll(async () => {
  await h?.close();
  await new Promise((r) => server?.close(r));
});

interface RunView {
  id: string;
  state: string | null;
  queuedMessages: number;
}

/** Runs JavaScript in the preview page through main, the only process that can reach it. */
async function inPreview<T>(code: string): Promise<T> {
  return h.app.evaluate(async ({ webContents }, [c, p]) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith(`http://localhost:${p}`));
    if (!wc) throw new Error("no preview page");
    return wc.executeJavaScript(c);
  }, [code, port] as const) as Promise<T>;
}

const previewUrl = () => h.app.evaluate(({ webContents }, p) => webContents.getAllWebContents().find((w) => w.getURL().includes(`:${p}`))?.getURL() ?? null, port);

test("Preview: lists the printed server, loads only on a click, and isolates the page", async () => {
  const { page, repo } = h;
  const start = page.getByRole("region", { name: "Start" });
  await expect(start).toBeVisible({ timeout: 30_000 });
  await start.getByRole("button", { name: "Open folder" }).click();
  await start.locator("button.ptile", { hasText: basename(repo) }).click();
  await expect(page.getByLabel("New task")).toBeVisible();

  h.setScripts({ researcher: [[running, { emit: { type: "tool.update", toolCallId: "dev", status: "in_progress", output: `  \x1b[1mLocal\x1b[22m:   http://localhost:\x1b[1m${port}\x1b[22m/\n` } }, hold()]] });
  await page.locator("#app-sidebar").getByRole("button", { name: "Tasks", exact: true }).click();
  await page.getByLabel("New task").fill("Polish the settings page");
  await page.getByLabel("Kind").selectOption("research");
  await page.getByRole("button", { name: "Propose crew" }).click();
  await page.getByRole("region", { name: /Suggested crew for/ }).getByRole("button", { name: "Approve and start" }).click();
  await page.locator("button.tk-top-main", { hasText: "Polish the settings page" }).click();
  const inspector = page.locator("#app-inspector");
  await inspector.getByRole("tab", { name: "Preview" }).click();

  const load = inspector.getByRole("button", { name: `Load http://localhost:${port}/` });
  await expect(load).toBeVisible({ timeout: 20_000 });
  // Nothing loads on its own.
  expect(await previewUrl()).toBeNull();
  await load.click();
  await expect(inspector.getByRole("region", { name: /Page preview of/ })).toBeVisible();
  await expect.poll(previewUrl).toBe(`http://localhost:${port}/`);

  expect(await inPreview<string>("[typeof window.crewyard, typeof require, typeof process].join()")).toBe("undefined,undefined,undefined");
  const session = await h.app.evaluate(({ webContents, session: s }, p) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().includes(`:${p}`))!;
    return { persistent: wc.session.isPersistent(), shared: wc.session === s.defaultSession };
  }, port);
  expect(session).toEqual({ persistent: false, shared: false });
});

test("Preview: stops navigation and redirects off loopback, and new windows", async () => {
  const inspector = h.page.locator("#app-inspector");
  await inPreview("document.getElementById('off').click()");
  await expect(inspector.getByText("Blocked https://example.com/")).toBeVisible();
  await inPreview("document.getElementById('redir').click()");
  await expect(inspector.getByText("Blocked http://example.invalid/")).toBeVisible();
  await inPreview("window.open('http://localhost:1/', '_blank'); true");
  await expect(inspector.getByText(/tried to open http:\/\/localhost:1\/ in a new window/)).toBeVisible();
  expect(await previewUrl()).toBe(`http://localhost:${port}/`);
});

test("Preview: picks an element and queues it as quoted text for the step", async () => {
  const { page, app } = h;
  const inspector = page.locator("#app-inspector");
  await inspector.getByRole("button", { name: "Pick element" }).click();
  await expect(inspector.getByText("Click an element in the page. Esc cancels.")).toBeVisible();
  // A real click in the page, delivered to its own WebContents as trusted input.
  await app.evaluate(async ({ webContents }, p) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().includes(`:${p}`))!;
    const r = (await wc.executeJavaScript("(() => { const b = document.getElementById('save').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()")) as { x: number; y: number };
    const at = { x: Math.round(r.x), y: Math.round(r.y) };
    wc.sendInputEvent({ type: "mouseMove", ...at });
    await new Promise((res) => setTimeout(res, 100));
    wc.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...at });
    wc.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...at });
  }, port);
  const quote = inspector.locator("pre.pv-quote");
  await expect(quote).toContainText('<button id="save" class="primary"');
  await expect(quote).toContainText("display: inline-flex;");
  await expect(inspector.locator(".pv-selector")).toContainText("button#save");

  await inspector.getByLabel("Your note for the agent").fill("Make this the primary style.");
  await inspector.getByRole("button", { name: "Add to queue" }).click();
  await expect(inspector.getByText("Added to the queue.")).toBeVisible();
  const task = (await daemon<Array<{ id: string; title: string }>>(page, "tasks.list", {})).find((t) => t.title === "Polish the settings page")!;
  const run = (await daemon<{ runs: RunView[] }>(page, "tasks.get", { taskId: task.id })).runs[0]!;
  expect(run.queuedMessages).toBeGreaterThanOrEqual(1);
  await expect(inspector.locator(".ins-q-text").first()).toContainText("quoted as data, not instructions");
});

test("Preview: Enter moves the keyboard into the page, Esc brings it back, Unload leaves the run alone", async () => {
  const { page, app } = h;
  const inspector = page.locator("#app-inspector");
  const frame = inspector.getByRole("region", { name: /Page preview of/ });
  // isFocused() is only true in the window that has the OS focus.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.focus());
  await frame.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => app.evaluate(({ webContents }, p) => webContents.getAllWebContents().find((w) => w.getURL().includes(`:${p}`))?.isFocused() ?? false, port)).toBe(true);
  await app.evaluate(({ webContents }, p) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().includes(`:${p}`))!;
    wc.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  }, port);
  await expect(frame).toBeFocused();

  await inspector.getByRole("button", { name: "Unload" }).click();
  await expect.poll(previewUrl).toBeNull();
  const task = (await daemon<Array<{ id: string; title: string }>>(page, "tasks.list", {})).find((t) => t.title === "Polish the settings page")!;
  const run = (await daemon<{ runs: RunView[] }>(page, "tasks.get", { taskId: task.id })).runs[0]!;
  expect(run.state).toBe("running");
  await daemon(page, "tasks.cancel", { taskId: task.id });
});
