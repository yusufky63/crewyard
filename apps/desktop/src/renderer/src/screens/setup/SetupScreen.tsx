import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button, Label } from "@crewyard/ui";
import { SETUP_CASE_TWINS, type FolderDetection } from "@crewyard/core";
import { call, useDaemon } from "../../ipc.ts";
import { canOpenProjects, useNav } from "../../nav.ts";
import { buildConfig, draftProblems, seedFromDetection, STEPS, useDraft, type Draft, type Step } from "./draft.ts";
import { FolderStep } from "./FolderStep.tsx";
import { Row, type RowState } from "./parts.tsx";
import { AgentsStep, BudgetStep, GithubStep, RulesStep } from "./steps.tsx";
import { WorktreeStep } from "./WorktreeStep.tsx";
import "./setup.css";

type ActionId = "gitInit" | "createRepo" | "ci" | "config";
interface Progress {
  items: Array<{ id: ActionId; state: RowState; error?: string }>;
}

/** What Create project will do, worked out from the latest detection so a retry skips finished steps. */
function plannedActions(d: Draft, det: FolderDetection): ActionId[] {
  const hasCi = det.workflows.some((f) => /^ci\.ya?ml$/i.test(f));
  const willBeRepo = det.git.isRepo || d.gitInit;
  return [
    ...(!det.git.isRepo && d.gitInit ? (["gitInit"] as const) : []),
    ...(d.createRepo && willBeRepo && !det.git.remoteUrl ? (["createRepo"] as const) : []),
    ...(d.ci && !hasCi && (d.build.trim() || d.test.trim()) ? (["ci"] as const) : []),
    "config" as const,
  ];
}

/** Daemon refusals that arrive as a code get the user's language; anything else is shown as it came. */
function useErrorText() {
  const { t } = useTranslation("setup");
  return (err: unknown, det: FolderDetection) => {
    const raw = err instanceof Error ? err.message : String(err);
    // Electron prefixes errors from ipcMain.handle with "Error invoking remote method '...': Error: ".
    const code = raw.replace(/^.*Error: /, "").trim();
    if (code === SETUP_CASE_TWINS) return t("errors.caseTwins", { folders: (det.caseTwins ?? []).join(", ") || t("errors.caseTwinsUnknown") });
    return raw;
  };
}

function useCreate(det: FolderDetection | undefined) {
  const errorText = useErrorText();
  const qc = useQueryClient();
  const { go, openProject } = useNav();
  const [progress, setProgress] = useState<Progress | null>(null);

  const create = async () => {
    const d = useDraft.getState();
    if (!det || !d.path) return;
    const ids = plannedActions(d, det);
    let items: Progress["items"] = ids.map((id) => ({ id, state: "none" }));
    const mark = (id: ActionId, state: RowState, error?: string) => {
      items = items.map((i) => (i.id === id ? { id, state, error } : i));
      setProgress({ items });
    };
    setProgress({ items });
    let remote = det.git.remoteUrl;
    let branch = det.git.branch ?? "main";
    let current: ActionId = ids[0] ?? "config";
    try {
      for (const id of ids) {
        current = id;
        mark(id, "run");
        if (id === "gitInit") branch = (await call("setup.gitInit", { path: d.path })).branch;
        if (id === "createRepo") remote = (await call("setup.createRepo", { path: d.path, name: d.repoName.trim() })).remoteUrl;
        if (id === "ci") await call("setup.writeCiTemplate", { path: d.path, branch, build: d.build.trim() || null, test: d.test.trim() || null });
        if (id === "config") {
          const { project } = await call("setup.create", { path: d.path, config: buildConfig(d, remote) });
          mark(id, "ok");
          await qc.invalidateQueries({ queryKey: ["projects.list"] });
          await qc.invalidateQueries({ queryKey: ["projects.scan"] });
          useDraft.getState().reset();
          setProgress(null);
          if (canOpenProjects) openProject(project.id);
          else go("start");
          return;
        }
        mark(id, "ok");
      }
    } catch (err) {
      mark(current, "bad", errorText(err, det));
      // Re-read the folder so a retry sees what already happened (a new repo, a remote, ci.yml).
      await qc.invalidateQueries({ queryKey: ["setup.detect"] });
    }
  };
  return { progress, create, dismiss: () => setProgress(null) };
}

export function SetupScreen() {
  const { t } = useTranslation("setup");
  const d = useDraft();
  const go = useNav((s) => s.go);
  const det = useDaemon("setup.detect", { path: d.path ?? "" }, { enabled: Boolean(d.path) });
  const { progress, create, dismiss } = useCreate(det.data);

  // Fill the fields once per folder; later re-detections (after a failed create) keep the user's edits.
  useEffect(() => {
    const s = useDraft.getState();
    if (det.data && s.path && s.seededFor !== s.path) s.set(seedFromDetection(s, det.data));
  }, [det.data]);

  // Screenshot mode can open a given step, source and folder (?step=3&source=clone&folder=C:\...).
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const step = Number(q.get("step"));
    const folder = q.get("folder");
    const source = q.get("source");
    if (source === "local" || source === "clone" || source === "empty") useDraft.getState().set({ source });
    if (folder) useDraft.getState().set({ path: folder, seededFor: null });
    if (STEPS.includes(step as Step)) useDraft.getState().set({ step: step as Step });
  }, []);

  const problems = draftProblems(d, det.data);
  const busy = progress?.items.some((i) => i.state === "run") ?? false;
  const cancel = () => {
    d.reset();
    go("start");
  };
  const last = STEPS.length as Step;
  const next = () => (d.step === last ? void create() : d.set({ step: (d.step + 1) as Step }));
  const firstProblem = problems[0];

  return (
    <section className="screen setup" aria-label={t("title")}>
      <div className="page-head">
        <div>
          <h1>{t("title")}</h1>
          <div className="sub lbl">{t("stepOf", { step: d.step, total: STEPS.length })}</div>
        </div>
        <div className="right">
          <Button size="sm" variant="ghost" onClick={cancel} disabled={busy}>
            {t("cancel")}
          </Button>
        </div>
      </div>

      <div className="steps-bar" role="tablist" aria-label={t("stepsLabel")}>
        {STEPS.map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={s === d.step}
            aria-current={s === d.step ? "step" : undefined}
            className={`spec stile${s < d.step ? " done" : ""}`}
            onClick={() => d.set({ step: s })}
            disabled={busy}
          >
            <Label>{s < d.step ? t("done") : String(s).padStart(2, "0")}</Label>
            <span className="s-name">{t(`steps.${s}.name`)}</span>
            <span className="s-sub">{t(`steps.${s}.sub`)}</span>
          </button>
        ))}
      </div>

      <div className="panel">
        <div className="wiz" role="tabpanel">
          {d.step === 1 && <FolderStep />}
          {d.step === 2 && <AgentsStep />}
          {d.step === 3 && <BudgetStep />}
          {d.step === 4 && <RulesStep />}
          {d.step === 5 && <WorktreeStep />}
          {d.step === 6 && <GithubStep det={det.data} />}
        </div>

        {progress && (
          <div className="wiz-progress">
            <div className="check-list">
              {progress.items.map((i) => (
                <Row key={i.id} state={i.state === "none" ? "wait" : i.state} label={t(`create.${i.id}`)}>
                  {i.error ?? t(`create.state.${i.state}`)}
                </Row>
              ))}
            </div>
            {!busy && (
              <div className="progress-foot">
                <Button size="sm" variant="ghost" onClick={dismiss}>
                  {t("create.dismiss")}
                </Button>
              </div>
            )}
          </div>
        )}

        <div className="wiz-foot">
          {d.step === last && firstProblem ? (
            <button type="button" className="problem" onClick={() => d.set({ step: firstProblem.step })}>
              {t(`problems.${firstProblem.problem}`, { step: firstProblem.step })}
            </button>
          ) : (
            <span className="muted small">{t("footNote")}</span>
          )}
          <div className="end">
            <Button onClick={() => d.set({ step: (d.step - 1) as Step })} disabled={d.step === 1 || busy}>
              {t("back")}
            </Button>
            <Button variant="primary" onClick={next} disabled={busy || (d.step === last && problems.length > 0)}>
              {d.step === last ? (busy ? t("creating") : t("create.go")) : t("next", { step: t(`steps.${d.step + 1}.name`) })}
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
