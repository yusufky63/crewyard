import yaml from "js-yaml";
import type { TriggeredWorkflow, WorkflowCheck, WorkflowFinding } from "@crewyard/core";

// Reads GitHub Actions workflow files to answer two questions without calling GitHub:
// which workflows a push of a branch would start, and which files break the user's CI rules
// (PLAN.md §10): push only on main, concurrency with cancel-in-progress, timeout-minutes on
// every job, Windows/macOS only on tags or manual runs, no schedule in a private repo.

export interface WorkflowFile {
  file: string;
  text: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? [v] : []);

export interface ParsedWorkflow {
  file: string;
  name: string;
  /** Normalized `on:` map; an event with no filter maps to {}. */
  on: Record<string, Obj>;
  doc: Obj;
}

export function parseWorkflow(f: WorkflowFile): ParsedWorkflow | { file: string; error: string } {
  let doc: unknown;
  try {
    doc = yaml.safeLoad(f.text, { filename: f.file });
  } catch (err) {
    return { file: f.file, error: err instanceof Error ? err.message.split("\n")[0]! : String(err) };
  }
  if (!isObj(doc)) return { file: f.file, error: "not a mapping" };
  // YAML 1.1 readers turn a bare `on` key into `true`; accept both spellings.
  const rawOn = "on" in doc ? doc.on : (doc as Record<string, unknown>)["true"];
  const on: Record<string, Obj> = {};
  if (typeof rawOn === "string") on[rawOn] = {};
  else if (Array.isArray(rawOn)) for (const e of rawOn) on[String(e)] = {};
  else if (isObj(rawOn)) for (const [k, v] of Object.entries(rawOn)) on[k] = isObj(v) ? v : {};
  const name = typeof doc.name === "string" ? doc.name : f.file.replace(/^.*[\\/]/, "");
  return { file: f.file, name, on, doc };
}

/** GitHub filter pattern to a regex: `*` stops at `/`, `**` does not, `?` and `+` quantify the previous character. */
export function patternToRegex(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i++;
      } else re += "[^/]*";
    } else if (c === "?" || c === "+") re += c;
    else if (c === "[") {
      const end = pattern.indexOf("]", i);
      if (end < 0) re += "\\[";
      else {
        re += pattern.slice(i, end + 1);
        i = end;
      }
    } else re += c.replace(/[.^${}()|\\/]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** Last matching pattern wins; a leading `!` excludes. */
export function matchesFilter(patterns: string[], value: string): boolean {
  let hit = false;
  for (const p of patterns) {
    const neg = p.startsWith("!");
    if (patternToRegex(neg ? p.slice(1) : p).test(value)) hit = !neg;
  }
  return hit;
}

function branchFilterPasses(filter: Obj, branch: string): boolean {
  if ("branches" in filter) return matchesFilter(list(filter.branches), branch);
  if ("branches-ignore" in filter) return !matchesFilter(list(filter["branches-ignore"]), branch);
  return true;
}

const hasPaths = (filter: Obj) => "paths" in filter || "paths-ignore" in filter;

/** Does a push of this branch start the workflow's `push` trigger? */
export function pushTriggers(w: ParsedWorkflow, branch: string): boolean {
  const push = w.on.push;
  if (!push) return false;
  // A push filter that names only tags never runs for branch pushes.
  if (("tags" in push || "tags-ignore" in push) && !("branches" in push) && !("branches-ignore" in push)) return false;
  return branchFilterPasses(push, branch);
}

/** Does a new commit on an open PR into `base` start a pull_request(_target) run? */
export function pullRequestTriggers(w: ParsedWorkflow, base: string): { event: Obj; hit: boolean } | null {
  for (const key of ["pull_request", "pull_request_target"]) {
    const ev = w.on[key];
    if (!ev) continue;
    const types = list(ev.types);
    if (types.length && !types.includes("synchronize")) continue;
    if (branchFilterPasses(ev, base)) return { event: ev, hit: true };
  }
  return null;
}

const COSTLY = /windows|macos|mac-|osx/i;

/** Runner labels of one job, with `${{ matrix.x }}` expanded from the job's matrix. */
export function runnerLabels(job: Obj): string[] {
  const runsOn = job["runs-on"];
  const raw = isObj(runsOn) ? [...list(runsOn.labels), ...list(runsOn.group)] : list(runsOn);
  const matrix = isObj(job.strategy) && isObj(job.strategy.matrix) ? job.strategy.matrix : null;
  const labels: string[] = [];
  for (const label of raw) {
    const m = label.match(/^\$\{\{\s*matrix\.([\w-]+)\s*\}\}$/);
    if (m?.[1] && matrix) {
      labels.push(...list(matrix[m[1]]));
      if (Array.isArray(matrix.include)) for (const inc of matrix.include) if (isObj(inc) && m[1] in inc) labels.push(String(inc[m[1]]));
    } else labels.push(label);
  }
  return [...new Set(labels)];
}

const jobsOf = (w: ParsedWorkflow): Array<[string, Obj]> => (isObj(w.doc.jobs) ? Object.entries(w.doc.jobs).filter((e): e is [string, Obj] => isObj(e[1])) : []);

function costlyJobs(w: ParsedWorkflow): string[] {
  const out: string[] = [];
  for (const [id, job] of jobsOf(w)) for (const l of runnerLabels(job)) if (COSTLY.test(l)) out.push(`${id}: ${l}`);
  return out;
}

/** Workflows a push of `branch` would start. `openPullBase` is the base of the branch's open PR, if any. */
export function triggeredBy(files: WorkflowFile[], branch: string, openPullBase: string | null): TriggeredWorkflow[] {
  const result: TriggeredWorkflow[] = [];
  for (const f of files) {
    const w = parseWorkflow(f);
    if ("error" in w) continue;
    const events: TriggeredWorkflow["events"] = [];
    let conditional = true;
    let anyUnfiltered = false;
    if (pushTriggers(w, branch)) {
      events.push("push");
      if (!hasPaths(w.on.push!)) anyUnfiltered = true;
    }
    const pr = openPullBase ? pullRequestTriggers(w, openPullBase) : null;
    if (pr) {
      events.push("pull_request");
      if (!hasPaths(pr.event)) anyUnfiltered = true;
    }
    if (!events.length) continue;
    if (anyUnfiltered) conditional = false;
    result.push({ file: w.file, name: w.name, events, conditional, costlyRunners: costlyJobs(w) });
  }
  return result;
}

const MAIN_NAMES = new Set(["main", "master"]);

export function checkWorkflows(files: WorkflowFile[], opts: { private: boolean | null; defaultBranch: string | null }): WorkflowCheck {
  const findings: WorkflowFinding[] = [];
  const mains = new Set([...MAIN_NAMES, ...(opts.defaultBranch ? [opts.defaultBranch] : [])]);
  const add = (file: string, rule: WorkflowFinding["rule"], severity: WorkflowFinding["severity"], job: string | null = null, detail: string | null = null) =>
    findings.push({ file, rule, severity, job, detail });

  for (const f of files) {
    const w = parseWorkflow(f);
    if ("error" in w) {
      add(f.file, "parse_error", "error", null, w.error);
      continue;
    }
    const push = w.on.push;
    const branchPush = push !== undefined && !(("tags" in push || "tags-ignore" in push) && !("branches" in push) && !("branches-ignore" in push));
    if (push && branchPush) {
      if (!("branches" in push)) add(w.file, "push_all_branches", "error", null, "branches-ignore" in push ? "branches-ignore" : null);
      else {
        const extra = list(push.branches).filter((b) => !b.startsWith("!") && !mains.has(b));
        if (extra.length) add(w.file, "push_all_branches", "warning", null, extra.join(", "));
      }
    }
    const onCode = branchPush || "pull_request" in w.on || "pull_request_target" in w.on;
    const jobs = jobsOf(w);

    if (onCode) {
      const top = w.doc.concurrency;
      const jobConc = jobs.map(([, j]) => j.concurrency);
      const covered = top !== undefined || (jobs.length > 0 && jobConc.every((c) => c !== undefined));
      if (!covered) add(w.file, "no_concurrency", "error");
      else {
        const all = top !== undefined ? [top] : jobConc;
        // An expression may switch it on per event; only a missing or literal false key is a finding.
        const cancels = all.every((c) => isObj(c) && (c["cancel-in-progress"] === true || (typeof c["cancel-in-progress"] === "string" && c["cancel-in-progress"].includes("${{"))));
        if (!cancels) add(w.file, "no_cancel_in_progress", "error");
      }
      for (const [id, job] of jobs) {
        for (const label of runnerLabels(job)) if (COSTLY.test(label)) add(w.file, "costly_runner_on_push", "error", id, label);
      }
    }
    for (const [id, job] of jobs) {
      // Jobs that call a reusable workflow cannot set timeout-minutes; the called workflow does.
      if (job.uses === undefined && job["timeout-minutes"] === undefined) add(w.file, "no_timeout", "error", id);
    }
    if ("schedule" in w.on && opts.private !== false) add(w.file, "schedule_private", opts.private ? "error" : "warning");
  }
  return { files: files.map((f) => f.file), findings };
}
