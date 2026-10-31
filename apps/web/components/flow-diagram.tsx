// The path of one task, drawn in code so it follows the theme. Boxes are hairlines in line colours;
// the three places that wait for you carry an accent border and a YOU label. Text is the app's own
// vocabulary, mono 11 px, as DESIGN.md asks for annotations.

const BOXES = [
  { x: 0, label: "Task", sub: "you describe it" },
  { x: 168, label: "Crew proposal", sub: "reasons, estimates" },
  { x: 336, label: "Approve and start", sub: "", gate: true },
  { x: 504, label: "Runs in worktrees", sub: "tests every turn" },
  { x: 672, label: "Review", sub: "pinned to the commit" },
  { x: 840, label: "Push · PR · merge", sub: "", gate: true },
] as const;

const W = 148;
const H = 64;
const Y = 24;

export function FlowDiagram() {
  return (
    <figure className="diagram frame">
      <svg viewBox="-8 0 1004 196" role="img" aria-label="Task, crew proposal, your approval, runs in worktrees with questions and approvals in the Inbox, review, then push, pull request and merge, each on your click.">
        <defs>
          <marker id="flow-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto">
            <path d="M0 0 L8 4 L0 8 z" fill="var(--line-strong)" />
          </marker>
        </defs>
        {BOXES.map((b, i) => (
          <g key={b.label}>
            <rect x={b.x} y={Y} width={W} height={H} fill="var(--surface)" stroke={"gate" in b && b.gate ? "var(--accent)" : "var(--line-strong)"} strokeWidth="1" />
            <text x={b.x + 12} y={Y + 26} fill="var(--ink)" style={{ font: "500 13px var(--ui)" }}>
              {b.label}
            </text>
            {b.sub ? (
              <text x={b.x + 12} y={Y + 46} fill="var(--ink-3)" style={{ font: "400 11px var(--mono)" }}>
                {b.sub}
              </text>
            ) : null}
            {"gate" in b && b.gate ? (
              <text x={b.x + 12} y={Y + 46} fill="var(--accent)" style={{ font: "500 11px var(--mono)", letterSpacing: "0.08em" }}>
                YOU
              </text>
            ) : null}
            {i < BOXES.length - 1 ? <line x1={b.x + W} y1={Y + H / 2} x2={b.x + 168 - 2} y2={Y + H / 2} stroke="var(--line-strong)" markerEnd="url(#flow-arrow)" /> : null}
          </g>
        ))}
        {/* The Inbox loop under the running step: a question goes out, your answer comes back. */}
        <path d="M 548 88 L 548 132" stroke="var(--line-strong)" markerEnd="url(#flow-arrow)" fill="none" />
        <path d="M 608 132 L 608 90" stroke="var(--accent)" markerEnd="url(#flow-arrow)" fill="none" strokeDasharray="3 3" />
        <rect x="504" y="134" width={W} height="44" fill="var(--surface)" stroke="var(--accent)" />
        <text x="516" y="154" fill="var(--ink)" style={{ font: "500 13px var(--ui)" }}>
          Inbox
        </text>
        <text x="516" y="170" fill="var(--accent)" style={{ font: "500 11px var(--mono)", letterSpacing: "0.08em" }}>
          YOU ANSWER
        </text>
        <text x="664" y="160" fill="var(--ink-3)" style={{ font: "400 11px var(--mono)" }}>
          questions, approvals, limits
        </text>
      </svg>
    </figure>
  );
}
