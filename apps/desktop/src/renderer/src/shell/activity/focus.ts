import { DRAWER_ID } from "../layout.ts";

// Where focus goes when the drawer opens or closes from the keyboard: into its active tab when the
// shortcut opened it, back to the status bar toggle when it closes (the control that was focused
// inside it no longer exists).

/** id of the status bar button that opens and closes the drawer. */
export const DRAWER_TOGGLE_ID = "activity-toggle";

let wantFocus = false;

/** The next time the drawer mounts, its active tab takes focus. */
export function focusOnOpen(): void {
  wantFocus = true;
}

/** Ref callback on the drawer's root. */
export function takeFocus(el: HTMLElement | null): void {
  if (!el || !wantFocus) return;
  wantFocus = false;
  el.querySelector<HTMLElement>("[data-drawer-tab=active]")?.focus();
}

/** Moves focus to the toggle only when it was inside the closing drawer, never away from elsewhere. */
export function focusToggle(): void {
  const active = document.activeElement;
  if (active && active !== document.body && !active.closest(`#${DRAWER_ID}`)) return;
  requestAnimationFrame(() => document.getElementById(DRAWER_TOGGLE_ID)?.focus());
}
