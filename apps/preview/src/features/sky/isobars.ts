interface IsobarViewportBox {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}

export interface IsobarGeoJson {
  readonly lines: {
    readonly type: 'FeatureCollection';
    readonly features: Array<{
      readonly type: 'Feature';
      readonly properties: { readonly hpa: number; readonly major: boolean; readonly label: string };
      readonly geometry: { readonly type: 'LineString'; readonly coordinates: Array<[number, number]> };
    }>;
  };
  readonly centers: {
    readonly type: 'FeatureCollection';
    readonly features: Array<{
      readonly type: 'Feature';
      readonly properties: { readonly kind: 'H' | 'L'; readonly hpa: number; readonly label: string };
      readonly geometry: { readonly type: 'Point'; readonly coordinates: [number, number] };
    }>;
  };
}

const FINE_COLS = 49;
const FINE_ROWS = 33;

function clampIndex(i: number, max: number): number {
  return i < 0 ? 0 : i > max ? max : i;
}

function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (
    2 * p1
    + (-p0 + p2) * t
    + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
    + (-p0 + 3 * p1 - 3 * p2 + p3) * t3
  );
}

function sampleCoarseNearestValid(grid: Float32Array, cols: number, rows: number, cx: number, cy: number): number {
  const v = grid[clampIndex(cy, rows - 1) * cols + clampIndex(cx, cols - 1)]!;
  if (Number.isFinite(v)) return v;
  for (let radius = 1; radius <= 2; radius++) {
    let sum = 0, count = 0;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || x >= cols || y < 0 || y >= rows) continue;
        const cand = grid[y * cols + x]!;
        if (Number.isFinite(cand)) { sum += cand; count++; }
      }
    }
    if (count > 0) return sum / count;
  }
  return Number.NaN;
}

function upsampleMslp(
  coarse: Float32Array,
  cols: number,
  rows: number
): { values: Float32Array; valid: Uint8Array } {
  const raw = new Float32Array(FINE_COLS * FINE_ROWS);
  const valid = new Uint8Array(FINE_COLS * FINE_ROWS);

  for (let fy = 0; fy < FINE_ROWS; fy++) {
    const gy = (fy / (FINE_ROWS - 1)) * (rows - 1);
    const y1 = Math.floor(gy), ty = gy - y1;
    for (let fx = 0; fx < FINE_COLS; fx++) {
      const gx = (fx / (FINE_COLS - 1)) * (cols - 1);
      const x1 = Math.floor(gx), tx = gx - x1;
      const idx = fy * FINE_COLS + fx;

      const c00 = coarse[clampIndex(y1, rows - 1) * cols + clampIndex(x1, cols - 1)]!;
      const c10 = coarse[clampIndex(y1, rows - 1) * cols + clampIndex(x1 + 1, cols - 1)]!;
      const c01 = coarse[clampIndex(y1 + 1, rows - 1) * cols + clampIndex(x1, cols - 1)]!;
      const c11 = coarse[clampIndex(y1 + 1, rows - 1) * cols + clampIndex(x1 + 1, cols - 1)]!;
      const validCorners = Number(Number.isFinite(c00)) + Number(Number.isFinite(c10)) + Number(Number.isFinite(c01)) + Number(Number.isFinite(c11));
      if (validCorners < 3) {
        raw[idx] = Number.NaN;
        continue;
      }

      const rowVals = [0, 0, 0, 0];
      let ok = true;
      for (let j = -1; j <= 2; j++) {
        const p0 = sampleCoarseNearestValid(coarse, cols, rows, x1 - 1, y1 + j);
        const p1 = sampleCoarseNearestValid(coarse, cols, rows, x1, y1 + j);
        const p2 = sampleCoarseNearestValid(coarse, cols, rows, x1 + 1, y1 + j);
        const p3 = sampleCoarseNearestValid(coarse, cols, rows, x1 + 2, y1 + j);
        if (!Number.isFinite(p0) || !Number.isFinite(p1) || !Number.isFinite(p2) || !Number.isFinite(p3)) {
          ok = false;
          break;
        }
        rowVals[j + 1] = catmullRom(p0, p1, p2, p3, tx);
      }
      if (!ok) {
        raw[idx] = Number.NaN;
        continue;
      }
      raw[idx] = catmullRom(rowVals[0]!, rowVals[1]!, rowVals[2]!, rowVals[3]!, ty);
      valid[idx] = 1;
    }
  }

  // Light 3x3 Gaussian smoothing so mountain-reduced MSLP yields clean synoptic contours.
  const smoothed = new Float32Array(FINE_COLS * FINE_ROWS).fill(Number.NaN);
  const kernel = [1, 2, 1, 2, 4, 2, 1, 2, 1];
  for (let y = 0; y < FINE_ROWS; y++) {
    for (let x = 0; x < FINE_COLS; x++) {
      const idx = y * FINE_COLS + x;
      if (!valid[idx]) continue;
      let sum = 0, weight = 0, k = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = clampIndex(y + dy, FINE_ROWS - 1);
        for (let dx = -1; dx <= 1; dx++, k++) {
          const xx = clampIndex(x + dx, FINE_COLS - 1);
          const v = raw[yy * FINE_COLS + xx]!;
          if (Number.isFinite(v)) {
            const w = kernel[k]!;
            sum += v * w;
            weight += w;
          }
        }
      }
      smoothed[idx] = weight > 0 ? sum / weight : raw[idx]!;
    }
  }
  return { values: smoothed, valid };
}

type Pt = [number, number];

function stitchSegments(segments: Array<[Pt, Pt]>): Pt[][] {
  if (!segments.length) return [];
  const keyOf = (p: Pt) => `${Math.round(p[0] * 1e4)},${Math.round(p[1] * 1e4)}`;
  const used = new Uint8Array(segments.length);
  const byStart = new Map<string, number[]>();
  const byEnd = new Map<string, number[]>();

  for (let i = 0; i < segments.length; i++) {
    const [a, b] = segments[i]!;
    const ka = keyOf(a), kb = keyOf(b);
    let sa = byStart.get(ka); if (!sa) { sa = []; byStart.set(ka, sa); } sa.push(i);
    let eb = byEnd.get(kb); if (!eb) { eb = []; byEnd.set(kb, eb); } eb.push(i);
  }

  const takeConnected = (point: Pt): Pt | null => {
    const k = keyOf(point);
    for (const idx of byStart.get(k) ?? []) {
      if (!used[idx]) { used[idx] = 1; return segments[idx]![1]; }
    }
    for (const idx of byEnd.get(k) ?? []) {
      if (!used[idx]) { used[idx] = 1; return segments[idx]![0]; }
    }
    return null;
  };

  const lines: Pt[][] = [];
  for (let i = 0; i < segments.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const [a, b] = segments[i]!;
    const forward: Pt[] = [a, b];
    for (;;) {
      const next = takeConnected(forward[forward.length - 1]!);
      if (!next) break;
      forward.push(next);
    }
    const backward: Pt[] = [];
    let tail = a;
    for (;;) {
      const prev = takeConnected(tail);
      if (!prev) break;
      backward.push(prev);
      tail = prev;
    }
    backward.reverse();
    const merged = backward.concat(forward);
    if (merged.length >= 3) lines.push(merged);
  }
  return lines;
}

function chaikinSmooth(line: Pt[]): Pt[] {
  if (line.length < 4) return line;
  const closed = Math.hypot(line[0]![0] - line[line.length - 1]![0], line[0]![1] - line[line.length - 1]![1]) < 1e-4;
  const out: Pt[] = closed ? [] : [line[0]!];
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

/**
 * Extracts smoothed sea-level pressure isobar polylines and H/L synoptic centers
 * from a viewport `mslp-hpa` sample grid.
 */
export function buildIsobarGeoJson(
  coarseMslp: Float32Array,
  cols: number,
  rows: number,
  box: IsobarViewportBox,
  zoom: number
): IsobarGeoJson {
  const empty: IsobarGeoJson = {
    lines: { type: 'FeatureCollection', features: [] },
    centers: { type: 'FeatureCollection', features: [] }
  };
  if (cols < 2 || rows < 2) return empty;

  const { values, valid } = upsampleMslp(coarseMslp, cols, rows);
  let minP = Infinity, maxP = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (valid[i] && Number.isFinite(v)) {
      if (v < minP) minP = v;
      if (v > maxP) maxP = v;
    }
  }
  if (!(maxP > minP) || !Number.isFinite(minP)) return empty;

  const minorStep = zoom < 4.3 ? 4 : 2;
  const majorStep = minorStep * 2;
  const startHpa = Math.ceil(minP / minorStep) * minorStep;
  const endHpa = Math.floor(maxP / minorStep) * minorStep;

  const toGeo = (gx: number, gy: number): Pt => [
    box.west + (gx / (FINE_COLS - 1)) * (box.east - box.west),
    box.north - (gy / (FINE_ROWS - 1)) * (box.north - box.south)
  ];

  const interp = (va: number, vb: number, level: number): number => {
    const d = vb - va;
    return Math.abs(d) < 1e-6 ? 0.5 : Math.max(0, Math.min(1, (level - va) / d));
  };

  const lineFeatures: IsobarGeoJson['lines']['features'] = [];

  for (let hpa = startHpa; hpa <= endHpa; hpa += minorStep) {
    const segs: Array<[Pt, Pt]> = [];
    for (let y = 0; y < FINE_ROWS - 1; y++) {
      for (let x = 0; x < FINE_COLS - 1; x++) {
        const i00 = y * FINE_COLS + x;
        const i10 = i00 + 1;
        const i01 = i00 + FINE_COLS;
        const i11 = i01 + 1;
        if (!valid[i00] || !valid[i10] || !valid[i01] || !valid[i11]) continue;

        const v00 = values[i00]!, v10 = values[i10]!, v11 = values[i11]!, v01 = values[i01]!;
        const mask = (v00 >= hpa ? 8 : 0) | (v10 >= hpa ? 4 : 0) | (v11 >= hpa ? 2 : 0) | (v01 >= hpa ? 1 : 0);
        if (mask === 0 || mask === 15) continue;

        const top = (): Pt => toGeo(x + interp(v00, v10, hpa), y);
        const right = (): Pt => toGeo(x + 1, y + interp(v10, v11, hpa));
        const bottom = (): Pt => toGeo(x + interp(v01, v11, hpa), y + 1);
        const left = (): Pt => toGeo(x, y + interp(v00, v01, hpa));

        switch (mask) {
          case 1: case 14: segs.push([left(), bottom()]); break;
          case 2: case 13: segs.push([bottom(), right()]); break;
          case 3: case 12: segs.push([left(), right()]); break;
          case 4: case 11: segs.push([top(), right()]); break;
          case 6: case 9: segs.push([top(), bottom()]); break;
          case 7: case 8: segs.push([left(), top()]); break;
          case 5: {
            const center = 0.25 * (v00 + v10 + v11 + v01);
            if (center >= hpa) { segs.push([left(), top()], [bottom(), right()]); }
            else { segs.push([left(), bottom()], [top(), right()]); }
            break;
          }
          case 10: {
            const center = 0.25 * (v00 + v10 + v11 + v01);
            if (center >= hpa) { segs.push([left(), bottom()], [top(), right()]); }
            else { segs.push([left(), top()], [bottom(), right()]); }
            break;
          }
        }
      }
    }

    const major = hpa % majorStep === 0;
    for (const rawLine of stitchSegments(segs)) {
      const coordinates = chaikinSmooth(rawLine);
      lineFeatures.push({
        type: 'Feature',
        properties: { hpa, major, label: `${hpa}` },
        geometry: { type: 'LineString', coordinates }
      });
    }
  }

  // Detect synoptic H / L extrema with prominence over surrounding ring.
  const candidates: Array<{ kind: 'H' | 'L'; hpa: number; x: number; y: number; prominence: number }> = [];
  const rInner = 3, rRing = 5;
  for (let y = rRing; y < FINE_ROWS - rRing; y++) {
    for (let x = rRing; x < FINE_COLS - rRing; x++) {
      const idx = y * FINE_COLS + x;
      if (!valid[idx]) continue;
      const center = values[idx]!;
      let isMax = true, isMin = true, allValid = true;
      for (let dy = -rInner; dy <= rInner && (isMax || isMin); dy++) {
        for (let dx = -rInner; dx <= rInner; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nIdx = (y + dy) * FINE_COLS + (x + dx);
          if (!valid[nIdx]) { allValid = false; isMax = false; isMin = false; break; }
          const nv = values[nIdx]!;
          if (nv >= center) isMax = false;
          if (nv <= center) isMin = false;
        }
      }
      if (!allValid || (!isMax && !isMin)) continue;
      let ringSum = 0, ringCount = 0;
      for (let dy = -rRing; dy <= rRing; dy++) {
        for (let dx = -rRing; dx <= rRing; dx++) {
          if (Math.abs(dx) < rRing && Math.abs(dy) < rRing) continue;
          const rIdx = (y + dy) * FINE_COLS + (x + dx);
          if (valid[rIdx]) { ringSum += values[rIdx]!; ringCount++; }
        }
      }
      if (ringCount < 8) continue;
      const ringMean = ringSum / ringCount;
      const prominence = Math.abs(center - ringMean);
      if (prominence >= 1.1) {
        candidates.push({ kind: isMax ? 'H' : 'L', hpa: Math.round(center), x, y, prominence });
      }
    }
  }

  candidates.sort((a, b) => b.prominence - a.prominence);
  const kept: typeof candidates = [];
  for (const cand of candidates) {
    if (kept.length >= 6) break;
    if (kept.some(prev => Math.hypot(prev.x - cand.x, prev.y - cand.y) < 11)) continue;
    kept.push(cand);
  }

  const centerFeatures: IsobarGeoJson['centers']['features'] = kept.map(cand => ({
    type: 'Feature',
    properties: { kind: cand.kind, hpa: cand.hpa, label: `${cand.kind}\n${cand.hpa}` },
    geometry: { type: 'Point', coordinates: toGeo(cand.x, cand.y) }
  }));

  return {
    lines: { type: 'FeatureCollection', features: lineFeatures },
    centers: { type: 'FeatureCollection', features: centerFeatures }
  };
}
