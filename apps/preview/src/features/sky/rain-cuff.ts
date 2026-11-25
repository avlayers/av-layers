import type { ResolvedChannelStyles } from '../map/channel-styles';
import type { PrecipField } from './precip-field';

const RAIN_CUFF_EDGE_MMH = 0.65;

/**
 * Computes #1 Asymmetric Inner Vignette Cuff RGBA image via a fast 2-pass Chamfer 3-4 distance transform.
 * Dry exterior pixels stay 100% transparent (`alpha = 0`), while wet edge pixels bleed smoothly inward
 * over `cuffCells` and fade completely to transparent in the interior so lift colors remain vivid!
 */
export function renderRainInnerVignetteRgba(
  field: PrecipField,
  styles: ResolvedChannelStyles,
  outData: Uint8ClampedArray
): boolean {
  const { cols, rows, mmh } = field;
  const n = cols * rows;
  if (field.maxMmh < RAIN_CUFF_EDGE_MMH || outData.length < n * 4) {
    outData.fill(0);
    return false;
  }

  const INF = 30_000;
  const dist = new Uint16Array(n);
  let anyWet = false;
  let anyDry = false;
  for (let i = 0; i < n; i++) {
    if (mmh[i]! >= RAIN_CUFF_EDGE_MMH) {
      dist[i] = INF;
      anyWet = true;
    } else {
      dist[i] = 0;
      anyDry = true;
    }
  }
  if (!anyWet || !anyDry) {
    outData.fill(0);
    return false;
  }

  // Forward Chamfer 3-4 pass
  for (let y = 0; y < rows; y++) {
    const row = y * cols;
    for (let x = 0; x < cols; x++) {
      const i = row + x;
      let d = dist[i]!;
      if (d === 0) continue;
      if (x > 0 && dist[i - 1]! + 3 < d) d = dist[i - 1]! + 3;
      if (y > 0) {
        const up = i - cols;
        if (dist[up]! + 3 < d) d = dist[up]! + 3;
        if (x > 0 && dist[up - 1]! + 4 < d) d = dist[up - 1]! + 4;
        if (x + 1 < cols && dist[up + 1]! + 4 < d) d = dist[up + 1]! + 4;
      }
      dist[i] = d;
    }
  }

  // Backward Chamfer 3-4 pass
  for (let y = rows - 1; y >= 0; y--) {
    const row = y * cols;
    for (let x = cols - 1; x >= 0; x--) {
      const i = row + x;
      let d = dist[i]!;
      if (d === 0) continue;
      if (x + 1 < cols && dist[i + 1]! + 3 < d) d = dist[i + 1]! + 3;
      if (y + 1 < rows) {
        const dn = i + cols;
        if (dist[dn]! + 3 < d) d = dist[dn]! + 3;
        if (x + 1 < cols && dist[dn + 1]! + 4 < d) d = dist[dn + 1]! + 4;
        if (x > 0 && dist[dn - 1]! + 4 < d) d = dist[dn - 1]! + 4;
      }
      dist[i] = d;
    }
  }

  const [cr, cg, cb] = styles.rainEdge.cuffRgb;
  const cuffCells = 13.5;
  const maxAlpha = styles.rainEdge.cuffMaxAlpha;

  let maxPlacedAlpha = 0;
  for (let i = 0; i < n; i++) {
    const off = i * 4;
    const dRaw = dist[i]!;
    if (dRaw === 0) {
      outData[off] = 0;
      outData[off + 1] = 0;
      outData[off + 2] = 0;
      outData[off + 3] = 0;
      continue;
    }
    const dCells = (dRaw - 3) / 3;
    const t = Math.max(0, 1 - dCells / cuffCells);
    const cuffFade = t * t * (1.2 - 0.2 * t);
    const alpha = Math.min(132, Math.round(maxAlpha * cuffFade));
    if (alpha > maxPlacedAlpha) maxPlacedAlpha = alpha;

    outData[off] = cr;
    outData[off + 1] = cg;
    outData[off + 2] = cb;
    outData[off + 3] = alpha;
  }
  return maxPlacedAlpha > 0;
}
