import { useEffect } from "react";
import { create } from "zustand";
import type { PreviewState } from "../../../../shared/api.ts";

// The preview page as main reports it (`preview.state`). One page exists at a time, owned by main;
// this store only mirrors it for the Preview tab.

const EMPTY: PreviewState = { taskId: null, url: null, title: null, loading: false, failed: null, blocked: null, picking: false };

export const usePreview = create<{ state: PreviewState }>()(() => ({ state: EMPTY }));

let subscribed = false;

/** Starts mirroring main's state once per window; later calls do nothing. */
function subscribe(): void {
  if (subscribed || typeof window === "undefined" || !window.crewyard) return;
  subscribed = true;
  window.crewyard.on("preview.state", (s) => usePreview.setState({ state: s as PreviewState }));
  void window.crewyard
    .previewState()
    .then((s) => s && usePreview.setState({ state: s }))
    .catch(() => undefined);
}

/**
 * Called by the inspector with the task it shows: the page belongs to one task, so it is unloaded
 * when the inspector moves to another task or closes. Unloading never stops the server or the run.
 */
export function usePreviewLifecycle(taskId: string | null): void {
  useEffect(subscribe, []);
  useEffect(() => {
    const loaded = usePreview.getState().state.taskId;
    if (loaded !== null && loaded !== taskId) window.crewyard.previewClose();
  }, [taskId]);
}

export { subscribe as subscribePreview };
