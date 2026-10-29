// Edge routing for the crew graph (DESIGN.md §5 GraphEdge): orthogonal paths with rounded corners,
// recomputed from node boxes on every move. A straight line wins when two nodes face each other;
// otherwise a step through the gap between them (one elbow, its two corners rounded), and only
// when that would cross another node, a single L-shaped bend.

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Route {
  d: string;
  /** Where a label sits: the middle of the elbow, or of a straight line. */
  label: { x: number; y: number };
}

/** Spreads several edges that leave or enter the same side, so they do not draw over each other. */
export interface PortOffsets {
  from?: number;
  to?: number;
}

type Pt = [number, number];

const RADIUS = 8;
/** Two boxes must share this much of a side before a straight line between them is used. */
const MIN_SHARED = 24;
/** Paths keep this distance from nodes they pass. */
const CLEARANCE = 4;

const cx = (b: Box) => b.x + b.w / 2;
const cy = (b: Box) => b.y + b.h / 2;
const right = (b: Box) => b.x + b.w;
const bottom = (b: Box) => b.y + b.h;

function overlaps(a: Box, b: Box): boolean {
  return a.x < right(b) && b.x < right(a) && a.y < bottom(b) && b.y < bottom(a);
}

/** True when the axis-aligned segment p→q passes through the inside of box b. */
export function segmentHits(p: Pt, q: Pt, b: Box): boolean {
  const x0 = Math.min(p[0], q[0]);
  const x1 = Math.max(p[0], q[0]);
  const y0 = Math.min(p[1], q[1]);
  const y1 = Math.max(p[1], q[1]);
  return x1 > b.x && x0 < right(b) && y1 > b.y && y0 < bottom(b);
}

const fmt = (n: number) => String(Math.round(n * 10) / 10);

/** Polyline through `pts` with every inner corner rounded; collinear points are dropped first. */
function path(pts: Pt[]): string {
  const clean = pts.filter((p, i) => {
    const prev = pts[i - 1];
    const next = pts[i + 1];
    if (!prev || !next) return true;
    return !((prev[0] === p[0] && p[0] === next[0]) || (prev[1] === p[1] && p[1] === next[1]));
  });
  let d = `M${fmt(clean[0]![0])} ${fmt(clean[0]![1])}`;
  for (let i = 1; i < clean.length - 1; i++) {
    const [p, c, q] = [clean[i - 1]!, clean[i]!, clean[i + 1]!];
    const len1 = Math.abs(c[0] - p[0]) + Math.abs(c[1] - p[1]);
    const len2 = Math.abs(q[0] - c[0]) + Math.abs(q[1] - c[1]);
    const r = Math.min(RADIUS, len1 / 2, len2 / 2);
    const a: Pt = [c[0] + Math.sign(p[0] - c[0]) * r, c[1] + Math.sign(p[1] - c[1]) * r];
    const b: Pt = [c[0] + Math.sign(q[0] - c[0]) * r, c[1] + Math.sign(q[1] - c[1]) * r];
    d += `L${fmt(a[0])} ${fmt(a[1])}Q${fmt(c[0])} ${fmt(c[1])} ${fmt(b[0])} ${fmt(b[1])}`;
  }
  const last = clean[clean.length - 1]!;
  return `${d}L${fmt(last[0])} ${fmt(last[1])}`;
}

interface Candidate {
  points: Pt[];
  label: { x: number; y: number };
}

const mid = (p: Pt, q: Pt) => ({ x: (p[0] + q[0]) / 2, y: (p[1] + q[1]) / 2 });

/** Candidate paths from a to b in order of preference; each one leaves and enters a box side. */
function candidates(a: Box, b: Box, off: PortOffsets): Candidate[] {
  const out: Candidate[] = [];
  const fo = off.from ?? 0;
  const to = off.to ?? 0;
  const shareY = Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y);
  const shareX = Math.min(right(a), right(b)) - Math.max(a.x, b.x);
  const bRight = b.x >= right(a);
  const bLeft = right(b) <= a.x;
  const bBelow = b.y >= bottom(a);
  const bAbove = bottom(b) <= a.y;

  if ((bRight || bLeft) && shareY >= MIN_SHARED) {
    const y = (Math.max(a.y, b.y) + Math.min(bottom(a), bottom(b))) / 2;
    const p: Pt = [bRight ? right(a) : a.x, y];
    const q: Pt = [bRight ? b.x : right(b), y];
    out.push({ points: [p, q], label: mid(p, q) });
  }
  if ((bBelow || bAbove) && shareX >= MIN_SHARED) {
    const x = (Math.max(a.x, b.x) + Math.min(right(a), right(b))) / 2;
    const p: Pt = [x, bBelow ? bottom(a) : a.y];
    const q: Pt = [x, bBelow ? b.y : bottom(b)];
    out.push({ points: [p, q], label: mid(p, q) });
  }
  // A step through the vertical gap between the two columns.
  if (bRight || bLeft) {
    const p: Pt = [bRight ? right(a) : a.x, cy(a) + fo];
    const q: Pt = [bRight ? b.x : right(b), cy(b) + to];
    const gx = bRight ? (right(a) + b.x) / 2 : (a.x + right(b)) / 2;
    out.push({ points: [p, [gx, p[1]], [gx, q[1]], q], label: { x: gx, y: (p[1] + q[1]) / 2 } });
  }
  // A step through the horizontal gap between the two rows.
  if (bBelow || bAbove) {
    const p: Pt = [cx(a) + fo, bBelow ? bottom(a) : a.y];
    const q: Pt = [cx(b) + to, bBelow ? b.y : bottom(b)];
    const gy = bBelow ? (bottom(a) + b.y) / 2 : (a.y + bottom(b)) / 2;
    out.push({ points: [p, [p[0], gy], [q[0], gy], q], label: { x: (p[0] + q[0]) / 2, y: gy } });
  }
  // Single bends: vertical first into the target's side, or horizontal first into its top or bottom.
  if ((bRight || bLeft) && (cy(b) > bottom(a) || cy(b) < a.y)) {
    const p: Pt = [cx(a), cy(b) > bottom(a) ? bottom(a) : a.y];
    const c: Pt = [cx(a), cy(b)];
    out.push({ points: [p, c, [bRight ? b.x : right(b), cy(b)]], label: { x: c[0], y: c[1] } });
  }
  if ((bBelow || bAbove) && (cx(b) > right(a) || cx(b) < a.x)) {
    const c: Pt = [cx(b), cy(a)];
    out.push({ points: [[cx(b) > right(a) ? right(a) : a.x, cy(a)], c, [cx(b), bBelow ? b.y : bottom(b)]], label: { x: c[0], y: c[1] } });
  }
  return out;
}

/**
 * Route from box a to box b. Returns null while the two boxes overlap (mid-drag), since no honest
 * line exists between them then.
 */
export function routeEdge(a: Box, b: Box, obstacles: Box[] = [], offsets: PortOffsets = {}): Route | null {
  if (overlaps(a, b)) return null;
  const all = candidates(a, b, offsets);
  if (all.length === 0) return null;
  const grown = obstacles.map((o) => ({ x: o.x - CLEARANCE, y: o.y - CLEARANCE, w: o.w + 2 * CLEARANCE, h: o.h + 2 * CLEARANCE }));
  const clear = all.find((c) => !grown.some((o) => c.points.slice(1).some((q, i) => segmentHits(c.points[i]!, q, o))));
  const best = clear ?? all[0]!;
  return { d: path(best.points), label: best.label };
}

/**
 * Port offsets for edges that share a node side: edges into one target are spread by the height
 * of their sources, edges out of one source by the height of their targets.
 */
export function spreadPorts(edges: Array<{ id: string; from: string; to: string }>, centerY: (id: string) => number, gap = 12): Map<string, PortOffsets> {
  const out = new Map<string, PortOffsets>(edges.map((e) => [e.id, {}]));
  const spread = (groupBy: "from" | "to", sortBy: "from" | "to", key: "from" | "to") => {
    const groups = new Map<string, typeof edges>();
    for (const e of edges) groups.set(e[groupBy], [...(groups.get(e[groupBy]) ?? []), e]);
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      group.sort((x, y) => centerY(x[sortBy]) - centerY(y[sortBy]));
      group.forEach((e, i) => (out.get(e.id)![key] = (i - (group.length - 1) / 2) * gap));
    }
  };
  spread("to", "from", "to");
  spread("from", "to", "from");
  return out;
}
