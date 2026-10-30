import type { IssueDetail, IssueSummary } from "@crewyard/core";
import { clip } from "./pr.ts";

// GitHub issues for the composer's import (A4). Everything here is text someone wrote on GitHub:
// it is shown and passed on as data, and importing one only fills the composer.

export interface RestIssue {
  number: number;
  title?: string | null;
  html_url: string;
  body?: string | null;
  user?: { login?: string } | null;
  labels?: Array<string | { name?: string | null }>;
  comments?: number;
  updated_at?: string;
  /** Present on pull requests, which the issues endpoint also lists. */
  pull_request?: unknown;
}

const TITLE_MAX = 300;
const BODY_MAX = 20_000;

/** Control characters other than tab and newline are dropped; they have no place in a task. */
// eslint-disable-next-line no-control-regex
const clean = (s: string) => s.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "");

export function mapIssue(r: RestIssue): IssueSummary {
  return {
    number: r.number,
    title: clip(clean(r.title ?? "").replace(/\s+/g, " "), TITLE_MAX),
    url: r.html_url,
    author: r.user?.login ?? null,
    labels: (r.labels ?? []).map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean),
    comments: r.comments ?? 0,
    updatedAt: r.updated_at ?? "",
  };
}

export function mapIssueDetail(r: RestIssue): IssueDetail {
  const body = clean(r.body ?? "").trim();
  return { ...mapIssue(r), body: body.length > BODY_MAX ? `${body.slice(0, BODY_MAX).trimEnd()}\n...` : body };
}

/** Open issues only: the endpoint mixes in pull requests. */
export const openIssues = (rows: RestIssue[]) => rows.filter((r) => r.pull_request === undefined).map(mapIssue);

/** Only GitHub issue URLs of the project's own repo are kept as a task's link. */
export function issueUrlOk(url: string, owner: string, repo: string, number: number): boolean {
  return url.toLowerCase() === `https://github.com/${owner}/${repo}/issues/${number}`.toLowerCase();
}
