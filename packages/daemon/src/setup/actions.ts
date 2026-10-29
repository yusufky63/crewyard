import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { GithubRepoItem } from "@crewyard/core";
import { run, which } from "@crewyard/proc";
import { ciTemplate, parseTargetFramework } from "./ci.ts";
import { writeFileAtomic } from "./config.ts";
import { detectProjectType, folderState, gitState } from "./detect.ts";

// The wizard's outward-facing steps. Each runs only when the renderer calls it after the user
// clicked Create project or Clone; none of them pushes anything.

async function need(bin: "git" | "gh"): Promise<string> {
  const path = await which(bin);
  if (!path) throw new Error(bin === "gh" ? "GitHub CLI (gh) is not installed." : "Git is not installed.");
  return path;
}

const lastLine = (s: string) => s.trim().split(/\r?\n/).filter(Boolean).pop() ?? "";

export async function gitInit(dir: string): Promise<{ branch: string }> {
  const abs = resolve(dir);
  if (!folderState(abs).exists) throw new Error(`Not a folder: ${abs}`);
  const state = await gitState(abs);
  if (state.isRepo) return { branch: state.branch ?? "main" };
  if (state.parentRepo) throw new Error(`This folder is inside another repository (${state.parentRepo}).`);
  const git = await need("git");
  const res = await run(git, ["init", "-b", "main", abs], { timeoutMs: 30_000 });
  if (res.code !== 0) throw new Error(`git init failed: ${lastLine(res.stderr || res.stdout)}`);
  return { branch: "main" };
}

const REPO_NAME = /^[\w.-]{1,100}$/;
const OWNER_REPO = /^[\w.-]{1,39}\/[\w.-]{1,100}$/;

export async function createPrivateRepo(dir: string, name: string): Promise<{ remoteUrl: string }> {
  const abs = resolve(dir);
  if (!REPO_NAME.test(name) || name === "." || name === "..") throw new Error(`Not a valid repository name: ${name}`);
  const state = await gitState(abs);
  if (!state.isRepo) throw new Error("Create the git repository first.");
  if (state.remoteUrl) throw new Error(`This repository already has an origin remote: ${state.remoteUrl}`);
  const gh = await need("gh");
  // Without --push nothing leaves the machine except the empty repository on GitHub.
  const res = await run(gh, ["repo", "create", name, "--private", "--source", ".", "--remote", "origin"], { cwd: abs, timeoutMs: 60_000 });
  if (res.code !== 0) throw new Error(`gh repo create failed: ${lastLine(res.stderr || res.stdout)}`);
  const after = await gitState(abs);
  if (!after.remoteUrl) throw new Error("gh created the repository but did not add the origin remote.");
  return { remoteUrl: after.remoteUrl };
}

export async function writeCi(dir: string, input: { branch: string; build: string | null; test: string | null }): Promise<{ file: string }> {
  const abs = resolve(dir);
  const file = join(abs, ".github", "workflows", "ci.yml");
  if (existsSync(file)) throw new Error(`${file} already exists; it was left as it is.`);
  const type = detectProjectType(abs);
  const csproj = type.markers.find((m) => /\.csproj$/i.test(m));
  let dotnetVersion: string | null = null;
  if (csproj) {
    try {
      dotnetVersion = parseTargetFramework(readFileSync(join(abs, csproj), "utf8"));
    } catch {
      dotnetVersion = null;
    }
  }
  const content = ciTemplate({ ...input, kind: type.kind, packageManager: type.packageManager, dotnetVersion, usesUv: existsSync(join(abs, "uv.lock")) });
  await writeFileAtomic(file, content);
  return { file };
}

interface GhRepoJson {
  nameWithOwner: string;
  description: string | null;
  isPrivate: boolean;
  updatedAt: string;
}

export async function listRepos(): Promise<{ login: string | null; repos: GithubRepoItem[] }> {
  const gh = await need("gh");
  const login = await run(gh, ["api", "user", "--jq", ".login"], { timeoutMs: 15_000 });
  const user = login.code === 0 && /^[\w-]+$/.test(login.stdout.trim()) ? login.stdout.trim() : null;
  if (!user) return { login: null, repos: [] };
  const res = await run(gh, ["repo", "list", "--limit", "200", "--json", "nameWithOwner,description,isPrivate,updatedAt"], { timeoutMs: 30_000 });
  if (res.code !== 0) throw new Error(`gh repo list failed: ${lastLine(res.stderr)}`);
  const repos = (JSON.parse(res.stdout) as GhRepoJson[])
    .map((r) => ({ nameWithOwner: r.nameWithOwner, description: r.description || null, isPrivate: r.isPrivate, updatedAt: r.updatedAt }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { login: user, repos };
}

export async function cloneRepo(repo: string, parent: string, name: string): Promise<{ path: string }> {
  if (!OWNER_REPO.test(repo)) throw new Error(`Not a GitHub repository: ${repo}`);
  if (!REPO_NAME.test(name) || name === "." || name === "..") throw new Error(`Not a valid folder name: ${name}`);
  const base = resolve(parent);
  if (!folderState(base).exists) throw new Error(`Not a folder: ${base}`);
  const target = join(base, name);
  if (existsSync(target) && readdirSync(target).length > 0) throw new Error(`${target} already exists and is not empty.`);
  const gh = await need("gh");
  const res = await run(gh, ["repo", "clone", repo, target], { timeoutMs: 15 * 60_000 });
  if (res.code !== 0) throw new Error(`gh repo clone failed: ${lastLine(res.stderr || res.stdout)}`);
  return { path: target };
}
