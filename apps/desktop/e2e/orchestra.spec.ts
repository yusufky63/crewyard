import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { FakeStep } from "@crewyard/adapter-fake";
import { composerMode, daemon, launch, result, running, say, write, type Harness } from "./harness.ts";

// Orchestra end to end (docs/adr/0019, design §7.1 item 10) against scripted runners and real git:
// the composer opens on Orchestra, the first goal shows its explainer card before any model call,
// the plan review orders two tasks that change the same file, one click approves the plan, a
// research report reaches the writing tasks only after you accept it, finished tasks are merged
// into the goal branch in order, a conflicting merge asks you and its follow-up resolves it, and
// the last review's pass opens the existing pull request gate, which stays yours. Also: Solo
// starts on its own click, a ready-made analysis goes to Crew, a plan of one task becomes an
// ordinary task, and a plan the checks refuse twice fails with the parser's words. Nothing is
// pushed or opened on GitHub: the test repo has no remote. What each agent was told is read from
// the run log the scripted runners keep (harness `runs()`).

test.describe.configure({ mode: "serial" });

let h: Harness;

test.beforeAll(async () => {
  h = await launch();
});

test.afterAll(async () => {
  await h?.close();
});

// Turkish goal text, as the planner quotes it back in `basis` and every goal task's prompt.
const GOAL = "Parolaların yanına passkey ile girişi ekle ve belgele";
const ONE_GOAL = "README'deki yazım hatasını düzelt";

const TITLES = {
  research: "Compare WebAuthn libraries",
  server: "Server: passkey registration and login",
  client: "Client: passkey button and flow",
  docs: "Docs: passkeys guide",
  one: "Fix the typo in the README",
};

const task = (t: { key: string; title: string; kind: string; mode: string; dependsOn?: string[]; paths?: string[]; basis: string }) => ({
  key: t.key,
  title: t.title,
  kind: t.kind,
  mode: t.mode,
  size: "S",
  description: `${t.title}, as the goal asks.`,
  acceptance: ["It works and is described."],
  basis: t.basis,
  dependsOn: t.dependsOn ?? [],
  paths: t.paths ?? [],
  reason: "Needed for the goal.",
  priority: "medium",
});

// Server and client both plan to change src/auth/session.ts and can run at the same time, so the
// daemon orders the client after the server. The docs task's real change also touches CHANGELOG.md,
// which nobody planned: that is the conflicting merge.
const PLAN = {
  summary: "Assumed the session store stays as it is.",
  tasks: [
    task({ key: "research", title: TITLES.research, kind: "research", mode: "solo", basis: "passkey ile giriş" }),
    task({ key: "server", title: TITLES.server, kind: "code", mode: "crew", dependsOn: ["research"], paths: ["src/auth/server.ts", "src/auth/session.ts"], basis: "passkey ile girişi ekle" }),
    task({ key: "client", title: TITLES.client, kind: "code", mode: "solo", dependsOn: ["research"], paths: ["src/auth/session.ts", "src/ui/passkey button.tsx"], basis: "passkey ile girişi ekle" }),
    task({ key: "docs", title: TITLES.docs, kind: "docs", mode: "solo", dependsOn: ["research"], paths: ["docs/passkeys guide.md"], basis: "belgele" }),
  ],
};

const ONE_PLAN = { summary: "One change is enough.", tasks: [task({ key: "typo", title: TITLES.one, kind: "code", mode: "solo", paths: ["README.md"], basis: "yazım hatasını düzelt" })] };

const SUMMARY = "Use one WebAuthn library on both sides; büyük İ harfi works in the display name.";
const findings = (summary: string) => result({ summary, findings: [] });
const pass = result({ verdict: "pass", summary: "Looks right.", comments: [] });

// The planner's usage as a runner reports it. A scripted runner cannot measure a real planner, so
// these are only what the fake says; the test reads back what the daemon recorded for the planning
// run and checks the spend against the stated ceiling. Real counts against §4.4's 80k/8k heuristic
// come from the live `goal` flow (packages/daemon/src/live/flows.live.ts).
const PLANNER_TOKENS = { tokensIn: 61_500, tokensOut: 5_200 };
const plannerUsage = (costUsd: number): FakeStep => ({
  emit: { type: "usage.update", ...PLANNER_TOKENS, cacheRead: 0, cacheWrite: 0, reasoning: 0, contextUsed: null, contextSize: null, costUsd, costProvenance: "reported" },
});

const CHANGELOG_SERVER = "- Passkey sign-in on the server\n";
const CHANGELOG_DOCS = "- Passkeys guide\n";

interface GoalTask {
  taskId: string;
  key: string;
  title: string;
  status: string;
  released: boolean;
  joined: { sha: string } | null;
  dependsOn: Array<{ key: string; source: string }>;
}
interface GoalRead {
  id: string;
  status: string;
  reason: string | null;
  budgetUsd: number | null;
  suggestedBudgetUsd: number | null;
  branch: string | null;
  collapsedTaskId: string | null;
  integration: { taskId: string; reviewPassed: boolean } | null;
  tasks: GoalTask[];
  joins: Array<{ taskId: string; outcome: string; conflictPaths: string[]; afterSha: string | null }>;
  decisions: Array<{ id: string; kind: string; taskId: string | null; answeredAt: string | null }>;
  revisions: Array<{ state: string; error: string | null; planTaskId: string | null; planningSpend: { usd: number | null; provenance: string } }>;
}
interface RunRead {
  role: string;
  endReason: string | null;
  tokensIn: number;
  tokensOut: number;
  cost: { usd: number | null; provenance: string };
}
const taskDetail = (page: Page, taskId: string) => daemon<{ id: string; title: string; status: string; goal: unknown; crew: { members: Array<{ role: string }> } | null; runs: RunRead[]; worktree: { path: string } | null }>(page, "tasks.get", { taskId });

/** The prompts of the runs started for a script key, oldest first. */
const promptsOf = (key: string) =>
  h
    .runs()
    .filter((r) => r.key === key)
    .map((r) => r.prompt);
const WRITERS = [`docs@${TITLES.docs}`, `implementer@${TITLES.server}`, `implementer@${TITLES.client}`];

const goals = (page: Page) => daemon<Array<{ id: string; title: string }>>(page, "goals.list", { projectId: projectId! });
const goalByText = async (page: Page, text: string) => {
  const g = (await goals(page)).find((x) => x.title === text);
  return g ? daemon<GoalRead>(page, "goals.get", { goalId: g.id }) : null;
};
const tasks = (page: Page) => daemon<Array<{ id: string; title: string; status: string; goal: unknown }>>(page, "tasks.list", {});
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, windowsHide: true, encoding: "utf8" });

let projectId: string | null = null;

const composer = (page: Page) => page.locator("main .tk-composer");
const modes = (page: Page) => composer(page).getByRole("group", { name: "How to run" });
const pressed = async (page: Page) => (await modes(page).getByRole("button", { pressed: true }).textContent())?.trim();

test("opens a project on Orchestra, the default", async () => {
  const { page, repo } = h;
  const start = page.getByRole("region", { name: "Start" });
  await expect(start).toBeVisible({ timeout: 30_000 });
  await start.getByRole("button", { name: "Open folder" }).click();
  await start.locator("button.ptile", { hasText: basename(repo) }).click();
  await page.locator("#app-sidebar").getByRole("button", { name: "Tasks", exact: true }).click();
  await expect(page.getByLabel("New goal")).toBeVisible();
  await expect.poll(() => pressed(page)).toBe("Orchestra");
  projectId = (await daemon<Array<{ id: string; path: string }>>(page, "projects.list", undefined)).find((p) => p.path === repo)!.id;
});

test("a ready-made analysis goes to Crew and the composer stays on Orchestra", async () => {
  const { page } = h;
  const main = page.locator("main");
  await main.getByLabel("Ready-made").selectOption({ label: "Find bugs and problems" });
  // The control shows Crew for this submission, with the reason, and the button proposes a crew.
  await expect.poll(() => pressed(page)).toBe("Crew");
  await expect(composer(page).getByText("Ready-made analyses and issues run as one task.")).toBeVisible();
  await expect(main.getByLabel("New task")).toHaveValue(/^Find bugs and problems\n/);
  await main.getByRole("button", { name: "Propose crew" }).click();
  await expect(main.getByRole("region", { name: /Suggested crew for/ })).toBeVisible();
  const proposed = (await tasks(page)).find((t) => t.title === "Find bugs and problems")!;
  expect(proposed.status).toBe("proposed");
  expect(proposed.goal ?? null).toBeNull();
  // No goal was planned for it, and nothing started.
  expect(await goals(page)).toEqual([]);
  // A preset leaves your mode as it was: the next request is a goal again.
  await expect.poll(() => pressed(page)).toBe("Orchestra");
  await expect(page.getByLabel("New goal")).toBeVisible();
});

test("Solo starts one agent on its own click and is never remembered", async () => {
  const { page } = h;
  h.setScripts({ researcher: [[running, say("The README has one heading."), findings("One heading, no install steps.")]] });
  await composerMode(page, "Solo");
  await page.getByLabel("New task").fill("Summarise the README\nList what it covers.");
  await page.getByLabel("Kind").selectOption("research");
  await expect(composer(page).getByText("Starts one agent now, in its own worktree, on the account shown.")).toBeVisible();
  // The button states the estimate it starts at; there is no proposal to approve.
  const startButton = composer(page).getByRole("button", { name: /^Start · ~?\$\d+\.\d+ Estimated$/ });
  await expect(startButton).toBeEnabled();
  await startButton.click();
  await expect.poll(async () => (await tasks(page)).find((t) => t.title === "Summarise the README")?.status, { timeout: 20_000 }).toBe("done");
  const solo = (await tasks(page)).find((t) => t.title === "Summarise the README")!;
  const detail = await daemon<{ crew: { members: Array<{ role: string }> } | null; goal: unknown }>(page, "tasks.get", { taskId: solo.id });
  expect(detail.crew!.members.map((m) => m.role)).toEqual(["researcher"]);
  expect(detail.goal ?? null).toBeNull();
  // Solo is picked per submission: the composer goes back to Orchestra.
  await expect.poll(() => pressed(page)).toBe("Orchestra");
});

async function planReview(page: Page): Promise<Locator> {
  const review = page.locator("main .gv.gp");
  await expect(review).toBeVisible({ timeout: 20_000 });
  return review;
}

const goalView = (page: Page) => page.locator("main .gv:not(.gp)");

test("the first goal: explainer card, plan review with the overlap ordered, one approval", async () => {
  const { page } = h;
  h.setScripts({
    "goal-planner": [[running, say("read src/auth"), { wait: 1_500 }, plannerUsage(0.03), result(PLAN)]],
    [`researcher@${TITLES.research}`]: [[running, say("Compared two libraries."), findings(SUMMARY)]],
    // The docs task is quick and lands first; its CHANGELOG line is the one the server's conflicts with.
    [`docs@${TITLES.docs}`]: [[running, write("docs/passkeys guide.md", "# Passkeys\n\nSign in with a passkey next to your password.\n"), write("CHANGELOG.md", CHANGELOG_DOCS), say("Wrote the guide.")]],
    // The server takes longer, so its merge comes after the docs and conflicts on CHANGELOG.md.
    [`implementer@${TITLES.server}`]: [[running, { wait: 2_500 }, write("src/auth/server.ts", "export const passkeys = true;\n"), write("CHANGELOG.md", CHANGELOG_SERVER), say("Added passkey routes.")]],
    [`implementer@${TITLES.client}`]: [[running, write("src/ui/passkey button.tsx", "export const PasskeyButton = () => null;\n"), say("Added the button.")]],
    // The follow-up after the conflict: the implementer takes the goal branch's CHANGELOG line.
    "resume@conflicts with the goal branch": [[running, write("CHANGELOG.md", CHANGELOG_DOCS), say("Took the goal branch's CHANGELOG.")]],
    reviewer: [[running, say("Reviewed."), pass]],
  });
  await composerMode(page, "Orchestra");
  await page.getByLabel("New goal").fill(GOAL);
  // The button carries the planning estimate, the foot note its ceiling.
  const plan = composer(page).getByRole("button", { name: /^Plan goal · ~\$\d+\.\d+ Estimated$/ });
  await expect(plan).toBeEnabled();
  const estimate = Number((await plan.textContent())!.match(/~\$(\d+\.\d+)/)![1]);
  const note = composer(page).getByText(/^Planning only reads the project and costs up to \$\d+\.\d+\. Nothing else starts until you approve the plan\.$/);
  await expect(note).toBeVisible();
  const ceiling = Number((await note.textContent())!.match(/up to \$(\d+\.\d+)/)![1]);
  await plan.click();

  // Before any model call: what happens, what stays yours, and the project's default goal budget.
  const card = page.getByRole("alertdialog", { name: "Before your first goal in this project" });
  await expect(card).toBeVisible();
  await expect(card.getByText("Opening the pull request")).toBeVisible();
  await expect(card.getByText("Passing research results to tasks that write code")).toBeVisible();
  expect(await goals(page)).toEqual([]);
  await card.getByLabel("Default goal budget for this project (USD)").fill("5");
  await card.getByRole("button", { name: /^Plan goal · ~\$\d+\.\d+ Estimated$/ }).click();
  await expect(card).toHaveCount(0);

  // Planning: one read-only run, with Stop planning while it works.
  const review = await planReview(page);
  await expect(review.getByRole("button", { name: "Stop planning" })).toBeVisible();
  await expect(review.getByRole("checkbox", { name: "Skip 04" })).toBeVisible({ timeout: 20_000 });
  const goal = (await goalByText(page, GOAL))!;
  // One read-only planning run, given the goal quoted.
  const planner = h.runs().filter((r) => r.role === "goal-planner");
  expect(planner).toHaveLength(1);
  expect(planner[0]!.writes).toBe("none");
  expect(planner[0]!.prompt).toContain(GOAL);
  // What the daemon recorded for the planning run, read back rather than echoed from the script:
  // its tokens, and a spend with its label that stays under the ceiling the button stated (§4.4).
  const planRun = (await taskDetail(page, goal.revisions[0]!.planTaskId!)).runs.find((r) => r.role === "goal-planner")!;
  expect({ tokensIn: planRun.tokensIn, tokensOut: planRun.tokensOut }).toEqual(PLANNER_TOKENS);
  const spend = goal.revisions[0]!.planningSpend;
  expect(["reported", "estimated"]).toContain(spend.provenance);
  expect(spend.usd).toBeGreaterThan(0);
  expect(spend.usd).toBeLessThanOrEqual(ceiling);
  test.info().annotations.push({
    type: "planning run (scripted runner)",
    description: `daemon recorded ${planRun.tokensIn} in, ${planRun.tokensOut} out, run cost ${planRun.cost.usd ?? "?"} ${planRun.cost.provenance}; goal planning spend $${spend.usd} ${spend.provenance}; button ~$${estimate} Estimated, ceiling $${ceiling}`,
  });
  // The first-goal card's budget is the project's default, and the review's prefill rests on it.
  expect((await daemon<{ defaultBudgetUsd: number | null }>(page, "goals.preview", { projectId: projectId!, text: GOAL })).defaultBudgetUsd).toBe(5);
  expect(goal.suggestedBudgetUsd).toBe(5);

  // Overlap ordered automatically, with the way out; the report line names the writing tasks it feeds.
  await expect(review.getByText("03 runs after 02: both change src/auth/session.ts")).toBeVisible();
  await expect(review.getByRole("button", { name: "Run side by side anyway" })).toBeVisible();
  await expect(review.getByText(/^01's report feeds 02, 03,? and 04: you read and accept it before they start$/)).toBeVisible();
  const client = goal.tasks.find((t) => t.key === "client")!;
  expect(client.dependsOn).toEqual(expect.arrayContaining([{ key: "server", source: "overlap", taskId: expect.any(String) }]));
  // Every cost on the review carries its provenance (planning, four tiles, the last review); nothing has started.
  const costs = review.locator(".gp-cost");
  await expect(costs).toHaveCount(6);
  for (const c of await costs.all()) await expect(c).toHaveText(/(Estimated|Reported|Unknown)/);
  await expect(review.getByText("Nothing starts until you approve. You open the pull request.")).toBeVisible();
  expect(goal.tasks.every((t) => !t.released)).toBe(true);

  // The keyboard path (design §3.7): Space on a tile skips it and accepts it again; Ctrl Enter approves.
  const approve = review.getByRole("button", { name: /^Approve and start 4 tasks · ~?\$\d+\.\d+ Estimated$/ });
  await expect(approve).toBeEnabled();
  const docsTile = review.locator('.gp-tile[data-plan-key="docs"]');
  await docsTile.focus();
  await page.keyboard.press("Space");
  await expect(review.getByRole("checkbox", { name: "Accept 04" })).not.toBeChecked();
  await expect(review.getByRole("button", { name: /^Approve and start 3 tasks · / })).toBeVisible();
  await page.keyboard.press("Space");
  await expect(review.getByRole("checkbox", { name: "Skip 04" })).toBeChecked();
  await expect(approve).toBeEnabled();
  await page.keyboard.press("Control+Enter");
  await expect(goalView(page)).toBeVisible({ timeout: 20_000 });
  await expect.poll(async () => (await goalByText(page, GOAL))!.tasks.find((t) => t.key === "research")!.released).toBe(true);
  // Approved at the budget the review prefilled from the card's default.
  expect((await goalByText(page, GOAL))!.budgetUsd).toBe(5);
});

test("a research report reaches the writing tasks only after you accept it", async () => {
  const { page } = h;
  const view = goalView(page);
  const accept = view.getByRole("button", { name: "Accept report" });
  await expect(accept).toBeVisible({ timeout: 20_000 });
  await expect(view.getByText(/^Read the report of 01 Compare WebAuthn libraries, then accept it/)).toBeVisible();
  const before = (await goalByText(page, GOAL))!;
  expect(before.status).toBe("needs_you");
  expect(before.reason).toBe("report");
  // Waiting for your reading: no writing task was released, and no writing agent was started.
  expect(before.tasks.filter((t) => t.key !== "research").map((t) => t.released)).toEqual([false, false, false]);
  expect(h.runs().filter((r) => WRITERS.includes(r.key))).toEqual([]);
  // The researcher read the goal too; its report is what you accept.
  expect(promptsOf(`researcher@${TITLES.research}`)[0]).toContain(GOAL);
  await accept.click();
  await expect.poll(async () => (await goalByText(page, GOAL))!.tasks.filter((t) => t.released).map((t) => t.key).sort(), { timeout: 20_000 }).toEqual(["docs", "research", "server"]);
  // The client waits for the server: same files.
  const waiting = (await goalByText(page, GOAL))!.tasks.find((t) => t.key === "client")!;
  expect(waiting.released).toBe(false);
  // The accepted report's summary, Turkish casing intact, and the goal quoted reach the writing agents (§4.11).
  await expect.poll(() => [WRITERS[0]!, WRITERS[1]!].map((k) => promptsOf(k).length), { timeout: 20_000 }).toEqual([1, 1]);
  for (const key of [WRITERS[0]!, WRITERS[1]!]) {
    const prompt = promptsOf(key)[0]!;
    expect(prompt).toContain(SUMMARY);
    expect(prompt).toContain(GOAL);
  }
});

test("tasks merge into the goal branch in order, and a conflicting merge asks you", async () => {
  const { page, repo } = h;
  const view = goalView(page);
  const conflict = view.getByText(/^Merging 02 Server: passkey registration and login into the goal branch conflicts/);
  await expect(conflict).toBeVisible({ timeout: 40_000 });
  await expect(view.getByText("Conflicted files: CHANGELOG.md")).toBeVisible();
  const goal = (await goalByText(page, GOAL))!;
  const id = (key: string) => goal.tasks.find((t) => t.key === key)!.taskId;
  expect(goal.joins.map((j) => [j.taskId, j.outcome])).toEqual([
    [id("docs"), "joined"],
    [id("server"), "conflict"],
  ]);
  expect(goal.joins[1]!.conflictPaths).toEqual(["CHANGELOG.md"]);
  // The docs commit is on the goal branch; the scheduler never guesses at the conflict.
  expect(git(repo, "show", `${goal.branch}:CHANGELOG.md`).replace(/\r\n/g, "\n")).toBe(CHANGELOG_DOCS);
  expect(git(repo, "show", `${goal.branch}:docs/passkeys guide.md`)).toContain("Sign in with a passkey");
  expect(goal.tasks.find((t) => t.key === "client")!.released).toBe(false);

  // The three ways design §4.9 offers, each naming the task it acts on.
  await expect(view.getByRole("button", { name: "I will merge it myself", exact: true })).toBeEnabled();
  // "I'll merge it" opens the task's own worktree folder and keeps the decision open for Check again.
  // Explorer is stubbed: the test records the folder instead of opening a window on the desktop.
  await h.app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as unknown as { openedFolders: string[] }).openedFolders = opened;
    shell.openPath = (async (path: string) => {
      opened.push(path);
      return "";
    }) as typeof shell.openPath;
  });
  await view.getByRole("button", { name: "I will merge it myself", exact: true }).click();
  await expect(view.getByText(/^The task's worktree is open in Explorer\./)).toBeVisible();
  const serverWorktree = (await taskDetail(page, id("server"))).worktree!.path;
  await expect.poll(() => h.app.evaluate(() => (globalThis as unknown as { openedFolders?: string[] }).openedFolders ?? [])).toEqual([serverWorktree]);
  expect((await goalByText(page, GOAL))!.decisions.find((d) => d.kind === "conflict")!.answeredAt).toBeNull();
  await expect(view.getByRole("button", { name: "Check again", exact: true })).toBeEnabled();
  await expect(view.getByRole("button", { name: "Leave 02 out of the goal", exact: true })).toBeEnabled();
  // Your answer: one more run of the server's implementer in its own session; Review runs again.
  await view.getByRole("button", { name: "Send to 02's implementer", exact: true }).click();
  await expect.poll(async () => (await goalByText(page, GOAL))!.tasks.find((t) => t.key === "server")!.joined, { timeout: 40_000 }).not.toBeNull();
  const server = await daemon<{ runs: Array<{ role: string; endReason: string | null }> }>(page, "tasks.get", { taskId: id("server") });
  expect(server.runs.filter((r) => r.role === "implementer")).toHaveLength(2);
  expect(server.runs.filter((r) => r.role === "reviewer" && r.endReason === "completed")).toHaveLength(2);
});

test("the last review passes on the goal branch and opens the pull request gate, which stays yours", async () => {
  const { page, repo } = h;
  const view = goalView(page);
  await expect(view.getByText("Ready for review")).toBeVisible({ timeout: 40_000 });
  const goal = (await goalByText(page, GOAL))!;
  const id = (key: string) => goal.tasks.find((t) => t.key === key)!.taskId;
  // Merged in order: docs first, the server after its follow-up, the client after the server (same files).
  expect(goal.joins.map((j) => [j.taskId, j.outcome])).toEqual([
    [id("docs"), "joined"],
    [id("server"), "conflict"],
    [id("server"), "joined"],
    [id("client"), "joined"],
  ]);
  expect(goal.status).toBe("ready_for_review");
  expect(goal.integration!.reviewPassed).toBe(true);
  const head = git(repo, "rev-parse", goal.branch!).trim();
  expect(git(repo, "show", `${goal.branch}:src/ui/passkey button.tsx`)).toContain("PasskeyButton");
  expect(git(repo, "show", `${goal.branch}:src/auth/server.ts`)).toContain("passkeys");
  // The last review read the branch head; nothing was pushed and your main branch is untouched.
  const integration = await daemon<{ loop: { verdicts: Array<{ verdict: string; headSha: string | null }> } }>(page, "tasks.get", { taskId: goal.integration!.taskId });
  expect(integration.loop.verdicts.at(-1)).toMatchObject({ verdict: "pass", headSha: head });
  expect(git(repo, "log", "--format=%s", "main").trim()).toBe("init");
  expect(git(repo, "remote").trim()).toBe("");
  // The client started only after the server joined. It builds on the accepted report and reads the
  // goal quoted; the server is only an overlap ordering, not a prerequisite, so it is not listed as
  // a result the client builds on (§4.11).
  const clientPrompt = promptsOf(`implementer@${TITLES.client}`)[0]!;
  expect(clientPrompt).toContain(SUMMARY);
  expect(clientPrompt).toContain(GOAL);
  expect(clientPrompt).toContain("Its place in the plan: task 03 of 4; it waits for 01.");

  // The goal view lists the merge order with each merge commit (design §3.3).
  const merges = view.locator(".gv-merges");
  await merges.locator("summary", { hasText: "Merge order" }).click();
  await expect(merges.locator("li")).toHaveText([
    new RegExp(`^04 ${TITLES.docs} · [0-9a-f]{7}$`),
    new RegExp(`^02 ${TITLES.server} · [0-9a-f]{7}$`),
    new RegExp(`^03 ${TITLES.client} · [0-9a-f]{7}$`),
  ]);
  // The task list (design §3.4): the goal is one group row with its four tasks under it; the
  // planning and integration tasks never show, and the joined tasks never count on their own
  // under Ready for review, where the goal counts once.
  const list = page.locator(".tk-list");
  const row = list.locator(".gl-row", { hasText: GOAL });
  await expect(row.locator(".gl-tasks .tk-row")).toHaveCount(4);
  for (const title of Object.values(TITLES).slice(0, 4)) await expect(row.locator(".gl-tasks").getByText(title, { exact: true })).toBeVisible();
  const planTitle = (await taskDetail(page, goal.revisions[0]!.planTaskId!)).title;
  const reviewTitle = (await taskDetail(page, goal.integration!.taskId)).title;
  await expect(list.getByText(planTitle, { exact: true })).toHaveCount(0);
  await expect(list.getByText(reviewTitle, { exact: true })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: /^Ready for review/ }).locator(".num")).toHaveText("1");

  await expect(view.getByText("The last review passed on the goal branch. You open the pull request.")).toBeVisible();
  await view.getByRole("button", { name: "Open pull request" }).click();
  // The existing gate, for the goal branch: reviewed at this commit, and the push is yours.
  const gate = page.getByRole("list", { name: "Before a pull request" });
  await expect(gate).toBeVisible();
  await expect(gate.getByText("Reviewed at this commit")).toBeVisible();
  await expect(gate.getByText("Review passed")).toBeVisible();
  await expect(gate.getByText("Not pushed yet")).toBeVisible();
  // The pull request is for the goal branch; with nothing pushed, opening it stays blocked.
  await expect(page.locator(".tp-flow", { hasText: goal.branch! })).toBeVisible();
  await expect(page.locator(".tp").getByRole("button", { name: "Open pull request" })).toBeDisabled();
  expect(git(repo, "remote").trim()).toBe("");
});

test("a plan of one task becomes an ordinary task, with no goal branch", async () => {
  const { page, repo } = h;
  h.setScripts({
    "goal-planner": [[running, say("read README.md"), plannerUsage(0.03), result(ONE_PLAN)]],
    [`implementer@${TITLES.one}`]: [[running, write("README.md", "# demo\n\nFixed.\n"), say("Fixed the typo.")]],
    reviewer: [[running, say("Reviewed."), pass]],
  });
  await goalView(page).getByRole("button", { name: "Close" }).click();
  await expect(page.getByLabel("New goal")).toBeVisible();
  await page.getByLabel("New goal").fill(ONE_GOAL);
  const plan = composer(page).getByRole("button", { name: /^Plan goal · ~\$\d+\.\d+ Estimated$/ });
  await expect(plan).toBeEnabled();
  await plan.click();
  // The card shows once per project: the second goal plans at once.
  await expect(page.getByRole("alertdialog", { name: "Before your first goal in this project" })).toHaveCount(0);
  const review = await planReview(page);
  await expect(review.getByText("One task is enough")).toBeVisible({ timeout: 20_000 });
  await expect(review.getByText("Approving makes it an ordinary task with this crew: no goal branch, and its own pull request.")).toBeVisible();
  await review.getByRole("button", { name: /^Approve and start · ~?\$\d+\.\d+ Estimated$/ }).click();

  await expect.poll(async () => (await goalByText(page, ONE_GOAL))?.collapsedTaskId ?? null, { timeout: 20_000 }).not.toBeNull();
  const goal = (await goalByText(page, ONE_GOAL))!;
  expect(goal.branch).toBeNull();
  expect(goal.integration).toBeNull();
  await expect.poll(async () => (await tasks(page)).find((t) => t.id === goal.collapsedTaskId)?.status, { timeout: 20_000 }).toBe("review");
  const ordinary = (await tasks(page)).find((t) => t.id === goal.collapsedTaskId)!;
  expect(ordinary.title).toBe(TITLES.one);
  expect(ordinary.goal ?? null).toBeNull();
  // Its own worktree branch, the ordinary per-task flow; no goal branch was made for it.
  const branches = git(repo, "branch", "--list", "crewyard/goal/*").split("\n").filter((l) => l.trim());
  expect(branches).toHaveLength(1);
});

// Fifteen tasks: the strict output schema takes it (it has no bounds), parseGoalPlan refuses it.
const TOO_MANY = { summary: "Split very finely.", tasks: Array.from({ length: 15 }, (_, i) => task({ key: `t${i + 1}`, title: `Parça ${i + 1}: küçük adım`, kind: "code", mode: "solo", paths: [`src/parça ${i + 1}.ts`], basis: "çok parçaya böl" })) };
const TOO_MANY_GOAL = "Ayarlar sayfasını çok parçaya böl";

test("a plan the checks refuse twice fails with the parser's words, and Run as one task proposes a crew", async () => {
  const { page } = h;
  h.setScripts({
    // The first run and the corrective turn both return fifteen tasks; whichever key the corrective
    // turn resumes under, it gets the same plan.
    "goal-planner": [[running, say("read src"), plannerUsage(0.02), result(TOO_MANY)]],
    "resume@Your plan was refused": [[running, plannerUsage(0.01), result(TOO_MANY)]],
  });
  await composerMode(page, "Orchestra");
  await page.getByLabel("New goal").fill(TOO_MANY_GOAL);
  await composer(page).getByRole("button", { name: /^Plan goal · ~\$\d+\.\d+ Estimated$/ }).click();
  const review = await planReview(page);
  await expect(review.getByText("Planning failed")).toBeVisible({ timeout: 20_000 });
  // The parser's refusal is said in the app's words; the stored error keeps the parser's text.
  await expect(review.getByText("The planner returned 15 tasks; a goal holds at most 8.")).toBeVisible();
  // Exactly one corrective turn, carrying the parser's words; no third planning run on its own.
  const corrective = h.runs().filter((r) => r.prompt.includes("Your plan was refused"));
  expect(corrective).toHaveLength(1);
  expect(corrective[0]!.prompt).toContain("the plan has 15 tasks; the limit is 8");
  expect(corrective[0]!.writes).toBe("none");
  const failed = (await goalByText(page, TOO_MANY_GOAL))!;
  expect(failed.revisions.at(-1)).toMatchObject({ state: "failed", error: "the plan has 15 tasks; the limit is 8" });
  expect(failed.tasks).toEqual([]);
  // Retrying is one more paid run, so its button states the cost; nothing retries by itself.
  await expect(review.getByRole("button", { name: /^Retry planning · ~\$\d+\.\d+ Estimated/ })).toBeEnabled();
  expect(h.runs().filter((r) => (r.role === "goal-planner" && r.prompt.includes(TOO_MANY_GOAL)) || r.prompt.includes("Your plan was refused"))).toHaveLength(2);

  await review.getByRole("button", { name: "Run as one task" }).click();
  await expect.poll(async () => (await goalByText(page, TOO_MANY_GOAL))?.collapsedTaskId ?? null, { timeout: 20_000 }).not.toBeNull();
  const one = await taskDetail(page, (await goalByText(page, TOO_MANY_GOAL))!.collapsedTaskId!);
  // One ordinary Crew task, proposed for you to approve: nothing started.
  expect(one.status).toBe("proposed");
  expect(one.goal ?? null).toBeNull();
  expect(one.crew!.members.length).toBeGreaterThan(0);
  expect(one.runs).toEqual([]);
  await expect(page.getByRole("region", { name: /Suggested crew for/ })).toBeVisible();
});

const HALT_GOAL = "Giriş sayfası için iki ayrı araştırma yap";
const HALT_PLAN = {
  summary: "Two separate research tasks.",
  tasks: [
    task({ key: "ra", title: "Araştırma A: mevcut giriş", kind: "research", mode: "solo", basis: "iki ayrı araştırma" }),
    task({ key: "rb", title: "Araştırma B: rakipler", kind: "research", mode: "solo", basis: "iki ayrı araştırma" }),
  ],
};
// A request every provider refuses: no same-profile retry, so both tasks fail at once with the same key.
const refused: FakeStep = { emit: { type: "run.ended", reason: "failed", detail: "HTTP 400: invalid tool schema" } };

test("a decision's Replan opens the form with its cost, and its planning run answers the decision", async () => {
  const { page } = h;
  h.setScripts({
    "goal-planner": [[running, say("read src"), plannerUsage(0.02), result(HALT_PLAN)]],
    "researcher@Araştırma A: mevcut giriş": [[running, refused]],
    "researcher@Araştırma B: rakipler": [[running, refused]],
  });
  await page.getByRole("button", { name: "Close" }).first().click().catch(() => undefined);
  await composerMode(page, "Orchestra");
  await page.getByLabel("New goal").fill(HALT_GOAL);
  await composer(page).getByRole("button", { name: /^Plan goal · ~\$\d+\.\d+ Estimated$/ }).click();
  const review = await planReview(page);
  const approve = review.getByRole("button", { name: /^Approve and start 2 tasks · / });
  await expect(approve).toBeEnabled({ timeout: 20_000 });
  await approve.click();

  // Two tasks failed the same way: the stop rule halts the goal and asks you.
  const view = goalView(page);
  const halt = view.locator(".gv-need", { hasText: "Halted: two tasks failed the same way" });
  await expect(halt).toBeVisible({ timeout: 30_000 });
  const before = (await goalByText(page, HALT_GOAL))!;
  const plannerRuns = () => h.runs().filter((r) => r.role === "goal-planner" && r.prompt.includes(HALT_GOAL)).length;
  expect(plannerRuns()).toBe(1);

  // The decision's Replan opens the form that states the cost; the click alone starts nothing.
  const open = halt.getByRole("button", { name: /^Replan · ~\$\d+\.\d+ Estimated/ });
  await expect(open).toHaveAttribute("aria-expanded", "false");
  await open.click();
  const form = halt.locator("form");
  await expect(form.getByLabel("Note to the planner (optional)")).toBeVisible();
  expect(plannerRuns()).toBe(1);
  expect((await goalByText(page, HALT_GOAL))!.decisions.find((d) => d.kind === "stop_rule")!.answeredAt).toBeNull();

  await form.getByLabel("Note to the planner (optional)").fill("Araştırmaları tek göreve indir.");
  await form.getByRole("button", { name: /^Replan · ~\$\d+\.\d+ Estimated/ }).click();
  // One planning run started, and it answered the decision.
  await expect.poll(plannerRuns, { timeout: 20_000 }).toBe(2);
  const after = (await goalByText(page, HALT_GOAL))!;
  expect(after.revisions.length).toBe(before.revisions.length + 1);
  expect(after.decisions.find((d) => d.kind === "stop_rule")!.answeredAt).not.toBeNull();
});
