export type GeoPt = [number, number];

interface ContourOptions {
  /** Cells with any corner flagged 0 here produce no segments. Omitted: every cell is contoured. */
  readonly valid?: ArrayLike<number>;
  /** Stitched polylines shorter than this many vertices are dropped. */
  readonly minVertices?: number;
}

// Cell corners: 8 = top-left (x, y), 4 = top-right, 2 = bottom-right, 1 = bottom-left; row 0 is north.
// Each segment runs between two cell edges with the high side (value >= level) on its LEFT in
// (lon, lat) space. Saddles (5, 10) use the cell-centre mean: a high centre joins the two high corners.
type Edge = 0 | 1 | 2 | 3; // top, right, bottom, left
const T = 0, R = 1, B = 2, L = 3;
const CASES: ReadonlyArray<ReadonlyArray<readonly [Edge, Edge]>> = [
  [], [[B, L]], [[R, B]], [[R, L]], [[T, R]], [], [[T, B]], [[T, L]],
  [[L, T]], [[B, T]], [], [[R, T]], [[L, R]], [[B, R]], [[L, B]], []
];
const SADDLES: Record<5 | 10, { high: ReadonlyArray<readonly [Edge, Edge]>; low: ReadonlyArray<readonly [Edge, Edge]> }> = {
  5: { high: [[T, L], [B, R]], low: [[T, R], [B, L]] },
  10: { high: [[R, T], [L, B]], low: [[L, T], [R, B]] }
};

/**
 * Oriented marching squares over a `cols x rows` grid, stitched into polylines and Chaikin-smoothed.
 * The one contour routine for isobars, cloud edges and rain edges.
 */
export function contourLines(
  grid: ArrayLike<number>,
  cols: number,
  rows: number,
  level: number,
  toGeo: (gx: number, gy: number) => GeoPt,
  { valid, minVertices = 3 }: ContourOptions = {}
): GeoPt[][] {
  if (cols < 2 || rows < 2) return [];
  const interp = (va: number, vb: number): number => {
    const d = vb - va;
    return Math.abs(d) < 1e-6 ? 0.5 : Math.max(0, Math.min(1, (level - va) / d));
  };
  const segments: Array<[GeoPt, GeoPt]> = [];
  for (let y = 0; y < rows - 1; y++) {
    for (let x = 0; x < cols - 1; x++) {
      const i00 = y * cols + x, i10 = i00 + 1, i01 = i00 + cols, i11 = i01 + 1;
      if (valid && (!valid[i00] || !valid[i10] || !valid[i01] || !valid[i11])) continue;
      const v00 = grid[i00]!, v10 = grid[i10]!, v11 = grid[i11]!, v01 = grid[i01]!;
      const mask = (v00 >= level ? 8 : 0) | (v10 >= level ? 4 : 0) | (v11 >= level ? 2 : 0) | (v01 >= level ? 1 : 0);
      if (mask === 0 || mask === 15) continue;
      const point = (edge: Edge): GeoPt => edge === T ? [x + interp(v00, v10), y]
        : edge === R ? [x + 1, y + interp(v10, v11)]
          : edge === B ? [x + interp(v01, v11), y + 1]
            : [x, y + interp(v00, v01)];
      const pairs = mask === 5 || mask === 10
        ? SADDLES[mask][0.25 * (v00 + v10 + v11 + v01) >= level ? 'high' : 'low']
        : CASES[mask]!;
      for (const [from, to] of pairs) segments.push([point(from), point(to)]);
    }
  }
  return stitch(segments, minVertices).map(line => smooth(line.map(([gx, gy]) => toGeo(gx, gy))));
}

/** Joins directed segments end-to-start. Shared edge points are computed identically, so keys are exact. */
function stitch(segments: ReadonlyArray<[GeoPt, GeoPt]>, minVertices: number): GeoPt[][] {
  const keyOf = (p: GeoPt) => `${p[0]},${p[1]}`;
  const used = new Uint8Array(segments.length);
  const byStart = new Map<string, number[]>(), byEnd = new Map<string, number[]>();
  segments.forEach(([a, b], i) => {
    const ka = keyOf(a), kb = keyOf(b);
    (byStart.get(ka) ?? byStart.set(ka, []).get(ka)!).push(i);
    (byEnd.get(kb) ?? byEnd.set(kb, []).get(kb)!).push(i);
  });
  const take = (index: Map<string, number[]>, pt: GeoPt, end: 0 | 1): GeoPt | null => {
    for (const i of index.get(keyOf(pt)) ?? []) if (!used[i]) { used[i] = 1; return segments[i]![end]; }
    return null;
  };
  const lines: GeoPt[][] = [];
  for (let i = 0; i < segments.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const [a, b] = segments[i]!;
    const forward: GeoPt[] = [a, b];
    for (let next = take(byStart, b, 1); next; next = take(byStart, next, 1)) forward.push(next);
    const backward: GeoPt[] = [];
    for (let prev = take(byEnd, a, 0); prev; prev = take(byEnd, prev, 0)) backward.push(prev);
    const line = backward.reverse().concat(forward);
    if (line.length >= minVertices) lines.push(line);
  }
  return lines;
}

function smooth(line: GeoPt[]): GeoPt[] {
  if (line.length < 4) return line;
  const closed = Math.hypot(line[0]![0] - line[line.length - 1]![0], line[0]![1] - line[line.length - 1]![1]) < 1e-4;
  const out: GeoPt[] = closed ? [] : [line[0]!];
  const limit = line.length - 1;
  for (let i = 0; i < limit; i++) {
    const p0 = line[i]!, p1 = line[i + 1]!;
    out.push([0.75 * p0[0] + 0.25 * p1[0], 0.75 * p0[1] + 0.25 * p1[1]]);
    out.push([0.25 * p0[0] + 0.75 * p1[0], 0.25 * p0[1] + 0.75 * p1[1]]);
  }
  if (closed && out.length) out.push(out[0]!);
  else out.push(line[limit]!);
  return out;
}
