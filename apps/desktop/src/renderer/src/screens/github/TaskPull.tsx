import { useEffect, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, CircleHelp, Clock, ExternalLink, GitMerge, GitPullRequest, ListPlus, MessageSquare, Play, ShieldAlert, ShieldCheck, Upload, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button, Label, Panel } from "@crewyard/ui";
import type { ChecksSummary, FeedbackItem, GateStatus, IpcMethod, IpcParams, IpcResult, TaskPullView } from "@crewyard/core";
import { call } from "../../ipc.ts";
import { FIXTURE } from "../tasks/fixture.ts";
import { fixtureTaskPull, fixtureTaskPulls } from "./fixture.ts";
import { useMinuteTick, useRelative } from "./live.ts";
import { gateTextKey, gateTitleKey, nextStep, pullLabel, type PullStep } from "./pullModel.ts";
import "./github.css";

// A task's pull request, one approved step at a time (PLAN.md §10, D8): push, open, merge, clean
// up. Each button is the approval for exactly that step; nothing here runs on its own.

const ICON = { size: 14, strokeWidth: 1.75 } as const;
const GATE_ICON = { pass: Check, wait: Clock, fail: X, unknown: CircleHelp, warn: AlertTriangle } as const;

const read = <M extends IpcMethod>(method: M, params: IpcParams<M>): Promise<IpcResult<M>> => {
  if (!FIXTURE) return call(method, params);
  const p = params as { taskId?: string; projectId?: string };
  return Promise.resolve((method === "github.taskPulls" ? fixtureTaskPulls(p.projectId ?? "fixture") : fixtureTaskPull(p.taskId ?? "")) as IpcResult<M>);
};
/** Writes do nothing in screenshot mode. */
const write = <M extends IpcMethod>(method: M, params: IpcParams<M>): Promise<unknown> => (FIXTURE ? Promise.resolve(null) : call(method, params));

/** Re-reads task PRs when GitHub refreshes or a task changes. */
function useTaskPullLive(): void {
  const qc = useQueryClient();
  useEffect(() => {
    const again = () => void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === "github.taskPull" || q.queryKey[0] === "github.taskPulls" });
    const offGithub = window.crewyard.on("github.changed", again);
    const offTasks = window.crewyard.on("tasks.changed", again);
    return () => {
      offGithub();
      offTasks();
    };
  }, [qc]);
}

export function useTaskPull(taskId: string, enabled = true) {
  useTaskPullLive();
  return useQuery({ queryKey: ["github.taskPull", { taskId }], queryFn: () => read("github.taskPull", { taskId }), enabled });
}

export function useTaskPulls(projectId: string) {
  useTaskPullLive();
  return useQuery({ queryKey: ["github.taskPulls", { projectId }], queryFn: () => read("github.taskPulls", { projectId }) });
}

/** Daemon errors arrive as a code ("pull.moved") or GitHub's own message; codes are translated. */
function useErrorText(): (err: unknown) => string {
  const { t } = useTranslation("github");
  return (err) => {
    const raw = err instanceof Error ? err.message : String(err);
    // A code may carry details after a colon ("merge.gate: checks"); the chips already show those.
    const code = raw.replace(/^.*Error: /, "").trim().replace(/:.*$/, "");
    return /^[a-z_]+\.[a-z_]+$/.test(code) ? t(`taskPull.error.${code.replace(".", "_")}`, { defaultValue: code }) : raw.replace(/^.*Error: /, "").trim();
  };
}

function PullState({ v }: { v: TaskPullView }) {
  const { t } = useTranslation("github");
  const label = pullLabel(v);
  // "Ready for review" and "Merged" never share a look: green check versus ink merge icon.
  if (label === "merged")
    return (
      <span className="tp-state">
        <GitMerge {...ICON} />
        {t("taskPull.state.merged")}
      </span>
    );
  if (label === "open")
    return (
      <span className="tp-state st-ok">
        <Check {...ICON} />
        {t("taskPull.state.open")}
      </span>
    );
  return (
    <span className="tp-state muted">
      <GitPullRequest {...ICON} />
      {t(`taskPull.state.${label}`)}
    </span>
  );
}

function ChecksLine({ c }: { c: ChecksSummary }) {
  const { t } = useTranslation("github");
  if (c.state === "none") return <span className="muted">{t("pulls.checks.none")}</span>;
  if (c.state === "passed")
    return (
      <span className="st-ok tp-inline">
        <ShieldCheck {...ICON} />
        {t("pulls.checks.passed", { passed: c.passed, total: c.total })}
      </span>
    );
  if (c.state === "pending")
    return (
      <span className="st-run tp-inline">
        <span className="spin" />
        {t("pulls.checks.pending", { count: c.pending })}
      </span>
    );
  return (
    <span className="st-bad tp-inline" title={c.failingNames.join(", ")}>
      <ShieldAlert {...ICON} />
      {t("pulls.checks.failing", { count: c.failing })}
    </span>
  );
}

function GateList({ items, label }: { items: Array<{ id: string; status: GateStatus; text: string; title?: string }>; label: string }) {
  return (
    <ul className="tp-gate" aria-label={label}>
      {items.map((i) => {
        const Icon = GATE_ICON[i.status];
        return (
          <li key={i.id} className={`g-${i.status}`} title={i.title}>
            <Icon {...ICON} aria-hidden="true" />
            <span>{i.text}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** Asks in place before an outward step; the sentence names exactly what will happen. */
function Confirm({
  text,
  action,
  busy,
  onCancel,
  onConfirm,
  icon,
  tone,
}: {
  text: string;
  action: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  icon: ReactNode;
  /** Merge confirms in ok and a removal in bad (owner, 2026-10-31); without one the confirm stays the neutral primary. */
  tone?: "ok" | "bad";
}) {
  const { t } = useTranslation("github");
  return (
    <div className="tp-confirm" role="group" onKeyDown={(e) => e.key === "Escape" && onCancel()}>
      <span>{text}</span>
      <span className="end">
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          {t("pulls.cancel")}
        </Button>
        {/* A removal confirms with the danger button, like every other destructive confirm (DESIGN.md §3 Danger). */}
        <Button size="sm" variant={tone === "bad" ? "danger" : tone ? "secondary" : "primary"} tone={tone === "bad" ? undefined : tone} onClick={onConfirm} disabled={busy} autoFocus>
          {icon}
          {action}
        </Button>
      </span>
    </div>
  );
}

function FeedbackList({ v, onError }: { v: TaskPullView; onError: (err: unknown) => void }) {
  const { t } = useTranslation("github");
  const rel = useRelative();
  const now = useMinuteTick();
  const [busy, setBusy] = useState(false);
  const held = v.feedback.filter((f) => f.state === "held").length;
  const toggle = async (enabled: boolean) => {
    try {
      await write("github.setRouting", { projectId: v.projectId, enabled });
    } catch (err) {
      onError(err);
    }
  };
  const send = async () => {
    setBusy(true);
    try {
      await write("github.sendFeedback", { taskId: v.taskId });
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };
  const title = (f: FeedbackItem) =>
    f.kind === "check" ? t("taskPull.feedback.check", { name: f.source }) : f.kind === "review" ? t("taskPull.feedback.review", { who: f.source }) : f.path ? t("taskPull.feedback.commentAt", { who: f.source, where: `${f.path}${f.line ? `:${f.line}` : ""}` }) : t("taskPull.feedback.comment", { who: f.source });
  return (
    <div className="tp-sec">
      <Label>{t("taskPull.feedback.label")}</Label>
      <SendChecks v={v} headSha={v.live?.headSha ?? null} onError={onError} />
      <label className="tp-toggle">
        <input type="checkbox" checked={v.routing} onChange={(e) => void toggle(e.target.checked)} />
        <span>{t("taskPull.feedback.routing")}</span>
      </label>
      {v.feedback.length === 0 ? (
        <p className="muted tp-small">{v.routing ? t("taskPull.feedback.none") : t("taskPull.feedback.off")}</p>
      ) : (
        <ul className="tp-feedback">
          {v.feedback.map((f) => (
            <li key={f.id}>
              <div className="tp-fb-head">
                {f.kind === "check" ? <ShieldAlert {...ICON} className="st-bad" aria-hidden="true" /> : <MessageSquare {...ICON} aria-hidden="true" />}
                <span className="tp-fb-title">
                  {title(f)}
                </span>
                <span className={`tp-fb-state ${f.state === "held" ? "st-wait" : "muted"}`}>{f.state === "held" ? t("taskPull.feedback.held") : t("taskPull.feedback.sent", { time: f.sentAt ? rel(f.sentAt, now) : "" })}</span>
              </div>
              {f.excerpt && (
                <pre className="tp-fb-excerpt mono">
                  {f.excerpt}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}
      {held > 0 && (
        <div>
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void send()}>
            {t("taskPull.feedback.send", { count: held })}
          </Button>
          <p className="muted tp-small">{t("taskPull.feedback.sendNote")}</p>
        </div>
      )}
    </div>
  );
}

/**
 * "Send failing checks to the agent" (omux's "Send Failing Checks to Session"): the failed steps'
 * log tails go into the owning step's queue, never straight to the agent. Off with its reason when
 * there is nothing to send. A finished step takes its queue only when you continue it.
 */
function SendChecks({ v, headSha, onError }: { v: TaskPullView; headSha: string | null; onError: (err: unknown) => void }) {
  const { t } = useTranslation("github");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const s = v.sendChecks;
  const owner = v.owner;
  const held = v.feedback.some((f) => f.state === "held");
  const send = async () => {
    if (!headSha) return;
    setBusy(true);
    setDone(null);
    try {
      const res = await (FIXTURE ? Promise.resolve({ checks: 2, skipped: 0 }) : call("github.sendChecks", { taskId: v.taskId, headSha }));
      const queued = t(owner?.finished ? "taskPull.checks.queuedFinished" : "taskPull.checks.queuedLive", { count: res.checks });
      setDone(res.skipped ? `${queued} ${t("taskPull.checks.skipped", { count: res.skipped })}` : queued);
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };
  const go = async () => {
    setBusy(true);
    setDone(null);
    try {
      await write("github.continueQueued", { taskId: v.taskId });
      setDone(t("taskPull.checks.continued"));
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };
  const why = `tp-checks-why-${v.taskId}`;
  return (
    <div className="tp-sec">
      <div className="tp-actions">
        <Button size="sm" variant="secondary" disabled={!s.ok || busy || !headSha} title={s.ok ? t("taskPull.checks.sendTitle") : undefined} aria-describedby={s.ok ? undefined : why} onClick={() => void send()}>
          <ListPlus {...ICON} />
          {t("taskPull.checks.send")}
        </Button>
        {owner?.finished && owner.queued > 0 && !held && (
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void go()}>
            <Play {...ICON} />
            {t("taskPull.checks.continue", { count: owner.queued })}
          </Button>
        )}
      </div>
      {s.ok ? (
        <p className="muted tp-small">{t("taskPull.checks.note")}</p>
      ) : (
        <p className="muted tp-small" id={why}>
          {t(`taskPull.checks.reason.${s.reason}`)}
        </p>
      )}
      {owner?.finished && owner.queued > 0 && !held && <p className="muted tp-small">{t("taskPull.checks.continueNote")}</p>}
      {done && (
        <p className="st-ok tp-small" role="status">
          {done}
        </p>
      )}
    </div>
  );
}

/** The full flow for one task: used in the inspector and on the GitHub screen. */
export function PullPanel({ v, showTitle = false }: { v: TaskPullView; showTitle?: boolean }) {
  const { t } = useTranslation("github");
  const rel = useRelative();
  const now = useMinuteTick();
  const qc = useQueryClient();
  const errorText = useErrorText();
  const [title, setTitle] = useState(v.draft?.title ?? v.title);
  const [body, setBody] = useState(v.draft?.body ?? "");
  const [asking, setAsking] = useState<PullStep | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const draft = v.draft;
  const live = v.live;
  const step = nextStep(v);

  const run = async (fn: () => Promise<unknown>, okText: string | null) => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await fn();
      setAsking(null);
      setDone(okText);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("github.") || String(q.queryKey[0]).startsWith("tasks.") });
    }
  };

  const gateText = (id: string, status: GateStatus) => t(`taskPull.gate.${id}.${status}`, { base: draft?.base ?? v.pull?.base ?? "", count: draft?.unpushed ?? 0 });
  const sha = (s: string | null | undefined) => (s ? s.slice(0, 7) : "");

  return (
    <div className="tp">
      <div className="tp-head">
        {showTitle ? <div className="tp-title">{v.title}</div> : <Label>{t("taskPull.label")}</Label>}
        <span className="tp-head-end">
          <PullState v={v} />
          {v.pull && (
            <Button size="sm" variant="ghost" onClick={() => window.open(v.pull!.url, "_blank")} aria-label={t("taskPull.openOnGithub", { number: v.pull.number })}>
              #{v.pull.number}
              <ExternalLink {...ICON} />
            </Button>
          )}
        </span>
      </div>
      {v.problem && <p className="muted tp-small">{t(`problem.${v.problem}`)}</p>}

      {draft && (!v.pull || v.pull.state === "closed") && (
        <div className="tp-sec">
          <GateList label={t("taskPull.gateLabel")} items={draft.gate.items.map((i) => ({ id: i.id, status: i.status, text: gateText(i.id, i.status) }))} />
          {draft.head && (
            <div className="mono tp-flow">
              {t("pulls.flow", { head: draft.head, base: draft.base ?? "" })}
            </div>
          )}
          {step === "push" && draft.head && draft.headSha && (
            <div>
              <Button size="sm" variant="primary" disabled={busy} onClick={() => void run(() => write("github.push", { projectId: v.projectId, branch: draft.head!, headSha: draft.headSha! }), t("push.pushed", { branch: draft.head }))}>
                <Upload {...ICON} />
                {t("taskPull.push", { count: draft.unpushed })}
              </Button>
              <p className="muted tp-small">{t("taskPull.pushNote")}</p>
            </div>
          )}
          {draft.gate.items.find((i) => i.id === "review")?.status === "pass" && (
            <>
              <label className="tp-field">
                <span className="lbl">{t("taskPull.titleLabel")}</span>
                <input value={title} onChange={(e) => setTitle(e.target.value)} />
              </label>
              <label className="tp-field">
                <span className="lbl">{t("taskPull.bodyLabel")}</span>
                <textarea rows={8} value={body} onChange={(e) => setBody(e.target.value)} />
              </label>
              {asking === "open" ? (
                <Confirm
                  text={t("taskPull.openConfirm", { head: draft.head, base: draft.base, sha: sha(draft.headSha) })}
                  action={busy ? t("taskPull.opening") : t("taskPull.openNow")}
                  busy={busy}
                  icon={<GitPullRequest {...ICON} />}
                  onCancel={() => setAsking(null)}
                  onConfirm={() => void run(() => write("github.createPull", { taskId: v.taskId, title, body, headSha: draft.headSha! }), t("taskPull.opened"))}
                />
              ) : (
                <div>
                  <Button size="sm" variant={step === "open" ? "primary" : "secondary"} disabled={!draft.gate.ready || !title.trim() || busy} title={draft.gate.ready ? undefined : t("taskPull.openBlocked")} onClick={() => setAsking("open")}>
                    <GitPullRequest {...ICON} />
                    {t("taskPull.open")}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {v.pull && v.pull.state !== "merged" && v.pull.state !== "closed" && (
        <div className="tp-sec">
          <div className="mono tp-flow">
            {t("pulls.flow", { head: v.pull.head, base: v.pull.base })}
          </div>
          {live ? <ChecksLine c={live.checks} /> : <span className="muted tp-small">{t("taskPull.notRead")}</span>}
          {live?.gate && <GateList label={t("pulls.colGate")} items={live.gate.items.map((i) => {
                const titleKey = gateTitleKey(i, live.mergeState, live.state === "draft");
                return { id: i.id, status: i.status, text: t(gateTextKey(i, live.mergeState), { base: v.pull!.base }), title: titleKey ? t(titleKey, { base: v.pull!.base }) : undefined };
              })} />}
          {asking === "merge" && live ? (
            <Confirm
              text={t("pulls.confirm", { number: v.pull.number, method: t(`pulls.method.${v.mergeMethod ?? "merge"}`), sha: sha(live.headSha) })}
              action={busy ? t("pulls.merging") : t("pulls.mergeNow")}
              tone="ok"
              busy={busy}
              icon={<GitMerge {...ICON} />}
              onCancel={() => setAsking(null)}
              onConfirm={() => void run(() => write("github.merge", { projectId: v.projectId, number: v.pull!.number, headSha: live.headSha }), t("pulls.merged", { number: v.pull!.number }))}
            />
          ) : (
            <div>
              <Button size="sm" variant={step === "merge" ? "primary" : "secondary"} disabled={!live?.gate?.readyForApproval || busy} title={live?.gate?.readyForApproval ? undefined : t("pulls.blocked")} onClick={() => setAsking("merge")}>
                <GitMerge {...ICON} />
                {t("pulls.reviewMerge")}
              </Button>
            </div>
          )}
        </div>
      )}

      {v.pull?.state === "merged" && (
        <div className="tp-sec">
          <span className="tp-small">{t("pulls.mergedLine", { base: v.pull.base, time: v.pull.mergedAt ? rel(v.pull.mergedAt, now) : "" })}</span>
          {v.pull.worktreeRemovedAt && <span className="muted tp-small">{t("taskPull.cleanup.removed")}</span>}
          {v.cleanup && (
            <>
              <Label>{t("taskPull.cleanup.label")}</Label>
              <div className="mono tp-path" title={v.cleanup.path}>
                {v.cleanup.path}
              </div>
              {v.cleanup.ok ? (
                asking === "cleanup" ? (
                  <Confirm
                    text={t("taskPull.cleanup.confirm", { branch: v.cleanup.branch ?? "" })}
                    action={t("taskPull.cleanup.removeNow")}
                    tone="bad"
                    busy={busy}
                    icon={<X {...ICON} />}
                    onCancel={() => setAsking(null)}
                    onConfirm={() => void run(() => write("github.removeWorktree", { projectId: v.projectId, path: v.cleanup!.path }), t("taskPull.cleanup.done"))}
                  />
                ) : (
                  <div>
                    <Button size="sm" variant="danger" disabled={busy} onClick={() => setAsking("cleanup")}>
                      {t("taskPull.cleanup.remove")}
                    </Button>
                  </div>
                )
              ) : (
                <ul className="tp-blocks">
                  {v.cleanup.blocks.map((b) => (
                    <li key={b}>{t(`taskPull.cleanup.block.${b}`)}</li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}

      {v.pull && v.pull.state !== "merged" && <FeedbackList v={v} onError={(err) => setError(errorText(err))} />}
      {done && (
        <p className="st-ok tp-small" role="status">
          {done}
        </p>
      )}
      {error && (
        <p className="st-bad tp-small" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Inspector section: loads the task's PR and shows the full flow. */
export function TaskPullSection({ taskId, className }: { taskId: string; className?: string }) {
  const q = useTaskPull(taskId);
  if (!q.data) return null;
  return (
    <div className={className}>
      <PullPanel key={`${q.data.taskId}:${q.data.pull?.number ?? "draft"}`} v={q.data} />
    </div>
  );
}

/**
 * Task row line: PR state, checks and the one next step. The step button opens the inspector,
 * where the step itself is confirmed.
 */
export function TaskPullChip({ taskId, onOpen }: { taskId: string; onOpen: () => void }) {
  const { t } = useTranslation("github");
  const q = useTaskPull(taskId);
  const v = q.data;
  if (!v) return null;
  const step = nextStep(v);
  return (
    <span className="tp-chip">
      {v.pull ? (
        <span className="tp-inline">
          <span className="mono">#{v.pull.number}</span>
          <PullState v={v} />
        </span>
      ) : (
        <PullState v={v} />
      )}
      {v.live && v.pull?.state !== "merged" && <ChecksLine c={v.live.checks} />}
      {step && (
        <Button size="sm" variant={step === "cleanup" ? "ghost" : "secondary"} onClick={onOpen}>
          {t(`taskPull.step.${step}`)}
        </Button>
      )}
    </span>
  );
}

/** GitHub screen panel: every task with a PR or waiting to open one. */
export function TaskPullsPanel({ projectId }: { projectId: string }) {
  const { t } = useTranslation("github");
  const q = useTaskPulls(projectId);
  const views = q.data ?? [];
  if (!q.data) return null;
  return (
    <Panel className="gh-tasks" role="region" aria-label={t("taskPull.panel")}>
      <div className="ph">
        <h2>{t("taskPull.panel")}</h2>
        <span className="end lbl">{views.length ? t("taskPull.count", { count: views.length }) : ""}</span>
      </div>
      {views.length === 0 && <p className="muted gh-wf-empty">{t("taskPull.empty")}</p>}
      <div className="gh-tasks-list">
        {views.map((v) => (
          <PullPanel key={`${v.taskId}:${v.pull?.number ?? "draft"}`} v={v} showTitle />
        ))}
      </div>
    </Panel>
  );
}
