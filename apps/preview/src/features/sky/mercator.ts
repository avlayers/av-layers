import type { Map as MapLibreMap } from 'maplibre-gl';

export const MAX_LAT = 85.05112878;
const DEG = Math.PI / 180;

export function mercY(lat: number): number {
  const clamped = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
  return Math.asinh(Math.tan(clamped * DEG));
}

export function invMercY(my: number): number {
  return Math.atan(Math.sinh(my)) / DEG;
}

export interface FastMercatorProjector {
  readonly cx: number;
  readonly cy: number;
  readonly cLon: number;
  readonly cMy: number;
  readonly kx: number;
  readonly ky: number;
}

/** Fits a linear lon/Mercator-Y to screen map around the centre; null when the view is not flat Mercator. */
export function calibrateMercatorProjector(map: MapLibreMap, centerLon: number, centerLat: number): FastMercatorProjector | null {
  const clampedLat = Math.max(-80, Math.min(80, centerLat));
  const cMy = mercY(clampedLat);
  const dLon = 0.25;
  const dMy = 0.04;
  const nLat = invMercY(cMy + dMy);
  const p0 = map.project([centerLon, clampedLat]);
  const pX = map.project([centerLon + dLon, clampedLat]);
  const pY = map.project([centerLon, nLat]);
  if (Math.abs(pX.y - p0.y) > 0.35 || Math.abs(pY.x - p0.x) > 0.35) return null;

  const kx = (pX.x - p0.x) / dLon;
  const ky = (p0.y - pY.y) / dMy;
  if (!Number.isFinite(kx) || !Number.isFinite(ky) || kx <= 0 || ky <= 0) return null;

  // Probe diagonal midpoint to catch globe curvature or linear-latitude test mocks cleanly.
  const testMy = cMy - dMy * 1.5;
  const testLat = invMercY(testMy);
  const testLon = centerLon - dLon * 1.5;
  const pDiag = map.project([testLon, testLat]);
  const estX = p0.x + (testLon - centerLon) * kx;
  const estY = p0.y + (cMy - testMy) * ky;
  if (Math.abs(pDiag.x - estX) > 0.45 || Math.abs(pDiag.y - estY) > 0.45) return null;

  return { cx: p0.x, cy: p0.y, cLon: centerLon, cMy, kx, ky };
}
