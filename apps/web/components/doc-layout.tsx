import type { ReactNode } from "react";

// Long pages (How it works, Security): a numbered rail beside the sections on wide screens. The
// rail and each section heading read their number and title from the same TOC array.

export type Toc = ReadonlyArray<readonly [id: string, title: string]>;

export function DocLayout({ toc, head, children }: { toc: Toc; head: ReactNode; children: ReactNode }) {
  return (
    <div className="wrap doc">
      <nav className="rail" aria-label="On this page">
        <ol>
          {toc.map(([id, title], i) => (
            <li key={id}>
              <a href={`#${id}`}>
                <span>{String(i + 1).padStart(2, "0")}</span>
                {title}
              </a>
            </li>
          ))}
        </ol>
      </nav>
      <div className="doc-main">
        <header className="doc-head">{head}</header>
        {children}
      </div>
    </div>
  );
}

export function DocSection({ toc, id, children }: { toc: Toc; id: string; children: ReactNode }) {
  const index = toc.findIndex(([key]) => key === id);
  return (
    <section id={id} className="doc-sec" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>
        <span className="n">{String(index + 1).padStart(2, "0")}</span>
        {toc[index]?.[1] ?? id}
      </h2>
      {children}
    </section>
  );
}
