import { call } from "../../ipc.ts";
import { usePrefs, type DrawerTab } from "../../prefs.ts";
import { FIXTURE } from "../../screens/tasks/fixture.ts";
import { focusOnOpen, focusToggle } from "./focus.ts";

// Opening the bottom panel on a tab, from its shortcuts, the status bar and the Tasks screen's
// Assistant button. Hiding the panel stops nothing; only the assistant's own close stops it
// (docs/adr/0014, DESIGN.md §7).

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

/** Opens the panel on `tab` and moves focus into it. */
export function openPanel(tab: DrawerTab): void {
  focusOnOpen();
  wantAssistantInput = tab === "assistant";
  usePrefs.getState().openDrawerTab(tab);
}

/** The panel is open and showing `tab`. */
export function panelShows(tab: DrawerTab): boolean {
  const s = usePrefs.getState();
  return s.drawerOpen && s.drawerTab === tab;
}

/** A tab's shortcut: opens the panel on it, or hides the panel when it already shows it. */
export function togglePanelTab(tab: DrawerTab): void {
  if (!panelShows(tab)) return openPanel(tab);
  focusToggle();
  usePrefs.getState().setDrawerOpen(false);
}

/** The assistant's session stops; its conversation and drafts stay for next time. */
export function stopAssistant(projectId: string): void {
  if (!FIXTURE) void call("assistant.stop", { projectId }).catch(() => undefined);
}

/**
 * "Stop and close": stops the assistant and hides the panel. Focus goes back to the Tasks screen's
 * Assistant button when it is there, else to the panel's toggle.
 */
export function closeAssistant(projectId: string): void {
  stopAssistant(projectId);
  hideAfterAssistant();
}

/** The panel side of "Stop and close", once the assistant itself was asked to stop. */
export function hideAfterAssistant(): void {
  usePrefs.getState().setDrawerOpen(false);
  requestAnimationFrame(() => {
    const opener = document.getElementById("tk-assistant-toggle");
    if (opener) opener.focus({ preventScroll: true });
    else focusToggle();
  });
}

/** Ctrl Shift A and the Tasks screen's button: open on the assistant, or stop it and close. */
export function toggleAssistant(projectId: string): void {
  if (panelShows("assistant")) closeAssistant(projectId);
  else openPanel("assistant");
}
