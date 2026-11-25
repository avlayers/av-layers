import type { Grid, LambertConformalGrid, RotatedLatLonGrid } from './grid-schema.js';
export type { Grid, LambertConformalGrid, RegularLatLonGrid, RotatedLatLonGrid } from './grid-schema.js';

export const MAX_GRID_DIMENSION = 0x7fffffff;
export const LAMBERT_GRID_FIELDS = ['kind', 'width', 'height', 'earthRadiusM', 'centralMeridianDeg', 'latitudeOfOriginDeg',
  'standardParallel1Deg', 'standardParallel2Deg', 'x0M', 'y0M', 'dxM', 'dyM', 'wrapLongitude'] as const satisfies readonly (keyof LambertConformalGrid)[];
export const ROTATED_GRID_FIELDS = ['kind', 'width', 'height', 'earthRadiusM', 'lon0', 'lat0', 'dx', 'dy', 'southPoleLatDeg', 'southPoleLonDeg', 'wrapLongitude'] as const satisfies readonly (keyof RotatedLatLonGrid)[];

export type GeographicBounds = readonly [west: number, south: number, east: number, north: number];
export interface GridPoint { x: number; y: number }
export interface GeographicPoint { lat: number; lon: number }
const RAD = Math.PI / 180;
const wrapRadians = (value: number) => ((value + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
const wrapDegrees = (value: number) => ((value + 180) % 360 + 360) % 360 - 180;
export const snapGridCoordinate = (value: number): number => Math.abs(value - Math.round(value)) <= 1e-10 ? Math.round(value) : value;

export interface LocatedSampleCell { column: number; row: number; fractionX: number; fractionY: number }

/** Index of the cell that `planSample` would read. A miss is outside that grid. */
export function locateSampleCell(grid: Grid, lat: number, lon: number, geometry?: GridGeometry | null): LocatedSampleCell | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isSafeInteger(grid.width) || !Number.isSafeInteger(grid.height) || grid.width <= 0 || grid.height <= 0) return null;
  let x: number, y: number;
  if (grid.kind === 'regular-latlon') {
    if (![grid.lon0, grid.lat0, grid.dx, grid.dy].every(Number.isFinite) || grid.dx === 0 || grid.dy === 0 || lat < -90 || lat > 90) return null;
    x = snapGridCoordinate((lon - grid.lon0) / grid.dx);
    y = snapGridCoordinate((lat - grid.lat0) / grid.dy);
    if (grid.wrapLongitude) x = snapGridCoordinate(((x % grid.width) + grid.width) % grid.width);
  } else {
    const projected = geometry === undefined ? sampleGeometry(grid) : geometry;
    if (!projected) return null;
    const point = projected.geographicToGrid(lat, lon);
    if (!point) return null;
    ({ x, y } = point);
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if ((!grid.wrapLongitude && (x < 0 || x > grid.width - 1)) || y < 0 || y > grid.height - 1) return null;
  const column = Math.floor(x), row = Math.floor(y);
  return { column, row, fractionX: x - column, fractionY: y - row };
}

export function nearerContributor(weight: number, row: number, column: number, bestWeight: number, bestRow: number, bestColumn: number): boolean {
  return weight > bestWeight || (weight === bestWeight && (row < bestRow || (row === bestRow && column < bestColumn)));
}

function sampleGeometry(grid: Grid): GridGeometry | null {
  try { return prepareGridGeometry(grid); } catch { return null; }
}

/** Bounds are a coarse geographic admission filter. west > east crosses the dateline. */
export function withinGeographicBounds(lat: number, lon: number, bounds?: GeographicBounds): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return false;
  if (!bounds) return true;
  const [west, south, east, north] = bounds;
  if (![west, south, east, north].every(Number.isFinite) || south < -90 || north > 90 || south > north || west < -180 || west > 180 || east < -180 || east > 180) return false;
  const insideLongitude = (value: number) => west <= east ? value >= west && value <= east : value >= west || value <= east;
  return lat >= south && lat <= north && (insideLongitude(lon) || (Math.abs(lon) === 180 && insideLongitude(-lon)));
}

function longitudeIntervals(west: number, east: number): readonly (readonly [number, number])[] {
  if (!Number.isFinite(west) || !Number.isFinite(east)) return [];
  if (west < -180 || west > 180 || east < -180 || east > 180) {
    if (east < west) return [];
    if (east - west >= 360) return [[-180, 180]];
    const wRaw = normalizeLon(west), eRaw = normalizeLon(east);
    const w = east > west && wRaw === 180 ? -180 : wRaw;
    const e = east > west && eRaw === -180 ? 180 : eRaw;
    if (east > west && w === e) return [[-180, 180]];
    return w <= e ? [[w, e]] : [[w, 180], [-180, e]];
  }
  if (east - west >= 360) return [[-180, 180]];
  return west <= east ? [[west, east]] : [[west, 180], [-180, east]];
}

/** True when two geographic bounding boxes share at least one point, including unwrapped or dateline-crossing longitudes. */
export function boundsOverlap(a?: GeographicBounds | null, b?: GeographicBounds | null): boolean {
  if (!a || !b) return false;
  const [aWest, aSouth, aEast, aNorth] = a, [bWest, bSouth, bEast, bNorth] = b;
  if (![aWest, aSouth, aEast, aNorth, bWest, bSouth, bEast, bNorth].every(Number.isFinite)) return false;
  if (aSouth < -90 || aNorth > 90 || aSouth > aNorth || bSouth < -90 || bNorth > 90 || bSouth > bNorth) return false;
  if (Math.max(aSouth, bSouth) > Math.min(aNorth, bNorth)) return false;
  const aLon = longitudeIntervals(aWest, aEast), bLon = longitudeIntervals(bWest, bEast);
  return aLon.some(([aw, ae]) => bLon.some(([bw, be]) =>
    Math.max(aw, bw) <= Math.min(ae, be) || (aw === -180 && be === 180) || (ae === 180 && bw === -180)
  ));
}

/** Fraction [0, 1] of `viewport` degree-area covered by `candidate`. */
export function boundsOverlapFraction(viewport?: GeographicBounds | null, candidate?: GeographicBounds | null): number {
  if (!boundsOverlap(viewport, candidate)) return 0;
  const [vWest, vSouth, vEast, vNorth] = viewport!, [cWest, cSouth, cEast, cNorth] = candidate!;
  const vLon = longitudeIntervals(vWest, vEast), cLon = longitudeIntervals(cWest, cEast);
  const vLatSpan = vNorth - vSouth, vLonSpan = vLon.reduce((sum, [w, e]) => sum + (e - w), 0);
  if (vLatSpan <= 0 || vLonSpan <= 0) return 0;
  const latOverlap = Math.max(0, Math.min(vNorth, cNorth) - Math.max(vSouth, cSouth));
  let lonOverlap = 0;
  for (const [vw, ve] of vLon) for (const [cw, ce] of cLon) lonOverlap += Math.max(0, Math.min(ve, ce) - Math.max(vw, cw));
  return Math.min(1, (latOverlap * lonOverlap) / (vLatSpan * vLonSpan));
}

function lambertConstants(grid: LambertConformalGrid) {
  const p1 = grid.standardParallel1Deg * RAD, p2 = grid.standardParallel2Deg * RAD;
  const t1 = Math.tan(Math.PI / 4 + p1 / 2), t2 = Math.tan(Math.PI / 4 + p2 / 2);
  const n = Math.abs(p1 - p2) < 1e-14 ? Math.sin(p1) : Math.log(Math.cos(p1) / Math.cos(p2)) / Math.log(t2 / t1);
  const f = Math.cos(p1) * t1 ** n / n;
  const rho0 = grid.earthRadiusM * f / Math.tan(Math.PI / 4 + grid.latitudeOfOriginDeg * RAD / 2) ** n;
  return { n, f, rho0 };
}

export function validGridCellCount(grid: Pick<Grid, 'width' | 'height'>): boolean {
  const cells = grid.width * grid.height;
  return Number.isSafeInteger(cells) && cells < 0xffffffff;
}

export function validLambertProjection(grid: LambertConformalGrid): boolean {
  const { n, f, rho0 } = lambertConstants(grid);
  return Number.isFinite(n) && Math.abs(n) >= 1e-10 && Number.isFinite(f) && Number.isFinite(rho0);
}

export function isValidGridGeometry(grid: Grid): boolean {
  if (!grid || ![grid.width, grid.height].every(size => Number.isSafeInteger(size) && size > 0 && size <= MAX_GRID_DIMENSION)
      || !validGridCellCount(grid) || !Number.isFinite(grid.earthRadiusM) || grid.earthRadiusM <= 0) return false;
  const finiteStep = (step: number) => Number.isFinite(step) && step !== 0;
  if (grid.kind === 'regular-latlon') {
    return Number.isFinite(grid.lon0) && Number.isFinite(grid.lat0) && Math.abs(grid.lat0) <= 90
      && finiteStep(grid.dx) && finiteStep(grid.dy) && typeof grid.wrapLongitude === 'boolean';
  }
  if (grid.kind === 'rotated-latlon') {
    return grid.wrapLongitude === false
      && Number.isFinite(grid.lon0) && grid.lon0 >= -180 && grid.lon0 <= 360
      && Number.isFinite(grid.lat0) && Math.abs(grid.lat0) <= 90
      && finiteStep(grid.dx) && finiteStep(grid.dy)
      && Number.isFinite(grid.southPoleLatDeg) && Math.abs(grid.southPoleLatDeg) < 90
      && Number.isFinite(grid.southPoleLonDeg) && grid.southPoleLonDeg >= -180 && grid.southPoleLonDeg <= 360;
  }
  return grid.kind === 'lambert-conformal' && grid.wrapLongitude === false
    && Number.isFinite(grid.centralMeridianDeg) && Math.abs(grid.centralMeridianDeg) <= 180
    && [grid.latitudeOfOriginDeg, grid.standardParallel1Deg, grid.standardParallel2Deg].every(angle => Number.isFinite(angle) && Math.abs(angle) < 90)
    && Number.isFinite(grid.x0M) && Number.isFinite(grid.y0M) && finiteStep(grid.dxM) && finiteStep(grid.dyM)
    && validLambertProjection(grid);
}

export interface GridGeometry {
  geographicToGrid(lat: number, lon: number): GridPoint | null;
  gridToGeographic(x: number, y: number): GeographicPoint | null;
  /** Grid vectors use positive projected axes, independent of signed storage row/column spacing. */
  rotationAndMetrics(lat: number, lon: number): GridMetrics | null;
}
export interface GridMetrics {
  /** Earth east = cos*u + sin*v; earth north = -sin*u + cos*v. */
  cos: number;
  sin: number;
  /** Projected distance / ground distance; absent for degree-based latitude/longitude. */
  mapScale: number | null;
  metersPerColumn: number;
  metersPerRow: number;
}

/** Compile one validated spherical geometry. No source fields, shared mutable state or caches. */
export function prepareGridGeometry(raw: Grid): GridGeometry {
  if (!isValidGridGeometry(raw)) throw new RangeError('Invalid grid geometry');
  if (raw.kind === 'regular-latlon') {
    const { lon0, lat0, dx, dy, width, earthRadiusM, wrapLongitude } = raw;
    return {
      geographicToGrid(lat, lon) {
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90) return null;
        let x = snapGridCoordinate((lon - lon0) / dx);
        const y = snapGridCoordinate((lat - lat0) / dy);
        if (wrapLongitude) x = snapGridCoordinate(((x % width) + width) % width);
        return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
      },
      gridToGeographic(x, y) {
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        const lat = lat0 + y * dy, lon = lon0 + x * dx;
        if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon)) return null;
        return { lat, lon: wrapDegrees(lon) };
      },
      rotationAndMetrics(lat, lon) {
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) >= 90) return null;
        return { cos: 1, sin: 0, mapScale: null, metersPerColumn: Math.abs(dx) * RAD * earthRadiusM * Math.cos(lat * RAD), metersPerRow: Math.abs(dy) * RAD * earthRadiusM };
      }
    };
  }
  if (raw.kind === 'rotated-latlon') {
    const { lon0, lat0, dx, dy, earthRadiusM, southPoleLatDeg, southPoleLonDeg } = raw;
    const zAngle = southPoleLonDeg * RAD, yAngle = (90 + southPoleLatDeg) * RAD;
    const cosZ = Math.cos(zAngle), sinZ = Math.sin(zAngle), cosY = Math.cos(yAngle), sinY = Math.sin(yAngle);
    const toRotatedRad = (lat: number, lon: number) => {
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90) return null;
      const latRad = lat * RAD, lonRad = lon * RAD, cosLat = Math.cos(latRad), sinLat = Math.sin(latRad);
      const vx = cosLat * Math.cos(lonRad), vy = cosLat * Math.sin(lonRad);
      const rx = vx * cosZ + vy * sinZ, gy = -vx * sinZ + vy * cosZ;
      const gx = rx * cosY + sinLat * sinY, gz = -rx * sinY + sinLat * cosY;
      return { gx, gy, gz, rotLatRad: Math.asin(Math.max(-1, Math.min(1, gz))), rotLonRad: Math.atan2(gy, gx) };
    };
    return {
      geographicToGrid(lat, lon) {
        const rotated = toRotatedRad(lat, lon);
        if (!rotated) return null;
        const x = snapGridCoordinate(wrapDegrees(rotated.rotLonRad / RAD - lon0) / dx);
        const y = snapGridCoordinate((rotated.rotLatRad / RAD - lat0) / dy);
        return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
      },
      gridToGeographic(x, y) {
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        const rotLat = lat0 + y * dy, rotLon = lon0 + x * dx;
        if (!Number.isFinite(rotLat) || rotLat < -90 || rotLat > 90 || !Number.isFinite(rotLon)) return null;
        const rotLatRad = rotLat * RAD, rotLonRad = rotLon * RAD, cosRotLat = Math.cos(rotLatRad);
        const gx = cosRotLat * Math.cos(rotLonRad), gy = cosRotLat * Math.sin(rotLonRad), gz = Math.sin(rotLatRad);
        const rx = gx * cosY - gz * sinY, vz = gx * sinY + gz * cosY;
        const vx = rx * cosZ - gy * sinZ, vy = rx * sinZ + gy * cosZ;
        const lat = Math.asin(Math.max(-1, Math.min(1, vz))) / RAD;
        const lon = wrapDegrees(Math.atan2(vy, vx) / RAD);
        return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
      },
      rotationAndMetrics(lat, lon) {
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) >= 90) return null;
        const rotated = toRotatedRad(lat, lon);
        if (!rotated || Math.hypot(rotated.gx, rotated.gy) < 1e-12) return null;
        const eastRotX = -Math.sin(rotated.rotLonRad), eastRotY = Math.cos(rotated.rotLonRad);
        const ex = eastRotX * cosY, ez = eastRotX * sinY;
        const geoEastX = ex * cosZ - eastRotY * sinZ, geoEastY = ex * sinZ + eastRotY * cosZ;
        const latRad = lat * RAD, lonRad = lon * RAD;
        const sinLat = Math.sin(latRad), cosLat = Math.cos(latRad), sinLon = Math.sin(lonRad), cosLon = Math.cos(lonRad);
        const cos = -geoEastX * sinLon + geoEastY * cosLon;
        const sin = geoEastX * sinLat * cosLon + geoEastY * sinLat * sinLon - ez * cosLat;
        return {
          cos,
          sin,
          mapScale: null,
          metersPerColumn: Math.abs(dx) * RAD * earthRadiusM * Math.cos(rotated.rotLatRad),
          metersPerRow: Math.abs(dy) * RAD * earthRadiusM
        };
      }
    };
  }
  const { centralMeridianDeg, x0M, y0M, dxM, dyM, earthRadiusM } = raw;
  const { n, f, rho0 } = lambertConstants(raw), sign = Math.sign(n);
  const project = (lat: number, lon: number) => {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) >= 90) return null;
    const theta = n * wrapRadians((lon - centralMeridianDeg) * RAD);
    const rho = earthRadiusM * f / Math.tan(Math.PI / 4 + lat * RAD / 2) ** n;
    if (!Number.isFinite(rho)) return null;
    return { theta, rho, x: rho * Math.sin(theta), y: rho0 - rho * Math.cos(theta) };
  };
  return {
    geographicToGrid(lat, lon) {
      const point = project(lat, lon);
      if (!point) return null;
      const x = snapGridCoordinate((point.x - x0M) / dxM), y = snapGridCoordinate((point.y - y0M) / dyM);
      return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
    },
    gridToGeographic(x, y) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      const px = x0M + x * dxM, py = y0M + y * dyM;
      const rho = sign * Math.hypot(px, rho0 - py);
      if (!Number.isFinite(rho) || rho === 0) return null;
      const theta = Math.atan2(sign * px, sign * (rho0 - py));
      if (Math.abs(theta / n) > Math.PI + 1e-12) return null;
      const lat = (2 * Math.atan((earthRadiusM * f / rho) ** (1 / n)) - Math.PI / 2) / RAD;
      const lon = wrapDegrees(centralMeridianDeg + theta / n / RAD);
      return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
    },
    rotationAndMetrics(lat, lon) {
      const point = project(lat, lon);
      if (!point) return null;
      const mapScale = Math.abs(n * point.rho) / (earthRadiusM * Math.cos(lat * RAD));
      if (!Number.isFinite(mapScale) || mapScale <= 0) return null;
      return { cos: Math.cos(point.theta), sin: Math.sin(point.theta), mapScale, metersPerColumn: Math.abs(dxM) / mapScale, metersPerRow: Math.abs(dyM) / mapScale };
    }
  };
}

export function geographicToGrid(grid: Grid, lat: number, lon: number): GridPoint | null {
  return prepareGridGeometry(grid).geographicToGrid(lat, lon);
}
export function gridToGeographic(grid: Grid, x: number, y: number): GeographicPoint | null {
  return prepareGridGeometry(grid).gridToGeographic(x, y);
}
export function gridVectorToEarth(u: number, v: number, rotation: Pick<GridMetrics, 'cos' | 'sin'>): { east: number; north: number } {
  return { east: rotation.cos * u + rotation.sin * v, north: -rotation.sin * u + rotation.cos * v };
}
export function earthVectorToGrid(east: number, north: number, rotation: Pick<GridMetrics, 'cos' | 'sin'>): { u: number; v: number } {
  return { u: rotation.cos * east - rotation.sin * north, v: rotation.sin * east + rotation.cos * north };
}

export function normalizeLon(lon: number): number {
  if (!Number.isFinite(lon)) return lon;
  const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
  return wrapped === -180 && lon > 0 ? 180 : Object.is(wrapped, -0) ? 0 : wrapped;
}

/** Cell-center ring of a non-wrapping grid. A wrapping grid has no drawable edge here. */
export function gridOutline(grid: Grid): GeographicPoint[][] {
  if (!isValidGridGeometry(grid) || grid.wrapLongitude) return [];
  const geometry = prepareGridGeometry(grid);
  const width = grid.width - 1, height = grid.height - 1;
  // Curved projections visit every cell. A coarser step can cross a null cell and still look continuous.
  const step = grid.kind === 'regular-latlon' ? Math.max(width, height, 1) : 1;
  const lines: GeographicPoint[][] = [];
  let current: GeographicPoint[] = [], broke = false;
  const commit = (split: boolean) => {
    if (split) broke = true;
    if (current.length >= 2) lines.push(current);
    current = [];
  };
  const add = (x: number, y: number) => {
    const point = geometry.gridToGeographic(x, y);
    // Unwrapped longitude keeps a short antimeridian crossing in one segment.
    if (point && grid.kind === 'regular-latlon') point.lon = grid.lon0 + x * grid.dx;
    if (!point) { commit(true); return; }
    const previous = current.at(-1);
    if (previous && Math.abs(point.lon - previous.lon) > 180) commit(true);
    const last = current.at(-1);
    if (last && last.lat === point.lat && last.lon === point.lon) return;
    current.push(point);
  };
  const span = (from: number, to: number) => {
    if (from === to) return [from];
    const sign = to > from ? 1 : -1, delta = step * sign, values: number[] = [];
    for (let value = from; sign > 0 ? value < to : value > to; value += delta) values.push(value);
    values.push(to);
    return values;
  };
  const east = span(0, width), north = span(0, height), west = span(width, 0), south = span(height, 0);
  for (const x of east) add(x, 0);
  for (const y of north.slice(1)) add(width, y);
  for (const x of west.slice(1)) add(x, height);
  for (const y of south.slice(1)) add(0, y);
  if (!broke && current.length >= 2) {
    const first = current[0]!, last = current.at(-1)!;
    if ((first.lat !== last.lat || first.lon !== last.lon) && Math.abs(first.lon - last.lon) <= 180) current.push({ ...first });
  }
  if (current.length >= 2) lines.push(current);
  return lines;
}
