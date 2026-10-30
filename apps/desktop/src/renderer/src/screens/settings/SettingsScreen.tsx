import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Bell, FolderOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@crewyard/ui";
import type { AppSettings, SettingsPatch } from "@crewyard/core";
import { call, useDaemon } from "../../ipc.ts";
import { useNav } from "../../nav.ts";
import { usePrefs, type Density, type ThemePref } from "../../prefs.ts";
import { AboutSection, DataSection } from "./DataSection.tsx";
import { HibernationRows } from "./Hibernation.tsx";
import { KeepAwakeRows } from "./KeepAwake.tsx";
import { backTarget, SECTIONS, useSettingsNav, type SectionId } from "./model.ts";
import { Row, Section, Seg, Toggle } from "./parts.tsx";
import { StallRules } from "./StallRules.tsx";
import "../providers/providers.css";
import "./settings.css";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function General() {
  const { t } = useTranslation("settings");
  const { theme, density, language, setTheme, setDensity, setLanguage } = usePrefs();
  return (
    <Section id="general" index={1} title={t("sections.general")}>
      <Row label={t("general.language")} hint={t("general.languageHint")}>
        <Seg
          label={t("general.language")}
          value={language ?? "system"}
          options={[
            { value: "system", label: t("general.system") },
            { value: "en", label: t("common:status.language.en"), lang: "en" },
            { value: "tr", label: t("common:status.language.tr"), lang: "tr" },
          ]}
          onChange={(v) => setLanguage(v === "system" ? null : v)}
        />
      </Row>
      <Row label={t("general.theme")} hint={t("general.themeHint")}>
        <Seg<ThemePref>
          label={t("general.theme")}
          value={theme}
          options={[
            { value: "system", label: t("general.system") },
            { value: "dark", label: t("general.dark") },
            { value: "light", label: t("general.light") },
          ]}
          onChange={setTheme}
        />
      </Row>
      <Row label={t("general.density")} hint={t("general.densityHint")}>
        <Seg<Density>
          label={t("general.density")}
          value={density}
          options={[
            { value: "comfortable", label: t("general.comfortable") },
            { value: "compact", label: t("general.compact") },
          ]}
          onChange={setDensity}
        />
      </Row>
      <p className="st-note">{t("general.scope")}</p>
    </Section>
  );
}

function Projects() {
  const { t } = useTranslation("settings");
  const { scanRoot, setScanRoot } = usePrefs();
  const projects = useDaemon("projects.list", undefined);
  const change = async () => {
    const picked = await window.crewyard.pickFolder();
    if (picked) setScanRoot(picked);
  };
  return (
    <Section id="projects" index={2} title={t("sections.projects")}>
      <Row label={t("projects.root")} hint={t("projects.rootHint")}>
        <span className="st-path mono as-typed" title={scanRoot}>
          {scanRoot}
        </span>
        <Button size="sm" onClick={() => void change()}>
          <FolderOpen strokeWidth={1.75} />
          {t("projects.change")}
        </Button>
      </Row>
      {projects.data && <p className="st-note">{t("projects.added", { count: projects.data.length })}</p>}
    </Section>
  );
}

/** Keeps the cached settings in step with saves from here and `settings.changed` from the daemon. */
function useAppSettings() {
  const qc = useQueryClient();
  const query = useDaemon("settings.get", undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => window.crewyard.on("settings.changed", (p) => qc.setQueryData(["settings.get", undefined], p as AppSettings)), [qc]);
  const save = (patch: SettingsPatch) => {
    setError(null);
    call("settings.update", patch)
      .then((next) => qc.setQueryData(["settings.get", undefined], next))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };
  return { settings: query.data, save, error };
}

function TimeField({ label, value, onCommit, disabled }: { label: string; value: string; onCommit: (v: string) => void; disabled: boolean }) {
  // Keyed by the saved value, so a save elsewhere resets the draft.
  const [draft, setDraft] = useState(value);
  return (
    <label className="st-time">
      <span className="lbl">{label}</span>
      <input
        type="time"
        className="pv-input mono"
        value={draft}
        disabled={disabled}
        onChange={(e) => {
          setDraft(e.target.value);
          if (HHMM.test(e.target.value) && e.target.value !== value) onCommit(e.target.value);
        }}
      />
    </label>
  );
}

function Notifications({ supported }: { supported: boolean }) {
  const { t } = useTranslation("settings");
  const { settings, save, error } = useAppSettings();
  const projects = useDaemon("projects.list", undefined);
  if (!settings) return <Section id="notifications" index={3} title={t("sections.notifications")}>{null}</Section>;
  const n = settings.notifications;
  const q = n.quietHours;
  const muted = new Set(n.mutedProjects);
  return (
    <Section id="notifications" index={3} title={t("sections.notifications")}>
      <Row label={t("notifications.enabled")} hint={t("notifications.enabledHint")}>
        <Toggle label={t("notifications.enabled")} value={n.enabled} onChange={(v) => save({ notifications: { enabled: v } })} />
      </Row>
      <Row label={t("notifications.quiet")} hint={q.enabled && q.start === q.end ? <span className="st-warn">{t("notifications.quietEmpty")}</span> : t("notifications.quietHint")}>
        <TimeField key={`s${q.start}`} label={t("notifications.from")} value={q.start} disabled={!q.enabled} onCommit={(v) => save({ notifications: { quietHours: { start: v } } })} />
        <TimeField key={`e${q.end}`} label={t("notifications.to")} value={q.end} disabled={!q.enabled} onCommit={(v) => save({ notifications: { quietHours: { end: v } } })} />
        <Toggle label={t("notifications.quiet")} value={q.enabled} onChange={(v) => save({ notifications: { quietHours: { enabled: v } } })} />
      </Row>
      <Row label={t("notifications.approve")} hint={t("notifications.approveHint")}>
        <Toggle label={t("notifications.approve")} value={n.approveFromToast} disabled={!n.enabled} onChange={(v) => save({ notifications: { approveFromToast: v } })} />
      </Row>
      <Row label={t("notifications.limit")} hint={t("notifications.limitHint")}>
        <Toggle label={t("notifications.limit")} value={n.limitActions} disabled={!n.enabled} onChange={(v) => save({ notifications: { limitActions: v } })} />
      </Row>
      <Row label={t("notifications.muted")} hint={t("notifications.mutedHint")} />
      <div className="st-list" role="list">
        {projects.data?.length === 0 && <p className="st-note">{t("notifications.noProjects")}</p>}
        {projects.data?.map((p) => (
          <div className="st-item" role="listitem" key={p.id}>
            <span className="st-item-name">{p.name}</span>
            <span className="st-item-path mono as-typed muted" title={p.path}>
              {p.path}
            </span>
            <Seg
              label={t("notifications.muted") + " · " + p.name}
              value={muted.has(p.id) ? "mute" : "notify"}
              options={[
                { value: "notify", label: t("notifications.notify") },
                { value: "mute", label: t("notifications.mute") },
              ]}
              onChange={(v) => save({ notifications: { mutedProjects: v === "mute" ? [...muted, p.id] : [...muted].filter((id) => id !== p.id) } })}
            />
          </div>
        ))}
      </div>
      <Row label={t("notifications.testLabel")} hint={supported ? t("notifications.testHint") : t("notifications.unsupported")}>
        <Button size="sm" disabled={!supported} onClick={() => window.crewyard.testToast()}>
          <Bell strokeWidth={1.75} />
          {t("notifications.test")}
        </Button>
      </Row>
      <StallRules stalls={settings.stalls} save={save} />
      {error && <p className="pv-error st-note">{t("saveFailed", { error })}</p>}
    </Section>
  );
}

function Startup() {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  const app = useAppSettings();
  const state = useQuery({ queryKey: ["app.startup"], queryFn: () => window.crewyard.startup() });
  const info = useQuery({ queryKey: ["app.info"], queryFn: () => window.crewyard.appInfo(), staleTime: Infinity });
  const s = state.data;
  const write = (next: { openAtLogin: boolean; hidden: boolean }) => void window.crewyard.setStartup(next).then((r) => qc.setQueryData(["app.startup"], r));
  const off = !s?.supported;
  return (
    <Section id="startup" index={4} title={t("sections.startup")}>
      <Row label={t("startup.login")} hint={off ? t("startup.unsupported") : t("startup.loginHint")}>
        <Toggle label={t("startup.login")} value={s?.openAtLogin ?? false} disabled={off} onChange={(v) => write({ openAtLogin: v, hidden: s?.hidden ?? true })} />
      </Row>
      <Row label={t("startup.hidden")} hint={t("startup.hiddenHint")}>
        <Toggle label={t("startup.hidden")} value={s?.hidden ?? false} disabled={off || !s?.openAtLogin} onChange={(v) => write({ openAtLogin: true, hidden: v })} />
      </Row>
      {s?.supported && s.development && info.data && <p className="st-note mono as-typed">{t("startup.dev", { path: info.data.exePath })}</p>}
      <Row label={t("startup.close")} hint={t("startup.closeHint")} />
      {app.settings && <KeepAwakeRows settings={app.settings} save={app.save} />}
      {app.settings && <HibernationRows key={app.settings.hibernation.idleMinutes} settings={app.settings} save={app.save} />}
      {app.error && <p className="pv-error st-note">{t("saveFailed", { error: app.error })}</p>}
    </Section>
  );
}

/** Highlights the section in view in the index on the left. */
function useCurrentSection(): SectionId {
  const [current, setCurrent] = useState<SectionId>("general");
  useEffect(() => {
    const seen = new Map<string, boolean>();
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => seen.set(e.target.id.replace("settings-", ""), e.isIntersecting));
        const first = SECTIONS.find((id) => seen.get(id));
        if (first) setCurrent(first);
      },
      { rootMargin: "0px 0px -55% 0px" },
    );
    SECTIONS.forEach((id) => {
      const el = document.getElementById(`settings-${id}`);
      if (el) io.observe(el);
    });
    return () => io.disconnect();
  }, []);
  return current;
}

export function SettingsScreen() {
  const { t } = useTranslation("settings");
  const { projectId, go } = useNav();
  const { from, section, clearSection } = useSettingsNav();
  const startup = useQuery({ queryKey: ["app.startup"], queryFn: () => window.crewyard.startup() });
  const info = useQuery({ queryKey: ["app.info"], queryFn: () => window.crewyard.appInfo(), staleTime: Infinity });
  const current = useCurrentSection();
  const jump = (id: SectionId) => document.getElementById(`settings-${id}`)?.scrollIntoView({ block: "start" });

  useEffect(() => {
    // ?section= comes only from screenshot runs (CREWYARD_SHOT_QUERY), to capture lower sections.
    const wanted = section ?? (new URLSearchParams(window.location.search).get("section") as SectionId | null);
    if (!wanted || !SECTIONS.includes(wanted)) return;
    jump(wanted);
    clearSection();
    // Sections above grow once their data arrives; land on the section again after that.
    const again = setTimeout(() => jump(wanted), 700);
    return () => clearTimeout(again);
  }, [section, clearSection]);

  return (
    <div className="screen settings">
      <div className="page-head">
        <div>
          <h1>{t("title")}</h1>
          {info.data && (
            <p className="st-context mono as-typed muted" title={info.data.userData}>
              {t("context", { path: info.data.userData })}
            </p>
          )}
        </div>
        <div className="right">
          <Button variant="ghost" size="sm" onClick={() => go(backTarget(from, projectId))}>
            <ArrowLeft strokeWidth={1.75} />
            {t("back")}
          </Button>
        </div>
      </div>
      <div className="st-layout">
        <nav className="st-index frame" aria-label={t("sectionsLabel")}>
          {SECTIONS.map((id, i) => (
            <button key={id} type="button" className="st-index-item" aria-current={current === id ? "true" : undefined} onClick={() => jump(id)}>
              <span className="lbl">{String(i + 1).padStart(2, "0")}</span>
              {t(`sections.${id}`)}
            </button>
          ))}
        </nav>
        <div className="st-sections">
          <General />
          <Projects />
          <Notifications supported={startup.data?.supported ?? false} />
          <Startup />
          <DataSection />
          <AboutSection />
        </div>
      </div>
    </div>
  );
}
