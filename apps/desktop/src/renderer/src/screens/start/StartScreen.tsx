import { useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, CircleHelp, Copy, FolderOpen, FolderSearch, FolderTree, GitBranch, GitPullRequest, Minus, Plus, RefreshCw, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { BrandIcon, Button, Label, Panel } from "@crewyard/ui";
import type { DefenderCheck, MachineEnv, ProjectSummary, ToolId, VersionGate } from "@crewyard/core";
import { call, useDaemon } from "../../ipc.ts";
import { canOpenProjects, useNav } from "../../nav.ts";
import { usePrefs } from "../../prefs.ts";
import { openSetup } from "../setup/draft.ts";
import { useWork } from "../tasks/data.ts";
import { Checklist, MACHINE_PANEL_ID } from "./Checklist.tsx";
import { branchParts, projectActivity } from "./tile.ts";
import "./start.css";

const TOOL_ORDER: ToolId[] = ["claude", "codex", "opencode", "gemini", "git", "gh"];
// Brand glyphs are keyed by runner id (PLAN.md D9), not by the CLI's binary name.
const TOOL_BRAND: Record<ToolId, string> = { claude: "claude-code", codex: "codex", opencode: "opencode", gemini: "gemini-cli", git: "git", gh: "github" };
const IMPORT_PREVIEW = 8;

function useRelativeTime() {
  const { i18n } = useTranslation();
  const rtf = new Intl.RelativeTimeFormat(i18n.language, { numeric: "auto" });
  return (iso: string) => {
    const minutes = Math.round((Date.parse(iso) - Date.now()) / 60_000);
    if (Math.abs(minutes) < 60) return rtf.format(minutes, "minute");
    const hours = Math.round(minutes / 60);
    if (Math.abs(hours) < 24) return rtf.format(hours, "hour");
    return rtf.format(Math.round(hours / 24), "day");
  };
}

type RowState = "ok" | "warn" | "neutral" | "unknown";

function RowIcon({ state, pending }: { state: RowState; pending: boolean }) {
  if (pending) {
    return (
      <span className="st st-run">
        <span className="spin" />
      </span>
    );
  }
  const icon = { ok: <Check size={16} strokeWidth={1.75} />, warn: <AlertTriangle size={16} strokeWidth={1.75} />, unknown: <CircleHelp size={16} strokeWidth={1.75} />, neutral: <Minus size={16} strokeWidth={1.75} /> }[state];
  const cls = { ok: "st st-ok", warn: "st st-wait", unknown: "st st-wait", neutral: "st muted" }[state];
  return <span className={cls}>{icon}</span>;
}

/** One machine check line; `children` is the note under it (why it matters and what to run). */
function CheckRow({ state, pending, label, detail, glyph, children }: { state: RowState; pending: boolean; label: string; detail: string; glyph: ReactNode; children?: ReactNode }) {
  return (
    <>
      <div className="sysrow">
        <RowIcon state={state} pending={pending} />
        <span className="brand-name">
          {glyph}
          {label}
        </span>
        <span className="muted">{detail}</span>
      </div>
      {children && !pending && <div className="sysnote">{children}</div>}
    </>
  );
}

/** A command for the user to run themselves; the app never runs it. Copying is the only action. */
function Cmd({ text }: { text: string }) {
  const { t } = useTranslation("start");
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard
      .writeText(text)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };
  return (
    <div className="cmd">
      <code>{text}</code>
      <Button size="sm" variant="ghost" onClick={copy} aria-label={t("machine.copyLabel", { command: text })}>
        <Copy size={14} strokeWidth={1.75} aria-hidden="true" />
        {copied ? t("machine.copied") : t("machine.copy")}
      </Button>
    </div>
  );
}

function GateNote({ id, gate }: { id: ToolId; gate: VersionGate }) {
  const { t } = useTranslation("start");
  if (gate.status === "ok" || !gate.update) return null;
  return (
    <>
      <p>{t(`machine.gate.${gate.status}`, { tool: t(`machine.tools.${id}`), verified: gate.verified, need: t(`machine.gate.rule.${gate.rule}`, { verified: gate.verified }) })}</p>
      <Cmd text={gate.update} />
    </>
  );
}

const MACHINE_STALE = 5 * 60_000;

/** Each tool is checked on its own, so one slow CLI never holds up the rest of the panel. */
function ToolRow({ id, env }: { id: ToolId; env: MachineEnv | undefined }) {
  const { t } = useTranslation("start");
  const q = useDaemon("machine.tool", { id }, { staleTime: MACHINE_STALE });
  const tool = q.data;
  const pending = q.isFetching || (id === "gh" && !env);
  const gate = tool?.found ? tool.gate : null;
  const gateOk = !gate || gate.status === "ok";
  let detail = t("machine.checking");
  if (q.isError) detail = t("common:errors.daemon", { message: String(q.error) });
  else if (tool && !pending) {
    if (!tool.found) detail = t("machine.notFound");
    else if (id === "gh") detail = env?.ghUser ? t("machine.ghSignedIn", { user: env.ghUser }) : t("machine.ghSignedOut");
    else detail = tool.version ? t("machine.version", { version: tool.version }) : t("machine.installed");
    if (gate && !gateOk) detail = `${detail} · ${t(`machine.gateShort.${gate.status}`)}`;
  }
  const ok = Boolean(tool?.found) && gateOk && (id !== "gh" || Boolean(env?.ghUser));
  return (
    <CheckRow state={ok ? "ok" : "warn"} pending={pending} label={t(`machine.tools.${id}`)} detail={detail} glyph={<BrandIcon id={TOOL_BRAND[id]} />}>
      {gate && !gateOk ? <GateNote id={id} gate={gate} /> : null}
    </CheckRow>
  );
}

const DEFENDER_ROW: Record<DefenderCheck["state"], RowState> = { excluded: "ok", not_excluded: "warn", unknown: "unknown", realtime_off: "neutral", unavailable: "neutral" };

/** Read-only: says whether the worktree folder is excluded and how to add it. It never adds it. */
function DefenderRow({ check, pending, error }: { check: DefenderCheck | undefined; pending: boolean; error: Error | null }) {
  const { t } = useTranslation("start");
  const glyph = <ShieldCheck className="brand" size={16} strokeWidth={1.75} aria-hidden="true" />;
  const label = t("machine.defender.label");
  if (error) return <CheckRow state="unknown" pending={false} label={label} glyph={glyph} detail={t("common:errors.daemon", { message: error.message })} />;
  const state = check?.state;
  const open = state === "not_excluded" || state === "unknown";
  const folders = check?.folders.filter((f) => f.excluded !== true) ?? [];
  return (
    <CheckRow state={state ? DEFENDER_ROW[state] : "unknown"} pending={pending || !check} label={label} glyph={glyph} detail={state ? t(`machine.defender.state.${state}`) : t("machine.checking")}>
      {open ? (
        <>
          <p>{state === "unknown" ? t("machine.defender.whyUnknown") : t("machine.defender.why")}</p>
          <ul className="sysfolders">
            {folders.map((f) => (
              <li key={f.path} className="mono">
                {f.path}
              </li>
            ))}
          </ul>
          <ol className="syssteps">
            <li>{t("machine.defender.step1")}</li>
            <li>{t("machine.defender.step2")}</li>
            <li>{t("machine.defender.step3")}</li>
          </ol>
          <p>{t("machine.defender.orAdmin")}</p>
          {folders.map((f) => (
            <Cmd key={f.path} text={`Add-MpPreference -ExclusionPath "${f.path}"`} />
          ))}
          {state === "unknown" && (
            <>
              <p>{t("machine.defender.checkAdmin")}</p>
              <Cmd text="(Get-MpPreference).ExclusionPath" />
            </>
          )}
          <p className="muted">{t("machine.defender.never")}</p>
        </>
      ) : null}
    </CheckRow>
  );
}

function MachineCheck() {
  const { t, i18n } = useTranslation("start");
  const qc = useQueryClient();
  const scanRoot = usePrefs((s) => s.scanRoot);
  const env = useDaemon("machine.env", undefined, { staleTime: MACHINE_STALE });
  const defender = useDaemon("machine.defender", { scanRoot }, { staleTime: MACHINE_STALE });
  const time = env.data ? new Intl.DateTimeFormat(i18n.language, { hour: "2-digit", minute: "2-digit" }).format(new Date(env.data.checkedAt)) : null;
  const checking = env.isFetching;
  const again = () => {
    void qc.invalidateQueries({ queryKey: ["machine.tool"] });
    void qc.invalidateQueries({ queryKey: ["machine.env"] });
    void qc.invalidateQueries({ queryKey: ["machine.defender"] });
  };

  return (
    <Panel id={MACHINE_PANEL_ID} tabIndex={-1} aria-labelledby={`${MACHINE_PANEL_ID}-title`} className="machine">
      <div className="ph">
        <h2 id={`${MACHINE_PANEL_ID}-title`}>{t("machine.title")}</h2>
        <span className="end lbl">{checking ? t("machine.checking") : time ? t("machine.checked", { time }) : ""}</span>
      </div>
      <div style={{ height: 8 }} />
      {TOOL_ORDER.map((id) => (
        <ToolRow key={id} id={id} env={env.data} />
      ))}
      {env.data?.longPathsEnabled !== null && (
        <CheckRow
          state={env.data?.longPathsEnabled ? "ok" : "warn"}
          pending={!env.data}
          label={t("machine.longPaths")}
          glyph={<FolderTree className="brand" size={16} strokeWidth={1.75} aria-hidden="true" />}
          detail={!env.data ? t("machine.checking") : env.data.longPathsEnabled ? t("machine.longOn") : t("machine.longOff")}
        />
      )}
      {defender.data?.state !== "unavailable" && <DefenderRow check={defender.data} pending={defender.isFetching} error={defender.error} />}
      <div className="panel-foot">
        <Button size="sm" variant="ghost" onClick={again} disabled={checking}>
          <RefreshCw size={14} strokeWidth={1.75} />
          {t("machine.again")}
        </Button>
      </div>
    </Panel>
  );
}

/** Branch state, running agents and open questions (PLAN.md §11.1). */
function TileState({ projectId }: { projectId: string }) {
  const { t } = useTranslation("start");
  const repo = useDaemon("github.repo", { projectId }, { staleTime: MACHINE_STALE });
  const tasks = useWork("tasks.list", { projectId });
  const requests = useWork("requests.list", { projectId });
  const parts = branchParts(repo.data);
  const activity = projectActivity(tasks.data, requests.data);
  const words = parts.map((p) => t(`tile.${p.key}`, p.params));
  return (
    <div className="tile-state">
      <span className="tile-branch" title={words.join(" · ")}>
        <GitBranch size={13} strokeWidth={1.75} aria-hidden="true" />
        <span className="tile-branch-t">
          {repo.isError
            ? t("tile.branchUnknown")
            : parts.length === 0
              ? t("tile.reading")
              : parts.map((p, i) => (
                  <span key={p.key}>
                    {i > 0 ? " · " : ""}
                    {words[i]}
                  </span>
                ))}
        </span>
      </span>
      {activity && (
        <span className="tile-activity">
          <span className={activity.running > 0 ? "st-run" : undefined}>{t("tile.running", { count: activity.running })}</span>
          <span className={activity.questions > 0 ? "st-wait" : undefined}>{t("tile.questions", { count: activity.questions })}</span>
        </span>
      )}
    </div>
  );
}

function ProjectTile({ project, index }: { project: ProjectSummary; index: number }) {
  const { t } = useTranslation("start");
  const rel = useRelativeTime();
  const openProject = useNav((s) => s.openProject);
  const qc = useQueryClient();
  const open = async () => {
    await call("projects.open", { projectId: project.id });
    void qc.invalidateQueries({ queryKey: ["projects.list"] });
    openProject(project.id);
  };
  const body = (
    <>
      <div className="tile-top">
        <Label>{String(index + 1).padStart(2, "0")}</Label>
        <svg className="tile-art" viewBox="0 0 34 34" aria-hidden="true">
          <path d="M5 9h9l2 3h13v14H5z" />
          <path d="M5 15h24" />
        </svg>
      </div>
      <div className="p-name">{project.name}</div>
      <div className="p-path" title={project.path}>
        {project.path}
      </div>
      <TileState projectId={project.id} />
      <Label>{project.lastOpenedAt ? t("recent.opened", { time: rel(project.lastOpenedAt) }) : t("recent.never")}</Label>
    </>
  );
  // Tiles become buttons once a project home screen exists to open into.
  return canOpenProjects ? (
    <button className="spec ptile" onClick={() => void open()}>
      {body}
    </button>
  ) : (
    <div className="spec ptile">{body}</div>
  );
}

function ImportPanel() {
  const { t } = useTranslation("start");
  const root = usePrefs((s) => s.scanRoot);
  const qc = useQueryClient();
  const scan = useDaemon("projects.scan", { root });
  const [busy, setBusy] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [filter, setFilter] = useState("");
  const missing = scan.data && scan.data.repos.length === 0;
  const fresh = scan.data?.repos.filter((r) => !r.known) ?? [];
  const matching = filter ? fresh.filter((r) => r.name.toLowerCase().includes(filter.toLowerCase())) : fresh;
  // A projects folder can hold dozens of repos; show a short list until asked for more.
  const visible = showAll || filter ? matching : matching.slice(0, IMPORT_PREVIEW);

  const add = async (path: string) => {
    setBusy(path);
    try {
      await call("projects.add", { path });
      await qc.invalidateQueries({ queryKey: ["projects.list"] });
      await qc.invalidateQueries({ queryKey: ["projects.scan"] });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel className="import">
      <div className="ph">
        <FolderSearch size={16} strokeWidth={1.75} />
        <h2>{t("scan.title", { root })}</h2>
        <span className="end lbl">{scan.data && !missing ? t("scan.count", { count: fresh.length }) : ""}</span>
      </div>
      <div style={{ height: 8 }} />
      {missing && (
        <div className="sysrow">
          <span />
          <span className="muted">{t("scan.missing", { root })}</span>
          <span />
        </div>
      )}
      {scan.data && !missing && fresh.length === 0 && (
        <div className="sysrow">
          <span />
          <span className="muted">{t("scan.none", { root })}</span>
          <span />
        </div>
      )}
      {fresh.length > IMPORT_PREVIEW && (
        <div className="import-filter">
          <input className="input" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t("scan.filter")} aria-label={t("scan.filter")} />
        </div>
      )}
      {visible.map((r) => (
        <div className="sysrow" key={r.path}>
          <span />
          <span>
            {r.name} <span className="muted mono path-inline">{r.path}</span>
          </span>
          <Button size="sm" onClick={() => void add(r.path)} disabled={busy !== null}>
            {busy === r.path ? t("scan.adding") : t("scan.add")}
          </Button>
        </div>
      ))}
      {!filter && matching.length > IMPORT_PREVIEW && (
        <div className="panel-foot">
          <Button size="sm" variant="ghost" onClick={() => setShowAll((v) => !v)}>
            {showAll ? t("scan.showFewer") : t("scan.showAll", { count: matching.length })}
          </Button>
        </div>
      )}
    </Panel>
  );
}

export function StartScreen() {
  const { t } = useTranslation("start");
  const qc = useQueryClient();
  const projects = useDaemon("projects.list", undefined);
  const root = usePrefs((s) => s.scanRoot);
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    void window.crewyard.appInfo().then((i) => setVersion(i.version));
  }, []);

  const openFolder = async () => {
    const path = await window.crewyard.pickFolder();
    if (!path) return;
    await call("projects.add", { path });
    await qc.invalidateQueries({ queryKey: ["projects.list"] });
    await qc.invalidateQueries({ queryKey: ["projects.scan"] });
  };

  const list = projects.data ?? [];
  return (
    <section className="screen start" aria-label={t("title")}>
      <div className="launch-grid">
        <div>
          <Label>{t("version", { version: version ?? "" })}</Label>
          <h1 className="hero">
            {t("hero1")}
            <br />
            <span className="dim">{t("hero2")}</span>
          </h1>
          <p className="sec lead">{t("lead")}</p>
          <div className="launch-actions">
            <Button variant="primary" onClick={() => openSetup("local")}>
              <Plus size={14} strokeWidth={1.75} />
              {t("setup:newProject")}
            </Button>
            <Button onClick={() => void openFolder()}>
              <FolderOpen size={14} strokeWidth={1.75} />
              {t("openFolder")}
            </Button>
            <Button onClick={() => openSetup("clone")}>
              <GitPullRequest size={14} strokeWidth={1.75} />
              {t("setup:source.clone")}
            </Button>
          </div>
          <Checklist />
          <MachineCheck />
        </div>
        <div>
          <div className="launch-head">
            <span className="lbl strong">{t("recent.title")}</span>
          </div>
          {list.length > 0 ? (
            <div className="recent-grid">
              {list.slice(0, 6).map((p, i) => (
                <ProjectTile key={p.id} project={p} index={i} />
              ))}
            </div>
          ) : (
            <p className="muted empty">{projects.isSuccess ? t("recent.empty", { root }) : ""}</p>
          )}
          <ImportPanel />
        </div>
      </div>
    </section>
  );
}
