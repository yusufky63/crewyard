import { Clock } from "lucide-react";
import Link from "next/link";
import { Fragment } from "react";
import { BrandMark } from "@/components/brand-mark";
import { DocLayout, DocSection, type Toc } from "@/components/doc-layout";
import { FlowDiagram } from "@/components/flow-diagram";
import { Shot } from "@/components/shot";
import { CLI_VERSIONS, FALLBACK_MODES, HANDOFF, NEVER_WITHOUT_YOU, NOTIFY, OPT_INS, PROVENANCE, PROVIDERS_NOTE, ROLES, STEPS } from "@/lib/content";
import { pageMeta } from "@/lib/page-meta";
import { adrUrl, SITE } from "@/lib/site";

export const metadata = pageMeta({
  title: "How it works",
  description: "How Crewyard runs a task: the crew proposal and your approval, runs in git worktrees, the Inbox, limits with Reported, Estimated or Unknown labels, fallback and handoff, the task assistant and Autopilot, and what never happens without you.",
  path: "/how-it-works",
});

const TOC: Toc = [
  ["flow", "The flow of a task"],
  ["crews", "Crews and roles"],
  ["runners", "Runners and providers"],
  ["limits", "Limits and provenance"],
  ["fallback", "Fallback and handoff"],
  ["assistant", "Task assistant and Autopilot"],
  ["files", "Your agent files and roles"],
  ["github", "GitHub"],
  ["never", "What never happens without you"],
];

const BADGE: Record<string, string> = { Reported: "badge-reported", Estimated: "badge-estimated", Unknown: "badge-unknown" };

export default function HowItWorksPage() {
  return (
    <DocLayout
      toc={TOC}
      head={
        <>
          <div className="eyebrow bare">How it works</div>
          <h1 className="h-page">One task, from your words to a merged pull request</h1>
          <p className="lead">Crewyard is the orchestrator: a deterministic scheduler runs the crew plan you approved. An agent cannot start other runs, and every step that leaves your machine waits for you.</p>
        </>
      }
    >
      <DocSection toc={TOC} id="flow">
        <FlowDiagram />
        <ol className="flow-steps">
          {STEPS.map((s, i) => (
            <li key={s.title} className="spec">
              <span className="spec-idx">{String(i + 1).padStart(2, "0")}</span>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </li>
          ))}
        </ol>
        <Shot name="tasks" title="Tasks" alt="Crewyard's Tasks screen with sample data: the task composer, status filters and task rows with their crews and steps." />
      </DocSection>

      <DocSection toc={TOC} id="crews">
        <p>When you submit a task, Crewyard classifies it (code, research, review or docs, and a size from S to L) with local rules first, picks the role template for that class, and scores every signed-in account for each role: how well the runner and model fit the role, headroom on plan windows (Reported before Estimated), cost for the task size against its budget, how often that runner&apos;s work was accepted in this repository, and your pins and exclusions.</p>
        <p>Each pick comes with a one-line reason and a meter, and the next two candidates become the role&apos;s standby chain. The reviewer never runs on the same model as the implementer. The first version is rule-based and learns only from what you accepted or rejected; no model is called without a key you configured.</p>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th scope="col">Role</th>
                <th scope="col">Permissions</th>
                <th scope="col">Output</th>
              </tr>
            </thead>
            <tbody>
              {ROLES.map((r) => (
                <tr key={r.role}>
                  <td>{r.role}</td>
                  <td>{r.permissions}</td>
                  <td>{r.output}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>Permissions are enforced by Crewyard&apos;s approval layer and each runner&apos;s own engine, never by the prompt. A run cannot create other runs: if an agent asks for more work, the request becomes an Inbox item.</p>
        <Shot name="crew" title="Crew graph" alt="A crew in Crewyard's Crew graph: steps as nodes with runner, model, account and status, and a standby, shown with sample data." />
      </DocSection>

      <DocSection toc={TOC} id="runners">
        <p>{PROVIDERS_NOTE}</p>
        <div className="runners">
          {CLI_VERSIONS.map((c) => (
            <div key={c.id} className="frame runner">
              <div className="runner-name">
                <BrandMark id={c.id} size={18} />
                {c.name}
              </div>
              <p>{c.note}</p>
              <div className="ver">Checked with {c.version}</div>
            </div>
          ))}
        </div>
        <p>Each account is its own config folder, so two accounts of one runner never share state. Every runner is driven through its native protocol (the Claude Agent SDK, the Codex app-server, the OpenCode server, the Agent Client Protocol for Gemini CLI), and a new CLI version is accepted only after Crewyard&apos;s conformance suite passes against it.</p>
      </DocSection>

      <DocSection toc={TOC} id="limits">
        <p>Quota comes only from each agent&apos;s own reporting channel, and every value carries where it came from and how old it is.</p>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th scope="col">Label</th>
                <th scope="col">Meaning</th>
                <th scope="col">Examples</th>
              </tr>
            </thead>
            <tbody>
              {PROVENANCE.map((p) => (
                <tr key={p.label}>
                  <td>
                    <span className={`badge ${BADGE[p.label]}`}>{p.label}</span>
                  </td>
                  <td>{p.meaning}</td>
                  <td>{p.examples}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Shot name="limits" title="Limits and usage" alt="Crewyard's Limits and usage screen with sample data: subscription windows per account with tick meters and their Reported, Estimated or Unknown labels, API spend over seven days, and balances and caps per key." />
        <p>API keys get a daily cap and a per-task cap. Notifications are deduplicated and batched, at most one per account per window state, with quiet hours and per-project mute.</p>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">What happens</th>
              </tr>
            </thead>
            <tbody>
              {NOTIFY.map((n) => (
                <tr key={n.trigger}>
                  <td>{n.trigger}</td>
                  <td>{n.what}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </DocSection>

      <DocSection toc={TOC} id="fallback">
        <p>Each task has a rule for what happens when a limit is reached, a credit runs out, a sign-in expires or an agent crashes.</p>
        <dl className="kv frame pad-kv">
          {FALLBACK_MODES.map((m) => (
            <Fragment key={m.mode}>
              <dt>{m.mode}</dt>
              <dd>{m.body}</dd>
            </Fragment>
          ))}
        </dl>
        <p>A handoff follows the same steps every time:</p>
        <ol>
          {HANDOFF.map((h) => (
            <li key={h}>{h}</li>
          ))}
        </ol>
        <p>
          Switching to another account of the same provider (for example from a work to a personal Codex account) is its own setting, off by default, behind a note about provider terms (<a href={adrUrl("0009-same-provider-auto-switch.md")}>ADR 0009</a>). A cross-provider handoff never claims to carry hidden model state.
        </p>
      </DocSection>

      <DocSection toc={TOC} id="assistant">
        <p>The task assistant is a terminal-style chat in the bottom panel (Ctrl Shift A on any project screen) with a read-only agent on a profile you pick. It reads the project, asks when something is unclear and proposes task drafts as editable cards. Add as draft turns one into a task whose crew still waits for your approval. It never writes files or starts runs, its spend counts against the key&apos;s daily cap as Estimated, and it stops on Stop and close or after it sits idle.</p>
        <p>
          Autopilot is an opt-in mode of the assistant, per project and off by default (<a href={adrUrl("0017-autopilot.md")}>ADR 0017</a>). After a consent card that lists what it may do and what stays with you, it creates tasks from what you write, edits ones that have not started, approves their crews when the Estimated cost fits, queues messages to running steps, retries a failed step once, cancels its own tasks and marks a finished analysis done after reading its report.
        </p>
        <ul>
          <li>Default limits: $1.00 per task, $5.00 per day, 4 tasks started and created per hour, 2 at once. Only your click changes them.</li>
          <li>An estimate must be known, never Unknown, and under the limits together with today&apos;s committed spend; every chosen key must be under its own caps.</li>
          <li>Push, pull requests, merges, deleting a worktree or branch, spend past any cap, Inbox approvals, sign-in and Autopilot&apos;s own settings stay with you. It has no tool for them.</li>
          <li>Stop Autopilot in the status bar or Settings refuses every call at once without stopping running agents. Two failed steps with the same failure within 24 hours halt it in that project.</li>
          <li>Every call, allowed or refused, is logged with its reason.</li>
        </ul>
      </DocSection>

      <DocSection toc={TOC} id="files">
        <p>Every profile runs in its own config folder, so your personal setup reaches a run only through Settings, Instructions and skills. Crewyard lists the instruction files, rules, skills, commands and subagents you wrote for Claude Code, Codex, Gemini CLI, OpenCode, Cursor, Windsurf, Copilot and Cline, without ever opening a credential, token, .env or settings file.</p>
        <ul>
          <li>Sharing copies the item you pick into the profiles you pick, in that runner&apos;s own place and format. It is never a link.</li>
          <li>A copy loses pre-approved tools, hooks and a model of its own; a skill with scripts needs an explicit tick. A file Crewyard did not write is never overwritten.</li>
          <li>Each copy shows whether it is up to date, and only Sync copies again.</li>
          <li>A project&apos;s AGENTS.md, CLAUDE.md, GEMINI.md, Copilot, Cursor or Windsurf rules can reach the runners that do not read them, per project and off by default. Nothing is written into the project.</li>
        </ul>
        <p>Role files in .crewyard/roles (or global ones in Crewyard&apos;s data folder) change a built-in role&apos;s contract or add a role of your own. A file that replaces a role may only narrow its permissions, a custom role never gets more than the project&apos;s rules allow, and a file that does not parse is not used. Instruction files and skills are untrusted text: they never change a role&apos;s permissions, the allowlist or the spend caps.</p>
      </DocSection>

      <DocSection toc={TOC} id="github">
        <ul>
          <li>Crewyard reuses your GitHub CLI sign-in and stores no new token.</li>
          <li>Agents commit locally. GitHub, Waiting to push, lists branches with their commit counts and the workflows a push would trigger; one click pushes once.</li>
          <li>A pull request is created only after the review gate passes and you click. Merging needs every gate: tests passed, branch up to date, no open questions, your approval.</li>
          <li>Send failing checks to the agent reads the failed steps&apos; logs and queues them as untrusted CI output for the step that owns the branch. It is queued, never sent, until the step reaches a turn boundary or you continue it.</li>
          <li>Worktrees are cleaned up only after merge, only when clean with nothing unpushed and no live process, and only after you confirm.</li>
          <li>Crewyard warns when a repository&apos;s workflows break your CI rules, and shows the month&apos;s Actions minutes when your token can read billing.</li>
        </ul>
      </DocSection>

      <DocSection toc={TOC} id="never">
        <ul className="marks">
          {NEVER_WITHOUT_YOU.map((t) => (
            <li key={t} className="wait">
              <Clock strokeWidth={1.5} aria-hidden />
              <span>{t} waits for your click.</span>
            </li>
          ))}
        </ul>
        <p>Two opt-ins may start a crew without a click, and both are audited:</p>
        <ul>
          {OPT_INS.map((o) => (
            <li key={o.title}>
              <strong>{o.title}.</strong> {o.body}
            </li>
          ))}
        </ul>
        <p>
          The full rules are in <a href={SITE.docs.plan}>PLAN.md</a> and the <a href={SITE.docs.adr}>decision records</a>. Security details are on the <Link href="/security">security page</Link>.
        </p>
      </DocSection>
    </DocLayout>
  );
}
