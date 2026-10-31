import type { AgentFileKind, AgentFileScope, AgentTool, BridgeHow, CopyState, ShareSupport } from "../agentfiles.ts";
import type { ProfileRunner } from "./providers.ts";

// IPC methods for Settings → Instructions and skills (docs/adr/0015): your own agent files found
// on this machine and in the open project, which of them each runner or profile gets as a copy in
// its own config folder, and the project bridge that offers one tool's instruction file to the
// others. Implemented in packages/daemon/src/handlers/agentfiles.ts.

/** A file or folder that discovery saw and did not open, with why. */
export interface AgentFileSkip {
  path: string;
  reason: "denied" | "too_large" | "too_many" | "link" | "unreadable" | "too_deep";
}

export interface AgentFileItem {
  /** Stable for the same source path and kind across scans. */
  id: string;
  tool: AgentTool;
  scope: AgentFileScope;
  kind: AgentFileKind;
  /** The skill's folder name, the command's file name without extension, or the file name. */
  name: string;
  /** The file, or the skill's folder. */
  path: string;
  /** Total bytes of what a copy would take. */
  bytes: number;
  files: number;
  /** From the front matter (or TOML), capped; untrusted, shown as text. */
  description: string | null;
  /** The start of the main file as text; untrusted, never rendered as markup. */
  preview: string;
  previewTruncated: boolean;
  /** Files inside a skill that run rather than instruct, relative to its folder. */
  scripts: string[];
  /** The body runs a shell command when used ("!`cmd`" or "!{cmd}"). */
  inlineShell: boolean;
  /** Front matter keys a copy removes (pre-approved tools, hooks, a model of its own). */
  strippedKeys: string[];
  /** `@path` imports in a memory file; a copy does not follow them. */
  imports: string[];
  /** Files inside a skill folder that were not read, with why. */
  skipped: AgentFileSkip[];
  /** A size, count or depth cap stopped reading the skill; it is listed but cannot be shared. */
  capped: boolean;
  /** What each runner can do with it when shared. */
  support: Array<{ runner: ProfileRunner; support: ShareSupport }>;
  /** Hash of everything a copy would write; changes when the source changes. */
  hash: string;
}

export interface AgentFileRoot {
  tool: AgentTool;
  scope: AgentFileScope;
  kind: AgentFileKind;
  path: string;
  found: boolean;
}

export interface AgentFilesScan {
  scannedAt: string;
  /** The home folder user-scope paths were read from. */
  home: string;
  projectPath: string | null;
  items: AgentFileItem[];
  /** Every allowlisted location and whether it exists, so an empty list still says where it looked. */
  roots: AgentFileRoot[];
  /** Locations that held something discovery did not open. */
  skipped: AgentFileSkip[];
}

/** Who gets a shared item: every profile of a runner (also ones added later), or one profile. */
export interface ShareTarget {
  runner: ProfileRunner;
  profileId: string | null;
}

export interface ShareCopyView {
  profileId: string;
  profileAlias: string;
  runner: ProfileRunner;
  /** The file or folder in the profile's config folder. */
  dest: string;
  state: CopyState;
  copiedAt: string | null;
  /** Why the last copy failed, as a code (`agentfiles.*`). */
  error: string | null;
}

export interface ShareView {
  id: string;
  itemId: string;
  tool: AgentTool;
  kind: AgentFileKind;
  name: string;
  source: string;
  target: ShareTarget;
  /** You ticked "copy its scripts too" for an item that has scripts or inline shell commands. */
  allowScripts: boolean;
  createdAt: string;
  copies: ShareCopyView[];
}

export interface BridgeFileView {
  /** Relative to the project root. */
  path: string;
  exists: boolean;
  /** The runners that use it when the bridge is on, and how. */
  runners: Array<{ runner: ProfileRunner; how: BridgeHow }>;
}

export interface BridgeView {
  projectId: string;
  enabled: boolean;
  /** The files you chose; empty means every file found. */
  chosen: string[];
  files: BridgeFileView[];
}

/** What one profile's runs in a project read, for the crew proposal. */
export interface StepAgentFiles {
  profileId: string;
  runner: ProfileRunner | null;
  /** Shared copies the profile folder holds, by kind and name, with their state; never-copied ones are left out. */
  shared: Array<{ kind: AgentFileKind; name: string; state: CopyState }>;
  /** Project files the runner reads by itself. */
  project: string[];
  /** Project files it gets through the bridge. */
  bridged: string[];
}

export interface AgentFilesIpc {
  /** Reads the allowlisted locations now; never opens a denied name, never writes. */
  "agentfiles.scan": { params: { projectId?: string | null }; result: AgentFilesScan };
  "agentfiles.shares": { params: void; result: ShareView[] };
  /**
   * Shares an item from the last scan and copies it at once. Refused for an item with scripts or
   * inline shell commands unless `allowScripts`, for a subagent, and for a project-scope item.
   */
  "agentfiles.share": { params: { itemId: string; target: ShareTarget; allowScripts?: boolean }; result: ShareView };
  /** Stops sharing and removes the copies Crewyard made (never a file it did not write). */
  "agentfiles.unshare": { params: { shareId: string }; result: { removed: boolean } };
  /** Copies again whatever is not current; one share, or all of them. */
  "agentfiles.sync": { params: { shareId?: string }; result: ShareView[] };
  "agentfiles.bridge": { params: { projectId: string }; result: BridgeView };
  "agentfiles.bridgeSet": { params: { projectId: string; enabled: boolean; chosen?: string[] }; result: BridgeView };
  "agentfiles.forSteps": { params: { projectId: string; profileIds: string[] }; result: StepAgentFiles[] };
}

export interface AgentFilesTopics {
  "agentfiles.changed": { shareId: string | null; projectId: string | null };
}
