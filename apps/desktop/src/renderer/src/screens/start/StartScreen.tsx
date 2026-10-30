import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { FolderOpen, FolderSearch, GitBranch, GitPullRequest, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button, Label, Panel } from "@crewyard/ui";
import type { ProjectSummary } from "@crewyard/core";
import { call, useDaemon } from "../../ipc.ts";
import { canOpenProjects, useNav } from "../../nav.ts";
import { usePrefs } from "../../prefs.ts";
import { openSetup } from "../setup/draft.ts";
import { useWork } from "../tasks/data.ts";
import { Checklist } from "./Checklist.tsx";
import { MachineCheck } from "./Machine.tsx";
import { branchParts, projectActivity } from "./tile.ts";
import "./start.css";

const IMPORT_PREVIEW = 8;
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
      {/* Areas: intro and recent projects first, then This machine across the full width so its
          state shows without scrolling at 1280 × 800, then Getting started and the import list. */}
      <div className="launch-grid">
        <div className="launch-intro">
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
        </div>
        <div className="launch-recent">
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
        </div>
        <div className="launch-machine">
          <MachineCheck />
        </div>
        <div className="launch-checklist">
          <Checklist />
        </div>
        <div className="launch-import">
          <ImportPanel />
        </div>
      </div>
    </section>
  );
}
