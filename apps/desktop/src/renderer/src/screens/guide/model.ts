import { signInKindFor, type CredentialSummary, type GithubAuth, type KeyCheckView, type ProfileSummary, type SignInStatus, type TaskStatus, type TaskSummary, type ToolCheck, type ToolId } from "@crewyard/core";

// The Guide's Getting started list. Every row reads state the daemon already has through existing
// IPC; nothing here is sample data. A read that has not answered yet is "checking", a read that
// failed is "unknown" (never "not done"), and a state that wants a fix is "problem".

export type GuideState = "done" | "todo" | "problem" | "unknown" | "checking";

export type GuideRowId = "machine" | "profile" | "project" | "firstTask" | "firstCrew" | "github";

export const GUIDE_ROWS: GuideRowId[] = ["machine", "profile", "project", "firstTask", "firstCrew", "github"];

/** One query as React Query hands it over: data, still loading, or failed. */
export interface Read<T> {
  data: T | undefined;
  pending: boolean;
  error: unknown;
}

const settled = (r: Read<unknown>): "pending" | "error" | "ok" => (r.error ? "error" : r.data === undefined ? "pending" : "ok");

export const GUIDE_AGENTS: ToolId[] = ["claude", "codex", "opencode", "gemini"];

/** A CLI that is installed and at a version Crewyard was checked with. */
const usable = (t: ToolCheck) => t.found && (!t.gate || t.gate.status === "ok");
/** Installed, but too old or otherwise refused by the version gate. */
const gated = (t: ToolCheck) => t.found && Boolean(t.gate) && t.gate!.status !== "ok";

/**
 * Passed when Git and at least one agent CLI are usable. Git is required, so a missing or refused
 * Git is a problem; no agent CLI at all is "not yet" (installing one is the next step), but agents
 * that are all installed and all refused by their version gate are a problem.
 */
export function machineState(tools: Partial<Record<ToolId, Read<ToolCheck>>>): GuideState {
  const git = tools.git;
  const agents = GUIDE_AGENTS.map((id) => tools[id]).filter((r): r is Read<ToolCheck> => Boolean(r));
  if (!git || settled(git) === "pending" || agents.length < GUIDE_AGENTS.length || agents.some((a) => settled(a) === "pending")) return "checking";
  if (settled(git) === "error") return "unknown";
  const g = git.data!;
  if (!g.found || gated(g)) return "problem";
  const read = agents.filter((a) => settled(a) === "ok").map((a) => a.data!);
  if (read.some(usable)) return "done";
  if (read.some(gated)) return "problem";
  // Some agent checks failed: one of them might be installed, so the answer is not known.
  if (read.length < agents.length) return "unknown";
  return "todo";
}

export interface ProfileInput {
  profiles: Read<ProfileSummary[]>;
  credentials: Read<CredentialSummary[]>;
  keyChecks: Read<KeyCheckView[]>;
  signIns: Read<SignInStatus[]>;
}

type ProfileVerdict = "ready" | "problem" | "waiting";

/** One profile: ready to run, broken in a way the user must fix, or simply not signed in yet. */
export function profileVerdict(p: ProfileSummary, credentials: CredentialSummary[], keyChecks: KeyCheckView[], signIns: SignInStatus[]): ProfileVerdict {
  if (signInKindFor(p.runner, p.providerId)) {
    const s = signIns.find((x) => x.profileId === p.id);
    if (s?.state === "signed_in") return "ready";
    return s?.state === "blocked" || s?.update ? "problem" : "waiting";
  }
  // No key and no runner sign-in: a local provider, which needs nothing stored.
  if (p.credentialId === null) return "ready";
  const cred = credentials.find((c) => c.id === p.credentialId);
  if (!cred || !cred.isSet) return "problem";
  return keyChecks.find((k) => k.credentialId === cred.id)?.state === "invalid" ? "problem" : "ready";
}

export function profileState(input: ProfileInput): GuideState {
  const reads = [input.profiles, input.credentials, input.keyChecks, input.signIns];
  if (reads.some((r) => settled(r) === "error")) {
    // Profiles alone can still say "none yet".
    return settled(input.profiles) === "ok" && input.profiles.data!.length === 0 ? "todo" : "unknown";
  }
  if (reads.some((r) => settled(r) === "pending")) return "checking";
  const profiles = input.profiles.data!;
  if (profiles.length === 0) return "todo";
  const verdicts = profiles.map((p) => profileVerdict(p, input.credentials.data!, input.keyChecks.data!, input.signIns.data!));
  if (verdicts.includes("ready")) return "done";
  return verdicts.includes("problem") ? "problem" : "todo";
}

/** A task in one of these states had its crew approved at least once (the same set the Start checklist uses). */
export const APPROVED: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["queued", "running", "needs_input", "limited", "handing_off", "failed", "review", "merged", "done"]);

export function taskState(tasks: Read<TaskSummary[]>, test: (t: TaskSummary) => boolean): GuideState {
  const s = settled(tasks);
  if (s === "error") return "unknown";
  if (s === "pending") return "checking";
  return tasks.data!.some(test) ? "done" : "todo";
}

/** GitHub goes through the gh CLI's own login; a missing gh is a problem, signed out is "not yet". */
export function githubState(auth: Read<GithubAuth>): GuideState {
  const s = settled(auth);
  if (s === "error") return "unknown";
  if (s === "pending") return "checking";
  const a = auth.data!;
  if (a.signedIn) return "done";
  if (a.problem === "no_gh") return "problem";
  if (a.problem === "offline" || a.problem === "error" || a.problem === "rate_limited") return "unknown";
  return "todo";
}

export interface GuideInput extends ProfileInput {
  tools: Partial<Record<ToolId, Read<ToolCheck>>>;
  projectOpen: boolean;
  tasks: Read<TaskSummary[]>;
  github: Read<GithubAuth>;
}

export function guideChecklist(input: GuideInput): Array<{ id: GuideRowId; state: GuideState }> {
  const states: Record<GuideRowId, GuideState> = {
    machine: machineState(input.tools),
    profile: profileState(input),
    project: input.projectOpen ? "done" : "todo",
    firstTask: taskState(input.tasks, () => true),
    firstCrew: taskState(input.tasks, (t) => APPROVED.has(t.status)),
    github: githubState(input.github),
  };
  return GUIDE_ROWS.map((id) => ({ id, state: states[id] }));
}

/** The badge a state wears (DESIGN.md §2: colour only repeats the word). */
export const STATE_BADGE: Record<GuideState, string> = {
  done: "badge badge-ok",
  todo: "badge",
  problem: "badge badge-warn",
  unknown: "badge badge-unknown",
  checking: "badge",
};
