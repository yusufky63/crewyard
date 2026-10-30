import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Folder, FolderInput, FolderOpen, FolderSearch, GitBranch, GitPullRequest, History, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button, Label, Panel } from "@crewyard/ui";
import type { ProjectSummary } from "@crewyard/core";
import { call, useDaemon } from "../../ipc.ts";
import { canOpenProjects, useNav } from "../../nav.ts";
import { usePrefs } from "../../prefs.ts";
import { folderDropProps, useFolderOpen } from "../../shell/openFolder.ts";
import { openSetup } from "../setup/draft.ts";
import { useWork } from "../tasks/data.ts";
import { Checklist } from "./Checklist.tsx";
import { MachineCheck } from "./Machine.tsx";
import { branchParts, projectActivity } from "./tile.ts";
import "./start.css";

const IMPORT_PREVIEW = 8;
/** Projects listed under Recently used, after the last one. */
const RECENT_MORE = 8;
const REPO_STALE = 5 * 60_000;

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

/** Branch state, running agents and open questions (PLAN.md §11.1). */
function TileState({ projectId }: { projectId: string }) {
  const { t } = useTranslation("start");
  const repo = useDaemon("github.repo", { projectId }, { staleTime: REPO_STALE });
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

/** Opening a project marks it opened, so it moves to the top of Last project and Recently used. */
function useOpenProject() {
  const openProject = useNav((s) => s.openProject);
  const qc = useQueryClient();
  return async (projectId: string) => {
    await call("projects.open", { projectId });
    void qc.invalidateQueries({ queryKey: ["projects.list"] });
    openProject(projectId);
  };
}

function ProjectTile({ project }: { project: ProjectSummary }) {
  const { t } = useTranslation("start");
  const rel = useRelativeTime();
  const openProject = useOpenProject();
  const open = () => openProject(project.id);
  // The last project only, wide and short: the folder mark on the left, three lines beside it.
  const body = (
    <>
      <div className="tile-side">
        <svg className="tile-art" viewBox="0 0 34 34" aria-hidden="true">
          <path d="M5 9h9l2 3h13v14H5z" />
          <path d="M5 15h24" />
        </svg>
      </div>
      <div className="tile-main">
        <div className="tile-head">
          <span className="p-name">{project.name}</span>
          <Label>{project.lastOpenedAt ? t("recent.opened", { time: rel(project.lastOpenedAt) }) : t("recent.never")}</Label>
        </div>
        <div className="p-path" title={project.path}>
          {project.path}
        </div>
        <TileState projectId={project.id} />
      </div>
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

/** The projects opened before the last one, newest first, one line each; empty with none. */
function RecentList({ projects }: { projects: ProjectSummary[] }) {
  const { t } = useTranslation("start");
  const rel = useRelativeTime();
  const openProject = useOpenProject();
  if (projects.length === 0) return null;
  return (
    <Panel className="recent-list">
      <div className="ph">
        <History size={16} strokeWidth={1.75} />
        <h2>{t("recent.othersTitle")}</h2>
        <span className="end lbl">{t("recent.othersCount", { count: projects.length })}</span>
      </div>
      <div style={{ height: 8 }} />
      {projects.map((p) => {
        const when = p.lastOpenedAt ? t("recent.opened", { time: rel(p.lastOpenedAt) }) : t("recent.never");
        const text = (
          <>
            <Folder size={14} strokeWidth={1.75} aria-hidden="true" />
            <span className="recent-name">
              {p.name} <span className="muted mono path-inline">{p.path}</span>
            </span>
            <Label>{when}</Label>
          </>
        );
        return canOpenProjects ? (
          <button type="button" className="sysrow recent-row" key={p.id} title={p.path} onClick={() => void openProject(p.id)}>
            {text}
          </button>
        ) : (
          <div className="sysrow recent-row" key={p.id} title={p.path}>
            {text}
          </div>
        );
      })}
    </Panel>
  );
}

function ImportPanel() {
  const { t } = useTranslation("start");
  const rel = useRelativeTime();
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
            {r.usedAt && <span className="muted used-inline">{t("scan.used", { time: rel(r.usedAt) })}</span>}
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

/** Why the last folder from Explorer, the command line or a drop could not be opened. */
function RefusedFolder() {
  const { t } = useTranslation("start");
  const refused = useFolderOpen((s) => s.refused);
  const dismiss = useFolderOpen((s) => s.dismiss);
  if (!refused?.problem) return null;
  return (
    <div className="banner banner-warn start-refused" role="alert">
      <span className="refused-text">
        <strong>{t("drop.refusedTitle")}</strong> {t(`drop.problem.${refused.problem}`, { path: refused.path })}
      </span>
      <Button size="sm" variant="ghost" onClick={dismiss}>
        {t("drop.dismiss")}
      </Button>
    </div>
  );
}

/** Shown while files are dragged over the window; the whole screen takes the drop. */
function DropZone() {
  const { t } = useTranslation("start");
  const dragging = useFolderOpen((s) => s.dragging);
  if (!dragging) return null;
  return (
    <div className="drop-zone" aria-hidden="true">
      <div className="spec drop-frame">
        <FolderInput size={28} strokeWidth={1.5} />
        <span className="drop-title">{t("drop.title")}</span>
        <span className="sec drop-body">{t("drop.body")}</span>
      </div>
    </div>
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
    // A folder dropped anywhere on the screen opens it (PLAN.md §12); main checks the path first.
    <section className="screen start" aria-label={t("title")} {...folderDropProps}>
      <DropZone />
      <RefusedFolder />
      {/* Areas: the intro and the last project across the full width; then Recently used and Getting
          started on the left and the import list on the right; This machine last, across the full
          width. The blocks are in that order here too, so Tab follows what you see. */}
      <div className="launch-grid">
        <div className="launch-intro">
          <div className="launch-copy">
            <Label>{t("version", { version: version ?? "" })}</Label>
            <h1 className="hero">
              {t("hero1")} <span className="dim">{t("hero2")}</span>
            </h1>
            <p className="sec lead">{t("lead")}</p>
          </div>
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
        </div>
        <div className="launch-recent">
          <div className="launch-head">
            <span className="lbl strong">{t("recent.lastTitle")}</span>
          </div>
          {list[0] ? (
            <ProjectTile project={list[0]} />
          ) : (
            <p className="muted empty">{projects.isSuccess ? t("recent.empty", { root }) : ""}</p>
          )}
        </div>
        <div className="launch-others">
          <RecentList projects={list.slice(1, 1 + RECENT_MORE)} />
        </div>
        <div className="launch-checklist">
          <Checklist />
        </div>
        <div className="launch-import">
          <ImportPanel />
        </div>
        <div className="launch-machine">
          <MachineCheck />
        </div>
      </div>
    </section>
  );
}
