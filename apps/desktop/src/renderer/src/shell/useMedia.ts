import { useSyncExternalStore } from "react";
import { RAIL_BELOW } from "./layout.ts";

/** True while the media query matches; follows window resizes. */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const m = window.matchMedia(query);
      m.addEventListener("change", onChange);
      return () => m.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
  );
}

/** Below 1180 px the sidebar is always the icon rail (DESIGN.md §4), whatever the user chose. */
export const useNarrow = (): boolean => useMedia(`(max-width: ${RAIL_BELOW}px)`);

/** The window's inner width, for limits that depend on it. */
export function useViewportWidth(): number {
  return useSyncExternalStore(
    (onChange) => {
      window.addEventListener("resize", onChange);
      return () => window.removeEventListener("resize", onChange);
    },
    () => window.innerWidth,
  );
}
