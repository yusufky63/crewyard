import type { ProjectSummary } from "@crewyard/core";

/** Project paths compare without case and separators on every platform, as the daemon stores them. */
export const samePath = (a: string, b: string) => {
  const key = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return key(a) === key(b);
};

/** The project a folder belongs to, exactly; a parent or a subfolder of a project is a new folder. */
export const findProject = (projects: readonly ProjectSummary[], path: string): ProjectSummary | null => projects.find((p) => samePath(p.path, path)) ?? null;
