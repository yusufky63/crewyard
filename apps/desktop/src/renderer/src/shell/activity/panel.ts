import { call } from "../../ipc.ts";
import { usePrefs, type DrawerTab } from "../../prefs.ts";
import { FIXTURE } from "../../screens/tasks/fixture.ts";
import { focusOnOpen, focusToggle } from "./focus.ts";

// Expanding and collapsing the bottom panel, from its toggle, its shortcuts, the status bar and the
// Tasks screen's Assistant button. Inside a project the panel never closes: collapsed it is its head
// strip. Collapsing stops nothing, the assistant included; only an explicit stop (the assistant's
// own `Stop and close`) stops it (owner, 2026-10-31; DESIGN.md §4, §7).

let wantAssistantInput = false;

/**
 * Asked once by the docked assistant as it mounts: true when its shortcut or button opened it, so
 * its message box takes focus; moving through the tabs with the arrows leaves focus on the tab.
 */
export function takeAssistantFocus(): boolean {
  const want = wantAssistantInput;
  wantAssistantInput = false;
  return want;
}

/** Expands the panel on `tab` and moves focus into it. */
export function openPanel(tab: DrawerTab): void {
  focusOnOpen();
  wantAssistantInput = tab === "assistant";
  usePrefs.getState().openDrawerTab(tab);
}

/** Collapses the panel to its head strip; focus inside it goes to the strip's toggle. */
export function collapsePanel(): void {
  focusToggle();
  usePrefs.getState().setDrawerOpen(false);
}

/** Ctrl J and the toggles: expand (focus into the tab list) or collapse (focus back to the toggle). */
export function togglePanel(): void {
  if (usePrefs.getState().drawerOpen) return collapsePanel();
  focusOnOpen();
  usePrefs.getState().setDrawerOpen(true);
}

/** The panel is expanded and showing `tab`. */
export function panelShows(tab: DrawerTab): boolean {
  const s = usePrefs.getState();
  return s.drawerOpen && s.drawerTab === tab;
}

/**
 * The panel toggles' tooltip. On the Assistant tab it leaves out Esc and "nothing stops": Esc inside
 * the assistant is its own explicit stop, so only Ctrl J is a collapse that is sure to stop nothing.
 */
export function toggleTitleKey(open: boolean, tab: DrawerTab): "toggle.expand" | "toggle.collapse" | "toggle.collapseAssistant" {
  if (!open) return "toggle.expand";
  return tab === "assistant" ? "toggle.collapseAssistant" : "toggle.collapse";
}

/** A tab's shortcut: expands the panel on it, or collapses the panel when it already shows it. */
export function togglePanelTab(tab: DrawerTab): void {
  if (!panelShows(tab)) return openPanel(tab);
  collapsePanel();
}

/** The assistant's session stops; its conversation and drafts stay for next time. */
export function stopAssistant(projectId: string): void {
  if (!FIXTURE) void call("assistant.stop", { projectId }).catch(() => undefined);
}

/**
 * An explicit "Stop and close": stops the assistant and collapses the panel. Focus goes back to the
 * Tasks screen's Assistant button when it is there, else to the panel's toggle.
 */
export function closeAssistant(projectId: string): void {
  stopAssistant(projectId);
  hideAfterAssistant();
}

/**
 * The panel side of the assistant's own "Stop and close" (and Esc inside it), once the assistant
 * itself was asked to stop: the panel collapses to its strip. Focus moves to the opener even from
 * elsewhere, because the control that was pressed is gone with the panel's body.
 */
export function hideAfterAssistant(): void {
  usePrefs.getState().setDrawerOpen(false);
  requestAnimationFrame(() => {
    const opener = document.getElementById("tk-assistant-toggle");
    if (opener) opener.focus({ preventScroll: true });
    else focusToggle();
  });
}

/**
 * Ctrl Shift A and the Tasks screen's button: expand on the assistant, or collapse the panel while
 * the assistant keeps running (it stops only on its own `Stop and close`, or when it sits idle).
 */
export function toggleAssistant(_projectId: string): void {
  // A plain collapse: focus moves only when it was inside the panel, so the shortcut never pulls it
  // away from what you were typing elsewhere.
  if (panelShows("assistant")) collapsePanel();
  else openPanel("assistant");
}
