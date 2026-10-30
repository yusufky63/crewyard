import { useState } from "react";
import { Check, CircleX, GitBranch, Square } from "lucide-react";
import type { BestOfVariantView, TaskDetail, TaskStatus } from "@crewyard/core";
import { Button, Label } from "@crewyard/ui";
import { useInspector } from "../../inspector.ts";
import { ProvBadge } from "../providers/shared.tsx";
import { act, useErrorText } from "./data.ts";
import { formatDuration, loopLook, type Tone } from "./model.ts";
import { ConfirmButton, ErrorLine, STATUS_ICONS, useFormat, Who } from "./parts.tsx";
import { DiffStat } from "./TaskRow.tsx";

// Best of N compare view (feature scan A8): the variants side by side with what you need to pick
// one: the files each changed, its last test run in its own worktree, the loop's verdict, spend.
// Keeping one asks first and names what it stops and parks. In the inspector it stacks.

const FILES_SHOWN = 6;

const STATUS_TONE: Partial<Record<TaskStatus, Tone>> = { running: "run", queued: "wait", needs_input: "wait", limited: "bad", handing_off: "wait", review: "ok", failed: "bad", cancelled: "muted" };
const toneClass = (tone: Tone | undefined) => (tone === "run" ? "st-run" : tone === "wait" ? "st-wait" : tone === "ok" ? "st-ok" : tone === "bad" ? "st-bad" : "muted");

function Variant({ detail, v, others, stacked }: { detail: TaskDetail; v: BestOfVariantView; others: BestOfVariantView[]; stacked: boolean }) {
  const f = useFormat();
  const errorText = useErrorText();
  const inspect = useInspector((s) => s.open);
  const [error, setError] = useState<string | null>(null);
  const group = detail.bestOfGroup!;
  const finished = v.status === "review";
  const live = v.run && !v.run.endedAt;
  const verdict = v.decisions.at(-1) ?? null;
  const look = verdict ? loopLook(verdict.kind) : null;
  const VerdictIcon = look ? STATUS_ICONS[look.icon] : null;
  const files = v.diffStat?.files ?? v.run?.diff ?? [];
  const stat = v.diffStat ? { files: v.diffStat.files.length, added: v.diffStat.added, removed: v.diffStat.removed } : files.length ? { files: files.length, added: files.reduce((n, x) => n + x.added, 0), removed: files.reduce((n, x) => n + x.removed, 0) } : null;
  const resumable = v.resumableRunIds[0];
  const running = others.filter((o) => o.run && !o.run.endedAt).length;

  const run$ = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div className={`spec bo-variant${v.outcome === "kept" ? " selected" : ""}`} aria-label={f.t("bestOf.variantAria", { index: v.position, alias: v.candidate.alias })}>
      <div className="bo-head">
        <span className="lbl num">{String(v.position).padStart(2, "0")}</span>
        <span className="bo-who">
          <Who c={v.candidate} model={false} />
        </span>
        {v.outcome === "kept" && <span className="st st-ok">{f.t("bestOf.kept")}</span>}
        {v.outcome === "discarded" && <span className="st muted">{v.parkError ? f.t("bestOf.discardedNotParked") : v.parkedAt ? f.t("bestOf.discardedParked") : f.t("bestOf.discarded")}</span>}
      </div>
      <div className="mono bo-model">{v.candidate.model ?? f.t("proposal.defaultModel")}</div>
      <div className={`st ${toneClass(v.status ? STATUS_TONE[v.status] : undefined)}`}>{v.status ? f.t(`bestOf.status.${v.status}`) : f.t("bestOf.status.waiting")}</div>

      <dl className="bo-facts">
        <dt className="lbl">{f.t("bestOf.spend")}</dt>
        <dd>
          <span className="num">{v.spend.usd !== null ? f.usd(v.spend.usd) : f.t("proposal.unknown")}</span> <ProvBadge value={v.spend.provenance} />
          <span className="muted bo-small"> · {f.t("bestOf.estimate", { usd: v.candidate.estimate.usd !== null ? f.usd(v.candidate.estimate.usd) : f.t("proposal.unknown") })}</span>
        </dd>
        <dt className="lbl">{f.t("bestOf.changes")}</dt>
        <dd>
          {stat ? <DiffStat stat={stat} /> : <span className="muted">{live ? f.t("bestOf.noChangesYet") : f.t("bestOf.noChanges")}</span>}
          {files.length > 0 && (
            <ul className="bo-files mono">
              {files.slice(0, FILES_SHOWN).map((x) => (
                <li key={x.path}>
                  <span className="as-typed">{x.path}</span>
                  <span className="add">+{x.added}</span>
                  <span className="del">−{x.removed}</span>
                </li>
              ))}
              {files.length > FILES_SHOWN && <li className="muted">{f.t("bestOf.moreFiles", { count: files.length - FILES_SHOWN })}</li>}
            </ul>
          )}
        </dd>
        <dt className="lbl">{f.t("bestOf.tests")}</dt>
        <dd>
          {v.test ? (
            <>
              <span className={`st ${v.test.passed ? "st-ok" : "st-bad"}`}>
                {v.test.passed ? <Check size={14} strokeWidth={1.75} aria-hidden="true" /> : <CircleX size={14} strokeWidth={1.75} aria-hidden="true" />}
                {v.test.passed ? f.t("bestOf.testsPassed") : f.t("bestOf.testsFailed", { code: v.test.exitCode ?? "-" })}
              </span>
              <span className="muted bo-small"> · {formatDuration(v.test.durationMs)}</span>
              <div className="mono muted bo-small as-typed">{v.test.command}</div>
              {!v.test.passed && v.test.tail && (
                <details className="bo-tail">
                  <summary className="bo-small">{f.t("bestOf.output")}</summary>
                  <pre className="mono">{v.test.tail}</pre>
                </details>
              )}
            </>
          ) : (
            <span className="muted">{f.t("bestOf.noTests")}</span>
          )}
        </dd>
        <dt className="lbl">{f.t("bestOf.verdict")}</dt>
        <dd>
          {verdict && look && VerdictIcon ? (
            <span className={`st ${toneClass(look.tone)}`}>
              <VerdictIcon size={14} strokeWidth={1.75} aria-hidden="true" />
              <span className="bo-wrap">{f.reason(verdict.reason)}</span>
            </span>
          ) : (
            <span className="muted">{f.t("bestOf.noVerdict")}</span>
          )}
        </dd>
        {v.branch && (
          <>
            <dt className="lbl">{f.t("bestOf.branch")}</dt>
            <dd className="mono bo-small">
              <GitBranch size={13} strokeWidth={1.75} aria-hidden="true" /> <span className="as-typed">{v.branch}</span>
            </dd>
          </>
        )}
        {v.parkError && (
          <>
            <dt className="lbl">{f.t("bestOf.parkFailed")}</dt>
            <dd className="st-bad bo-small">{f.t(`errors.${v.parkError.replace(/\./g, "_")}`, { defaultValue: v.parkError })}</dd>
          </>
        )}
      </dl>

      <div className={`bo-actions${stacked ? " stacked" : ""}`}>
        {group.phase !== "kept" && finished && (
          <ConfirmButton
            size="md"
            variant="secondary"
            confirmLabel={f.t("bestOf.keepYes")}
            label={f.t("bestOf.keep")}
            confirm={others.length > 0 ? f.t("bestOf.keepConfirm", { count: others.length, running }) : f.t("bestOf.keepConfirmAlone")}
            onConfirm={() => run$(() => act("tasks.keepVariant", { taskId: detail.id, variantId: v.id }))}
          />
        )}
        {group.phase !== "kept" && live && v.run && (
          <ConfirmButton label={f.t("bestOf.stop")} confirm={f.t("bestOf.stopConfirm")} onConfirm={() => run$(() => act("runs.stop", { runId: v.run!.id, sessionId: v.run!.nativeSessionId }))} />
        )}
        {group.phase !== "kept" && !live && resumable && (
          <Button size="sm" onClick={() => void run$(() => act("runs.retry", { runId: resumable }))}>
            {f.t("action.retry")}
          </Button>
        )}
        {v.taskId && (
          <Button size="sm" variant="ghost" onClick={() => inspect({ taskId: v.taskId!, ...(v.run ? { memberId: v.run.memberId, runId: v.run.id } : {}) })}>
            {f.t("bestOf.inspect")}
          </Button>
        )}
      </div>
      <ErrorLine>{error}</ErrorLine>
    </div>
  );
}

/** The whole group: a line on what happens, then one column per variant (stacked in the inspector). */
export function BestOfCompare({ detail, stacked = false }: { detail: TaskDetail; stacked?: boolean }) {
  const f = useFormat();
  const group = detail.bestOfGroup;
  if (!group) return null;
  const finished = group.variants.filter((v) => v.status === "review").length;
  return (
    <section className={stacked ? "ins-sec bo" : "tk-crew frame bo"} aria-label={f.t("bestOf.aria", { title: detail.title })}>
      <div className="tk-crew-head">
        <Label>{f.t("bestOf.title", { count: group.n })}</Label>
        <span className="lbl">{f.t(`bestOf.phase.${group.phase}`)}</span>
        {group.estimate.usd !== null && (
          <span className="lbl">
            · {f.t("bestOf.groupEstimate", { usd: f.usd(group.estimate.usd) })} <ProvBadge value={group.estimate.provenance} />
          </span>
        )}
      </div>
      {!stacked && <h2 className="tk-crew-task">{detail.title}</h2>}
      <p className="bo-note">
        {group.phase === "kept" ? (
          <>
            <Square size={13} strokeWidth={1.75} aria-hidden="true" /> {f.t("bestOf.keptNote")}
          </>
        ) : group.phase === "choosing" ? (
          f.t("bestOf.chooseNote", { count: finished })
        ) : (
          f.t("bestOf.runningNote")
        )}
      </p>
      <div className={stacked ? "bo-stack" : "bo-grid"} style={stacked ? undefined : { gridTemplateColumns: `repeat(${group.n}, minmax(220px, 1fr))` }}>
        {group.variants.map((v) => (
          <Variant key={v.id} detail={detail} v={v} others={group.variants.filter((o) => o.id !== v.id && o.outcome !== "discarded")} stacked={stacked} />
        ))}
      </div>
    </section>
  );
}
