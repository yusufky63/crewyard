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
  /** The existing .crewyard/project.json when it is valid, so the wizard can start from it. */
  existingConfig: ProjectConfig | null;
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
  /** Validates and writes .crewyard/project.json, then adds and opens the project. Refuses secret-like keys. */
  "setup.create": { params: { path: string; config: unknown }; result: { project: ProjectSummary; configPath: string } };
  "setup.gitInit": { params: { path: string }; result: { branch: string } };
  /** `gh repo create <name> --private --source . --remote origin`. Never pushes. */
  "setup.createRepo": { params: { path: string; name: string }; result: { remoteUrl: string } };
  /** Writes .github/workflows/ci.yml; refuses to overwrite an existing file. */
  "setup.writeCiTemplate": { params: { path: string; branch: string; build: string | null; test: string | null }; result: { file: string } };
  "setup.listRepos": { params: void; result: { login: string | null; repos: GithubRepoItem[] } };
  /** `gh repo clone owner/name <parent>\<name>`; the target folder must not exist yet. */
  "setup.clone": { params: { repo: string; parent: string; name: string }; result: { path: string } };
}
