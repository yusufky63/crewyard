import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FakeStep } from "@crewyard/adapter-fake";
import type { StartRequest } from "@crewyard/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../store.ts";
import { AdapterRegistry } from "../orchestrator/adapters.ts";
import { Orchestrator } from "../orchestrator/orchestrator.ts";
import { CANDIDATES, cleanTemps, git, ScriptedAdapter, tempDir, tempRepo, waitFor } from "../orchestrator/testing.ts";
import { GithubClient, type FetchLike } from "./client.ts";
import { PrFlow } from "./flow.ts";
import { GithubService } from "./service.ts";

// The whole M4 path against a local bare remote and a mocked GitHub API: a crew finishes, the
// branch is pushed, the PR is opened, feedback is routed and deduplicated, the PR is merged, the
// task reads merged, and the worktree is removed only when that is safe.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const open: Array<{ o: Orchestrator; store: Store; svc: GithubService }> = [];
afterEach(async () => {
  for (const { o, svc } of open) {
    svc.stop();
    o.shutdown();
    await o.settle();
  }
  open.splice(0).forEach(({ store }) => store.close());
  cleanTemps();
});

const running: FakeStep = { emit: { type: "run.state", state: "running" } };
const say = (text: string): FakeStep => ({ emit: { type: "message.delta", text } });
const tool: FakeStep = { emit: { type: "tool.call", toolCallId: "t1", title: "read", kind: "read" } };

/** A GitHub API with state: what the tests change is what the next read returns. ETags as GitHub sends them. */
function github() {
  const s = {
    pulls: [] as Array<Record<string, unknown>>,
    checks: [] as Array<Record<string, unknown>>,
    comments: [] as Array<Record<string, unknown>>,
    reviews: [] as Array<Record<string, unknown>>,
    behind: 0,
    created: null as Record<string, unknown> | null,
    merged: null as Record<string, unknown> | null,
  };
  const seen: string[] = [];
  const json = (body: unknown, status = 200) => {
    const text = JSON.stringify(body);
    return new Response(text, { status, headers: { "content-type": "application/json", etag: `"${text.length}-${text.charCodeAt(text.length >> 1)}"` } });
  };
  const fn: FetchLike = async (url, init) => {
    const path = url.replace("https://api.github.com", "");
    seen.push(`${init.method} ${path}`);
    if (init.method === "POST" && path === "/graphql") return Response.json({ data: { repository: { viewerDefaultMergeMethod: "SQUASH" } } });
    if (init.method === "POST" && path === "/repos/octo/app/pulls") {
      s.created = JSON.parse(init.body ?? "{}");
      const pr = { number: 41, html_url: "https://github.com/octo/app/pull/41", state: "open", draft: false, user: { login: "me" }, head: { ref: s.created!.head, sha: "" }, base: { ref: s.created!.base }, title: s.created!.title };
      return json(pr, 201);
    }
    if (init.method === "PUT" && path === "/repos/octo/app/pulls/41/merge") {
      s.merged = JSON.parse(init.body ?? "{}");
      return json({ merged: true, sha: "m41" });
    }
    if (path === "/repos/octo/app") return json({ private: true, default_branch: "main", owner: { type: "User" }, allow_merge_commit: false, allow_squash_merge: true, allow_rebase_merge: false });
    if (path.startsWith("/repos/octo/app/pulls?state=open")) return json(s.pulls.filter((p) => !p.merged_at));
    if (path.startsWith("/repos/octo/app/pulls?state=closed")) return json(s.pulls.filter((p) => p.merged_at));
    if (/\/commits\/[^/]+\/check-runs/.test(path)) return json({ check_runs: s.checks });
    if (/\/commits\/[^/]+\/statuses/.test(path)) return json([]);
    if (path.startsWith("/repos/octo/app/compare/")) return json({ ahead_by: 1, behind_by: s.behind });
    if (path.startsWith("/repos/octo/app/pulls/41/comments")) return json(s.comments);
    if (path.startsWith("/repos/octo/app/pulls/41/reviews")) return json(s.reviews);
    if (path === "/repos/octo/app/actions/jobs/99/logs") return new Response("2026-10-30T10:00:00.0000000Z FAIL src/limiter.test.ts\n2026-10-30T10:00:01.0000000Z expected 200 to be 429\n", { status: 200 });
    return json({ message: "Not Found" }, 404);
  };
  return { s, seen, fn };
}

async function setup() {
  const root = tempDir("crewyard pr flow ");
  const repo = await tempRepo(root);
  const bare = join(root, "remote repo.git");
  await git(root, "init", "--bare", "-q", "-b", "main", bare);
  // The remote looks like GitHub; pushes go to the local bare repo.
  await git(repo, "remote", "add", "origin", "https://github.com/octo/app.git");
  await git(repo, "config", `url.${bare.replace(/\\/g, "/")}.pushInsteadOf`,"https://github.com/octo/app.git");
  await git(repo, "push", "-q", "origin", "main");
  await git(repo, "fetch", "-q", bare, "main:refs/remotes/origin/main");

  const store = new Store(join(root, "t.db"));
  const project = store.addProject(repo, "demo repo");
  const adapter = new ScriptedAdapter((role: string, _req: StartRequest, resumed: boolean) =>
    role === "reviewer" ? [running, say("Reading the diff."), tool, say("Approved: the limiter and its tests look right.")] : [running, say(resumed ? "fixed" : `${role} done`)],
  );
  const adapters = new AdapterRegistry({});
  adapters.set("fake", adapter);
  const topics: Array<{ topic: string; payload: unknown }> = [];
  const emit = (topic: string, payload: unknown) => topics.push({ topic, payload });
  const o = new Orchestrator({ store, dataDir: join(root, "data"), emit, adapters, directory: { candidates: () => CANDIDATES(), envFor: () => ({}) }, tickMs: 0, freeMemoryMb: () => 64_000, stopTimeoutMs: 2_000 });
  o.start();
  const gh = github();
  const client = new GithubClient(async () => "test-token", gh.fn);
  let flow: PrFlow | null = null;
  const svc = new GithubService({
    projectPath: () => repo,
    emit,
    client,
    tokenState: () => "ok",
    resetToken: () => undefined,
    openQuestions: (p, b) => flow!.openQuestions(p, b),
    afterRefresh: (p) => flow!.sync(p),
  });
  flow = new PrFlow({ store, service: svc, client, tasks: () => o, projectPath: () => repo, emit });
  open.push({ o, store, svc });
  return { root, repo, store, project, o, adapter, gh, svc, flow, topics };
}

describe("task PR flow", () => {
  it("goes from a finished crew to a merged PR with every outward step explicit, then cleans up safely", async () => {
    const { root, repo, project, o, adapter, gh, svc, flow, topics } = await setup();
    const proposed = await o.propose({ projectId: project.id, title: "Implement rate limiting for the login endpoint", description: "Five attempts per minute per account." });
    await o.approve({ taskId: proposed.id });
    await waitFor(() => o.get(proposed.id).status === "review");
    const wt = o.get(proposed.id).worktree!;
    writeFileSync(join(wt.path, "limiter.ts"), "export const limit = 5;\n");
    await git(wt.path, "add", "-A");
    await git(wt.path, "commit", "-q", "-m", "Add the login limiter");
    const tip = (await git(wt.path, "rev-parse", "HEAD")).trim();

    // 1. The draft: review gate passed, one commit, clean, not pushed yet.
    let view = await flow.view(proposed.id);
    expect(view.pull).toBeNull();
    expect(view.draft?.gate.items.map((i) => [i.id, i.status])).toEqual([
      ["review", "pass"],
      ["commits", "pass"],
      ["clean", "pass"],
      ["pushed", "wait"],
      ["no_pull", "pass"],
    ]);
    expect(view.draft).toMatchObject({ title: proposed.title, head: wt.branch, base: "main", headSha: tip, ahead: 1, unpushed: 1 });
    expect(view.draft?.body).toContain("Five attempts per minute per account.");
    expect(view.draft?.body).toContain("- Add the login limiter");
    expect(view.draft?.body).toContain("> Approved: the limiter and its tests look right.");
    expect(view.draft?.body).not.toContain("Reading the diff.");

    // 2. No PR before the push, and nothing was written to GitHub.
    await expect(flow.create(proposed.id, proposed.title, "body", tip)).rejects.toThrow("pull.gate_closed");
    expect(gh.seen.some((x) => x.startsWith("POST /repos"))).toBe(false);

    // 3. Push once (its own click), then the gate opens.
    expect((await svc.push(project.id, wt.branch, tip)).pushed).toBe(true);
    view = await flow.view(proposed.id);
    expect(view.draft?.gate.ready).toBe(true);

    // 4. Open the PR: the branch must still be at the reviewed tip.
    await expect(flow.create(proposed.id, proposed.title, "body", "0".repeat(40))).rejects.toThrow("pull.moved");
    await expect(flow.create(proposed.id, "  ", "body", tip)).rejects.toThrow("pull.no_title");
    const pull = await flow.create(proposed.id, proposed.title, "The body", tip);
    expect(gh.s.created).toEqual({ title: proposed.title, body: "The body", head: wt.branch, base: "main" });
    expect(pull).toMatchObject({ number: 41, state: "open", origin: "app", head: wt.branch, base: "main" });
    // An open PR is still "Ready for review", never merged.
    expect(o.get(proposed.id).status).toBe("review");
    expect(topics.some((t) => t.topic === "tasks.changed" && (t.payload as { cause: string }).cause === "pull_request")).toBe(true);

    // 5. GitHub reports a failing check and a review comment.
    const pr = { number: 41, title: proposed.title, html_url: "https://github.com/octo/app/pull/41", user: { login: "me" }, head: { ref: wt.branch, sha: tip }, base: { ref: "main" } };
    gh.s.pulls = [pr];
    gh.s.checks = [{ id: 99, name: "test", status: "completed", conclusion: "failure", html_url: "https://github.com/octo/app/runs/99", output: { title: "1 test failed", summary: "" }, app: { slug: "github-actions" } }];
    gh.s.comments = [{ id: 7, body: "Use a constant for 429.", path: "limiter.ts", line: 1, user: { login: "mona" } }];
    gh.s.reviews = [{ id: 5, state: "APPROVED", body: "", user: { login: "mona" } }];

    // Routing is off until the project opts in.
    await svc.refresh(project.id);
    expect((await flow.view(proposed.id)).feedback).toEqual([]);
    expect(gh.seen.some((x) => x.includes("/actions/jobs/"))).toBe(false);

    flow.setRouting(project.id, true);
    await svc.refresh(project.id);
    view = await flow.view(proposed.id);
    expect(view.routing).toBe(true);
    expect(view.feedback.map((f) => [f.kind, f.source, f.state])).toEqual(
      expect.arrayContaining([
        ["check", "test", "held"],
        ["review_comment", "mona", "held"],
      ]),
    );
    expect(view.feedback).toHaveLength(2);
    expect(view.feedback.find((f) => f.kind === "check")?.excerpt).toBe("1 test failed\nFAIL src/limiter.test.ts\nexpected 200 to be 429");
    expect(view.feedback.find((f) => f.kind === "review_comment")).toMatchObject({ path: "limiter.ts", line: 1 });

    // Deduplicated: another refresh adds nothing and does not download the log again.
    await svc.refresh(project.id);
    expect((await flow.view(proposed.id)).feedback).toHaveLength(2);
    expect(gh.seen.filter((x) => x.includes("/actions/jobs/99/logs"))).toHaveLength(1);

    // 6. The implementer already finished, so its feedback waits for "Send to agent", which continues the step.
    const before = adapter.started.length;
    expect(await flow.sendHeld(proposed.id)).toBe(2);
    const followUp = adapter.started[before]!;
    expect(followUp.resumed).toBe(true);
    expect(followUp.req.prompt).toContain("GitHub feedback on pull request #41");
    expect(followUp.req.prompt).toContain('Check "test" failed.');
    expect(followUp.req.cwd).toBe(wt.path);
    await waitFor(() => o.get(proposed.id).status === "review");
    expect((await flow.view(proposed.id)).feedback.every((f) => f.state === "sent" && f.runId)).toBe(true);
    expect(await flow.sendHeld(proposed.id)).toBe(0);

    // 7. Merge gates: questions come from the task's open requests; then merge with the repo's method.
    expect(flow.openQuestions(project.id, wt.branch)).toBe(0);
    expect(flow.openQuestions(project.id, "someone/else")).toBe(0);
    gh.s.checks = [{ id: 100, name: "test", status: "completed", conclusion: "success", app: { slug: "github-actions" } }];
    gh.s.behind = 2;
    await expect(svc.merge(project.id, 41, tip)).rejects.toThrow(/up_to_date/);
    gh.s.behind = 0;
    const merged = await svc.merge(project.id, 41, tip);
    expect(merged).toEqual({ merged: true, sha: "m41", method: "squash" });
    expect(gh.s.merged).toEqual({ merge_method: "squash", sha: tip });
    flow.afterMerge(project.id, 41, tip, merged);
    expect(o.get(proposed.id).status).toBe("merged");

    // The next refresh sees the PR as merged on GitHub; the record stays merged.
    gh.s.pulls = [{ ...pr, merged_at: new Date().toISOString() }];
    await svc.refresh(project.id);
    view = await flow.view(proposed.id);
    expect(view.pull?.state).toBe("merged");
    expect(view.draft).toBeNull();
    expect(view.cleanup).toMatchObject({ ok: true, blocks: [], branch: wt.branch });

    // 8. Cleanup refuses anything that could lose work, and never touches folders git does not list.
    writeFileSync(join(wt.path, "scratch.txt"), "local notes\n");
    expect(await flow.remove(project.id, wt.path)).toMatchObject({ removed: false, verdict: { blocks: ["dirty"] } });
    expect(existsSync(join(wt.path, "scratch.txt"))).toBe(true);
    rmSync(join(wt.path, "scratch.txt"));

    const stranger = join(root, "not a worktree");
    mkdirSync(stranger);
    expect((await flow.remove(project.id, stranger)).verdict.blocks).toContain("unknown_to_git");
    expect(existsSync(stranger)).toBe(true);
    expect((await flow.verdict(project.id, repo)).blocks).toContain("primary");

    expect(await flow.remove(project.id, wt.path)).toMatchObject({ removed: true });
    expect(existsSync(wt.path)).toBe(false);
    expect(await git(repo, "worktree", "list")).not.toContain(wt.path.replace(/\\/g, "/"));
    // The branch stays; only the worktree folder went.
    expect((await git(repo, "branch", "--list", wt.branch)).trim()).not.toBe("");
    view = await flow.view(proposed.id);
    expect(view.cleanup).toBeNull();
    expect(view.pull?.worktreeRemovedAt).not.toBeNull();
  });

  it("delivers feedback to a run that has not finished, and blocks merge while the task has an open request", async () => {
    const { project, o, adapter, gh, svc, flow } = await setup();
    const proposed = await o.propose({ projectId: project.id, title: "Implement rate limiting for the login endpoint", description: "" });
    await o.approve({ taskId: proposed.id });
    await waitFor(() => o.get(proposed.id).status === "review");
    const detail = o.get(proposed.id);
    const wt = detail.worktree!;
    const impl = detail.runs.find((r) => r.role === "implementer")!;
    // A PR found on GitHub for the task's branch is linked without a click (reading is not outward).
    gh.s.pulls = [{ number: 41, title: "x", html_url: "https://github.com/octo/app/pull/41", user: { login: "me" }, head: { ref: wt.branch, sha: "abc" }, base: { ref: "main" } }];
    gh.s.comments = [{ id: 8, body: "Please rename.", path: "a.ts", line: 2, user: { login: "mona" } }];
    flow.setRouting(project.id, true);

    // Make the implementer's latest run unfinished: a stopped run takes messages into its step's outbox.
    const store = (o as unknown as { opts: { store: Store } }).opts.store;
    store.db.prepare("update runs set end_reason = 'stopped' where id = ?").run(impl.id);
    await svc.refresh(project.id);
    const view = await flow.view(proposed.id);
    expect(view.pull).toMatchObject({ number: 41, origin: "linked" });
    expect(view.feedback).toEqual([expect.objectContaining({ kind: "review_comment", state: "sent", runId: impl.id })]);
    expect(o.get(proposed.id).runs.find((r) => r.id === impl.id)?.queuedMessages).toBe(1);
    expect(adapter.started.filter((s) => s.req.prompt.includes("GitHub feedback"))).toEqual([]);

    // An open request on the task closes the merge gate.
    store.db.prepare("insert into requests (id, task_id, run_id, kind, payload, created_at) values ('q1', ?, ?, 'question', '{}', ?)").run(proposed.id, impl.id, new Date().toISOString());
    expect(flow.openQuestions(project.id, wt.branch)).toBe(1);
    gh.s.checks = [{ id: 100, name: "test", status: "completed", conclusion: "success" }];
    await expect(svc.merge(project.id, 41, "abc")).rejects.toThrow(/questions/);
    expect(gh.seen.some((x) => x.startsWith("PUT"))).toBe(false);
  });
});
