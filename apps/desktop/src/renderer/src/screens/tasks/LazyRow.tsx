import { useEffect, useRef, useState, type ReactNode } from "react";

// Mounts a task row only once it comes near the view. Each row reads its own task, so a project
// with a thousand tasks would otherwise start a thousand reads and render every step list at once.
// A row stays mounted after that, so expanding one never shifts or reloads another.

/** Rows the first screen always shows without waiting for a scroll. */
export const EAGER_ROWS = 30;

export function LazyRow({ index, children }: { index: number; children: ReactNode }) {
  const [seen, setSeen] = useState(index < EAGER_ROWS || typeof IntersectionObserver === "undefined");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (seen || !ref.current) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { rootMargin: "800px 0px" },
    );
    io.observe(ref.current);
    return () => io.disconnect();
  }, [seen]);
  return seen ? children : <div ref={ref} className="tk-row tk-row-ph" aria-hidden="true" />;
}
