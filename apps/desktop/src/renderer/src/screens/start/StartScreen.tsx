import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, FolderOpen, FolderSearch, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button, Label, Panel } from "@crewyard/ui";
import type { MachineEnv, ProjectSummary, ToolId } from "@crewyard/core";
import { call, useDaemon } from "../../ipc.ts";
import { canOpenProjects, useNav } from "../../nav.ts";
import { usePrefs } from "../../prefs.ts";
import "./start.css";

const TOOL_ORDER: ToolId[] = ["claude", "codex", "opencode", "gemini", "git", "gh"];
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

function CheckRow({ ok, pending, label, detail }: { ok: boolean; pending: boolean; label: string; detail: string }) {
  return (
    <div className="sysrow">
      <span className={pending ? "st st-run" : ok ? "st st-ok" : "st st-wait"}>
        {pending ? <span className="spin" /> : ok ? <Check size={16} strokeWidth={1.75} /> : <AlertTriangle size={16} strokeWidth={1.75} />}
      </span>
      <span>{label}</span>
      <span className="muted">{detail}</span>
    </div>
  );
}

const MACHINE_STALE = 5 * 60_000;

/** Each tool is checked on its own, so one slow CLI never holds up the rest of the panel. */
function ToolRow({ id, env }: { id: ToolId; env: MachineEnv | undefined }) {
  const { t } = useTranslation("start");
  const q = useDaemon("machine.tool", { id }, { staleTime: MACHINE_STALE });
  const tool = q.data;
  const pending = q.isFetching || (id === "gh" && !env);
  let detail = t("machine.checking");
  if (q.isError) detail = t("common:errors.daemon", { message: String(q.error) });
  else if (tool && !pending) {
    if (!tool.found) detail = t("machine.notFound");
    else if (id === "gh") detail = env?.ghUser ? t("machine.ghSignedIn", { user: env.ghUser }) : t("machine.ghSignedOut");
    else detail = tool.version ? t("machine.version", { version: tool.version }) : t("machine.installed");
  }
  const ok = Boolean(tool?.found) && (id !== "gh" || Boolean(env?.ghUser));
  return <CheckRow ok={ok} pending={pending} label={t(`machine.tools.${id}`)} detail={detail} />;
}

function MachineCheck() {
  const { t, i18n } = useTranslation("start");
  const qc = useQueryClient();
  const env = useDaemon("machine.env", undefined, { staleTime: MACHINE_STALE });
  const time = env.data ? new Intl.DateTimeFormat(i18n.language, { hour: "2-digit", minute: "2-digit" }).format(new Date(env.data.checkedAt)) : null;
  const checking = env.isFetching;
  const again = () => {
    void qc.invalidateQueries({ queryKey: ["machine.tool"] });
    void qc.invalidateQueries({ queryKey: ["machine.env"] });
  };

  return (
    <Panel>
      <div className="ph">
        <h2>{t("machine.title")}</h2>
        <span className="end lbl">{checking ? t("machine.checking") : time ? t("machine.checked", { time }) : ""}</span>
      </div>
      <div style={{ height: 8 }} />
      {TOOL_ORDER.map((id) => (
        <ToolRow key={id} id={id} env={env.data} />
      ))}
      {env.data?.longPathsEnabled !== null && (
        <CheckRow
          ok={Boolean(env.data?.longPathsEnabled)}
          pending={!env.data}
          label={t("machine.longPaths")}
          detail={!env.data ? t("machine.checking") : env.data.longPathsEnabled ? t("machine.longOn") : t("machine.longOff")}
        />
      )}
      <div className="panel-foot">
        <Button size="sm" variant="ghost" onClick={again} disabled={checking}>
          <RefreshCw size={14} strokeWidth={1.75} />
          {t("machine.again")}
        </Button>
      </div>
    </Panel>
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
      <div className="p-path" title={project.path}>{project.path}</div>
      <Label>{project.lastOpenedAt ? t("recent.opened", { time: rel(project.lastOpenedAt) }) : t("recent.never")}</Label>
    </>
  );
  // Tiles become buttons once a project home screen exists to open into.
  return canOpenProjects ? (
    <button className="spec ptile" onClick={() => void open()}>{body}</button>
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
      {missing && <div className="sysrow"><span /><span className="muted">{t("scan.missing", { root })}</span><span /></div>}
      {scan.data && !missing && fresh.length === 0 && <div className="sysrow"><span /><span className="muted">{t("scan.none", { root })}</span><span /></div>}
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
            <Button variant="primary" onClick={() => void openFolder()}>
              <FolderOpen size={14} strokeWidth={1.75} />
              {t("openFolder")}
            </Button>
          </div>
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
