import { useEffect, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Splitter } from "@crewyard/ui";
import { usePrefs } from "../../prefs.ts";
import { INBOX_LIST, inboxListBounds } from "../../shell/layout.ts";
import { useMedia } from "../../shell/useMedia.ts";

/** Handle width in the grid (inbox.css). */
const HANDLE = 16;

/**
 * The handle between the request list and the detail pane (DESIGN.md §5 `Splitter`). The width
 * lives in prefs and reaches the grid as `--inbox-list-w`, so a drag re-renders only this. Below
 * 1280 px the two stack and the handle hides.
 */
export function InboxSplit({ grid, list }: { grid: RefObject<HTMLDivElement | null>; list: string }) {
  const { t } = useTranslation();
  const width = usePrefs((s) => s.inboxListWidth);
  const setWidth = usePrefs((s) => s.setInboxListWidth);
  const stacked = useMedia("(max-width: 1279.98px)");
  const [gridWidth, setGridWidth] = useState(0);

  // A passive effect: the grid ref is attached after this child's layout effects on first mount.
  // The 16 px track is in the CSS already, so the handle appearing a frame later moves nothing.
  useEffect(() => {
    const el = grid.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setGridWidth(entry?.contentRect.width ?? 0));
    ro.observe(el);
    return () => ro.disconnect();
  }, [grid]);

  if (stacked || gridWidth === 0) return null;
  const bounds = inboxListBounds(gridWidth, HANDLE);
  return (
    <Splitter
      inline
      value={width}
      min={bounds.min}
      max={bounds.max}
      defaultValue={INBOX_LIST.default}
      edge="end"
      label={t("layout.inbox.resize")}
      title={t("layout.resetHint")}
      controls={list}
      onChange={setWidth}
    />
  );
}
