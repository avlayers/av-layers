// Isoband contouring of a sampled chart grid into evenodd SVG paths, on d3-contour.

import { contours } from 'd3-contour';
import { clamp } from './windgram-format.ts';

/**
 * Contours `values` (row-major, `rows + 1` by `cols + 1`; NaN counts as below every threshold) into one
 * evenodd path per band: the area at or above `thresholds[i]` minus the area at or above `thresholds[i + 1]`.
 */
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
  const plotHeight = plotBottom - plotTop;
  // d3-contour puts sample (c, r) at (c + 0.5, r + 0.5) and closes rings half a cell outside the grid.
  const xOf = (gx: number) => {
    const c = clamp(gx - 0.5, 0, cols), lo = c | 0, hi = Math.min(cols, lo + 1);
    return xs[lo]! + (xs[hi]! - xs[lo]!) * (c - lo);
  };
  const yOf = (gy: number) => plotTop + (clamp(gy - 0.5, 0, rows) / rows) * plotHeight;
  const generator = contours().size([cols + 1, rows + 1]);
  const pathCache = new Map<number, string>();
  const pathAt = (t: number): string => {
    let path = pathCache.get(t);
    if (path === undefined) {
      path = ringsPath(generator.contour(values as unknown as number[], t).coordinates.flat(), xOf, yOf);
      pathCache.set(t, path);
    }
    return path;
  };

  const result: Record<string, string> = {};
  for (let i = 0; i < classNames.length; i++) {
    const path = pathAt(thresholds[i]!) + (i + 1 < thresholds.length ? pathAt(thresholds[i + 1]!) : '');
    if (path) result[classNames[i]!] = path;
  }
  return result;
}

/** SVG path for closed rings in grid space, rounded to 0.1 px with collinear points dropped. */
function ringsPath(rings: readonly (readonly (readonly number[])[])[], xOf: (gx: number) => number, yOf: (gy: number) => number): string {
  const round = (v: number) => Math.round(v * 10) / 10;
  let out = '';
  for (const ring of rings) {
    const xsOut: number[] = [], ysOut: number[] = [];
    for (const point of ring) {
      const x = round(xOf(point[0]!)), y = round(yOf(point[1]!));
      const len = xsOut.length;
      if (len > 0 && xsOut[len - 1] === x && ysOut[len - 1] === y) continue;
      if (len >= 2 && Math.abs((xsOut[len - 1]! - xsOut[len - 2]!) * (y - ysOut[len - 2]!) - (ysOut[len - 1]! - ysOut[len - 2]!) * (x - xsOut[len - 2]!)) < 0.3) {
        xsOut[len - 1] = x; ysOut[len - 1] = y;
        continue;
      }
      xsOut.push(x); ysOut.push(y);
    }
    if (xsOut.length < 3) continue;
    out += `M${xsOut[0]} ${ysOut[0]}`;
    for (let k = 1; k < xsOut.length; k++) out += `L${xsOut[k]} ${ysOut[k]}`;
    out += 'Z';
  }
  return out;
}
