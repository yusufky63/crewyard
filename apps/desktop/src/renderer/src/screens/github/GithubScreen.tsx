import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, CircleHelp, Clock, ExternalLink, GitMerge, RefreshCw, ShieldAlert, ShieldCheck, Upload, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button, Label, Panel, ProvenanceBadge, TickMeter } from "@crewyard/ui";
import type { ActionsMinutes, GateItem, GithubProblem, PullSummary, PushCandidate, WorkflowFinding } from "@crewyard/core";
import { call, useDaemon } from "../../ipc.ts";
import { useNav } from "../../nav.ts";
import { useGithubLive, useMinuteTick, useNumber, useRelative } from "./live.ts";
import "./github.css";

const ICON = { size: 14, strokeWidth: 1.75 } as const;
const PUSH_SHOWN = 3;

function ProblemBanner({ problem }: { problem: GithubProblem }) {
  const { t } = useTranslation("github");
  return (
    <div className="banner banner-warn gh-banner" role="status">
      <AlertTriangle {...ICON} />
      <span>{t(`problem.${problem}`)}</span>
    </div>
  );
}

function MinutesPanel({ projectId }: { projectId: string }) {
  const { t, i18n } = useTranslation("github");
  const fmt = useNumber();
  const q = useDaemon("github.minutes", { projectId }, { staleTime: 10 * 60_000 });
  const m: ActionsMinutes | undefined = q.data;
  const month = new Intl.DateTimeFormat(i18n.language, { month: "long", timeZone: "UTC" }).format(m ? new Date(`${m.month}-01T00:00:00Z`) : new Date());
  const reported = m?.provenance === "reported" && m.usedMinutes !== null;
  const pct = reported && m.includedMinutes ? (m.usedMinutes! / m.includedMinutes) * 100 : null;
  return (
    <Panel className="gh-tile">
      <div className="gh-tile-head">
        <Label>
          {/* Product names and repo ids keep their own casing under Turkish uppercase rules. */}
          <span lang="en">{t("minutes.product")}</span> {t("minutes.label", { month })}
        </Label>
        {m && <ProvenanceBadge provenance={m.provenance}>{t(`provenance.${m.provenance}`)}</ProvenanceBadge>}
      </div>
      <div className="metric num">
        {reported ? fmt(m.usedMinutes!) : "—"}{" "}
        <small>{reported && m.includedMinutes ? t("minutes.of", { included: fmt(m.includedMinutes) }) : reported ? t("minutes.noQuota") : ""}</small>
      </div>
      <TickMeter value={pct} label={t("minutes.meter")} />
      {reported && m.byOs && <span className="gh-note mono">{t("minutes.byOs", { linux: fmt(m.byOs.linux), windows: fmt(m.byOs.windows), macos: fmt(m.byOs.macos) })}</span>}
      {m?.reason && (
        <span className="gh-note">
          {t(`minutes.reason.${m.reason}`, { owner: m.owner ?? "" })}
          {m.reason === "needs_scope" && <code className="gh-cmd">{t("minutes.scopeCommand")}</code>}
        </span>
      )}
      <span className="gh-note">{t("minutes.note")}</span>
    </Panel>
  );
}

function PushRow({ projectId, b, primary }: { projectId: string; b: PushCandidate; primary: boolean }) {
  const { t } = useTranslation("github");
  const qc = useQueryClient();
  const [state, setState] = useState<{ busy: boolean; msg: string | null; bad: boolean }>({ busy: false, msg: null, bad: false });
  const sure = b.workflows.filter((w) => !w.conditional).map((w) => w.name);
  const maybe = b.workflows.filter((w) => w.conditional);
  const costly = b.workflows.flatMap((w) => w.costlyRunners);
  const push = async () => {
    setState({ busy: true, msg: null, bad: false });
    try {
      await call("github.push", { projectId, branch: b.branch, headSha: b.headSha });
      setState({ busy: false, msg: t("push.pushed", { branch: b.branch }), bad: false });
    } catch (err) {
      setState({ busy: false, msg: t("push.failed", { message: err instanceof Error ? err.message : String(err) }), bad: true });
    } finally {
      void qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("github.") });
    }
  };
  return (
    <div className="gh-push-row">
      <div className="gh-push-main">
        <div className="gh-push-name mono" title={b.branch}>
          {b.branch}
        </div>
        <div className="gh-push-meta">
          {t("push.commits", { count: b.commits })}
          {!b.upstream && ` · ${t("push.newBranch")}`}
        </div>
        <div className="gh-note">
          {b.workflows.length === 0 ? t("push.startsNothing") : sure.length ? t("push.starts", { names: sure.join(", ") }) : null}
          {maybe.map((w) => (
            <span key={w.file} className="gh-maybe">
              {t("push.conditional", { name: w.name })}
            </span>
          ))}
        </div>
        {costly.length > 0 && (
          <div className="gh-note gh-warn">
            <AlertTriangle {...ICON} />
            {t("push.costly", { jobs: costly.join(", ") })}
          </div>
        )}
        {state.msg && <div className={`gh-note ${state.bad ? "gh-bad" : "gh-ok"}`} role="status">{state.msg}</div>}
      </div>
      <Button size="sm" variant={primary ? "primary" : "secondary"} onClick={() => void push()} disabled={state.busy}>
        <Upload {...ICON} />
        {state.busy ? t("push.pushing") : t("push.pushOnce")}
      </Button>
    </div>
  );
}

function PushPanel({ projectId }: { projectId: string }) {
  const { t } = useTranslation("github");
  const [all, setAll] = useState(false);
  const q = useDaemon("github.pushQueue", { projectId });
  const branches = q.data?.branches ?? [];
  const commits = branches.reduce((n, b) => n + b.commits, 0);
  const shown = all ? branches : branches.slice(0, PUSH_SHOWN);
  return (
    <Panel className="gh-tile">
      <Label>{t("push.label")}</Label>
      <div className="metric num">
        {q.data ? branches.length : "—"} <small>{q.data ? `${t("push.branches", { count: branches.length })} · ${t("push.commits", { count: commits })}` : ""}</small>
      </div>
      {q.data && branches.length === 0 && <span className="gh-note">{t("push.empty")}</span>}
      {shown.map((b) => (
        <PushRow key={b.branch} projectId={projectId} b={b} primary={branches.length === 1} />
      ))}
      {branches.length > PUSH_SHOWN && !all && (
        <div>
          <Button size="sm" variant="ghost" onClick={() => setAll(true)}>
            {t("push.more", { count: branches.length - PUSH_SHOWN })}
          </Button>
        </div>
      )}
    </Panel>
  );
}

function WorktreesPanel({ projectId }: { projectId: string }) {
  const { t } = useTranslation("github");
  const q = useDaemon("github.worktrees", { projectId });
  const w = q.data;
  const stale = w?.items.filter((i) => i.stale) ?? [];
  const dirty = w?.items.filter((i) => i.dirty).length ?? 0;
  return (
    <Panel className="gh-tile">
      <Label>{t("worktrees.label")}</Label>
      <div className="metric num">
        {w?.active ?? "—"} <small>{t("worktrees.active")}{w ? ` · ${t("worktrees.stale", { count: w.stale })}` : ""}</small>
      </div>
      {stale.slice(0, 3).map((s) => (
        <span key={s.path} className="gh-note" title={s.path}>
          {t("worktrees.staleLine", { branch: s.branch ?? s.path })}
        </span>
      ))}
      {w && stale.length === 0 && <span className="gh-note">{t("worktrees.clean")}</span>}
      {dirty > 0 && <span className="gh-note">{t("worktrees.dirtyLine", { count: dirty })}</span>}
    </Panel>
  );
}

const GATE_ICON = { pass: Check, wait: Clock, fail: X, unknown: CircleHelp } as const;

function GateChips({ pr }: { pr: PullSummary }) {
  const { t } = useTranslation("github");
  if (pr.state === "merged" || !pr.gate) {
    return (
      <span className="st st-rev gh-small">
        <GitMerge {...ICON} />
        {t("pulls.state.merged")}
      </span>
    );
  }
  const title = (i: GateItem) => (i.id === "questions" && i.status === "unknown" ? t("pulls.gateTitle.questions_unknown") : i.id === "approval" && pr.state === "draft" ? t("pulls.gateTitle.draft") : undefined);
  return (
    <ul className="gh-gate" aria-label={t("pulls.colGate")}>
      {pr.gate.items.map((i) => {
        const Icon = GATE_ICON[i.status];
        return (
          <li key={i.id} className={`g-${i.status}`} title={title(i)}>
            <Icon {...ICON} />
            {t(`pulls.gate.${i.id}.${i.status}`, { base: pr.base })}
          </li>
        );
      })}
    </ul>
  );
}

function Checks({ pr }: { pr: PullSummary }) {
  const { t } = useTranslation("github");
  const c = pr.checks;
  if (c.state === "none") return <span className="muted gh-small">{t("pulls.checks.none")}</span>;
  if (c.state === "passed")
    return (
      <span className="st st-ok gh-small">
        <ShieldCheck {...ICON} />
        {t("pulls.checks.passed", { passed: c.passed, total: c.total })}
      </span>
    );
  if (c.state === "pending")
    return (
      <span className="st st-run gh-small">
        <span className="spin" />
        {t("pulls.checks.pending", { count: c.pending })}
      </span>
    );
  return (
    <div>
      <span className="st st-bad gh-small">
        <ShieldAlert {...ICON} />
        {t("pulls.checks.failing", { count: c.failing })}
      </span>
      <div className="gh-failing mono" title={c.failingNames.join(", ")}>
        {c.failingNames.join(", ")}
      </div>
    </div>
  );
}

function StateLabel({ pr }: { pr: PullSummary }) {
  const { t } = useTranslation("github");
  // "Ready for review" and "Merged" never share a look: green check versus ink merge icon.
  if (pr.state === "merged") return null;
  return pr.state === "draft" ? (
    <span className="gh-state muted">{t("pulls.state.draft")}</span>
  ) : (
    <span className="gh-state st-ok">
      <Check {...ICON} />
      {t("pulls.state.open")}
    </span>
  );
}

function PullRow({ projectId, pr, method, now }: { projectId: string; pr: PullSummary; method: string | null; now: number }) {
  const { t } = useTranslation("github");
  const rel = useRelative();
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null);
  const open = () => window.open(pr.url, "_blank");
  const merge = async () => {
    setBusy(true);
    try {
      await call("github.merge", { projectId, number: pr.number, headSha: pr.headSha });
      setMsg({ text: t("pulls.merged", { number: pr.number }), bad: false });
      setConfirm(false);
    } catch (err) {
      setMsg({ text: t("pulls.mergeFailed", { message: err instanceof Error ? err.message : String(err) }), bad: true });
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("github.") });
    }
  };
  const ready = pr.gate?.readyForApproval ?? false;
  return (
    <>
      <tr>
        <td>
          <div className="gh-pr-title">
            #{pr.number} {pr.title}
          </div>
          <div className="gh-pr-sub">
            <StateLabel pr={pr} />
            {pr.state === "merged" ? (
              <span>{t("pulls.mergedLine", { base: pr.base, time: pr.mergedAt ? rel(pr.mergedAt, now) : "" })}</span>
            ) : (
              <>
                <span className="mono">{t("pulls.flow", { head: pr.head, base: pr.base })}</span>
                {pr.aheadBy !== null && pr.behindBy !== null && <span>{t("pulls.aheadBehind", { ahead: pr.aheadBy, behind: pr.behindBy })}</span>}
              </>
            )}
            {pr.author && <span>{t("pulls.by", { author: pr.author })}</span>}
          </div>
        </td>
        <td>
          <Checks pr={pr} />
        </td>
        <td>
          <GateChips pr={pr} />
        </td>
        <td className="gh-act">
          {pr.state === "merged" || pr.state === "draft" ? (
            <Button size="sm" variant="ghost" onClick={open}>
              {t("pulls.view")}
            </Button>
          ) : (
            <div className="gh-act-stack">
              <Button size="sm" variant={ready ? "primary" : "secondary"} disabled={!ready || confirm} title={ready ? undefined : t("pulls.blocked")} onClick={() => setConfirm(true)}>
                {t("pulls.reviewMerge")}
              </Button>
              <Button size="sm" variant="ghost" onClick={open} aria-label={`${t("pulls.view")} #${pr.number}`}>
                <ExternalLink {...ICON} />
              </Button>
            </div>
          )}
        </td>
      </tr>
      {(confirm || msg) && (
        <tr className="gh-confirm">
          <td colSpan={4}>
            {confirm && (
              <div className="gh-confirm-row">
                <span>{t("pulls.confirm", { number: pr.number, method: t(`pulls.method.${method ?? "merge"}`), sha: pr.headSha.slice(0, 7) })}</span>
                <span className="end">
                  <Button size="sm" variant="ghost" onClick={() => setConfirm(false)} disabled={busy}>
                    {t("pulls.cancel")}
                  </Button>
                  <Button size="sm" variant="primary" onClick={() => void merge()} disabled={busy}>
                    <GitMerge {...ICON} />
                    {busy ? t("pulls.merging") : t("pulls.mergeNow")}
                  </Button>
                </span>
              </div>
            )}
            {msg && (
              <div className={`gh-note ${msg.bad ? "gh-bad" : "gh-ok"}`} role="status">
                {msg.text}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function PullsPanel({ projectId, now }: { projectId: string; now: number }) {
  const { t } = useTranslation("github");
  const q = useDaemon("github.pulls", { projectId });
  const pulls = q.data?.pulls ?? [];
  return (
    <Panel className="gh-pulls">
      <div className="gh-scroll">
        <table className="gh-table">
          <thead>
            <tr>
              <th>{t("pulls.colPull")}</th>
              <th>{t("pulls.colChecks")}</th>
              <th>{t("pulls.colGate")}</th>
              <th className="gh-act">{t("pulls.colAction")}</th>
            </tr>
          </thead>
          <tbody>
            {pulls.map((pr) => (
              <PullRow key={pr.number} projectId={projectId} pr={pr} method={q.data?.mergeMethod ?? null} now={now} />
            ))}
            {q.data && pulls.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  {t("pulls.empty")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function WorkflowsPanel({ projectId }: { projectId: string }) {
  const { t } = useTranslation("github");
  const q = useDaemon("github.workflows", { projectId });
  const data = q.data;
  if (!data) return null;
  const byFile = new Map<string, WorkflowFinding[]>();
  for (const f of data.findings) byFile.set(f.file, [...(byFile.get(f.file) ?? []), f]);
  return (
    <Panel className="gh-wf">
      <div className="ph">
        <h2>{t("workflows.label")}</h2>
        <span className="end lbl">{data.findings.length ? t("workflows.count", { count: data.findings.length }) : ""}</span>
      </div>
      {data.files.length === 0 && <p className="gh-wf-empty muted">{t("workflows.none")}</p>}
      {data.files.length > 0 && data.findings.length === 0 && (
        <p className="gh-wf-empty st-ok">
          <Check {...ICON} />
          {t("workflows.clean", { count: data.files.length })}
        </p>
      )}
      {[...byFile.entries()].map(([file, findings]) => (
        <div key={file} className="gh-wf-file">
          <div className="mono gh-wf-name">{file}</div>
          <ul>
            {findings.map((f, i) => (
              <li key={i} className={`gh-wf-${f.severity}`}>
                {f.severity === "error" ? <X {...ICON} aria-label={t("workflows.severity.error")} /> : <AlertTriangle {...ICON} aria-label={t("workflows.severity.warning")} />}
                <span>
                  {f.job && <span className="mono gh-wf-job">{t("workflows.job", { job: f.job })}</span>}
                  {t(`workflows.rule.${f.rule}`)}
                  {f.detail && <span className="mono muted"> · {f.detail}</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </Panel>
  );
}

export function GithubScreen() {
  const { t } = useTranslation("github");
  const projectId = useNav((s) => s.projectId);
  useGithubLive();
  const now = useMinuteTick();
  const rel = useRelative();
  const qc = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const auth = useDaemon("github.auth", undefined, { staleTime: 5 * 60_000 });
  const repo = useDaemon("github.repo", { projectId: projectId ?? "" }, { enabled: Boolean(projectId) });
  const sync = useDaemon("github.sync", { projectId: projectId ?? "" }, { enabled: Boolean(projectId) });
  const pulls = useDaemon("github.pulls", { projectId: projectId ?? "" }, { enabled: Boolean(projectId) });
  if (!projectId) return null;

  const refresh = async () => {
    setRefreshing(true);
    try {
      await call("github.refresh", { projectId });
    } finally {
      setRefreshing(false);
      await qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("github.") });
    }
  };

  const r = repo.data;
  const remote = r?.remote;
  const syncedAt = pulls.data?.syncedAt ?? sync.data?.syncedAt ?? null;
  const authProblem = auth.data?.problem === "no_gh" || auth.data?.problem === "signed_out" ? auth.data.problem : null;
  const problem = authProblem ?? r?.problem ?? pulls.data?.problem ?? null;
  const hasGithub = Boolean(remote) && !authProblem;
  const context = [
    r?.private === true ? t("visibility.private") : r?.private === false ? t("visibility.public") : null,
    remote ? (syncedAt ? t("synced", { time: rel(syncedAt, now) }) : t("neverSynced")) : null,
  ].filter(Boolean);

  return (
    <section className="screen gh" aria-label={t("title")}>
      <div className="page-head">
        <div>
          <h1>{t("title")}</h1>
          <div className="lbl gh-sub">
            <span lang="en">{remote ? `${remote.owner}/${remote.repo}` : r?.path}</span>
            {context.map((c) => ` · ${c}`).join("")}
          </div>
          {r?.currentBranch && (
            <div className="gh-branch mono">
              {r.ahead !== null && r.behind !== null ? t("branch", { branch: r.currentBranch, ahead: r.ahead, behind: r.behind }) : t("branchNoUpstream", { branch: r.currentBranch })}
            </div>
          )}
        </div>
        <div className="right">
          {remote && (
            <Button size="sm" variant="ghost" onClick={() => window.open(remote.webUrl, "_blank")}>
              <ExternalLink {...ICON} />
              <span lang="en">{`${remote.owner}/${remote.repo}`}</span>
            </Button>
          )}
          <Button size="sm" onClick={() => void refresh()} disabled={refreshing}>
            <RefreshCw {...ICON} />
            {refreshing ? t("refreshing") : t("refresh")}
          </Button>
        </div>
      </div>
      {problem && <ProblemBanner problem={problem} />}
      <div className="gh-top">
        <MinutesPanel projectId={projectId} />
        <PushPanel projectId={projectId} />
        <WorktreesPanel projectId={projectId} />
      </div>
      {hasGithub && <PullsPanel projectId={projectId} now={now} />}
      <WorkflowsPanel projectId={projectId} />
    </section>
  );
}
