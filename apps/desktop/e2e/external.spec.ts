import { spawn, type ChildProcess } from "node:child_process";
import { basename } from "node:path";
import { expect, test } from "@playwright/test";
import { daemon, launch, type Harness } from "./harness.ts";

// Settings → External access (docs/adr/0021): turned on, a client added from the keyboard, its
// config shown, then the real relay started from that config the way Claude Code would start it,
// driven over stdio by a scripted MCP client. What it proposes waits for approval on the Tasks
// screen; revoking it closes the relay; turning access off hides the status bar item.

test.describe.configure({ mode: "serial" });

let h: Harness;
let relay: ChildProcess | null = null;

interface Config {
  clientId: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

test.beforeAll(async () => {
  h = await launch();
  const start = h.page.getByRole("region", { name: "Start" });
  await expect(start).toBeVisible({ timeout: 30_000 });
  await start.getByRole("button", { name: "Open folder" }).click();
  await start.locator("button.ptile", { hasText: basename(h.repo) }).click();
  await expect(h.page.locator("#app-sidebar")).toBeVisible();
});

test.afterAll(async () => {
  relay?.kill();
  await h?.close();
});

/** A scripted MCP client on the relay's stdio: one JSON-RPC message per line. */
function mcpClient(child: ChildProcess) {
  const lines: Array<{ id?: number; result?: { content?: Array<{ text: string }> }; error?: { code: number } }> = [];
  let buf = "";
  child.stdout!.setEncoding("utf8").on("data", (d: string) => {
    buf += d;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      lines.push(JSON.parse(buf.slice(0, nl)) as (typeof lines)[number]);
      buf = buf.slice(nl + 1);
    }
  });
  let id = 0;
  const request = async (method: string, params: unknown) => {
    const n = ++id;
    child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: n, method, params })}\n`);
    await expect.poll(() => lines.some((l) => l.id === n), { timeout: 30_000 }).toBe(true);
    return lines.find((l) => l.id === n)!;
  };
  const tool = async (name: string, args: unknown) => JSON.parse((await request("tools/call", { name, arguments: args })).result!.content![0]!.text) as Record<string, unknown>;
  return { request, tool };
}

test("connects an outside agent that can read and propose, never approve", async () => {
  const { page } = h;
  await page.locator("#app-sidebar").getByRole("button", { name: "Settings" }).click();
  const section = page.locator("#settings-external");
  await section.scrollIntoViewIfNeeded();
  await expect(section.getByRole("heading", { name: "External access" })).toBeVisible();
  await expect(section.getByText("No clients yet.")).toBeVisible();
  const status = page.locator(".sb", { hasText: "External access" });
  await expect(status).toHaveCount(0);

  await section.getByRole("group", { name: "External access" }).getByRole("button", { name: "On" }).click();
  await expect(section.getByText(/listening on a private endpoint/)).toBeVisible();
  await expect(status).toContainText("connected: 0");

  // Keyboard: type a name, Enter adds the client and shows its config.
  await section.getByLabel("New client").fill("Scripted client");
  await page.keyboard.press("Enter");
  const snippets = section.getByRole("group", { name: "Config for Scripted client" });
  await expect(snippets.locator("pre")).toContainText("claude mcp add crewyard --scope user");
  await snippets.getByRole("button", { name: "Codex" }).click();
  await expect(snippets.locator("pre")).toContainText("[mcp_servers.crewyard]");

  const projects = await daemon<Array<{ id: string; name: string }>>(page, "projects.list", undefined);
  const view = await daemon<{ clients: Array<{ id: string }> }>(page, "external.get", undefined);
  const config = await daemon<Config>(page, "external.clientConfig", { clientId: view.clients[0]!.id });

  relay = spawn(config.command, config.args, { env: { ...process.env, ...config.env }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const c = mcpClient(relay);
  await c.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "e2e-client", version: "1" } });
  const listed = await c.tool("list_projects", {});
  expect(JSON.stringify(listed)).toContain(basename(h.repo));
  const proposed = await c.tool("propose_task", { project_id: projects[0]!.id, title: "Tidy the README", kind: "docs" });
  expect(proposed).toMatchObject({ ok: true, status: "proposed" });
  // There is no tool to approve it.
  expect((await c.request("tools/call", { name: "approve_task", arguments: { task_id: proposed.task_id } })).error).toMatchObject({ code: -32602 });

  await expect(section.getByText(/Connected now: 1.*reports itself as e2e-client 1/)).toBeVisible({ timeout: 20_000 });
  await expect(status).toContainText("connected: 1");
  const task = await daemon<{ status: string }>(page, "tasks.get", { taskId: proposed.task_id });
  expect(task.status).toBe("proposed");

  // Revoke asks first, then closes the relay's connection.
  const exited = new Promise<number | null>((r) => relay!.once("exit", r));
  const row = section.getByRole("listitem").filter({ hasText: "Scripted client" });
  await row.getByRole("button", { name: "Revoke" }).click();
  await row.getByRole("button", { name: "Revoke" }).click();
  await exited;
  relay = null;
  await expect(section.getByText("No clients yet.")).toBeVisible();

  await section.getByRole("group", { name: "External access" }).getByRole("button", { name: "Off" }).click();
  await expect(status).toHaveCount(0);
});
