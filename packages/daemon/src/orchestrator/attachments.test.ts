import { existsSync, mkdirSync, readFileSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";
import { ATTACHMENT_LIMITS, type RunHandle, type StartRequest } from "@crewyard/core";
import type { FakeStep } from "@crewyard/adapter-fake";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../store.ts";
import { AdapterRegistry } from "./adapters.ts";
import { AttachmentStore, STAGED_TTL_MS } from "./attachments.ts";
import { Orchestrator } from "./orchestrator.ts";
import { handoffPackage } from "./prompts.ts";
import { ROLES } from "./roles.ts";
import { CANDIDATES, cleanTemps, ScriptedAdapter, tempDir, tempRepo, waitFor } from "./testing.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const PDF = Buffer.from("%PDF-1.7\n%test\n");
const b64 = (b: Buffer) => b.toString("base64");

const stores: Store[] = [];
const open: Orchestrator[] = [];
afterEach(async () => {
  const all = open.splice(0);
  all.forEach((o) => o.shutdown());
  for (const o of all) await o.settle();
  stores.splice(0).forEach((s) => s.close());
  cleanTemps();
});

function storage(now = () => new Date("2026-10-31T10:00:00Z")) {
  const root = tempDir("crewyard attach-");
  const store = new Store(join(root, "t.db"));
  stores.push(store);
  const dataDir = join(root, "data dir");
  return { store, dataDir, files: new AttachmentStore(store.db, dataDir, now) };
}

describe("attachment storage", () => {
  it("stores an upload in the staging folder under its cleaned name and keeps only metadata in SQLite", () => {
    const { store, dataDir, files } = storage();
    const view = files.add("C:\\Users\\me\\Screen shot 1.png", b64(PNG));
    expect(view).toMatchObject({ kind: "image", name: "Screen shot 1.png", mime: "image/png", bytes: PNG.length });
    const path = join(dataDir, "attachments", "staged", view.id, "Screen shot 1.png");
    expect(readFileSync(path)).toEqual(PNG);
    const row = store.db.prepare("select * from attachments where id = ?").get(view.id) as Record<string, unknown>;
    expect(JSON.stringify(row)).not.toContain(b64(PNG));
    expect(files.preview(view.id)).toBe(`data:image/png;base64,${b64(PNG)}`);
  });

  it("refuses the wrong type, an empty upload, and anything over the size cap of its kind", () => {
    const { files } = storage();
    expect(() => files.add("tool.exe", b64(Buffer.from("MZ\u0090\u0000")))).toThrow("attachment.type");
    expect(() => files.add("cat.png", b64(Buffer.from("not a png")))).toThrow("attachment.type");
    expect(() => files.add("a.txt", "")).toThrow("attachment.empty");
    expect(() => files.add("a.txt", "@@not base64@@")).toThrow("attachment.type");
    const bigImage = Buffer.concat([PNG, Buffer.alloc(ATTACHMENT_LIMITS.imageBytes)]);
    expect(() => files.add("big.png", b64(bigImage))).toThrow("attachment.too_large");
    const bigText = Buffer.alloc(ATTACHMENT_LIMITS.fileBytes + 1, 0x61);
    expect(() => files.add("big.txt", b64(bigText))).toThrow("attachment.too_large");
    // A text file of the same size as the image is fine: files have the larger cap.
    expect(files.add("ok.txt", b64(Buffer.alloc(ATTACHMENT_LIMITS.imageBytes + 1, 0x61))).kind).toBe("file");
    expect(() => files.preview(files.add("n.txt", b64(Buffer.from("x"))).id)).toThrow("attachment.type");
  });

  it("checks the count per message, unknown ids and ids already used, before anything is claimed", () => {
    const { files } = storage();
    const ids = Array.from({ length: ATTACHMENT_LIMITS.perMessage + 1 }, (_, i) => files.add(`n${i}.txt`, b64(Buffer.from(`note ${i}`))).id);
    expect(() => files.check(ids)).toThrow("attachment.too_many");
    expect(() => files.check(["nope"])).toThrow("attachment.not_found");
    expect(() => files.check([ids[0]!, ids[0]!])).toThrow("attachment.claimed");
    files.check(ids.slice(0, 2));
  });

  it("moves claimed uploads into the task folder, refuses to discard them, and removes a deleted message's files", () => {
    const { store, dataDir, files } = storage();
    store.db.prepare("insert into projects (id, name, path, added_at) values ('p', 'p', 'C:\\\\p', 'now')").run();
    store.db.prepare("insert into tasks (id, project_id, title, description, kind, size, fallback, wait_reset_minutes, classification, created_at) values ('t', 'p', 'x', '', 'code', 'S', 'ask', 20, '[]', 'now')").run();
    const a = files.add("spec.pdf", b64(PDF));
    const b = files.add("log one.txt", b64(Buffer.from("error\n")));
    const [claimed] = files.claim([a.id], "t", null);
    expect(claimed!.path).toBe(join(dataDir, "tasks", "t", "attachments", a.id, "spec.pdf"));
    expect(readFileSync(claimed!.path)).toEqual(PDF);
    expect(existsSync(join(dataDir, "attachments", "staged", a.id))).toBe(false);
    expect(files.taskViews("t").map((v) => v.name)).toEqual(["spec.pdf"]);
    expect(() => files.discard(a.id)).toThrow("attachment.claimed");
    expect(() => files.check([a.id])).toThrow("attachment.claimed");

    const [msg] = files.claim([b.id], "t", "message-1");
    expect(files.forMessage("message-1")).toEqual([msg]);
    expect(files.taskViews("t")).toHaveLength(1);
    files.removeForMessage("message-1");
    expect(existsSync(dirname(msg!.path))).toBe(false);
    expect(files.forMessage("message-1")).toEqual([]);
  });

  it("discards an unused upload, and sweeps uploads nothing took within a day", () => {
    let now = new Date("2026-10-31T10:00:00Z");
    const { dataDir, files } = storage(() => now);
    const gone = files.add("a.txt", b64(Buffer.from("a")));
    files.discard(gone.id);
    expect(existsSync(join(dataDir, "attachments", "staged", gone.id))).toBe(false);
    expect(() => files.discard(gone.id)).toThrow("attachment.not_found");

    const old = files.add("old.txt", b64(Buffer.from("old")));
    now = new Date(now.getTime() + STAGED_TTL_MS - 1000);
    const fresh = files.add("fresh.txt", b64(Buffer.from("fresh")));
    now = new Date(now.getTime() + 2000);
    // A staged folder left without a row (a crash between write and insert) goes too, once old.
    const orphan = join(dataDir, "attachments", "staged", "orphan");
    mkdirSync(orphan);
    utimesSync(orphan, new Date(0), new Date(0));
    const stagedOld = join(dataDir, "attachments", "staged", old.id);
    utimesSync(stagedOld, new Date(0), new Date(0));
    expect(files.sweep()).toBe(1);
    expect(existsSync(stagedOld)).toBe(false);
    expect(existsSync(join(dataDir, "attachments", "staged", fresh.id))).toBe(true);
    expect(existsSync(orphan)).toBe(false);
  });
});

describe("attachments through a crew", () => {
  const running: FakeStep = { emit: { type: "run.state", state: "running" } };

  async function setup(caps: { images: boolean; files: boolean }) {
    const root = tempDir("crewyard attach-flow-");
    const repo = await tempRepo(root);
    const store = new Store(join(root, "t.db"));
    stores.push(store);
    const project = store.addProject(repo, "demo repo");
    const adapter = new ScriptedAdapter((role) => (role === "researcher" ? [running, { awaitAnswer: "work" }, { emit: { type: "message.delta", text: "done" } }] : [running]), { capabilities: { attachments: caps } });
    const adapters = new AdapterRegistry({});
    adapters.set("fake", adapter);
    const cands = CANDIDATES();
    const o = new Orchestrator({ store, dataDir: join(root, "data"), emit: () => {}, adapters, directory: { candidates: () => cands, envFor: () => ({}) }, tickMs: 0, stallCheckMs: 0, freeMemoryMb: () => 64_000, stopTimeoutMs: 2_000 });
    o.start();
    open.push(o);
    return { o, project, adapter };
  }

  it("gives the description's attachments to the first prompt and a message's to the turn that takes it", async () => {
    const { o, project, adapter } = await setup({ images: true, files: true });
    const shot = o.attachments.add("shot.png", b64(PNG));
    const spec = o.attachments.add("spec.pdf", b64(PDF));
    const t = await o.propose({ projectId: project.id, title: "Research what the screenshot shows", kind: "research", attachments: [shot.id, spec.id] });
    expect(t.attachments?.map((a) => a.name)).toEqual(["shot.png", "spec.pdf"]);
    await o.approve({ taskId: t.id });
    const run = await waitFor(() => o.get(t.id).runs.find((r) => r.role === "researcher"));
    const started = adapter.started.find((s) => s.role === "researcher")!;
    expect(started.req.attachments?.map((a) => a.name)).toEqual(["shot.png", "spec.pdf"]);
    expect(started.req.prompt).toContain("Attachments from the user:\n- shot.png (image/png, attached to this message");
    expect(run.controls.attach).toEqual({ image: { ok: true, reason: null }, file: { ok: true, reason: null } });

    const note = o.attachments.add("note.md", b64(Buffer.from("# Look here\n")));
    const view = await o.message(run.id, "Also this note.", undefined, [note.id]);
    expect(view.queue[0]!.attachments?.map((a) => a.name)).toEqual(["note.md"]);
    await adapter.answer({ runId: started.runId } as RunHandle, "work", { kind: "cancel" });
    await waitFor(() => o.get(t.id).runs.find((r) => r.id === run.id)?.endedAt);
    const [turn] = adapter.inspect(started.runId).inputs;
    expect(turn!.text).toContain("Also this note.\n\nAttachments from the user:\n- note.md (text/markdown");
    expect(turn!.attachments?.map((a) => a.name)).toEqual(["note.md"]);
    expect(existsSync(turn!.attachments![0]!.path)).toBe(true);
  });

  it("lists a kind the runner cannot take as a path, and disables attaching it with the reason", async () => {
    const { o, project, adapter } = await setup({ images: true, files: false });
    const shot = o.attachments.add("shot.png", b64(PNG));
    const spec = o.attachments.add("spec.pdf", b64(PDF));
    const t = await o.propose({ projectId: project.id, title: "Research A", kind: "research", attachments: [shot.id, spec.id] });
    await o.approve({ taskId: t.id });
    const run = await waitFor(() => o.get(t.id).runs.find((r) => r.role === "researcher"));
    const req: StartRequest = adapter.started.find((s) => s.role === "researcher")!.req;
    expect(req.attachments?.map((a) => a.name)).toEqual(["shot.png"]);
    expect(req.prompt).toMatch(/- spec\.pdf \(application\/pdf; read it from .+spec\.pdf\)/);
    expect(run.controls.attach?.file).toEqual({ ok: false, reason: "attach.file_unsupported" });
  });

  it("refuses a message with a bad attachment id without queueing the text, and deletes a queued message's files with it", async () => {
    const { o, project } = await setup({ images: true, files: true });
    const t = await o.propose({ projectId: project.id, title: "Research B", kind: "research" });
    await o.approve({ taskId: t.id });
    const run = await waitFor(() => o.get(t.id).runs.find((r) => r.role === "researcher"));
    await expect(o.message(run.id, "with a ghost", undefined, ["ghost"])).rejects.toThrow("attachment.not_found");
    expect(o.get(t.id).runs.find((r) => r.id === run.id)!.queue).toEqual([]);
    const note = o.attachments.add("n.txt", b64(Buffer.from("n")));
    const view = await o.message(run.id, "with a note", undefined, [note.id]);
    const path = o.attachments.forMessage(view.queue[0]!.id)[0]!.path;
    o.queueDelete(run.id, view.queue[0]!.id);
    expect(existsSync(path)).toBe(false);
  });
});

describe("handoff package", () => {
  it("lists the attachments with their paths so the next agent can read them", () => {
    const text = handoffPackage({
      task: { title: "T", description: "D" } as never,
      source: { role: "implementer", runner: "fake", model: null } as never,
      role: ROLES.implementer,
      trigger: "limit",
      plan: null,
      diffStat: null,
      checkpointSha: null,
      openQuestions: [],
      attachments: [{ id: "a", kind: "image", name: "shot.png", mime: "image/png", bytes: 16, path: "C:\\data dir\\tasks\\t\\attachments\\a\\shot.png" }],
      transcript: "log",
    });
    expect(text).toContain("## Attachments\nFiles the user attached; read them from these paths.\n- shot.png (image/png, 16 bytes): C:\\data dir\\tasks\\t\\attachments\\a\\shot.png");
  });
});
