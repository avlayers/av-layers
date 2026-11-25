// Marching-squares isoband contouring of a sampled chart grid into evenodd SVG paths.

import { clamp } from './windgram-format.ts';

/** Contours `values` (row-major, `rows + 1` by `cols + 1`) into one path per band between consecutive thresholds. */
export function contourGridIsobands(args: {
  values: Float32Array;
  xs: ArrayLike<number>;
  rows: number;
  cols: number;
  plotTop: number;
  plotBottom: number;
  thresholds: readonly number[];
  classNames: readonly string[];
}): Record<string, string> {
  const { values, xs, rows, cols, plotTop, plotBottom, thresholds, classNames } = args;
  const stride = cols + 1;
  const edgeStride = cols + 3;
  const maxEdges = (rows + 3) * edgeStride * 2;
  const nextSeg = new Int32Array(maxEdges);
  const plotHeight = plotBottom - plotTop;
  const left = xs[0]!;
  const right = xs[cols]!;
  const xOf = (c: number) => {
    if (c <= 0) return left;
    if (c >= cols) return right;
    const lo = c | 0;
    const hi = lo + 1 <= cols ? lo + 1 : cols;
    return xs[lo]! + (xs[hi]! - xs[lo]!) * (c - lo);
  };
  const yOf = (r: number) => plotTop + (clamp(r, 0, rows) / rows) * plotHeight;
  const clamp01 = (v: number) => (v <= 0 ? 0 : v >= 1 ? 1 : v);
  const shortNum = (v: number) => Math.round(v * 10) / 10;
  const hEdge = (r: number, c: number) => ((r + 1) * edgeStride + (c + 1)) * 2;
  const vEdge = (r: number, c: number) => ((r + 1) * edgeStride + (c + 1)) * 2 + 1;

  const thresholdRings = (t: number): Float64Array[] => {
    nextSeg.fill(-1);
    const fromEdges: number[] = [];
    const toEdges: number[] = [];
    const segCoords: number[] = [];
    const used: number[] = [];
    const addSeg = (fk: number, fx: number, fy: number, tk: number, tx: number, ty: number) => {
      const idx = fromEdges.length;
      fromEdges.push(fk);
      toEdges.push(tk);
      segCoords.push(fx, fy, tx, ty);
      used.push(0);
      nextSeg[fk] = idx;
    };
    const valAt = (r: number, c: number) =>
      r >= 0 && r <= rows && c >= 0 && c <= cols ? values[r * stride + c]! : -1;
    const frac = (a: number, b: number) =>
      !Number.isFinite(a) ? 0.999 : !Number.isFinite(b) ? 0.001 : a === b ? 0.5 : clamp01((t - a) / (b - a));

    for (let r = -1; r <= rows; r++) {
      for (let c = -1; c <= cols; c++) {
        const vTL = valAt(r, c);
        const vTR = valAt(r, c + 1);
        const vBR = valAt(r + 1, c + 1);
        const vBL = valAt(r + 1, c);
        const idx = (vTL >= t ? 8 : 0) | (vTR >= t ? 4 : 0) | (vBR >= t ? 2 : 0) | (vBL >= t ? 1 : 0);
        if (idx === 0 || idx === 15) continue;
        const tk = hEdge(r, c), tx = xOf(c + frac(vTL, vTR)), ty = yOf(r);
        const bk = hEdge(r + 1, c), bx = xOf(c + frac(vBL, vBR)), by = yOf(r + 1);
        const lk = vEdge(r, c), lx = xOf(c), ly = yOf(r + frac(vTL, vBL));
        const rk = vEdge(r, c + 1), rx = xOf(c + 1), ry = yOf(r + frac(vTR, vBR));
        const finiteSum =
          (Number.isFinite(vTL) ? vTL : 0) +
          (Number.isFinite(vTR) ? vTR : 0) +
          (Number.isFinite(vBR) ? vBR : 0) +
          (Number.isFinite(vBL) ? vBL : 0);
        const finiteCount =
          Number(Number.isFinite(vTL)) +
          Number(Number.isFinite(vTR)) +
          Number(Number.isFinite(vBR)) +
          Number(Number.isFinite(vBL));
        const centreIn = finiteCount === 4 && finiteSum * 0.25 >= t;
        switch (idx) {
          case 1: addSeg(lk, lx, ly, bk, bx, by); break;
          case 2: addSeg(bk, bx, by, rk, rx, ry); break;
          case 3: addSeg(lk, lx, ly, rk, rx, ry); break;
          case 4: addSeg(rk, rx, ry, tk, tx, ty); break;
          case 6: addSeg(bk, bx, by, tk, tx, ty); break;
          case 7: addSeg(lk, lx, ly, tk, tx, ty); break;
          case 8: addSeg(tk, tx, ty, lk, lx, ly); break;
          case 9: addSeg(tk, tx, ty, bk, bx, by); break;
          case 11: addSeg(tk, tx, ty, rk, rx, ry); break;
          case 12: addSeg(rk, rx, ry, lk, lx, ly); break;
          case 13: addSeg(rk, rx, ry, bk, bx, by); break;
          case 14: addSeg(bk, bx, by, lk, lx, ly); break;
          case 5:
            if (centreIn) { addSeg(lk, lx, ly, tk, tx, ty); addSeg(rk, rx, ry, bk, bx, by); }
            else { addSeg(lk, lx, ly, bk, bx, by); addSeg(rk, rx, ry, tk, tx, ty); }
            break;
          case 10:
            if (centreIn) { addSeg(tk, tx, ty, rk, rx, ry); addSeg(bk, bx, by, lk, lx, ly); }
            else { addSeg(tk, tx, ty, lk, lx, ly); addSeg(bk, bx, by, rk, rx, ry); }
            break;
        }
      }
    }

    const out: Float64Array[] = [];
    const segCount = fromEdges.length;
    for (let s = 0; s < segCount; s++) {
      if (used[s]) continue;
      const coords: number[] = [segCoords[s * 4]!, segCoords[s * 4 + 1]!];
      let cur = s;
      while (cur >= 0 && !used[cur]) {
        used[cur] = 1;
        coords.push(segCoords[cur * 4 + 2]!, segCoords[cur * 4 + 3]!);
        cur = nextSeg[toEdges[cur]!]!;
      }
      if (coords.length >= 8) out.push(Float64Array.from(coords));
    }
    return out;
  };

  const ringCache = new Map<number, Float64Array[]>();
  const ringsAt = (t: number) => {
    let cached = ringCache.get(t);
    if (!cached) {
      cached = thresholdRings(t);
      ringCache.set(t, cached);
    }
    return cached;
  };

  const result: Record<string, string> = {};
  for (let i = 0; i < classNames.length; i++) {
    const sets: Float64Array[][] = [ringsAt(thresholds[i]!)];
    if (i + 1 < thresholds.length) sets.push(ringsAt(thresholds[i + 1]!));
    const parts: string[] = [];
    for (const set of sets) {
      for (const ring of set) {
        const xsOut: number[] = [];
        const ysOut: number[] = [];
        for (let k = 0; k < ring.length; k += 2) {
          const x = shortNum(ring[k]!);
          const y = shortNum(ring[k + 1]!);
          const len = xsOut.length;
          if (len > 0 && xsOut[len - 1] === x && ysOut[len - 1] === y) continue;
          if (len >= 2) {
            const px = xsOut[len - 2]!, py = ysOut[len - 2]!;
            const lx = xsOut[len - 1]!, ly = ysOut[len - 1]!;
            if (Math.abs((lx - px) * (y - py) - (ly - py) * (x - px)) < 0.3) {
              xsOut[len - 1] = x;
              ysOut[len - 1] = y;
              continue;
            }
          }
          xsOut.push(x);
          ysOut.push(y);
        }
        if (xsOut.length >= 3) {
          let d = `M${xsOut[0]} ${ysOut[0]}`;
          for (let k = 1; k < xsOut.length; k++) d += `L${xsOut[k]} ${ysOut[k]}`;
          parts.push(`${d}Z`);
        }
      }
    }
    if (parts.length) result[classNames[i]!] = parts.join('');
  }
  return result;
}
