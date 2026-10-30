import { describe, expect, it } from "vitest";
import { issueUrlOk, mapIssueDetail, openIssues } from "./issues.ts";

describe("issue import", () => {
  it("lists open issues only, leaving pull requests out, with labels from either shape", () => {
    const rows = [
      { number: 12, title: "Login  fails\n on Windows", html_url: "https://github.com/octo/app/issues/12", user: { login: "mona" }, labels: [{ name: "bug" }, "windows", { name: null }], comments: 3, updated_at: "2026-10-29T10:00:00Z" },
      { number: 13, title: "A PR", html_url: "https://github.com/octo/app/pull/13", pull_request: { url: "x" } },
    ];
    expect(openIssues(rows)).toEqual([{ number: 12, title: "Login fails on Windows", url: "https://github.com/octo/app/issues/12", author: "mona", labels: ["bug", "windows"], comments: 3, updatedAt: "2026-10-29T10:00:00Z" }]);
  });

  it("keeps the body as text, without control characters, and cuts a huge one", () => {
    const d = mapIssueDetail({ number: 1, title: null, html_url: "u", body: "Steps\r\n1. open\u0007\u001b[31m\n", user: null });
    expect(d).toMatchObject({ title: "", author: null, labels: [], comments: 0, body: "Steps\n1. open[31m" });
    expect(mapIssueDetail({ number: 1, html_url: "u", body: "x".repeat(30_000) }).body.length).toBeLessThan(20_010);
  });

  it("accepts only the project's own issue URL as a task link", () => {
    expect(issueUrlOk("https://github.com/Octo/App/issues/12", "octo", "app", 12)).toBe(true);
    expect(issueUrlOk("https://github.com/octo/app/issues/13", "octo", "app", 12)).toBe(false);
    expect(issueUrlOk("https://evil.example/octo/app/issues/12", "octo", "app", 12)).toBe(false);
  });
});
