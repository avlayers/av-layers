export type GeoPt = [number, number];

/**
 * Extracts oriented, Chaikin-smoothed contour polylines from a scalar grid `(cols x rows)`
 * where row `0` is North and row `rows - 1` is South.
 *
 * Orientation invariant: every directed segment `(A -> B)` keeps the high side (`value >= level`)
 * strictly on its LEFT in `(lon, lat)` space (`inwardNormal = (-dy, dx)`, `outwardNormal = (dy, -dx)`).
 */
export function extractOrientedContours(
  grid: Float32Array,
  cols: number,
  rows: number,
  level: number,
  toGeo: (gx: number, gy: number) => GeoPt,
  minVertices = 4
): GeoPt[][] {
  if (cols < 2 || rows < 2) return [];
  const interp = (va: number, vb: number): number => {
    const d = vb - va;
    return Math.abs(d) < 1e-6 ? 0.5 : Math.max(0, Math.min(1, (level - va) / d));
  };

  const segs: Array<[GeoPt, GeoPt]> = [];
  for (let y = 0; y < rows - 1; y++) {
    for (let x = 0; x < cols - 1; x++) {
      const i00 = y * cols + x;
      const i10 = i00 + 1;
      const i01 = i00 + cols;
      const i11 = i01 + 1;
      const v00 = grid[i00]!, v10 = grid[i10]!, v11 = grid[i11]!, v01 = grid[i01]!;
      const mask = (v00 >= level ? 8 : 0) | (v10 >= level ? 4 : 0) | (v11 >= level ? 2 : 0) | (v01 >= level ? 1 : 0);
      if (mask === 0 || mask === 15) continue;

      const top = (): GeoPt => toGeo(x + interp(v00, v10), y);
      const right = (): GeoPt => toGeo(x + 1, y + interp(v10, v11));
      const bottom = (): GeoPt => toGeo(x + interp(v01, v11), y + 1);
      const left = (): GeoPt => toGeo(x, y + interp(v00, v01));

      switch (mask) {
        case 1: segs.push([bottom(), left()]); break;
        case 14: segs.push([left(), bottom()]); break;
        case 2: segs.push([right(), bottom()]); break;
        case 13: segs.push([bottom(), right()]); break;
        case 3: segs.push([right(), left()]); break;
        case 12: segs.push([left(), right()]); break;
        case 4: segs.push([top(), right()]); break;
        case 11: segs.push([right(), top()]); break;
        case 6: segs.push([top(), bottom()]); break;
        case 9: segs.push([bottom(), top()]); break;
        case 7: segs.push([top(), left()]); break;
        case 8: segs.push([left(), top()]); break;
        case 5: {
          const center = 0.25 * (v00 + v10 + v11 + v01);
          if (center >= level) segs.push([top(), right()], [bottom(), left()]);
          else segs.push([right(), bottom()], [left(), top()]);
          break;
        }
        case 10: {
          const center = 0.25 * (v00 + v10 + v11 + v01);
          if (center >= level) segs.push([right(), bottom()], [left(), top()]);
          else segs.push([bottom(), left()], [top(), right()]);
          break;
        }
      }
    }
  }

  return stitchDirectedSegments(segs, minVertices).map(smoothPolyline);
}

function stitchDirectedSegments(segments: Array<[GeoPt, GeoPt]>, minVertices: number): GeoPt[][] {
  if (!segments.length) return [];
  const keyOf = (p: GeoPt) => `${Math.round(p[0] * 2e4)},${Math.round(p[1] * 2e4)}`;
  const used = new Uint8Array(segments.length);
  const byStart = new Map<string, number[]>();
  const byEnd = new Map<string, number[]>();

  for (let i = 0; i < segments.length; i++) {
    const [a, b] = segments[i]!;
    const ka = keyOf(a), kb = keyOf(b);
    let sa = byStart.get(ka); if (!sa) { sa = []; byStart.set(ka, sa); } sa.push(i);
    let eb = byEnd.get(kb); if (!eb) { eb = []; byEnd.set(kb, eb); } eb.push(i);
  }

  const takeForward = (pt: GeoPt): GeoPt | null => {
    for (const idx of byStart.get(keyOf(pt)) ?? []) {
      if (!used[idx]) { used[idx] = 1; return segments[idx]![1]; }
    }
    return null;
  };

  const takeBackward = (pt: GeoPt): GeoPt | null => {
    for (const idx of byEnd.get(keyOf(pt)) ?? []) {
      if (!used[idx]) { used[idx] = 1; return segments[idx]![0]; }
    }
    return null;
  };

  const polylines: GeoPt[][] = [];
  for (let i = 0; i < segments.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const [a, b] = segments[i]!;
    const fwd: GeoPt[] = [a, b];
    for (;;) {
      const nxt = takeForward(fwd[fwd.length - 1]!);
      if (!nxt) break;
      fwd.push(nxt);
    }
    const bwd: GeoPt[] = [];
    let tail = a;
    for (;;) {
      const prv = takeBackward(tail);
      if (!prv) break;
      bwd.push(prv);
      tail = prv;
    }
    bwd.reverse();
    const merged = bwd.concat(fwd);
    if (merged.length >= minVertices) polylines.push(merged);
  }
  return polylines;
}

function smoothPolyline(line: GeoPt[]): GeoPt[] {
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
