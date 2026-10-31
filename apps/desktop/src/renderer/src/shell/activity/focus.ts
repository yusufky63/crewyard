import { DRAWER_ID } from "../layout.ts";

// Where focus goes when the panel expands or collapses from the keyboard: into its active tab when a
// shortcut expanded it, back to the panel's own collapse toggle when it collapses (the control that
// was focused in its body no longer exists, while the head strip with the toggle stays).

/** id of the status bar button that expands and collapses the panel. */
export const DRAWER_TOGGLE_ID = "activity-toggle";

/** id of the collapse toggle at the right end of the panel's head, the one that stays in the strip. */
export const PANEL_TOGGLE_ID = "drawer-toggle";

let wantFocus = false;

/** The next time the panel expands (or changes tab from a shortcut), its active tab takes focus. */
export function focusOnOpen(): void {
  wantFocus = true;
}

/**
 * Called by the panel in a layout effect once it is expanded, so a view that focuses something of
 * its own as it mounts (the assistant's message box, in a passive effect) still wins.
 */
export function takeFocus(root: HTMLElement | null): void {
  if (!root || !wantFocus) return;
  wantFocus = false;
  root.querySelector<HTMLElement>("[data-drawer-tab=active]")?.focus();
}

/** Moves focus to the panel's toggle only when it was inside the panel, never away from elsewhere. */
export function focusToggle(): void {
  const active = document.activeElement;
  if (active && active !== document.body && !active.closest(`#${DRAWER_ID}`)) return;
  requestAnimationFrame(() => document.getElementById(PANEL_TOGGLE_ID)?.focus());
}
