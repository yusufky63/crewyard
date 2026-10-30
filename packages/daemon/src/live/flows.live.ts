import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultProjectConfig, ReviewVerdict, type ProfileInput, type RequestView, type RunView, type TaskDetail } from "@crewyard/core";
import { commandLineLeaks, defaultDecide, describeRequest, hasKey, keyFor, killTree, LiveDaemon, processTable, scanFiles, type Decide, type KeyVar } from "./harness.ts";

// `pnpm --filter @crewyard/daemon live` under env-vault `run` (see vitest.live.config.ts). Every
// flow below is what a user would click, scripted; the report goes to CREWYARD_LIVE_OUT.
//
// CREWYARD_LIVE_REMOTE=owner/name   a private test repository the flows may push, PR and merge on;
//                                   without it the project is a local clone of CREWYARD_LIVE_SEED
//                                   and the GitHub flow only reads what the app says about it.
// CREWYARD_LIVE_GEMINI_BIN=<folder> a current Gemini CLI, put first on PATH for the daemon.
// CREWYARD_LIVE_FLOWS=a,b           run only these flows (setup always runs): crew, github, fallback,
//                                   research, keyenv, turns, stall.
// CREWYARD_LIVE_KEYENV=impl:rev,...  implementer:reviewer pairs for the key exposure probe.
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
      // Clone refuses a parent that does not exist, as the wizard does.
      mkdirSync(parent, { recursive: true });
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
    // The github flow merges this change into the test repo, so every run asks for a function that
    // is not there yet; a fixed name finds the previous run's merge and leaves nothing to commit.
    const fn = `times${Date.now().toString(36).slice(-5)}`;
    const title = `Add a ${fn} function and its test`;
    const description = `In src/math.js add and export a function ${fn}(a, b) that returns the product of a and b. Add a test for it in src/math.test.js next to the existing ones. Run the tests with \`npm test\`, then commit. Keep the change small.`;

    // What the app picks on its own, for the record; it is cancelled before anything runs.
    const auto = await d.call("tasks.propose", { projectId, title, description });
    d.log("auto proposal", auto.kind, auto.size, auto.classification.map((c) => c.code).join(","), "|", crewLine(auto), "| estimate", auto.crew?.estimate.usd ?? "?", auto.crew?.estimate.provenance);
    await d.call("tasks.cancel", { taskId: auto.id });
    // A reviewer pinned to the implementer's model breaks the independence rule: what does the proposal do with the pin?
    if (profiles["cx-ds"]) {
      const clash = await d.call("tasks.propose", { projectId, title, description, kind: "code", size: "S", pins: { implementer: profiles["cc-ds"], reviewer: profiles["cx-ds"] } });
      const r = clash.crew?.members.find((m) => m.role === "reviewer");
      d.log("pinned same-model reviewer", crewLine(clash), "| reviewer member reasons", r?.reasons.map((x) => x.code).join(",") ?? "-");
      await d.call("tasks.cancel", { taskId: clash.id });
    }

    const t = await d.call("tasks.propose", { projectId, title, description, kind: "code", size: "S", budgetUsd: 0.5, pins: { implementer: profiles["cc-ds"], reviewer } });
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
    // A repository without CI never passes the checks item, so the app offers no merge. The user
    // then merges on GitHub; the app must notice that and allow the cleanup.
    let outside = false;
    if (!merged.ok && gated.live?.gate?.items.find((i) => i.id === "checks")?.status === "unknown" && gated.live.checks.total === 0) {
      execFileSync("gh", ["pr", "merge", String(pr.number), "--repo", REMOTE, "--merge"], { windowsHide: true, stdio: "pipe" });
      outside = true;
      d.log("merged on GitHub with gh pr merge (outside the app)");
    }
    const task = await d.waitFor(
      "task merged",
      async () => {
        await d.call("github.refresh", { projectId });
        const x = await d.call("tasks.get", { taskId: t.id });
        return x.status === "merged" ? x : null;
      },
      3 * MIN,
      5_000,
    ).catch(() => d.call("tasks.get", { taskId: t.id }));
    const after = await d.call("github.taskPull", { taskId: t.id });
    d.log("after merge", task.status, JSON.stringify(after.cleanup));
    const removed = await d.attempt("github.removeWorktree", { projectId, path: t.worktree.path });
    d.log("remove worktree", removed.ok ? JSON.stringify(removed.result) : removed.error, "folder still there:", existsSync(t.worktree.path));
    const appMerged = merged.ok && merged.result.merged;
    const cleaned = task.status === "merged" && removed.ok && removed.result.removed;
    d.row({ flow: "github push/PR/merge/cleanup", runner: "-", result: appMerged && cleaned ? "pass" : cleaned ? "partial" : "fail", costUsd: 0, notes: `PR #${pr.number}; app merge ${appMerged ? "ok" : (merged.ok ? "not merged" : merged.error)}${outside ? "; merged on GitHub instead" : ""}; task ${task.status}; worktree removed ${removed.ok && removed.result.removed}` });
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

  // The report server (docs/adr/0007): a read-only researcher calls report and propose_followup
  // through the PowerShell relay and the daemon's pipe; the follow-up becomes a draft only.
  for (const [key, runner] of [
    ["cc-ds", "claude-code/deepseek"],
    ["oc-ds", "opencode/deepseek"],
  ] as const) {
    const flow = `mcp report on ${runner}`;
    it(flow, { timeout: 10 * MIN }, async () => {
      if (!want("mcp") || (await overBudget(flow))) return;
      const id = profiles[key];
      if (!id) {
        d.row({ flow, runner, result: "skipped", costUsd: null, notes: "profile not created" });
        return;
      }
      const description = [
        "You have MCP tools from the server named crewyard. Do exactly these steps, in order, and nothing else:",
        '1. Call the crewyard report tool with kind "checkpoint" and text "Read package.json".',
        '2. Call the crewyard propose_followup tool with title "Add a lint script" and description "The repo has no lint step."',
        '3. Call the crewyard report tool with kind "done" and text "Test runner named".',
        "4. Answer in one sentence which test runner the test script in package.json uses. Do not change any file.",
      ].join("\n");
      const t = await d.call("tasks.propose", { projectId, title: "Research: report through Crewyard", description, kind: "research", size: "S", budgetUsd: 0.2, pins: { researcher: id } });
      const approved = await d.attempt("tasks.approve", { taskId: t.id });
      if (!approved.ok) {
        d.row({ flow, runner, result: "fail", costUsd: null, notes: `approve refused: ${approved.error}` });
        return;
      }
      const end = await watch(t.id, (x) => ENDED.has(x.status) || x.status === "needs_input", 8 * MIN);
      if (end.status === "needs_input") await d.call("tasks.cancel", { taskId: t.id });
      const reports = await d.call("mcp.reports.list", { taskId: t.id, includeClosed: true });
      const usage = (await d.call("mcp.servers.usage", { projectId })).filter((u) => u.taskId === t.id);
      const types = reports.map((r) => r.type).sort();
      d.log(flow, "reports", JSON.stringify(reports.map((r) => ({ type: r.type, title: r.title, text: r.text.slice(0, 80) }))), "servers", JSON.stringify(usage.map((u) => u.servers.map((s) => s.name))));
      const followup = reports.find((r) => r.type === "followup");
      let draft = "none";
      if (followup) {
        const tasksBefore = (await d.call("tasks.list", { projectId })).length;
        const accepted = await d.call("mcp.followups.accept", { reportId: followup.id });
        const created = await d.call("tasks.get", { taskId: accepted.taskId });
        draft = `${created.status}, ${created.runs.length} runs, ${(await d.call("tasks.list", { projectId })).length - tasksBefore} new task`;
        expect(created.status).toBe("proposed");
        expect(created.runs).toHaveLength(0);
        await d.call("tasks.cancel", { taskId: created.id });
      }
      const ok = types.includes("checkpoint") && types.includes("done") && types.includes("followup") && usage.some((u) => u.servers.some((s) => s.name === "crewyard"));
      d.row({ flow, runner: `${runner} ${end.runs.at(-1)?.model ?? ""}`.trim(), result: ok ? "pass" : "fail", costUsd: end.spend.usd, notes: `status ${end.status}; reports ${types.join(", ") || "none"}; follow-up draft: ${draft}` });
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

  // A cancelled OpenCode run must take its `opencode serve` with it (AGENTS.md: agent processes
  // are killed as a tree on stop). An orphan has left that tree, so it is looked for by name.
  it("stop: a cancelled OpenCode run leaves no opencode serve behind", { timeout: 10 * MIN }, async () => {
    const flow = "stop OpenCode mid-turn";
    if (!want("stop") || (await overBudget(flow))) return;
    const id = profiles["oc-ds"];
    if (!id) {
      d.row({ flow, runner: "opencode/deepseek", result: "skipped", costUsd: null, notes: "profile not created" });
      return;
    }
    // cross-spawn quotes each argument through the .cmd shim: the line reads `opencode.exe" "serve" ...`.
    const serving = () => new Set(processTable().filter((r) => r.name.toLowerCase() === "opencode.exe" && /[\s"]serve[\s"]/.test(r.commandLine ?? "")).map((r) => r.pid));
    const before = serving();
    const t = await d.call("tasks.propose", { projectId, title: "Research: describe every file", description: "Read every file in this repository, one at a time, and describe each in two sentences. Do not change any file.", kind: "research", size: "S", budgetUsd: 0.2, pins: { researcher: id } });
    await d.call("tasks.approve", { taskId: t.id });
    const started = await watch(t.id, (x) => x.runs.some((r) => r.state === "running") || ENDED.has(x.status), 3 * MIN, 500);
    const during = [...serving()].filter((p) => !before.has(p));
    await d.call("tasks.cancel", { taskId: t.id });
    const end = await watch(t.id, (x) => ENDED.has(x.status), 2 * MIN);
    await new Promise((r) => setTimeout(r, 5_000));
    const left = [...serving()].filter((p) => !before.has(p));
    for (const pid of left) killTree(pid);
    d.log(flow, "status at cancel", started.status, "serve during", during.join(",") || "-", "left after cancel", left.join(",") || "-");
    d.row({ flow, runner: "opencode/deepseek", result: during.length === 0 ? "partial" : left.length === 0 ? "pass" : "fail", costUsd: end.spend.usd, notes: `serve processes during the turn ${during.length}, left 5 s after cancel ${left.length}; status ${end.status}` });
    expect(left).toEqual([]);
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
    const file = join(projectPath, ".crewyard", "project.json");
    const before = readFileSync(file, "utf8");
    const cfg = JSON.parse(before) as { commands: { test: string | null } };
    cfg.commands.test = command;
    writeFileSync(file, JSON.stringify(cfg, null, 2));
    return () => writeFileSync(file, before);
  }

  /**
   * Best of 2 live: the implement step on two DeepSeek profiles of different runners, each in its
   * own worktree; the first that finishes is kept, the other stopped and parked, and the review
   * continues on the kept worktree.
   */
  it("best of 2: two implementers, keep one, review continues", { timeout: 25 * MIN }, async () => {
    if (!want("best-of") || (await overBudget("best-of"))) return;
    const a = profiles["cc-ds"];
    const b = profiles["oc-ds"] ?? profiles["cx-ds"];
    const reviewer = profiles[REVIEWER];
    if (!a || !b || !reviewer) throw new Error("best of 2 needs cc-ds, oc-ds or cx-ds, and the reviewer profile");
    const description = "In src/math.js add and export a function square(n) that returns n * n. Add a test for it in src/math.test.js. Run `npm test`, then commit. Keep the change small.";
    const t = await d.call("tasks.propose", { projectId, title: "Add a square function and its test", description, kind: "code", size: "S", budgetUsd: 0.5, bestOf: 2, pins: { implementer: a, reviewer } });
    const g = t.bestOfGroup!;
    d.log("best-of proposal", g.variants.map((v) => `${alias(v.candidate.profileId)} ${v.candidate.estimate.usd ?? "?"}`).join(" | "), "| crew estimate", t.crew?.estimate.usd ?? "?", t.crew?.estimate.provenance);
    await d.call("tasks.approve", { taskId: t.id, bestOf: { profileIds: [a, b] } });
    const started = await d.call("tasks.get", { taskId: t.id });
    d.log("best-of started", started.bestOfGroup?.phase, "reservations", JSON.stringify(d.store.db.prepare("select amount_usd from spend_reservations where task_id = ? and settled_at is null").all(t.id)));
    const ready = await d.waitFor(
      "a finished variant",
      async () => {
        const x = await d.call("tasks.get", { taskId: t.id });
        const done = x.bestOfGroup?.variants.find((v) => v.status === "review" && v.diffStat);
        const stuck = x.bestOfGroup?.phase === "failed" || x.status === "cancelled";
        return done ? { x, done } : stuck ? { x, done: null } : null;
      },
      15 * MIN,
      5_000,
    );
    for (const v of ready.x.bestOfGroup!.variants) d.log(`  variant ${v.position} ${alias(v.candidate.profileId)}: ${v.status} files ${v.diffStat?.files.map((f) => f.path).join(",") ?? "-"} test ${v.test ? (v.test.passed ? "pass" : "fail") : "-"} verdict ${v.decisions.at(-1)?.kind ?? "-"} spend ${v.spend.usd ?? "?"}`);
    if (!ready.done) {
      d.row({ flow: "best of 2", runner: "cc-ds + oc-ds", result: "fail", costUsd: ready.x.spend.usd, notes: `no variant finished; phase ${ready.x.bestOfGroup?.phase}` });
      return;
    }
    const kept = await d.call("tasks.keepVariant", { taskId: t.id, variantId: ready.done.id });
    const lost = kept.bestOfGroup!.variants.find((v) => v.id !== ready.done!.id)!;
    d.log("kept", alias(ready.done.candidate.profileId), "worktree", kept.worktree ? d.rel(kept.worktree.path) : "-", "| other", lost.outcome, lost.parkedAt ? "parked" : `not parked (${lost.parkError ?? "-"})`, "folder there", lost.worktreePath ? existsSync(lost.worktreePath) : false);
    const end = await watch(t.id, settled, 12 * MIN);
    const verdict = verdictOf(t.id);
    const pass = end.worktree ? testsPass(end.worktree.path) : false;
    const ok = end.status === "review" && end.bestOfGroup?.phase === "kept" && end.worktree?.path === ready.done.worktreePath && Boolean(lost.parkedAt) && pass;
    d.row({ flow: "best of 2 (keep one, review continues)", runner: `${alias(a)} + ${alias(b)} -> ${REVIEWER}`, result: ok ? "pass" : "fail", costUsd: end.spend.usd, notes: `kept ${alias(ready.done.candidate.profileId)}; other ${lost.outcome}/${lost.parkedAt ? "parked" : lost.parkError}; task ${end.status}; tests ${pass}; verdict ${verdict.ok ? verdict.value.verdict : "none"}; spend counts both variants ${end.spend.provenance}` });
  });

  /**
   * Hibernation live: an implementer asks a question and nobody answers; after the idle window
   * (1 minute here) its process stops and the run stays open. The answer wakes it by session id.
   * (A read-only role cannot ask: Claude Code runs it in "dontAsk", where AskUserQuestion is off.)
   */
  it("hibernate: an idle run waiting on a question sleeps and wakes with the answer", { timeout: 15 * MIN }, async () => {
    if (!want("hibernate") || (await overBudget("hibernate"))) return;
    const p = profiles["cc-ds"];
    const reviewer = profiles[REVIEWER];
    if (!p || !reviewer) throw new Error("the hibernate flow needs cc-ds and the reviewer profile");
    await d.call("settings.update", { hibernation: { enabled: true, idleMinutes: 1 } });
    let taskId = "";
    let held: RequestView | null = null;
    let release = false;
    d.decide = (r): ReturnType<Decide> => {
      if (r.taskId === taskId && r.kind === "question") {
        held = r;
        return release ? defaultDecide(r) : null;
      }
      return defaultDecide(r);
    };
    try {
      const t = await d.call("tasks.propose", {
        projectId,
        title: "Write the chosen name to NAME.txt",
        description: "Before you change anything, use the AskUserQuestion tool to ask me one question: which name the new helper should have, with the options square and sq. Wait for my answer. Then create a file NAME.txt at the repository root that contains only the name I chose, and commit it. Do not run any other command than git.",
        kind: "code",
        size: "S",
        budgetUsd: 0.5,
        pins: { implementer: p, reviewer },
      });
      taskId = t.id;
      await d.call("tasks.approve", { taskId: t.id });
      const asleep = await watch(t.id, (x) => Boolean(x.runs[0]?.hibernatedAt) || ENDED.has(x.status), 6 * MIN, 5_000);
      const run = asleep.runs[0]!;
      const counts = d.store.db.prepare("select count(*) as n from run_hibernation where run_id = ? and woke_at is null").get(run.id) as { n: number };
      d.log("hibernated", run.hibernatedAt ?? "no", "question held", Boolean(held), "end", run.endReason ?? "open", "rows asleep", counts.n);
      release = true;
      const end = await watch(t.id, settled, 6 * MIN);
      const woke = d.store.db.prepare("select woke_by from run_hibernation where run_id = ?").all(run.id) as Array<{ woke_by: string | null }>;
      const impl = end.runs.filter((r) => r.role === "implementer");
      const name = end.worktree && existsSync(join(end.worktree.path, "NAME.txt")) ? readFileSync(join(end.worktree.path, "NAME.txt"), "utf8").trim() : null;
      d.log("after wake", "implementer runs", impl.length, "NAME.txt", name ?? "-", "status", end.status);
      const ok = Boolean(run.hibernatedAt) && !run.endedAt && end.status === "review" && impl.length === 1 && woke.some((w) => w.woke_by === "answer") && name === "square";
      d.row({ flow: "hibernate and wake on the answer", runner: `claude-code/deepseek-flash -> ${REVIEWER}`, result: ok ? "pass" : held ? "fail" : "partial", costUsd: end.spend.usd, notes: `question ${held ? "asked" : "never asked"}; hibernated ${Boolean(run.hibernatedAt)}; woke by ${woke.map((w) => w.woke_by).join(",") || "-"}; implementer runs ${impl.length}; NAME.txt ${name ?? "-"}; task ${end.status}` });
    } finally {
      d.decide = defaultDecide;
      await d.call("settings.update", { hibernation: { idleMinutes: 30 } });
    }
  });

  // Turn control on Claude Code: a follow-up typed while a turn runs waits in the step's queue and
  // becomes the next turn of the same session; then "Undo last turn" takes that turn back. The
  // reviewer is held on the tiny task budget meanwhile, so nothing else works in the worktree.
  it("turn control: queue, flush at the turn boundary, undo (Claude Code)", { timeout: 20 * MIN }, async () => {
    if (!want("turns") || (await overBudget("turn control"))) return;
    const impl = profiles["cc-ds"];
    const reviewer = profiles[REVIEWER];
    if (!impl || !reviewer) throw new Error("turn control needs cc-ds and the reviewer profile");
    let taskId = "";
    const held: RequestView[] = [];
    const roleOf = (runId: string | null) => (runId ? (d.store.db.prepare("select m.role from runs r join crew_members m on m.id = r.member_id where r.id = ?").get(runId) as { role: string } | undefined)?.role : undefined);
    d.decide = (r): ReturnType<Decide> => {
      if (r.taskId === taskId && r.payload.kind === "handoff" && r.payload.trigger === "budget") {
        if (roleOf(r.runId) === "reviewer") {
          if (!held.some((h) => h.id === r.id)) held.push(r);
          return null;
        }
        return { kind: "handoff", decision: "continue" };
      }
      return defaultDecide(r);
    };
    const t = await d.call("tasks.propose", {
      projectId,
      title: "Add notes a and b",
      description: "Create the file notes/a.txt containing the word alpha and commit it. Then stop and report; do nothing else.",
      kind: "code",
      size: "S",
      budgetUsd: 0.0005,
      fallback: "manual",
      pins: { implementer: impl, reviewer },
    });
    taskId = t.id;
    await d.call("tasks.approve", { taskId: t.id });
    const live = await watch(t.id, (x) => x.runs.some((r) => r.role === "implementer" && r.state === "running") || ENDED.has(x.status), 8 * MIN, 300);
    const run = live.runs.find((r) => r.role === "implementer") as RunView;
    const follow = "Next, create the file notes/b.txt containing the word beta and commit it.";
    const queued = await d.attempt("runs.message", { runId: run.id, text: follow, sessionId: run.nativeSessionId });
    const queueLen = queued.ok ? queued.result.queue.length : -1;
    let edited = "not tried";
    if (queued.ok && queued.result.queue[0]) {
      const e = await d.attempt("queue.edit", { runId: run.id, messageId: queued.result.queue[0].id, text: `${follow} Use a one-line commit message.` });
      edited = e.ok ? `ok (${e.result.queue.length} queued)` : e.error;
    }
    d.log("queued while running:", queued.ok ? `${queueLen} in queue, steer ${JSON.stringify(queued.result.controls.steer)}` : queued.error, "| edit:", edited);
    // The implementer ends after the queued turn; the reviewer then waits on its budget request.
    const parked = await watch(t.id, (x) => (held.length > 0 && Boolean(x.runs.find((r) => r.id === run.id)?.endedAt)) || ENDED.has(x.status), 10 * MIN, 1_000);
    const wt = parked.worktree?.path ?? "";
    const before = { a: existsSync(join(wt, "notes", "a.txt")), b: existsSync(join(wt, "notes", "b.txt")) };
    const implRun = parked.runs.find((r) => r.id === run.id) as RunView;
    const turns = d.events.filter((e) => {
      const p = e.payload as { runId?: string; event?: { type?: string } };
      return e.topic === "runs.event" && p.runId === run.id && p.event?.type === "turn.started";
    }).length;
    d.log("after flush:", JSON.stringify(before), "turns", turns, "queue", implRun.queue.length, "undo control", JSON.stringify(implRun.controls.undo));
    let undo: string;
    let after = before;
    const preview = await d.attempt("runs.undoPreview", { runId: run.id });
    if (preview.ok) {
      d.log("undo preview", JSON.stringify({ files: preview.result.files, commits: preview.result.commits, native: preview.result.native, noteQueued: preview.result.noteQueued }));
      const u = await d.attempt("runs.undo", { runId: run.id, turnId: preview.result.turnId });
      undo = u.ok ? "ok" : u.error;
      after = { a: existsSync(join(wt, "notes", "a.txt")), b: existsSync(join(wt, "notes", "b.txt")) };
      d.log("undo", undo, JSON.stringify(after), "log", git(wt, "log", "--format=%s", `${parked.worktree?.baseSha}..HEAD`).replace(/\n/g, " | "));
    } else {
      undo = `preview refused: ${preview.error}`;
      d.log("undo preview refused", preview.error);
    }
    // Let the reviewer go on.
    for (const r of held) await d.attempt("requests.answer", { requestId: r.id, answer: { kind: "handoff", decision: "continue" }, runId: r.runId, sessionId: r.sessionId });
    d.decide = defaultDecide;
    const end = await watch(t.id, settled, 10 * MIN);
    const flushed = queued.ok && queueLen === 1 && before.a && before.b && implRun.queue.length === 0;
    d.row({ flow: "queue + flush at turn boundary", runner: "cc-ds", result: flushed ? "pass" : "fail", costUsd: null, notes: `queued ${queueLen}, edit ${edited}; turns ${turns}; a ${before.a} b ${before.b}` });
    d.row({ flow: "undo last turn", runner: "cc-ds", result: undo === "ok" && after.a && !after.b ? "pass" : "fail", costUsd: end.spend.usd, notes: `${undo}; after undo a ${after.a} b ${after.b}; task ${end.status}` });
  });

  // "Steer now" on Codex: a queued message goes into the turn in flight through turn/steer.
  it("turn control: steer now (Codex)", { timeout: 15 * MIN }, async () => {
    if (!want("turns") || (await overBudget("steer"))) return;
    const impl = profiles["cx-ds"];
    const reviewer = profiles[REVIEWER];
    if (!impl || !reviewer) throw new Error("steer needs cx-ds and the reviewer profile");
    const t = await d.call("tasks.propose", {
      projectId,
      title: "Add statistics helpers",
      description: "Create src/stats.js exporting mean(values) and median(values), and src/stats.test.js with one node:test test for each. Run `npm test` after writing each function. Commit at the end.",
      kind: "code",
      size: "S",
      budgetUsd: 0.5,
      pins: { implementer: impl, reviewer },
    });
    await d.call("tasks.approve", { taskId: t.id });
    const live = await watch(t.id, (x) => x.runs.some((r) => r.role === "implementer" && r.controls.steer.ok) || ENDED.has(x.status), 8 * MIN, 300);
    const run = live.runs.find((r) => r.role === "implementer") as RunView;
    let steer = `never steerable (${run.controls.steer.reason ?? "-"})`;
    if (run.controls.steer.ok) {
      const q = await d.attempt("runs.message", { runId: run.id, text: "Also export range(values), the largest value minus the smallest, from src/stats.js with one test.", sessionId: run.nativeSessionId });
      const id = q.ok ? q.result.queue[0]?.id : undefined;
      const s = id ? await d.attempt("queue.steer", { runId: run.id, messageId: id, sessionId: run.nativeSessionId }) : null;
      steer = !q.ok ? `message refused: ${q.error}` : !id ? "message went straight in (no queue item)" : s?.ok ? `ok (queue ${s.result.queue.length})` : `refused: ${s?.error ?? "-"}`;
    }
    d.log("steer", steer);
    const end = await watch(t.id, settled, 10 * MIN);
    const file = end.worktree ? join(end.worktree.path, "src", "stats.js") : "";
    const src = file && existsSync(file) ? readFileSync(file, "utf8") : "";
    const pass = end.worktree ? testsPass(end.worktree.path) : false;
    d.row({ flow: "steer now", runner: "cx-ds", result: steer.startsWith("ok") && /range/.test(src) ? "pass" : "fail", costUsd: end.spend.usd, notes: `${steer}; range in stats.js ${/range/.test(src)}; tests ${pass}; task ${end.status}` });
  });

  // One stall alert: the no-events rule at its lowest setting, and a command that stays quiet longer.
  it("stall alert: no events", { timeout: 15 * MIN }, async () => {
    if (!want("stall") || (await overBudget("stall"))) return;
    const impl = profiles["cc-ds"];
    const reviewer = profiles[REVIEWER];
    if (!impl || !reviewer) throw new Error("the stall flow needs cc-ds and the reviewer profile");
    const saved = (await d.call("settings.get", undefined)).stalls;
    await d.call("settings.update", { stalls: { noEventsMinutes: 1, cooldownMinutes: 1 } });
    try {
      const t = await d.call("tasks.propose", {
        projectId,
        title: "Wait for a slow command",
        description: "Run exactly this command once and wait for it to finish: node -e \"setTimeout(() => console.log('slept'), 100000)\"\nThen create notes/stall.txt containing the word done and commit it. Do nothing else.",
        kind: "code",
        size: "S",
        budgetUsd: 0.5,
        pins: { implementer: impl, reviewer },
      });
      await d.call("tasks.approve", { taskId: t.id });
      const alerts = await d
        .waitFor(
          "stall alert",
          async () => {
            const a = await d.call("stalls.list", { taskId: t.id, includeClosed: true });
            return a.length ? a : null;
          },
          5 * MIN,
          5_000,
        )
        .catch(() => []);
      const notices = d.events.filter((e) => e.topic === "stall.notice" && (e.payload as { taskId?: string }).taskId === t.id).length;
      d.log("stall alerts", JSON.stringify(alerts.map((a) => ({ rule: a.rule, minutes: a.minutes, cleared: a.clearedAt !== null }))), "notices", notices);
      const end = await watch(t.id, settled, 8 * MIN);
      const closed = await d.call("stalls.list", { taskId: t.id, includeClosed: true });
      const cleared = closed.filter((a) => a.clearedAt !== null).length;
      d.row({ flow: "stall alert (no events, 1 min)", runner: "cc-ds", result: alerts.some((a) => a.rule === "no_events") && notices > 0 ? "pass" : "fail", costUsd: end.spend.usd, notes: `${alerts.length} alerts (${alerts.map((a) => `${a.rule} ${a.minutes ?? "-"}m`).join(", ")}); ${notices} stall.notice; ${cleared} cleared after the run moved on; task ${end.status}` });
    } finally {
      await d.call("settings.update", { stalls: saved });
    }
  });
});
