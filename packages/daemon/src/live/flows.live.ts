import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultProjectConfig, ReviewVerdict, type ProfileInput, type RequestView, type RunView, type TaskDetail } from "@crewyard/core";
import { commandLineLeaks, defaultDecide, describeRequest, hasKey, keyFor, LiveDaemon, scanFiles, type Decide, type KeyVar } from "./harness.ts";

// `pnpm --filter @crewyard/daemon live` under env-vault `run` (see vitest.live.config.ts). Every
// flow below is what a user would click, scripted; the report goes to CREWYARD_LIVE_OUT.
//
// CREWYARD_LIVE_REMOTE=owner/name   a private test repository the flows may push, PR and merge on;
//                                   without it the project is a local clone of CREWYARD_LIVE_SEED
//                                   and the GitHub flow only reads what the app says about it.
// CREWYARD_LIVE_GEMINI_BIN=<folder> a current Gemini CLI, put first on PATH for the daemon.
// CREWYARD_LIVE_FLOWS=a,b           run only these flows (setup always runs).
// CREWYARD_LIVE_RESEARCH=gm,cx-ds   only these profiles in the research flows.
// CREWYARD_LIVE_KEEP=1              keep the temp folder for the Electron capture.
// CREWYARD_LIVE_REVIEWER=cx-dsp     profile key of the crew flow's reviewer.
// CREWYARD_LIVE_MAX_USD=2           stop starting flows once today's recorded spend passes this.

const live = process.env.CREWYARD_LIVE === "1" && process.platform === "win32";
const OUT = process.env.CREWYARD_LIVE_OUT ?? join(tmpdir(), "crewyard-live-out");
const REMOTE = process.env.CREWYARD_LIVE_REMOTE ?? null;
const SEED = process.env.CREWYARD_LIVE_SEED ?? null;
const GEMINI_BIN = process.env.CREWYARD_LIVE_GEMINI_BIN ?? null;
const ONLY = process.env.CREWYARD_LIVE_FLOWS?.split(",").map((s) => s.trim()) ?? null;
const RESEARCH = process.env.CREWYARD_LIVE_RESEARCH?.split(",").map((s) => s.trim()) ?? null;
const KEEP = process.env.CREWYARD_LIVE_KEEP === "1";
const MAX_USD = Number(process.env.CREWYARD_LIVE_MAX_USD ?? 2);
// Profile key of the crew flow's reviewer (see the setup flow's list).
const REVIEWER = process.env.CREWYARD_LIVE_REVIEWER ?? "cx-dsp";

const MIN = 60_000;
const GEMINI_MODELS = ["gemini-3.1-flash-lite", "gemini-3.5-flash-lite", "gemini-flash-lite-latest", "gemini-2.5-flash"];
const ENDED = new Set(["review", "done", "merged", "failed", "cancelled"]);
/** Finished, or failed with nothing left to answer or running. */
const settled = (t: TaskDetail) => ["review", "done", "merged", "cancelled"].includes(t.status) || (t.status === "failed" && t.openRequests === 0 && t.activeRuns === 0);

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, windowsHide: true, encoding: "utf8" }).trim();

describe.runIf(live)("crewyard live", () => {
  let d: LiveDaemon;
  let projectId = "";
  let projectPath = "";
  const profiles: Record<string, string> = {};
  const credentials: Partial<Record<KeyVar, string>> = {};
  const cmdLeaks: string[] = [];
  let codeTask: TaskDetail | null = null;

  const want = (flow: string) => {
    if (!projectId) throw new Error("setup did not finish");
    return !ONLY || ONLY.includes(flow);
  };
  const spentToday = async () => (await d.call("providers.spend", { days: 1 })).totalUsd;
  const overBudget = async (flow: string) => {
    const spent = await spentToday();
    if (spent < MAX_USD) return false;
    d.row({ flow, runner: "-", result: "skipped", costUsd: null, notes: `spend guard: $${spent.toFixed(3)} recorded today` });
    return true;
  };
  const alias = (id: string | null | undefined) => Object.entries(profiles).find(([, v]) => v === id)?.[0] ?? id ?? "-";

  /** Logs each run's state as it changes and checks child command lines for keys once per run. */
  const watch = async (taskId: string, done: (t: TaskDetail) => boolean, timeoutMs: number, everyMs = 3_000): Promise<TaskDetail> => {
    const seen = new Map<string, string>();
    const checked = new Set<string>();
    return d.waitFor(
      `task ${taskId}`,
      async () => {
        const t = await d.call("tasks.get", { taskId });
        for (const r of t.runs) {
          const line = `${r.state}${r.endReason ? `/${r.endReason}` : ""}${r.endDetail ? ` (${r.endDetail})` : ""} in=${r.tokensIn} out=${r.tokensOut} cost=${r.cost.usd ?? "?"} ${r.cost.provenance}`;
          if (seen.get(r.id) !== line) {
            seen.set(r.id, line);
            d.log(`  run ${r.role} on ${alias(r.profileId)} [${r.runner} ${r.model ?? "-"}]: ${line}`);
          }
          if (r.state === "running" && !checked.has(r.id)) {
            checked.add(r.id);
            for (const hit of commandLineLeaks()) cmdLeaks.push(`${hit.name} pid ${hit.pid}: ${hit.key}`);
          }
        }
        return done(t) ? t : null;
      },
      timeoutMs,
      everyMs,
    );
  };

  const crewLine = (t: TaskDetail) =>
    (t.crew?.members ?? []).map((m) => `${m.role}=${alias(m.chosen?.profileId)}${m.chosen ? ` (${m.chosen.estimate.usd?.toFixed(4) ?? "?"} ${m.chosen.estimate.provenance}; ${m.chosen.reasons.map((r) => r.code).join(",")})` : ` [${m.reasons.map((r) => r.code).join(",")}]`} standby=[${m.standby.map((s) => alias(s.profileId)).join(",")}]`).join("; ");

  const verdictOf = (taskId: string) => {
    const rows = d.audit("review.verdict", taskId);
    const last = rows.at(-1);
    if (!last) return { ok: false as const, error: `no review.verdict event; result.invalid: ${JSON.stringify(d.audit("result.invalid", taskId).map((r) => r.payload))}` };
    const parsed = ReviewVerdict.safeParse(last.payload);
    return parsed.success ? { ok: true as const, value: parsed.data } : { ok: false as const, error: parsed.error.message };
  };

  const testsPass = (cwd: string) => {
    try {
      execFileSync("node", ["--test"], { cwd, windowsHide: true, stdio: "pipe", encoding: "utf8" });
      return true;
    } catch {
      return false;
    }
  };

  beforeAll(async () => {
    if (GEMINI_BIN) process.env.PATH = `${GEMINI_BIN};${process.env.PATH ?? ""}`;
    d = LiveDaemon.open(OUT);
    writeFileSync(join(OUT, "root.txt"), d.root);
    d.log("root", d.root);
    d.startAutopilot();
  });

  afterAll(async () => {
    if (!d) return;
    try {
      const spend = await d.call("providers.spend", { days: 1 });
      d.log("spend today", spend.totalUsd.toFixed(4), spend.provenance, JSON.stringify(spend.byProvider));
      const balances = await d.attempt("providers.balancesRefresh", {});
      if (balances.ok) d.log("balances after", JSON.stringify(balances.result.map((b) => ({ provider: b.providerId, wallets: b.wallets, error: b.error }))));
    } catch (err) {
      d.log("summary failed", String(err));
    }
    await d.close();
    const files = scanFiles([d.root, OUT]);
    d.log(`leak scan: ${files.length} file hits, ${cmdLeaks.length} command-line hits, ${d.emittedLeaks} redacted in emitted data`);
    for (const f of files) d.log("  key in file", d.rel(f.where), f.key);
    for (const c of cmdLeaks) d.log("  key on command line", c);
    if (files.length || cmdLeaks.length || d.emittedLeaks)
      d.finding({ id: "leak", title: "A key reached a file, a command line or an emitted payload", steps: "See live.log 'leak scan'", suspect: "see paths", severity: "high" });
    d.writeReport();
    if (!KEEP) d.remove();
  });

  it("setup: keys, caps, profiles, project", { timeout: 5 * MIN }, async () => {
    const status = await d.call("daemon.status", undefined);
    d.log("daemon", JSON.stringify(status.versions));
    for (const id of ["claude", "codex", "opencode", "gemini", "git", "gh"] as const) {
      const t = await d.attempt("machine.tool", { id: id as never });
      d.log("tool", id, t.ok ? JSON.stringify(t.result) : t.error);
    }

    const listed: Record<string, string[]> = {};
    const caps: Array<[KeyVar, string, string, number]> = [
      ["DEEPSEEK_API_KEY", "live-deepseek", "deepseek", 0.5],
      ["OPENAI_API_KEY", "live-openai", "openai", 1],
      ["GEMINI_API_KEY", "live-gemini", "google", 0.5],
    ];
    for (const [name, label, providerId, daily] of caps) {
      if (!hasKey(name)) {
        d.log("no key for", name);
        continue;
      }
      const c = await d.call("providers.credentialAdd", { alias: label, providerId, secret: keyFor(name) });
      await d.call("providers.capsSet", { credentialId: c.id, dailyUsd: daily, taskUsd: null });
      credentials[name] = c.id;
      const check = await d.call("providers.keyCheck", { credentialId: c.id });
      d.log("key", label, check.state, check.reason ?? "", `${check.models.length} models`);
      listed[providerId] = check.models;
      expect(check.state).toBe("valid");
    }
    const before = await d.attempt("providers.balancesRefresh", {});
    if (before.ok) d.log("balances before", JSON.stringify(before.result.map((b) => ({ provider: b.providerId, wallets: b.wallets, error: b.error }))));

    // Gemini 2.5 Flash Lite is still in the catalog but refused to new API users; take the
    // cheapest flash-lite the key actually lists.
    const gemini = GEMINI_MODELS.find((m) => listed.google?.some((x) => x === m || x === `models/${m}`)) ?? GEMINI_MODELS[0]!;
    d.log("gemini model", gemini, "2.5 flash lite listed:", listed.google?.some((x) => x.includes("gemini-2.5-flash-lite")) ?? false);
    // Model ids as the profile dialog offers them: the catalog's own ids, no provider prefix.
    const wanted: Array<[string, ProfileInput]> = [
      ["cc-ds", { alias: "cc-deepseek", runner: "claude-code", providerId: "deepseek", credentialId: credentials.DEEPSEEK_API_KEY ?? null, defaultModel: "deepseek-flash" }],
      ["cx-oa", { alias: "codex-openai", runner: "codex", providerId: "openai", credentialId: credentials.OPENAI_API_KEY ?? null, defaultModel: "gpt-5-nano" }],
      ["cx-ds", { alias: "codex-deepseek", runner: "codex", providerId: "deepseek", credentialId: credentials.DEEPSEEK_API_KEY ?? null, defaultModel: "deepseek-flash" }],
      // A second DeepSeek model, so a reviewer can be independent of a deepseek-flash implementer.
      ["cx-dsp", { alias: "codex-deepseek-pro", runner: "codex", providerId: "deepseek", credentialId: credentials.DEEPSEEK_API_KEY ?? null, defaultModel: "deepseek-v4-pro" }],
      ["oc-ds", { alias: "opencode-deepseek", runner: "opencode", providerId: "deepseek", credentialId: credentials.DEEPSEEK_API_KEY ?? null, defaultModel: "deepseek-flash" }],
      ["oc-gm", { alias: "opencode-gemini", runner: "opencode", providerId: "google", credentialId: credentials.GEMINI_API_KEY ?? null, defaultModel: gemini }],
      // A user may type OpenCode's own "provider/model"; the app stores the catalog id instead.
      ["ocp-ds", { alias: "opencode-deepseek-prefixed", runner: "opencode", providerId: "deepseek", credentialId: credentials.DEEPSEEK_API_KEY ?? null, defaultModel: "deepseek/deepseek-flash" }],
      ["ocp-gm", { alias: "opencode-gemini-prefixed", runner: "opencode", providerId: "google", credentialId: credentials.GEMINI_API_KEY ?? null, defaultModel: `google/${gemini}` }],
      ["gm", { alias: "gemini-cli", runner: "gemini-cli", providerId: "google", credentialId: credentials.GEMINI_API_KEY ?? null, defaultModel: gemini }],
    ];
    for (const [key, input] of wanted) {
      if (!input.credentialId) continue;
      const p = await d.attempt("providers.profileCreate", input);
      if (p.ok) profiles[key] = p.result.id;
      d.log("profile", key, p.ok ? `${p.result.id} ${p.result.configDir}` : `refused: ${p.error}`);
    }

    // The project: the private test repo through the setup flow's clone, or a local clone of the seed.
    const parent = join(d.root, "projects");
    if (REMOTE) {
      const repos = await d.call("setup.listRepos", undefined);
      d.log("gh login", repos.login, "repos listed", repos.repos.length, "test repo listed", repos.repos.some((r) => r.nameWithOwner === REMOTE));
      projectPath = (await d.call("setup.clone", { repo: REMOTE, parent, name: "e2e sample repo" })).path;
    } else {
      if (!SEED) throw new Error("CREWYARD_LIVE_SEED or CREWYARD_LIVE_REMOTE is required");
      const bare = join(d.root, "remote", "sample.git");
      git(d.root, "clone", "-q", "--bare", SEED, bare);
      projectPath = join(parent, "e2e sample repo");
      git(d.root, "clone", "-q", bare, projectPath);
    }
    const det = await d.call("setup.detect", { path: projectPath });
    d.log("detect", JSON.stringify({ kind: det.type.kind, pm: det.type.packageManager, test: det.type.test, git: { branch: det.git.branch, clean: det.git.clean, githubRepo: det.git.githubRepo }, worktreeRoot: d.rel(det.worktreeRoot), path: det.pathCheck }));
    const config = {
      ...(det.existingConfig ?? defaultProjectConfig(det.name, det.worktreeRoot)),
      commands: { build: det.type.build, test: det.type.test },
      budget: { dailyUsd: 2, perTaskUsd: 0.5 },
      github: { remote: det.git.remoteUrl ? "origin" : null, pushNeedsApproval: true as const, actionsWarnPct: 80 },
    };
    const created = await d.call("setup.create", { path: projectPath, config });
    projectId = created.project.id;
    d.log("project", projectId, d.rel(created.configPath));
    d.row({ flow: "setup", runner: "-", result: "pass", costUsd: 0, notes: `${Object.keys(credentials).length} keys valid, profiles ${Object.keys(profiles).join(", ")}; project via ${REMOTE ? "setup.clone" : "local clone"}` });
  });

  it("crew: propose, approve, run, review verdict", { timeout: 25 * MIN }, async () => {
    if (!want("crew") || (await overBudget("crew"))) return;
    const reviewer = profiles[REVIEWER];
    expect(profiles["cc-ds"] && reviewer).toBeTruthy();
    // A crashed step asks in the Inbox where to go next; the scripted user takes the proposed standby.
    const handedOff: string[] = [];
    let taskId = "";
    d.decide = (r): ReturnType<Decide> => {
      // Any answer to "handoff failed" is refused with run.session_changed (the failed target counts
      // as having taken over the step), so the scripted user cancels the task instead of waiting forever.
      if (r.taskId === taskId && r.payload.kind === "handoff" && r.payload.trigger === "handoff_failed") {
        handedOff.push("handoff_failed -> cancel task");
        return d.call("tasks.cancel", { taskId }).then(() => null);
      }
      if (r.taskId === taskId && r.payload.kind === "handoff" && r.payload.trigger === "crashed") {
        const to = r.payload.proposedTarget ?? r.payload.candidates[0] ?? null;
        handedOff.push(`${r.payload.trigger} -> ${alias(to?.profileId)}`);
        return to ? { kind: "handoff", decision: "hand_off", targetProfileId: to.profileId } : { kind: "handoff", decision: "stop" };
      }
      return defaultDecide(r);
    };
    const description = "In src/math.js add and export a function multiply(a, b) that returns the product. Add a test for it in src/math.test.js next to the existing one. Run the tests with `npm test`, then commit. Keep the change small.";

    // What the app picks on its own, for the record; it is cancelled before anything runs.
    const auto = await d.call("tasks.propose", { projectId, title: "Add a multiply function and its test", description });
    d.log("auto proposal", auto.kind, auto.size, auto.classification.map((c) => c.code).join(","), "|", crewLine(auto), "| estimate", auto.crew?.estimate.usd ?? "?", auto.crew?.estimate.provenance);
    await d.call("tasks.cancel", { taskId: auto.id });
    // A reviewer pinned to the implementer's model breaks the independence rule: what does the proposal do with the pin?
    if (profiles["cx-ds"]) {
      const clash = await d.call("tasks.propose", { projectId, title: "Add a multiply function and its test", description, kind: "code", size: "S", pins: { implementer: profiles["cc-ds"], reviewer: profiles["cx-ds"] } });
      const r = clash.crew?.members.find((m) => m.role === "reviewer");
      d.log("pinned same-model reviewer", crewLine(clash), "| reviewer member reasons", r?.reasons.map((x) => x.code).join(",") ?? "-");
      await d.call("tasks.cancel", { taskId: clash.id });
    }

    const t = await d.call("tasks.propose", { projectId, title: "Add a multiply function and its test", description, kind: "code", size: "S", budgetUsd: 0.5, pins: { implementer: profiles["cc-ds"], reviewer } });
    taskId = t.id;
    d.log("proposal", crewLine(t), "| estimate", t.crew?.estimate.usd ?? "?", t.crew?.estimate.provenance);
    const impl = t.crew?.members.find((m) => m.role === "implementer");
    const rev = t.crew?.members.find((m) => m.role === "reviewer");
    expect(impl?.chosen?.profileId).toBe(profiles["cc-ds"]);
    expect(rev?.chosen?.profileId).toBe(reviewer);
    await d.call("tasks.approve", { taskId: t.id });

    const end = await watch(t.id, settled, 20 * MIN);
    codeTask = end;
    d.decide = defaultDecide;
    const requests = await d.call("requests.list", { taskId: t.id, includeAnswered: true });
    d.log("requests", requests.length, requests.map((r) => `${r.kind}:${r.answeredBy ?? "open"}:${describeRequest(r)}`).join(" | "));
    const verdict = verdictOf(t.id);
    d.log("verdict", JSON.stringify(verdict));
    const wt = end.worktree;
    const commits = wt ? git(wt.path, "log", "--oneline", `${wt.baseSha}..HEAD`) : "";
    const pass = wt ? testsPass(wt.path) : false;
    d.log("worktree", wt ? d.rel(wt.path) : "-", wt?.branch, "commits:", commits.split("\n").filter(Boolean).length, "tests pass:", pass);
    const ok = end.status === "review" && verdict.ok && pass && commits.length > 0;
    d.row({ flow: "crew code S (implement + review)", runner: `claude-code/deepseek-flash -> ${REVIEWER}`, result: ok ? "pass" : "fail", costUsd: end.spend.usd, notes: `status ${end.status}; handoffs [${handedOff.join(", ")}]; verdict ${verdict.ok ? verdict.value.verdict : verdict.error}; ${requests.length} requests; spend ${end.spend.provenance}` });
  });

  it("github: push queue, push, PR, merge gates, merge, cleanup", { timeout: 10 * MIN }, async () => {
    if (!want("github")) return;
    const t = codeTask;
    if (!t?.worktree) {
      d.row({ flow: "github", runner: "-", result: "skipped", costUsd: null, notes: "no finished code task" });
      return;
    }
    const auth = await d.attempt("github.auth", undefined);
    d.log("github.auth", auth.ok ? JSON.stringify({ ...auth.result }) : auth.error);
    const queue = await d.call("github.pushQueue", { projectId });
    d.log("push queue", JSON.stringify(queue));
    const pullView = await d.call("github.taskPull", { taskId: t.id });
    d.log("task pull", JSON.stringify({ problem: pullView.problem, pull: pullView.pull, gate: pullView.draft?.gate, unpushed: pullView.draft?.unpushed, ahead: pullView.draft?.ahead }));
    if (!REMOTE) {
      d.row({ flow: "github", runner: "-", result: "blocked", costUsd: 0, notes: `no GitHub test repo (creation was refused by the session's permission layer); push queue problem ${queue.problem ?? "none"}, task pull problem ${pullView.problem ?? "none"}` });
      return;
    }
    const candidate = queue.branches.find((b) => b.branch === t.worktree?.branch);
    expect(candidate).toBeTruthy();
    const pushed = await d.call("github.push", { projectId, branch: candidate!.branch, headSha: candidate!.headSha });
    d.log("push", pushed.pushed, pushed.output.split("\n").slice(-3).join(" / "));
    await d.call("github.refresh", { projectId });
    const draft = (await d.call("github.taskPull", { taskId: t.id })).draft;
    d.log("draft", JSON.stringify({ title: draft?.title, head: draft?.head, base: draft?.base, gate: draft?.gate, bodyChars: draft?.body.length }));
    expect(draft?.headSha).toBeTruthy();
    const pr = await d.call("github.createPull", { taskId: t.id, title: draft!.title, body: draft!.body, headSha: draft!.headSha! });
    d.log("pull", pr.number, pr.url);
    const gated = await d.waitFor(
      "merge gate",
      async () => {
        await d.call("github.refresh", { projectId });
        const v = await d.call("github.taskPull", { taskId: t.id });
        return v.live?.gate ? v : null;
      },
      3 * MIN,
      5_000,
    );
    d.log("merge gate", JSON.stringify(gated.live?.gate));
    const merged = await d.attempt("github.merge", { projectId, number: pr.number, headSha: gated.live!.headSha });
    d.log("merge", merged.ok ? JSON.stringify(merged.result) : merged.error);
    await d.call("github.refresh", { projectId });
    const after = await d.call("github.taskPull", { taskId: t.id });
    const task = await d.call("tasks.get", { taskId: t.id });
    d.log("after merge", task.status, JSON.stringify(after.cleanup));
    const removed = await d.attempt("github.removeWorktree", { projectId, path: t.worktree.path });
    d.log("remove worktree", removed.ok ? JSON.stringify(removed.result) : removed.error, "folder still there:", existsSync(t.worktree.path));
    const ok = merged.ok && merged.result.merged && task.status === "merged" && removed.ok && removed.result.removed;
    d.row({ flow: "github push/PR/merge/cleanup", runner: "-", result: ok ? "pass" : "fail", costUsd: 0, notes: `PR #${pr.number}; task ${task.status}; worktree removed ${removed.ok && removed.result.removed}` });
  });

  it("fallback: budget pause and continue", { timeout: 15 * MIN }, async () => {
    if (!want("fallback") || (await overBudget("budget pause"))) return;
    const source = profiles["cc-ds"];
    const reviewer = profiles[REVIEWER];
    if (!source || !reviewer) throw new Error("the budget flow needs cc-ds and the reviewer profile");
    const pauses: RequestView[] = [];
    let taskId = "";
    d.decide = (r): ReturnType<Decide> => {
      if (r.taskId === taskId && r.payload.kind === "handoff" && (r.payload.trigger === "budget" || r.payload.trigger === "unpriced")) {
        pauses.push(r);
        return { kind: "handoff", decision: "continue" };
      }
      return defaultDecide(r);
    };
    const t = await d.call("tasks.propose", {
      projectId,
      title: "Add a subtract function and its test",
      description: "In src/math.js add and export subtract(a, b) returning a - b. Add a test in src/math.test.js. Run `npm test`, then commit. Keep the change small.",
      kind: "code",
      size: "S",
      // Any real turn passes this, so the first usage report pauses the run on the task budget.
      budgetUsd: 0.0005,
      fallback: "manual",
      pins: { implementer: source, reviewer },
    });
    taskId = t.id;
    await d.call("tasks.approve", { taskId: t.id });
    const end = await watch(t.id, settled, 12 * MIN);
    d.decide = defaultDecide;
    const kinds = pauses.map((r) => (r.payload.kind === "handoff" ? `${r.payload.cap?.kind ?? r.payload.trigger}@${alias(r.runId ? end.runs.find((x) => x.id === r.runId)?.profileId : null)}` : ""));
    const verdict = verdictOf(t.id);
    d.log("budget", "pauses", kinds.join(","), "status", end.status, "verdict", JSON.stringify(verdict));
    d.row({ flow: "budget pause + continue", runner: `cc-ds -> ${REVIEWER}`, result: pauses.length > 0 && end.status === "review" ? "pass" : pauses.length > 0 ? "partial" : "fail", costUsd: end.spend.usd, notes: `${pauses.length} pauses answered continue (${kinds.join(", ")}); task ${end.status}; verdict ${verdict.ok ? verdict.value.verdict : "none"}` });
  });

  it("fallback: manual Change AI handoff, same worktree", { timeout: 25 * MIN }, async () => {
    if (!want("fallback") || (await overBudget("handoff"))) return;
    const sourceKey = process.env.CREWYARD_LIVE_HANDOFF_SOURCE ?? "cc-ds";
    const source = profiles[sourceKey];
    const target = profiles["cx-ds"];
    const reviewer = profiles[REVIEWER];
    if (!source || !target || !reviewer) throw new Error(`the handoff flow needs ${sourceKey}, cx-ds and the reviewer profile`);
    const other: string[] = [];
    let taskId = "";
    d.decide = (r): ReturnType<Decide> => {
      if (r.taskId === taskId && r.payload.kind === "handoff") other.push(describeRequest(r));
      return defaultDecide(r);
    };
    const t = await d.call("tasks.propose", {
      projectId,
      title: "Add divide and its tests",
      description: "In src/math.js add and export divide(a, b) that throws a RangeError when b is 0. Add two tests in src/math.test.js: one division and the divide-by-zero case. Run `npm test`, then commit. Keep the change small.",
      kind: "code",
      size: "S",
      budgetUsd: 0.5,
      fallback: "manual",
      pins: { implementer: source, reviewer },
    });
    taskId = t.id;
    await d.call("tasks.approve", { taskId: t.id });

    // As soon as the implementer works, move it by hand ("Change AI" in the Crew graph).
    const working = await watch(t.id, (x) => x.runs.some((r) => r.role === "implementer" && r.state === "running") || ENDED.has(x.status), 8 * MIN, 500);
    const src = working.runs.find((r) => r.role === "implementer") as RunView;
    let handoff: { ok: true } | { ok: false; error: string } = { ok: false, error: "source ended before the handoff" };
    if (!src.endedAt) {
      const h = await d.attempt("runs.handoff", { runId: src.id, targetProfileId: target });
      handoff = h.ok ? { ok: true } : h;
      d.log("runs.handoff", h.ok ? `${h.result.state} handoff ${h.result.handoffId}` : h.error);
    }
    const end = await watch(t.id, settled, 15 * MIN);
    d.decide = defaultDecide;
    const next = end.runs.find((r) => r.role === "implementer" && r.id !== src.id && r.profileId === target);
    const ho = end.handoffs.at(-1);
    d.log("handoffs", JSON.stringify(end.handoffs.map((h) => ({ trigger: h.trigger, kind: h.kind, phase: h.phase, outcome: h.outcome, detail: h.detail, pkg: h.packagePath ? d.rel(h.packagePath) : null, checkpoint: h.checkpointSha?.slice(0, 8) }))));
    const sameTree = Boolean(next && next.cwd === src.cwd && next.worktreeId === src.worktreeId);
    const verdict = verdictOf(t.id);
    const pass = end.worktree ? testsPass(end.worktree.path) : false;
    const commits = end.worktree ? git(end.worktree.path, "log", "--format=%s", `${end.worktree.baseSha}..HEAD`).split("\n").filter(Boolean) : [];
    d.log("standby", next ? `${alias(next.profileId)} ${next.state}/${next.endReason} same worktree ${sameTree}` : "none", "verdict", JSON.stringify(verdict), "tests", pass, "commits", JSON.stringify(commits), "other handoff requests", other.join(" | "));
    d.row({ flow: "manual Change AI handoff", runner: `${sourceKey} -> cx-ds`, result: handoff.ok && ho?.outcome === "completed" && sameTree && pass ? "pass" : "fail", costUsd: end.spend.usd, notes: `${handoff.ok ? "accepted" : handoff.error}; outcome ${ho?.outcome ?? "-"} ${ho?.kind ?? ""}; same worktree ${sameTree}; ${commits.length} commits; tests ${pass}; task ${end.status}; verdict ${verdict.ok ? verdict.value.verdict : "none"}` });
  });

  // One short research turn each: proves the runner starts, authenticates with the app's env
  // only, reports usage and ends, without any code changes.
  const research: Array<[string, string, string]> = [
    ["gm", "gemini-cli", "research on Gemini CLI"],
    ["oc-gm", "opencode/google", "research on OpenCode + Gemini (catalog model id)"],
    ["ocp-gm", "opencode/google", "research on OpenCode + Gemini (provider/model id)"],
    ["oc-ds", "opencode/deepseek", "research on OpenCode + DeepSeek (catalog model id)"],
    ["ocp-ds", "opencode/deepseek", "research on OpenCode + DeepSeek (provider/model id)"],
    ["cx-ds", "codex/deepseek", "research on Codex + DeepSeek"],
    ["cx-oa", "codex/openai", "research on Codex + OpenAI"],
  ];
  for (const [key, runner, flow] of research) {
    it(flow, { timeout: 10 * MIN }, async () => {
      if (!want("research") || (RESEARCH && !RESEARCH.includes(key)) || (await overBudget(flow))) return;
      const id = profiles[key];
      if (!id) {
        d.row({ flow, runner, result: "skipped", costUsd: null, notes: "profile not created" });
        return;
      }
      const t = await d.call("tasks.propose", { projectId, title: "Research: name the test runner this repo uses", description: "Read package.json only and answer in one sentence which test runner the test script uses. Do not change any file.", kind: "research", size: "S", budgetUsd: 0.2, pins: { researcher: id } });
      d.log(flow, "proposal", crewLine(t));
      const approved = await d.attempt("tasks.approve", { taskId: t.id });
      if (!approved.ok) {
        d.row({ flow, runner, result: "fail", costUsd: null, notes: `approve refused: ${approved.error}` });
        return;
      }
      const end = await watch(t.id, (x) => ENDED.has(x.status) || x.status === "needs_input", 8 * MIN);
      const run = end.runs.at(-1);
      const reqs = await d.call("requests.list", { taskId: t.id, includeAnswered: true });
      const finalText = d.audit("run.ended", t.id).length;
      d.log(flow, "end", end.status, run?.endReason, run?.endDetail, `tokens ${run?.tokensIn}/${run?.tokensOut}`, `requests ${reqs.map((r) => describeRequest(r)).join(" | ")}`, `run.ended audits ${finalText}`);
      if (end.status === "needs_input") await d.call("tasks.cancel", { taskId: t.id });
      const ok = (end.status === "done" || end.status === "review") && run?.endReason === "completed";
      d.row({ flow, runner: `${runner} ${run?.model ?? ""}`.trim(), result: ok ? "pass" : "fail", costUsd: end.spend.usd, notes: `status ${end.status}; end ${run?.endReason ?? "-"} ${run?.endDetail ?? ""}; tokens ${run?.tokensIn ?? 0}/${run?.tokensOut ?? 0} ${end.spend.provenance}` });
    });
  }

  // Whether the agent's own shell commands can read a key. The probe prints only true/false per
  // variable name, never a value; an empty variable counts as unreadable (OpenCode's guard blanks).
  it("key exposure to agent shell commands", { timeout: 25 * MIN }, async () => {
    if (!want("keyenv") || (await overBudget("keyenv"))) return;
    const names = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "OPENCODE_SERVER_PASSWORD"];
    const probe = `node -e "console.log('KEYENV ' + ${JSON.stringify(names).replace(/"/g, "'")}.map((k) => k + '=' + Boolean(process.env[k])).join(' '))"`;
    const pairs = (process.env.CREWYARD_LIVE_KEYENV ?? "cx-ds:cx-dsp,cc-ds:cx-dsp,oc-ds:cx-dsp,cx-oa:cx-dsp").split(",").map((p) => p.split(":") as [string, string]);
    // Reviewers on another model than the implementer, so the independence rule keeps the pin.
    for (const [impl, rev] of pairs) {
      if (!profiles[impl] || !profiles[rev]) {
        d.row({ flow: `key visible to agent shell (${impl})`, runner: impl, result: "skipped", costUsd: null, notes: "profile not created" });
        continue;
      }
      const t = await d.call("tasks.propose", {
        projectId,
        title: `Record the environment check (${impl})`,
        description: `Run exactly this command once, unchanged: ${probe}
Then create a new file ENV_CHECK.md that holds its single output line, and commit only that file. Do nothing else.`,
        kind: "code",
        size: "S",
        budgetUsd: 0.2,
        pins: { implementer: profiles[impl], reviewer: profiles[rev] },
      });
      await d.call("tasks.approve", { taskId: t.id });
      const end = await watch(t.id, settled, 10 * MIN);
      const seen = new Set<string>();
      for (const e of d.events) {
        if (e.topic !== "runs.event" || (e.payload as { taskId?: string }).taskId !== t.id) continue;
        for (const m of JSON.stringify(e.payload).matchAll(/KEYENV((?: [A-Z_]+=(?:true|false))+)/g)) seen.add(m[1]!.trim());
      }
      const file = end.worktree && existsSync(join(end.worktree.path, "ENV_CHECK.md")) ? readFileSync(join(end.worktree.path, "ENV_CHECK.md"), "utf8").trim() : null;
      const exposed = [...seen].flatMap((l) => l.split(" ").filter((p) => p.endsWith("=true")).map((p) => p.slice(0, -5)));
      d.log("keyenv", impl, "tool output:", [...seen].join(" | ") || "-", "file:", file ?? "-");
      d.row({ flow: `key visible to agent shell (${impl})`, runner: impl, result: seen.size === 0 ? "fail" : exposed.length ? "fail" : "pass", costUsd: end.spend.usd, notes: seen.size ? `exposed: ${[...new Set(exposed)].join(", ") || "none"}` : `probe output not seen; status ${end.status}` });
    }
  });

  /**
   * Feature scan A9 live: the project's test command is a check the task text does not mention,
   * so the implementer's first try fails it; the failure goes back to the same session and the
   * second try passes. The reviewer is Codex, which reviews through its own review/start (A12),
   * pinned to the head the tests passed on.
   */
  it("loop: implement, tests fail, fix, tests pass", { timeout: 20 * MIN }, async () => {
    if (!want("loop-tests") || (await overBudget("loop-tests"))) return;
    const reviewer = profiles[REVIEWER];
    expect(profiles["cc-ds"] && reviewer).toBeTruthy();
    const check = [
      'import { existsSync, readFileSync } from "node:fs";',
      'const ok = existsSync("LOOP_CHECK.txt") && readFileSync("LOOP_CHECK.txt", "utf8").trim() === "green";',
      'if (!ok) { console.error("loop check failed: the repository root needs a file LOOP_CHECK.txt whose only content is the word green"); process.exit(1); }',
      'console.log("loop check passed");',
    ].join("\n");
    writeFileSync(join(projectPath, "loop-check.mjs"), `${check}\n`);
    git(projectPath, "add", "loop-check.mjs");
    git(projectPath, "commit", "-q", "-m", "Add the loop check");
    const restore = setTestCommand("node loop-check.mjs");
    try {
      const description = "Create a file hello.txt at the repository root containing the single word hi, then commit it. Do not run tests or any other command except git.";
      const t = await d.call("tasks.propose", { projectId, title: "Add hello.txt", description, kind: "code", size: "S", budgetUsd: 0.5, pins: { implementer: profiles["cc-ds"], reviewer } });
      await d.call("tasks.approve", { taskId: t.id });
      const end = await watch(t.id, settled, 15 * MIN);
      const decisions = end.loop.decisions.map((x) => `${x.kind}#${x.iteration}`);
      d.log("loop-tests decisions", decisions.join(" "), "| tests", end.loop.tests.map((x) => (x.passed ? "pass" : `fail(${x.exitCode})`)).join(" "), "| verdicts", end.loop.verdicts.map((v) => `${v.verdict}@${v.headSha?.slice(0, 8)}${v.native ? " native" : ""}`).join(" "));
      const wt = end.worktree;
      const head = wt ? git(wt.path, "rev-parse", "HEAD") : null;
      const kinds = end.loop.decisions.map((x) => x.kind);
      const ok = kinds[0] === "tests_failed" && kinds.includes("tests_passed") && end.loop.verdicts.some((v) => v.headSha === head);
      d.row({ flow: "loop: tests fail, fix, pass", runner: `claude-code/deepseek-flash -> ${REVIEWER}`, result: ok ? "pass" : "fail", costUsd: end.spend.usd, notes: `status ${end.status}; ${decisions.join(" ")}; verdict ${end.loop.verdicts.at(-1)?.verdict ?? "-"} at head ${end.loop.verdicts.at(-1)?.headSha === head}; native ${end.loop.verdicts.at(-1)?.native ?? "-"}` });
    } finally {
      restore();
    }
  });

  /**
   * The review loop live: the task tells the reviewer what to require and the implementer to write
   * less, so the first verdict is "changes"; its comments go back to the same implementer session,
   * then Test and Review run again. The reviewer runs on Claude Code (deepseek-v4-pro), which reads
   * the task text, unlike Codex's own review.
   */
  it("loop: review asks for changes, implementer fixes, review passes", { timeout: 20 * MIN }, async () => {
    if (!want("loop-review") || (await overBudget("loop-review"))) return;
    if (!profiles["cc-dsp"]) {
      const p = await d.attempt("providers.profileCreate", { alias: "cc-deepseek-pro", runner: "claude-code", providerId: "deepseek", credentialId: credentials.DEEPSEEK_API_KEY ?? null, defaultModel: "deepseek-v4-pro" });
      if (p.ok) profiles["cc-dsp"] = p.result.id;
    }
    expect(profiles["cc-ds"] && profiles["cc-dsp"]).toBeTruthy();
    const restore = setTestCommand(null);
    try {
      const description = [
        "Implementer: create a file greet.txt at the repository root whose only line is: hello. Commit it. Do not run any command except git.",
        "Reviewer: the task is only done when greet.txt has a second line that says: reviewed. If that line is missing, your verdict must be changes, with a comment on greet.txt asking for it. Otherwise pass.",
      ].join("\n");
      const t = await d.call("tasks.propose", { projectId, title: "Add greet.txt", description, kind: "code", size: "S", budgetUsd: 0.5, pins: { implementer: profiles["cc-ds"], reviewer: profiles["cc-dsp"] } });
      await d.call("tasks.approve", { taskId: t.id });
      const end = await watch(t.id, (x) => settled(x) && x.activeRuns === 0 && !x.runs.some((r) => !r.endedAt), 15 * MIN);
      const decisions = end.loop.decisions.map((x) => `${x.kind}#${x.iteration}`);
      d.log("loop-review decisions", decisions.join(" "), "| verdicts", end.loop.verdicts.map((v) => `${v.verdict}@${v.headSha?.slice(0, 8)}${v.stale ? " stale" : ""}`).join(" "));
      const wt = end.worktree;
      const greet = wt && existsSync(join(wt.path, "greet.txt")) ? readFileSync(join(wt.path, "greet.txt"), "utf8").trim().split(/\r?\n/) : [];
      const kinds = end.loop.decisions.map((x) => x.kind);
      const impls = end.runs.filter((r) => r.role === "implementer");
      const sameSession = impls.length >= 2 && impls[1]!.resumedFrom === impls[0]!.id;
      const ok = kinds.includes("review_changes") && kinds.at(-1) === "review_passed" && sameSession;
      d.row({ flow: "loop: review changes, fix, pass", runner: "claude-code/deepseek-flash -> claude-code/deepseek-v4-pro", result: ok ? "pass" : "fail", costUsd: end.spend.usd, notes: `status ${end.status}; ${decisions.join(" ")}; greet.txt ${JSON.stringify(greet)}; implementer resumed in its session ${sameSession}` });
    } finally {
      restore();
    }
  });

  /**
   * Handoff by fork (A11) live: a Codex researcher on DeepSeek flash hands its step to Codex on
   * DeepSeek pro (same runner, same provider), draining the turn in flight first, and the target
   * continues a compacted fork of the thread. A research step, because with only a DeepSeek key a
   * code crew has no reviewer left that is independent of both DeepSeek models.
   */
  it("handoff: fork and compact between two Codex profiles, drained", { timeout: 15 * MIN }, async () => {
    if (!want("handoff-fork") || (await overBudget("handoff-fork"))) return;
    expect(profiles["cx-ds"] && profiles["cx-dsp"]).toBeTruthy();
    const restore = setTestCommand(null);
    try {
      const description = "Look at this repository: list its files, read each source file, then write a short report of what each function does. Work through the files one at a time.";
      const t = await d.call("tasks.propose", { projectId, title: "Describe the repository", description, kind: "research", size: "S", budgetUsd: 0.5, pins: { researcher: profiles["cx-ds"] } });
      await d.call("tasks.approve", { taskId: t.id });
      const src = await d.waitFor("researcher working", async () => (await d.call("tasks.get", { taskId: t.id })).runs.find((r) => r.role === "researcher" && r.state === "running" && r.tokensIn > 0) ?? null, 5 * MIN, 1_000);
      const asked = await d.attempt("runs.handoff", { runId: src.id, targetProfileId: profiles["cx-dsp"]!, stop: "drain" });
      d.log("fork handoff", asked.ok ? "accepted" : asked.error);
      const end = await watch(t.id, (x) => x.handoffs[0] !== undefined && x.handoffs[0].closedAt !== null && !x.runs.some((r) => !r.endedAt), 10 * MIN);
      const h = end.handoffs[0];
      const forked = d.audit("handoff.forked", t.id).at(-1)?.payload as { compacted?: boolean; summaryChars?: number } | undefined;
      const failed = d.audit("handoff.fork_failed", t.id).at(-1)?.payload;
      const target = end.runs.find((r) => r.profileId === profiles["cx-dsp"]);
      d.log("fork result", JSON.stringify({ outcome: h?.outcome, kind: h?.kind, stop: h?.stop, forked, failed, target: target ? `${target.endReason} in=${target.tokensIn}` : null, status: end.status }));
      const ok = h?.outcome === "completed" && h.kind === "fork" && h.stop === "drain" && target?.endReason === "completed";
      d.row({ flow: "handoff: fork + compact, drain", runner: "codex/deepseek-flash -> codex/deepseek-v4-pro", result: ok ? "pass" : "fail", costUsd: end.spend.usd, notes: `outcome ${h?.outcome}; kind ${h?.kind}; stop ${h?.stop}; compacted ${forked?.compacted ?? "-"}; fork failure ${failed ? JSON.stringify(failed) : "none"}; target ${target?.endReason ?? "-"}; task ${end.status}` });
    } finally {
      restore();
    }
  });

  /** Points the project's test command elsewhere for one flow; returns the undo. */
  function setTestCommand(command: string | null): () => void {
    const file = join(projectPath, ".mission", "project.json");
    const before = readFileSync(file, "utf8");
    const cfg = JSON.parse(before) as { commands: { test: string | null } };
    cfg.commands.test = command;
    writeFileSync(file, JSON.stringify(cfg, null, 2));
    return () => writeFileSync(file, before);
  }

  it("turn control and stall alerts", async () => {
    if (!want("turns")) return;
    const has = (m: string) => m in d.handlers;
    const present = ["queue.edit", "queue.steer", "runs.undo", "stalls.list"].filter(has);
    d.row({ flow: "turn control / stalls", runner: "-", result: present.length ? "partial" : "skipped", costUsd: null, notes: present.length ? `handlers present: ${present.join(", ")}` : "not merged into this base (turn-control branch still open)" });
  });
});
