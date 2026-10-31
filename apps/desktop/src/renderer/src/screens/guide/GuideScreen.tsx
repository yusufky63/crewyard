import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, ArrowRight, Check, ChevronRight, CircleHelp, Minus } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ToolCheck, ToolId } from "@crewyard/core";
import { Button, Label, Panel } from "@crewyard/ui";
import { useDaemon } from "../../ipc.ts";
import { keycaps, type ShortcutId } from "../../keys.ts";
import { useNav } from "../../nav.ts";
import { usePrefs } from "../../prefs.ts";
import { openPanel } from "../../shell/activity/panel.ts";
import { KeyboardMap } from "../../shell/status/keys.tsx";
import { goInProject, openTask, startNewTask } from "../../shell/titlebar/actions.ts";
import { useProvidersLive } from "../providers/shared.tsx";
import { openSettings } from "../settings/model.ts";
import { useUpdates } from "../settings/Updates.tsx";
import { openSetup } from "../setup/draft.ts";
import { MACHINE_PANEL_ID } from "../start/Machine.tsx";
import { defenderItem, longPathsItem, summarize, TOOL_ORDER, toolItem } from "../start/machine.ts";
import { FAQ, FEATURES, FLOW, needsProject, type GuideAction } from "./content.ts";
import { guideChecklist, machineProblem, releaseFacts, STATE_BADGE, type GuideRowId, type GuideState, type Read } from "./model.ts";
import "./guide.css";

// The Guide (How it works): the task flow as numbered spec tiles, a Getting started list read from
// real state, the main features and a short FAQ. Every button goes to the screen it talks about;
// project screens open the open project, else the most recent one, else say a project is needed.

const STALE = 5 * 60_000;
const SECTIONS = ["flow", "checklist", "features", "faq"] as const;
const pad = (n: number) => String(n).padStart(2, "0");
const sectionId = (id: string) => `guide-${id}`;

/** Start's This machine strip renders after the screen swaps; wait for it, then bring it into view. */
function focusMachine(): void {
  let tries = 0;
  const step = () => {
    const el = document.getElementById(MACHINE_PANEL_ID);
    if (el) {
      el.scrollIntoView({ block: "nearest" });
      el.focus({ preventScroll: true });
    } else if (++tries < 20) setTimeout(step, 50);
  };
  setTimeout(step, 0);
}

const asRead = <T,>(q: { data: T | undefined; isPending: boolean; error: unknown }): Read<T> => ({ data: q.data, pending: q.isPending, error: q.error });

function useGuideActions() {
  const qc = useQueryClient();
  const { projectId, go, closeProject } = useNav();
  const projectsQ = useDaemon("projects.list", undefined);
  const projects = projectsQ.data ?? [];
  // The open project, else the most recently opened one, as the title bar search does.
  const target = projectId ?? projects[0]?.id ?? null;
  const [keysOpen, setKeysOpen] = useState(false);

  const run = async (a: GuideAction): Promise<void> => {
    switch (a.kind) {
      case "screen":
        if (!target) return go(a.screen);
        return goInProject(qc, target, a.screen);
      case "newTask":
        if (target) await startNewTask(qc, target);
        return;
      case "start":
        return closeProject();
      case "setup":
        return openSetup("local");
      case "settings":
        return openSettings(a.section);
      case "panel":
        if (!target) return;
        // The panel lives in the project frame; open the project first and stay on the Guide.
        if (projectId !== target) await goInProject(qc, target, "guide");
        return openPanel(a.tab);
      case "keys":
        return setKeysOpen(true);
    }
  };
  // Until projects.list answers (or while it fails), whether a project exists is not known, so a
  // project button waits instead of claiming "Open a project first", the same guard the banner uses.
  const projectKnown = projectId !== null || projectsQ.isSuccess;
  const available = (a: GuideAction) => !needsProject(a) || target !== null;
  return { run, available, projectKnown, target, projects, projectsRead: projectsQ.isSuccess, projectId, keysOpen, closeKeys: () => setKeysOpen(false) };
}

type Actions = ReturnType<typeof useGuideActions>;

function GoButton({ action, label, actions }: { action: GuideAction; label: string; actions: Actions }) {
  const { t } = useTranslation("guide");
  if (!actions.available(action) && !actions.projectKnown) {
    return (
      <span className="gd-go off">
        <Button size="sm" variant="ghost" disabled>
          {label}
        </Button>
      </span>
    );
  }
  if (!actions.available(action)) {
    return (
      <span className="gd-go off">
        <Button size="sm" variant="ghost" disabled>
          {label}
        </Button>
        <span className="muted gd-why">{t("needsProject")}</span>
      </span>
    );
  }
  return (
    <span className="gd-go">
      <Button size="sm" variant="ghost" onClick={() => void actions.run(action)}>
        {label}
        <ArrowRight aria-hidden="true" />
      </Button>
    </span>
  );
}

function SectionHead({ id, index, children }: { id: string; index: number; children?: ReactNode }) {
  const { t } = useTranslation("guide");
  return (
    <div className="gd-head">
      <h2 id={`${sectionId(id)}-title`} className="gd-h2" tabIndex={-1}>
        <span className="lbl">{pad(index)}</span>
        {t(`sections.${id}`)}
      </h2>
      {children}
    </div>
  );
}

function Flow({ actions }: { actions: Actions }) {
  const { t } = useTranslation("guide");
  return (
    <section id={sectionId("flow")} className="gd-section" aria-labelledby={`${sectionId("flow")}-title`}>
      <SectionHead id="flow" index={1}>
        <p className="sec">{t("flow.lead")}</p>
      </SectionHead>
      <ol className="gd-flow">
        {FLOW.map((s, i) => {
          const Icon = s.icon;
          return (
            <li key={s.id} className="spec gd-step">
              <div className="gd-step-top">
                <span className="lbl">{pad(i + 1)}</span>
                <Icon className="gd-icon" size={16} strokeWidth={1.5} aria-hidden="true" />
              </div>
              <h3 className="gd-title">{t(`flow.steps.${s.id}.title`)}</h3>
              <p className="sec gd-body">{t(`flow.steps.${s.id}.body`)}</p>
              <GoButton action={s.action} label={t(`flow.steps.${s.id}.go`)} actions={actions} />
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function StateMark({ state }: { state: GuideState }) {
  if (state === "checking") {
    return (
      <span className="st st-run">
        <span className="spin" />
      </span>
    );
  }
  const icon = { done: <Check size={16} strokeWidth={1.75} />, problem: <AlertTriangle size={16} strokeWidth={1.75} />, unknown: <CircleHelp size={16} strokeWidth={1.75} />, todo: <Minus size={16} strokeWidth={1.75} /> }[state];
  const cls = { done: "gd-mark ok", problem: "gd-mark warn", unknown: "gd-mark", todo: "gd-mark" }[state];
  return (
    <span className={cls} aria-hidden="true">
      {icon}
    </span>
  );
}

function Checklist({ actions }: { actions: Actions }) {
  const { t } = useTranslation("guide");
  const qc = useQueryClient();
  // The same queries (and cache keys) as Start's This machine strip, so both agree and share reads.
  const opts = { staleTime: STALE };
  // Opens without a project too, where the sidebar's accounts block (which also listens) is absent.
  useProvidersLive();
  const scanRoot = usePrefs((s) => s.scanRoot);
  const tools: Record<ToolId, Read<ToolCheck>> = {
    claude: asRead(useDaemon("machine.tool", { id: "claude" }, opts)),
    codex: asRead(useDaemon("machine.tool", { id: "codex" }, opts)),
    opencode: asRead(useDaemon("machine.tool", { id: "opencode" }, opts)),
    gemini: asRead(useDaemon("machine.tool", { id: "gemini" }, opts)),
    git: asRead(useDaemon("machine.tool", { id: "git" }, opts)),
    gh: asRead(useDaemon("machine.tool", { id: "gh" }, opts)),
  };
  const env = useDaemon("machine.env", undefined, opts);
  const defender = useDaemon("machine.defender", { scanRoot }, opts);
  const profiles = asRead(useDaemon("providers.profiles", undefined));
  const credentials = asRead(useDaemon("providers.credentials", undefined));
  const keyChecks = asRead(useDaemon("providers.keyChecks", undefined));
  const signIns = asRead(useDaemon("providers.signInStatus", undefined));
  const tasks = asRead(useDaemon("tasks.list", {}));
  const github = asRead(useDaemon("github.auth", undefined, { staleTime: STALE }));
  const rows = guideChecklist({ tools, profiles, credentials, keyChecks, signIns, projectOpen: Boolean(actions.projectId), tasks, github });
  const done = rows.filter((r) => r.state === "done").length;
  // The row says whether tasks can run; the rest of This machine (an update, gh's sign-in, long
  // paths, Defender, other copies) is counted exactly as Start's strip counts it, so the Guide never
  // reads "all fine" while Start says checks need attention.
  const machineItems = TOOL_ORDER.map((id) => toolItem(id, tools[id], env.data));
  const longPaths = longPathsItem(env.data);
  if (longPaths) machineItems.push(longPaths);
  const def = defenderItem(defender.data, defender.isPending, defender.error);
  if (def) machineItems.push(def);
  const attention = summarize(machineItems).attention;
  const problem = machineProblem(tools);
  const { target, projects } = actions;
  const proposed = tasks.data?.find((x) => x.status === "proposed" && (!actions.projectId || x.projectId === actions.projectId));

  // "New project" only once the list has answered empty; while it loads or fails, Start is the safe
  // place to send someone, since it lists the projects that exist.
  const noProjects = actions.projectsRead && projects.length === 0;
  const projectGo = noProjects ? { label: t("checklist.rows.project.goNew"), run: () => void actions.run({ kind: "setup" }) } : { label: t("checklist.rows.project.goOpen"), run: () => void actions.run({ kind: "start" }) };
  const where: Record<GuideRowId, { label: string; run(): void }> = {
    machine: {
      label: t("checklist.rows.machine.go"),
      run: () => {
        void actions.run({ kind: "start" });
        focusMachine();
      },
    },
    profile: { label: t("checklist.rows.profile.go"), run: () => void actions.run({ kind: "screen", screen: "providers" }) },
    project: projectGo,
    firstTask: target ? { label: t("checklist.rows.firstTask.go"), run: () => void actions.run({ kind: "newTask" }) } : projectGo,
    firstCrew: proposed
      ? { label: t("checklist.rows.firstCrew.goProposal"), run: () => void openTask(qc, proposed.projectId, proposed.id) }
      : target
        ? { label: t("checklist.rows.firstCrew.go"), run: () => void actions.run({ kind: "screen", screen: "tasks" }) }
        : projectGo,
    github: target
      ? { label: t("checklist.rows.github.go"), run: () => void actions.run({ kind: "screen", screen: "github" }) }
      : {
          label: t("checklist.rows.github.goMachine"),
          run: () => {
            void actions.run({ kind: "start" });
            focusMachine();
          },
        },
  };

  const hint = (id: GuideRowId, state: GuideState) => {
    if (state === "unknown") return t("checklist.unknownHint");
    if (id === "machine" && state === "done" && attention > 0) return t("checklist.rows.machine.attention", { count: attention });
    if (id === "machine" && state === "problem") return t(problem === "refused" ? "checklist.rows.machine.refused" : "checklist.rows.machine.problem");
    if (state === "problem" && (id === "profile" || id === "github")) return t(`checklist.rows.${id}.problem`);
    return t(`checklist.rows.${id}.hint`);
  };

  return (
    <section id={sectionId("checklist")} className="gd-section" aria-labelledby={`${sectionId("checklist")}-title`}>
      <SectionHead id="checklist" index={2}>
        <p className="sec">{t("checklist.lead")}</p>
      </SectionHead>
      <Panel className="gd-check">
        <div className="gd-check-head">
          <span className="lbl">{t("checklist.count", { done, total: rows.length })}</span>
        </div>
        <ol className="gd-rows">
          {rows.map((r, i) => (
            <li key={r.id} className={`gd-row is-${r.state}`}>
              <StateMark state={r.state} />
              <span className="lbl gd-idx">{pad(i + 1)}</span>
              <span className="gd-row-text">
                <span className="gd-row-label">{t(`checklist.rows.${r.id}.label`)}</span>
                <span className="muted gd-row-hint">{hint(r.id, r.state)}</span>
              </span>
              <span className={STATE_BADGE[r.state]}>{t(`checklist.state.${r.state}`)}</span>
              <span className="gd-row-go">
                {(r.state !== "done" || (r.id === "machine" && attention > 0)) && (
                  <Button size="sm" variant="ghost" tone={r.state === "problem" || r.state === "done" ? "warn" : undefined} onClick={where[r.id].run}>
                    {where[r.id].label}
                    <ArrowRight aria-hidden="true" />
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ol>
      </Panel>
    </section>
  );
}

const KEY_HINTS: ShortcutId[] = ["palette", "go.guide", "drawer", "assistant", "help"];

function KeyRows() {
  const { t } = useTranslation("keys");
  const space = t("space");
  return (
    <dl className="gd-keys">
      {KEY_HINTS.map((id) => {
        const caps = keycaps(id, space);
        return (
          <div key={id} className="gd-key">
            <dt className="sec">{t(`action.${id}`)}</dt>
            <dd aria-label={caps.map((c) => c.join(" ")).join(` ${t("or")} `)}>
              {caps.map((chord, i) => (
                <span key={i} className="gd-chord" aria-hidden="true">
                  {i > 0 && <span className="muted">{t("or")}</span>}
                  {chord.map((c, j) => (
                    <kbd key={j} className="kbd">
                      {c}
                    </kbd>
                  ))}
                </span>
              ))}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

const BADGES = [
  ["reported", "badge badge-reported"],
  ["estimated", "badge badge-estimated"],
  ["unknown", "badge badge-unknown"],
  ["plan", "badge"],
] as const;

function Features({ actions }: { actions: Actions }) {
  const { t } = useTranslation("guide");
  return (
    <section id={sectionId("features")} className="gd-section" aria-labelledby={`${sectionId("features")}-title`}>
      <SectionHead id="features" index={3} />
      <div className="gd-features">
        {FEATURES.map((f) => {
          const Icon = f.icon;
          const points = f.id === "keyboard" ? {} : (t(`features.${f.id}.points`, { returnObjects: true }) as Record<string, string>);
          return (
            <article key={f.id} className="spec gd-feature" aria-labelledby={`gd-f-${f.id}`}>
              <div className="gd-step-top">
                <Icon className="gd-icon" size={16} strokeWidth={1.5} aria-hidden="true" />
                <h3 id={`gd-f-${f.id}`} className="gd-title">
                  {t(`features.${f.id}.title`)}
                </h3>
              </div>
              <p className="sec gd-body">{t(`features.${f.id}.body`)}</p>
              {f.id === "limits" && (
                <dl className="gd-badges">
                  {BADGES.map(([id, cls]) => (
                    <div key={id} className="gd-badge-row">
                      <dt>
                        <span className={cls}>{t(`features.limits.badges.${id}.term`)}</span>
                      </dt>
                      <dd className="sec">{t(`features.limits.badges.${id}.meaning`)}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {f.id === "keyboard" && <KeyRows />}
              {Object.keys(points).length > 0 && (
                <ul className="gd-points">
                  {Object.entries(points).map(([k, v]) => (
                    <li key={k}>{v}</li>
                  ))}
                </ul>
              )}
              <GoButton action={f.action} label={t(`features.${f.id}.go`)} actions={actions} />
            </article>
          );
        })}
      </div>
    </section>
  );
}

/** The release answer describes the build that is running, as Settings → Updates reads it. */
function releaseAnswer(t: (k: string, o?: Record<string, unknown>) => string, s: ReturnType<typeof releaseFacts>): string {
  if (!s) return t("faq.release.reading");
  const build = t(s.signed ? "faq.release.signed" : "faq.release.unsigned", { version: s.version });
  const updates = s.updates.looks ? t("faq.release.feed") : t(`settings:updates.off.${s.updates.why}`);
  return `${build} ${updates}`;
}

function Faq() {
  const { t } = useTranslation("guide");
  const release = releaseFacts(useUpdates());
  // ?faq= comes only from screenshot runs, to capture an answer open.
  const shotOpen = new URLSearchParams(window.location.search).get("faq");
  return (
    <section id={sectionId("faq")} className="gd-section" aria-labelledby={`${sectionId("faq")}-title`}>
      <SectionHead id="faq" index={4} />
      <div className="gd-faq">
        {FAQ.map((id) => (
          <details key={id} className="frame gd-faq-item" open={shotOpen === id ? true : undefined}>
            <summary>
              <ChevronRight className="gd-chev" size={14} strokeWidth={1.75} aria-hidden="true" />
              {t(`faq.${id}.q`)}
            </summary>
            <p className="sec">{id === "release" ? releaseAnswer(t, release) : t(`faq.${id}.a`)}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

export function GuideScreen() {
  const { t } = useTranslation("guide");
  const go = useNav((s) => s.go);
  const actions = useGuideActions();
  const jump = (id: string) => {
    const head = document.getElementById(`${sectionId(id)}-title`);
    head?.scrollIntoView({ block: "start" });
    head?.focus({ preventScroll: true });
  };
  useEffect(() => {
    // ?section= comes only from screenshot runs (CREWYARD_SHOT_QUERY), to capture lower sections.
    const wanted = new URLSearchParams(window.location.search).get("section");
    if (!wanted || !(SECTIONS as readonly string[]).includes(wanted)) return;
    const later = setTimeout(() => document.getElementById(`${sectionId(wanted)}-title`)?.scrollIntoView({ block: "start" }), 600);
    return () => clearTimeout(later);
  }, []);
  return (
    <div className="screen guide">
      <div className="page-head">
        <div className="gd-intro">
          <Label>{t("eyebrow")}</Label>
          <h1>{t("title")}</h1>
          <p className="sec gd-sub">{t("sub")}</p>
        </div>
        {!actions.projectId && (
          <div className="right">
            <Button variant="ghost" size="sm" onClick={() => go("start")}>
              <ArrowLeft aria-hidden="true" />
              {t("back")}
            </Button>
          </div>
        )}
      </div>
      <nav className="gd-index" aria-label={t("index")}>
        {SECTIONS.map((id, i) => (
          <button key={id} type="button" className="chip" onClick={() => jump(id)}>
            <span className="lbl">{pad(i + 1)}</span>
            {t(`sections.${id}`)}
          </button>
        ))}
      </nav>
      {actions.target === null && actions.projectsRead && (
        <div className="banner banner-info gd-noproject" role="note">
          <span>{t("noProject.text")}</span>
          <Button size="sm" onClick={() => void actions.run({ kind: "setup" })}>
            {t("noProject.go")}
          </Button>
        </div>
      )}
      <Flow actions={actions} />
      <Checklist actions={actions} />
      <Features actions={actions} />
      <Faq />
      {actions.keysOpen && createPortal(<KeyboardMap onClose={actions.closeKeys} />, document.body)}
    </div>
  );
}
