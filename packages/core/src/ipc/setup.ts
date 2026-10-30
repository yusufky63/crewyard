import type { ProjectConfig } from "../project.ts";
import type { ProjectSummary } from "../ipc.ts";

// IPC methods for the New project wizard and .crewyard/project.json. Owned by the project setup work; other work only reads it.
// Implementations live in packages/daemon/src/handlers/setup.ts. Detection only reads; every method
// that writes (git init, gh repo create, clone, CI template, project.json) runs only on its own call.

export interface GitState {
  /** False when git is not installed; every other field is then empty. */
  available: boolean;
  /** True only when the folder is the top of a repository, not a subfolder of one. */
  isRepo: boolean;
  /** Set when the folder sits inside another repository. */
  parentRepo: string | null;
  branch: string | null;
  commits: number;
  /** null when it could not be read (not a repo, or git refused the folder). */
  clean: boolean | null;
  remoteUrl: string | null;
  /** "owner/name" when the origin remote points at github.com. */
  githubRepo: string | null;
  /** git's own message when it refused the folder, e.g. dubious ownership. */
  error: string | null;
}

export type ProjectKind = "godot-csharp" | "godot" | "dotnet" | "node" | "rust" | "python" | "unknown";
export type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

export interface ProjectTypeGuess {
  kind: ProjectKind;
  /** The marker files the guess came from, e.g. ["project.godot", "NewRts.csproj"]. */
  markers: string[];
  packageManager: PackageManager | null;
  /** Suggested commands; null when nothing reliable was found. */
  build: string | null;
  test: string | null;
}

export interface PathLengthCheck {
  /** Characters of the longest path an agent worktree would hold: root + task folder + longest file. */
  longest: number;
  longestRelative: string | null;
  /** 260 unless Windows long paths are enabled (then null: no limit applies). */
  limit: number | null;
  ok: boolean;
  /** True when the walk stopped at its bound before seeing every file. */
  truncated: boolean;
  filesSeen: number;
}

/** A value in project.json this build does not know, replaced by `used` when the file was read. */
export interface ConfigFallback {
  /** Dotted path, e.g. `rules.network` or `runners.2`. */
  path: string;
  /** The value as written, as JSON text. */
  value: string;
  /** What Crewyard uses instead, as JSON text; null when the entry was dropped (an unknown runner). */
  used: string | null;
}

/** Why project.json could not be used: the file could not be read, is not JSON or not an object, has no usable version, a field fails its rule, or a key looks like a secret. */
export type ConfigProblem = "unreadable" | "json" | "not_object" | "version" | "schema" | "secret";

/**
 * What reading .crewyard/project.json found. A newer file is used read-only: Crewyard applies what
 * it understands and never writes it. An invalid one is never overwritten without asking, and the
 * old file is kept beside it as project.json.bak.
 */
export type ProjectConfigStatus =
  | { state: "missing" }
  | { state: "valid"; file: string; fallbacks: ConfigFallback[] }
  | { state: "newer"; file: string; version: number; fallbacks: ConfigFallback[]; understood: boolean; detail: string | null }
  | { state: "invalid"; file: string; reason: ConfigProblem; detail: string };

/** setup.create's refusals; the wizard words them in the user's language. */
export const SETUP_CONFIG_NEWER = "setup.config_newer";
export const SETUP_CONFIG_INVALID = "setup.config_invalid";

export interface FolderDetection {
  path: string;
  name: string;
  exists: boolean;
  /** No entries at all, so it is safe to `git init` and start fresh. */
  empty: boolean;
  alreadyAdded: boolean;
  git: GitState;
  type: ProjectTypeGuess;
  worktreeRoot: string;
  pathCheck: PathLengthCheck;
  longPathsEnabled: boolean | null;
  /** The existing .crewyard/project.json when it could be used (valid, or newer and understood), so the wizard can start from it. */
  existingConfig: ProjectConfig | null;
  /** What reading project.json found; the wizard shows it and Create project follows it. */
  configStatus: ProjectConfigStatus;
  /** Workflow files already in .github/workflows. */
  workflows: string[];
  /** Sibling folders whose names differ only by letter case; setup.create refuses while any exist. */
  caseTwins?: string[];
}

/** setup.create's refusal while `caseTwins` is not empty; the wizard words it with the twins it shows. */
export const SETUP_CASE_TWINS = "setup.case_twins";

export interface GithubRepoItem {
  nameWithOwner: string;
  description: string | null;
  isPrivate: boolean;
  updatedAt: string;
}

export interface SetupIpc {
  "setup.detect": { params: { path: string }; result: FolderDetection };
  /** Recomputes the path-length check for a worktree root the user changed. */
  "setup.pathCheck": { params: { path: string; worktreeRoot: string }; result: PathLengthCheck };
  /**
   * Validates and writes .crewyard/project.json, then adds and opens the project. Refuses secret-like keys.
   * Keys this build does not know survive the write. A file from a newer Crewyard is never written: the
   * project is added and the file stays as it is (`written: false`). An invalid file is replaced only
   * with `replaceInvalid: true`, after a copy goes to project.json.bak; otherwise SETUP_CONFIG_INVALID.
   */
  "setup.create": {
    params: { path: string; config: unknown; replaceInvalid?: boolean };
    result: { project: ProjectSummary; configPath: string; written: boolean; backup: string | null };
  };
  /** Projects whose project.json is newer, invalid or had values replaced, for the notices in Settings. */
  "setup.configNotices": { params: void; result: Array<{ projectId: string; name: string; path: string; status: ProjectConfigStatus }> };
  "setup.gitInit": { params: { path: string }; result: { branch: string } };
  /** `gh repo create <name> --private --source . --remote origin`. Never pushes. */
  "setup.createRepo": { params: { path: string; name: string }; result: { remoteUrl: string } };
  /** Writes .github/workflows/ci.yml; refuses to overwrite an existing file. */
  "setup.writeCiTemplate": { params: { path: string; branch: string; build: string | null; test: string | null }; result: { file: string } };
  "setup.listRepos": { params: void; result: { login: string | null; repos: GithubRepoItem[] } };
  /** `gh repo clone owner/name <parent>\<name>`; the target folder must not exist yet. */
  "setup.clone": { params: { repo: string; parent: string; name: string }; result: { path: string } };
}
