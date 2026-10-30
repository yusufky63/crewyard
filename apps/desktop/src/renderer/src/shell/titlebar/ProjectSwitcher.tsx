import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, FolderOpen, Folder, House, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ContextMenu, MENU_SEPARATOR, type ContextMenuEntry } from "@crewyard/ui";
import { useDaemon } from "../../ipc.ts";
import { useNav } from "../../nav.ts";
import { openSetup } from "../../screens/setup/draft.ts";
import { openFolder, openProjectById } from "./actions.ts";

const RECENT = 8;

/** Recent projects, the Start screen and Open folder (DESIGN.md §4). */
export function ProjectSwitcher() {
  const { t } = useTranslation("titlebar");
  const qc = useQueryClient();
  const { projectId, closeProject } = useNav();
  const projects = useDaemon("projects.list", undefined);
  const list = projects.data ?? [];
  const current = list.find((p) => p.id === projectId);
  const button = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  // The menu closes itself on any outside press, the trigger included; this stops that same
  // press from opening it again.
  const wasOpen = useRef(false);

  const toggle = () => {
    if (wasOpen.current) {
      wasOpen.current = false;
      return;
    }
    const r = button.current?.getBoundingClientRect();
    if (r) setAt({ x: r.left, y: r.bottom + 4 });
  };

  const icon = (Icon: typeof Folder) => <Icon size={14} strokeWidth={1.75} />;
  const items: ContextMenuEntry[] = [
    ...list.slice(0, RECENT).map((p) => ({ id: `p:${p.id}`, label: p.name, icon: p.id === projectId ? icon(Check) : icon(Folder) })),
    ...(list.length > 0 ? [MENU_SEPARATOR] : []),
    { id: "start", label: t("switcher.start"), icon: icon(House) },
    { id: "open", label: t("switcher.openFolder"), icon: icon(FolderOpen) },
    { id: "new", label: t("switcher.newProject"), icon: icon(Plus) },
  ];

  const onSelect = (id: string) => {
    if (id === "start") closeProject();
    else if (id === "open") void openFolder(qc);
    else if (id === "new") openSetup("local");
    else if (id.startsWith("p:")) void openProjectById(qc, id.slice(2));
  };

  return (
    <>
      <button
        ref={button}
        className="tb-chip"
        aria-haspopup="menu"
        aria-expanded={at !== null}
        title={current?.path}
        aria-label={t("switcher.labelWith", { name: current?.name ?? t("switcher.noProject") })}
        onPointerDown={() => (wasOpen.current = at !== null)}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            toggle();
          }
        }}
      >
        <FolderOpen size={15} strokeWidth={1.75} aria-hidden="true" />
        <span className="tb-chip-name">{current?.name ?? t("switcher.noProject")}</span>
        <ChevronDown size={13} strokeWidth={1.75} aria-hidden="true" />
      </button>
      {at && (
        <ContextMenu
          x={at.x}
          y={at.y}
          label={t("switcher.label")}
          heading={list.length > 0 ? t("switcher.recent") : undefined}
          items={items}
          onSelect={onSelect}
          onClose={() => setAt(null)}
        />
      )}
    </>
  );
}
