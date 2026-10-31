import type { LucideIcon } from "lucide-react";
import { Bot, Eye, FolderOpen, GitBranch, GitPullRequest, Inbox, Keyboard, ListChecks, PanelBottom, Repeat, SquarePen, Gauge, FileText, ShieldCheck, Workflow, Users } from "lucide-react";
import type { DrawerTab } from "../../prefs.ts";
import type { SectionId } from "../settings/model.ts";

// What the Guide teaches and where each part sends you. The words live in locales/<lang>/guide.json;
// every fact there comes from PLAN.md, DESIGN.md, README.md or an ADR, never from a feature that
// does not exist. Each id here has a title and a body in both languages (content.test.ts).

/** Where a Guide button goes. Project screens need a project; the screen resolves that. */
export type GuideAction =
  | { kind: "screen"; screen: "tasks" | "crew" | "inbox" | "github" | "limits" | "providers" }
  | { kind: "newTask" }
  | { kind: "start" }
  | { kind: "setup" }
  | { kind: "settings"; section: SectionId }
  | { kind: "panel"; tab: DrawerTab }
  | { kind: "keys" };

export interface FlowStep {
  id: string;
  icon: LucideIcon;
  action: GuideAction;
}

/** project → task → crew proposal → approve → worktrees → Inbox → review → push, PR and merge. */
export const FLOW: FlowStep[] = [
  { id: "project", icon: FolderOpen, action: { kind: "start" } },
  { id: "task", icon: SquarePen, action: { kind: "newTask" } },
  { id: "proposal", icon: Users, action: { kind: "screen", screen: "crew" } },
  { id: "approve", icon: ListChecks, action: { kind: "screen", screen: "tasks" } },
  { id: "worktrees", icon: GitBranch, action: { kind: "screen", screen: "github" } },
  { id: "inbox", icon: Inbox, action: { kind: "screen", screen: "inbox" } },
  { id: "review", icon: Eye, action: { kind: "screen", screen: "tasks" } },
  { id: "ship", icon: GitPullRequest, action: { kind: "screen", screen: "github" } },
];

export interface Feature {
  id: string;
  icon: LucideIcon;
  action: GuideAction;
}

export const FEATURES: Feature[] = [
  { id: "assistant", icon: Bot, action: { kind: "panel", tab: "assistant" } },
  { id: "autopilot", icon: ShieldCheck, action: { kind: "panel", tab: "assistant" } },
  { id: "panel", icon: PanelBottom, action: { kind: "panel", tab: "problems" } },
  { id: "fallback", icon: Repeat, action: { kind: "settings", section: "fallback" } },
  { id: "limits", icon: Gauge, action: { kind: "screen", screen: "limits" } },
  { id: "agentfiles", icon: FileText, action: { kind: "settings", section: "agentfiles" } },
  { id: "crew", icon: Workflow, action: { kind: "screen", screen: "crew" } },
  { id: "keyboard", icon: Keyboard, action: { kind: "keys" } },
];

export const FAQ = ["keys", "nothingStarts", "closePanel", "estimated", "subscriptions", "release"] as const;

/** An action that only makes sense inside a project. */
export const needsProject = (a: GuideAction): boolean => a.kind === "newTask" || a.kind === "panel" || (a.kind === "screen" && a.screen !== "providers");
