import type { AssistantDraftView, TaskReport } from "@crewyard/core";

// Screenshot data for the task report (docs/adr/0014): the finished research task `t-done` has
// a summary with Markdown, findings at every tone, and suggested drafts linked from them. Every
// other task has no report. Sample data for screenshot mode only, never shown with real data.

const AT = "2026-10-30T14:05:00.000Z";

const draft = (id: string, source: AssistantDraftView["source"], title: string, description: string, acceptance: string[]): AssistantDraftView => ({
  id,
  conversationId: null,
  source,
  sourceTaskId: "t-done",
  status: "open",
  taskId: null,
  createdAt: AT,
  title,
  description,
  kind: "code",
  size: "S",
  acceptance,
});

export function fixtureReport(taskId: string | undefined): TaskReport | null {
  if (taskId !== "t-done") return null;
  return {
    taskId,
    source: "findings",
    verdict: null,
    summary: [
      "Most tools keep API keys in the **Windows Credential Manager**, encrypted with DPAPI for the signed-in user. Two of the eight write them to plain files.",
      "",
      "### What to change here",
      "",
      "- Move the release script off `--api-key` on the command line",
      "- Stop writing `keys.json` next to the project",
      "",
      "Sources were each tool's own docs and source, opened on 30 October.",
    ].join("\n"),
    findings: [
      {
        title: "Release script passes the key on the command line",
        severity: "high",
        file: "scripts/release.ps1",
        line: 41,
        detail: "`gh release create` gets `--api-key $env:KEY`. Any process can read another's command line on Windows, so the key leaks to `Get-CimInstance Win32_Process`.\n\nPass it through the environment of the child process instead.",
        draftId: "d-fx-1",
      },
      {
        title: "Keys file written beside the project",
        severity: "medium",
        file: "src/config/keys.ts",
        line: 18,
        detail: "`saveKeys()` writes `keys.json` in the project folder with no ACL. It is in `.gitignore`, but backups and sync tools still copy it.",
        draftId: "d-fx-2",
      },
      { title: "No reminder to rotate old keys", severity: "low", file: null, line: null, detail: "Keys older than 90 days are kept without a notice.", draftId: null },
      { title: "Credential Manager is the common choice", severity: "info", file: null, line: null, detail: "Six of eight tools use it through DPAPI.", draftId: null },
    ],
    truncated: false,
    at: AT,
    drafts: [
      draft("d-fx-1", "finding", "Pass the release key through the environment", "Drop `--api-key` from release.ps1 and read the key from the child environment.", ["No key on any command line in scripts/"]),
      draft("d-fx-2", "finding", "Store saved keys with DPAPI", "Replace keys.json with DPAPI-encrypted secrets.", ["keys.json is no longer written", "Existing keys migrate once"]),
      draft("d-fx-3", "followup", "Add a key-age notice in Settings", "Show keys older than 90 days with a rotate hint.", []),
    ],
  };
}
