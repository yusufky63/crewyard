import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@crewyard/ui";
import type { IncludeEntry } from "@crewyard/core";
import { useDaemon } from "../../ipc.ts";
import { formatBytes } from "../settings/model.ts";
import { includeOk, newStep, portProblem, stepProblem, useDraft, type DraftStep } from "./draft.ts";
import { CheckBox, Row, type RowState } from "./parts.tsx";

const ICON = { size: 14, strokeWidth: 1.75 } as const;

/** One list of setup or cleanup commands with a timeout each. */
function StepList({ phase }: { phase: "setup" | "cleanup" }) {
  const { t } = useTranslation("setup");
  const d = useDraft();
  const steps = d[phase];
  const put = (next: DraftStep[]) => d.set({ [phase]: next });
  const patch = (i: number, p: Partial<DraftStep>) => put(steps.map((s, j) => (j === i ? { ...s, ...p } : s)));
  return (
    <div className="wt-steps">
      {steps.map((s, i) => {
        const problem = s.command.trim() ? stepProblem(s) : null;
        return (
          <div className="wt-step" key={i}>
            <span className="muted mono small wt-n">{String(i + 1).padStart(2, "0")}</span>
            <input
              className="input mono"
              value={s.command}
              onChange={(e) => patch(i, { command: e.target.value })}
              placeholder={t(`worktree.${phase}Placeholder`)}
              aria-label={t("worktree.command", { n: i + 1 })}
              aria-invalid={problem === "command"}
            />
            <span className="money">
              <input
                className="input mono num-input wt-timeout"
                inputMode="numeric"
                value={s.timeoutSec}
                onChange={(e) => patch(i, { timeoutSec: e.target.value })}
                aria-label={t("worktree.timeout", { n: i + 1 })}
                aria-invalid={problem === "timeout"}
              />
              <span className="muted small">{t("worktree.seconds")}</span>
            </span>
            <button type="button" className="chip-x" onClick={() => put(steps.filter((_, j) => j !== i))} aria-label={t("worktree.removeStep", { n: i + 1 })}>
              <X size={12} strokeWidth={1.75} />
            </button>
            {problem && <span className="wt-bad small">{t(`worktree.problem.${problem}`)}</span>}
          </div>
        );
      })}
      <div>
        <Button size="sm" variant="ghost" onClick={() => put([...steps, newStep()])} disabled={steps.length >= 20}>
          <Plus {...ICON} />
          {t("worktree.addStep")}
        </Button>
      </div>
    </div>
  );
}

function IncludeChips() {
  const { t } = useTranslation("setup");
  const d = useDraft();
  const [next, setNext] = useState("");
  const value = next.trim();
  const ok = value !== "" && includeOk(value);
  const add = () => {
    if (ok && !d.include.includes(value)) d.set({ include: [...d.include, value] });
    if (ok) setNext("");
  };
  return (
    <div className="chips">
      {d.include.map((p) => (
        <span className="chip" key={p}>
          <b className="mono">{p}</b>
          <button type="button" className="chip-x" onClick={() => d.set({ include: d.include.filter((x) => x !== p) })} aria-label={t("worktree.removeInclude", { path: p })}>
            <X size={12} strokeWidth={1.75} />
          </button>
        </span>
      ))}
      <input
        className="input mono chip-input"
        value={next}
        onChange={(e) => setNext(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") add();
        }}
        placeholder={t("worktree.includePlaceholder")}
        aria-label={t("worktree.addInclude")}
        aria-invalid={value !== "" && !ok}
      />
      <Button size="sm" variant="ghost" onClick={add} disabled={!ok}>
        {t("worktree.addInclude")}
      </Button>
    </div>
  );
}

const ENTRY_STATE: Record<IncludeEntry["state"], RowState> = { copy: "ok", missing: "wait", not_ignored: "wait", link: "bad", over_cap: "bad" };

/** What the include list copies, read from the chosen folder: names and sizes only. */
function IncludePreviewList() {
  const { t, i18n } = useTranslation("setup");
  const d = useDraft();
  const mb = Number(d.includeMaxMb);
  const valid = Number.isInteger(mb) && mb >= 1 && mb <= 4096;
  // Typing in the cap field should not walk the folder on every key.
  const [params, setParams] = useState({ include: d.include, maxMb: valid ? mb : 64 });
  useEffect(() => {
    const id = setTimeout(() => setParams({ include: d.include, maxMb: valid ? mb : 64 }), 300);
    return () => clearTimeout(id);
  }, [d.include, mb, valid]);
  const q = useDaemon("worktrees.includePreview", { path: d.path ?? "", ...params }, { enabled: Boolean(d.path) && params.include.length > 0 });
  if (d.include.length === 0) return <p className="muted small note">{t("worktree.includeNone")}</p>;
  if (!d.path) return null;
  const size = (n: number) => formatBytes(n, i18n.language);
  return (
    <div className="check-list">
      {q.isPending && <Row state="run" label={t("worktree.includeLabel")}>{t("checking")}</Row>}
      {q.isError && <Row state="bad" label={t("worktree.includeLabel")}>{String(q.error)}</Row>}
      {q.data?.entries.map((e) => (
        <Row key={e.path} state={ENTRY_STATE[e.state]} label={<span className="mono">{e.path}</span>}>
          {e.state === "copy" || e.state === "over_cap" ? `${t(`worktree.entry.${e.state}`)} · ${t("worktree.files", { count: e.files })} · ${size(e.bytes)}` : t(`worktree.entry.${e.state}`)}
        </Row>
      ))}
      {q.data && (
        <Row state="none" label={t("worktree.includeTotal")}>
          {t("worktree.includeTotalText", { files: q.data.copyFiles, size: size(q.data.copyBytes), cap: size(q.data.capBytes) })}
        </Row>
      )}
    </div>
  );
}

export function WorktreeStep() {
  const { t } = useTranslation("setup");
  const d = useDraft();
  const mb = Number(d.includeMaxMb);
  const badPort = portProblem(d);
  return (
    <>
      <h2>{t("worktree.title")}</h2>
      <p className="sec">{t("worktree.lead")}</p>

      <div className="setrow wrap">
        <span>
          {t("worktree.setup")}
          <span className="muted small block">{t("worktree.setupHint")}</span>
        </span>
      </div>
      <StepList phase="setup" />

      <div className="setrow wrap">
        <span>
          {t("worktree.cleanup")}
          <span className="muted small block">{t("worktree.cleanupHint")}</span>
        </span>
      </div>
      <StepList phase="cleanup" />

      <div className="setrow wrap">
        <span>
          {t("worktree.include")}
          <span className="muted small block">{t("worktree.includeHint")}</span>
        </span>
        <IncludeChips />
      </div>
      <div className="setrow">
        <span>
          {t("worktree.includeCap")}
          <span className="muted small block">{t("worktree.includeCapHint")}</span>
        </span>
        <span className="money">
          <input className="input mono num-input" inputMode="numeric" value={d.includeMaxMb} onChange={(e) => d.set({ includeMaxMb: e.target.value })} aria-label={t("worktree.includeCap")} aria-invalid={!(Number.isInteger(mb) && mb >= 1 && mb <= 4096)} />
          <span className="muted">MB</span>
        </span>
      </div>
      <IncludePreviewList />

      <div className="setrow wrap">
        <span>
          {t("worktree.port")}
          <span className="muted small block">{t("worktree.portHint")}</span>
        </span>
        <span className="money">
          <CheckBox checked={d.portOn} onChange={(v) => d.set({ portOn: v })} label={t("worktree.portOn")} />
          <span className="muted small">{t("worktree.portOn")}</span>
        </span>
      </div>
      {d.portOn && (
        <div className="check-list">
          <Row state={badPort ? "bad" : "ok"} label={t("worktree.portRange")}>
            <span className="money">
              <input className="input mono num-input" inputMode="numeric" value={d.portFrom} onChange={(e) => d.set({ portFrom: e.target.value })} aria-label={t("worktree.portFrom")} aria-invalid={badPort} />
              <span className="muted">–</span>
              <input className="input mono num-input" inputMode="numeric" value={d.portTo} onChange={(e) => d.set({ portTo: e.target.value })} aria-label={t("worktree.portTo")} aria-invalid={badPort} />
            </span>
          </Row>
          <Row state={badPort ? "bad" : "ok"} label={t("worktree.portVar")}>
            <span className="money">
              <input className="input mono wt-var" value={d.portEnvVar} onChange={(e) => d.set({ portEnvVar: e.target.value })} aria-label={t("worktree.portVar")} aria-invalid={badPort} />
              <span className="muted small">{t("worktree.portVarText", { name: d.portEnvVar || "PORT" })}</span>
            </span>
          </Row>
        </div>
      )}
      <p className="muted small note">{t("worktree.note")}</p>
    </>
  );
}
