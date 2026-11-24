import { normalizeLon, prepareGridGeometry, snapGridCoordinate, withinGeographicBounds, type GeographicBounds, type Grid, type GridGeometry } from '@av/contracts/geometry';
import { STATUS_MASK, STATUS_NO_LIFT, STATUS_OUTSIDE, STATUS_UNAVAILABLE, STATUS_VALID, SUPPORT_MASK } from '@av/contracts/layers';
import { WIND_FINE_CELL_BYTES, type TileMask } from '@av/contracts/wind-data';
import { nearerContributor, type SamplePlan } from '@av/forecast/sampler';
import { decodePackedWindChunk, type PackedWindChunk } from '@av/forecast/wind';

export const MAX_CHUNKS = 64;

// Scratch shared by every sample on the main thread; callers reset lengths after use.
const plans: SamplePlan[] = Array.from({ length: 2 }, () => ({ contributors: Array.from({ length: 4 }, () => ({ index: 0, row: 0, column: 0, weight: 0 })), byteRange: { offset: 0, length: 0 } }));
const planContributors = plans.map(plan => [...plan.contributors]);
export const chunks: (PackedWindChunk | undefined)[] = [], offsets: number[] = [], values = new Float64Array(4), flags = new Uint8Array(4);

export function samplingPlan(grid: Grid, geometry: GridGeometry, lat: number, lon: number, slot: number): SamplePlan | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isSafeInteger(grid.width) || !Number.isSafeInteger(grid.height) || grid.width <= 0 || grid.height <= 0) return null;
  let x: number, y: number;
  if (grid.kind === 'regular-latlon') {
    if (!Number.isFinite(grid.lon0) || !Number.isFinite(grid.lat0) || !Number.isFinite(grid.dx) || !Number.isFinite(grid.dy) || !grid.dx || !grid.dy || lat < -90 || lat > 90) return null;
    x = snapGridCoordinate((lon - grid.lon0) / grid.dx); y = snapGridCoordinate((lat - grid.lat0) / grid.dy);
    if (grid.wrapLongitude) x = snapGridCoordinate(((x % grid.width) + grid.width) % grid.width);
  } else {
    const point = geometry.geographicToGrid(lat, lon);
    if (!point) return null;
    x = point.x; y = point.y;
  }
  if (!Number.isFinite(x) || !Number.isFinite(y) || (!grid.wrapLongitude && (x < 0 || x > grid.width - 1)) || y < 0 || y > grid.height - 1) return null;
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, plan = plans[slot];
  let count = 0;
  for (let dy = 0; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++) {
    if ((dx && fx === 0) || (dy && fy === 0)) continue;
    const item = planContributors[slot][count++];
    item.row = y0 + dy; item.column = (x0 + dx) % grid.width; item.index = item.row * grid.width + item.column;
    item.weight = (dy ? fy : 1 - fy) * (dx ? fx : 1 - fx);
    plan.contributors[count - 1] = item;
  }
  plan.contributors.length = count;
  return plan;
}

export function targetHeight(plan: SamplePlan, height: number | 'lift'): { value: number | null; status: number } {
  if (height !== 'lift' && (!Number.isFinite(height) || height < 0)) throw new RangeError('Invalid AGL height');
  let missing = false, allNoLift = true, noLiftWeight = 0, nearest = 0;
  for (let i = 0; i < plan.contributors.length; i++) {
    const status = flags[i] & STATUS_MASK, item = planContributors[1][i], best = plan.contributors[nearest];
    if (height !== 'lift' && (status === STATUS_NO_LIFT || (flags[i] & SUPPORT_MASK) !== 0)) throw new RangeError('Terrain cell has lift status or support');
    missing ||= status >= STATUS_UNAVAILABLE; allNoLift &&= status === STATUS_NO_LIFT;
    if (status === STATUS_NO_LIFT) noLiftWeight += item.weight;
    if (nearerContributor(item.weight, item.row, item.column, best.weight, best.row, best.column)) nearest = i;
  }
  if (missing || plan.contributors.length === 1) {
    const idx = missing ? nearest : 0, status = flags[idx] & STATUS_MASK;
    return { value: status === STATUS_VALID ? height === 'lift' ? values[idx] : values[idx] + height : null, status };
  }
  if (height === 'lift' && (allNoLift || noLiftWeight > 0.5)) return { value: null, status: STATUS_NO_LIFT };
  let value = 0;
  for (let i = 0; i < plan.contributors.length; i++) {
    value += values[i] * plan.contributors[i].weight;
  }
  return { value: height === 'lift' ? value : value + height, status: STATUS_VALID };
}

export function tilesForBounds(grid: Grid, bounds: GeographicBounds, size: number, padding = 2, mask?: TileMask): number[] | null {
  const geometry = prepareGridGeometry(grid), [west, south, east, north] = bounds;
  const span = west <= east ? east - west : east + 360 - west;
  if (span > 180) {
    const count = mask ? mask.count : Math.ceil(grid.width / size) * Math.ceil(grid.height / size);
    return count <= MAX_CHUNKS ? Array.from({ length: count }, (_, i) => i) : null;
  }
  const points: Array<{ x: number; y: number }> = [];
  for (let y = 0; y <= 32; y++) for (let x = 0; x <= 32; x++) {
    const point = geometry.geographicToGrid(south + (north - south) * y / 32, normalizeLon(west + span * x / 32));
    if (point) points.push(point);
  }
  for (const x of [0, (grid.width - 1) / 2, grid.width - 1]) for (const y of [0, (grid.height - 1) / 2, grid.height - 1]) {
    const point = geometry.gridToGeographic(x, y);
    if (point && withinGeographicBounds(point.lat, point.lon, bounds)) points.push({ x, y });
  }
  if (!points.length) return [];
  const w = Math.ceil(grid.width / size), h = Math.ceil(grid.height / size);
  const xs = points.map(p => p.x), ys = points.map(p => p.y), minX = Math.min(...xs), maxX = Math.max(...xs);
  const y0 = Math.max(0, Math.floor((Math.min(...ys) - padding) / size)), y1 = Math.min(h - 1, Math.floor((Math.max(...ys) + padding) / size));
  const intervals = grid.wrapLongitude && maxX - minX > grid.width / 2
    ? [[0, Math.max(...xs.filter(x => x < grid.width / 2)) + padding], [Math.min(...xs.filter(x => x >= grid.width / 2)) - padding, grid.width - 1]]
    : [[minX - padding, maxX + padding]];
  if (grid.wrapLongitude) for (const [s, e] of [...intervals]) {
    if (s < 0) intervals.push([grid.width + s, grid.width - 1]);
    if (e >= grid.width) intervals.push([0, e - grid.width]);
  }
  const result = new Set<number>();
  for (const [s, e] of intervals) {
    const x0 = Math.max(0, Math.floor(s / size)), x1 = Math.min(w - 1, Math.floor(e / size));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const logical = y * w + x, slot = mask ? mask.slot(logical) : logical;
      if (slot >= 0 && result.add(slot).size > MAX_CHUNKS) return null;
    }
  }
  return [...result];
}

export function overviewCoordinate(point: number, length: number, stride: number, wrap = false): number {
  const last = Math.ceil(length / stride) - 1, center = (stride - 1) / 2, tail = length - last * stride;
  if (!last) return 0;
  if (tail < stride) {
    if (point > (last - 1) * stride + center) return last - 1 + (point - (last - 1) * stride - center) / ((stride + tail) / 2);
    if (wrap && point < center) return (point - center) / ((stride + tail) / 2);
  }
  return (point - center) / stride;
}

export function validateChunk(kind: string, bytes: Uint8Array, tileSize: number, levels: number, isOverview: boolean): PackedWindChunk | DataView {
  if (kind === 'wind') {
    const columns = decodePackedWindChunk(bytes);
    if (columns.count !== tileSize ** 2 || columns.levels !== levels) throw new Error('Numeric chunk dimensions mismatch');
    return columns;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (isOverview) {
    for (let i = 0; i < bytes.length; i += 9) {
      const u = view.getFloat32(i, true), v = view.getFloat32(i + 4, true), status = view.getUint8(i + 8);
      if (status > STATUS_OUTSIDE || !Number.isFinite(u) || !Number.isFinite(v) || (status !== STATUS_VALID && (u !== 0 || v !== 0))) throw new Error('Invalid numeric overview');
    }
    return view;
  }
  for (let i = 0; i < bytes.length; i += WIND_FINE_CELL_BYTES) {
    const packed = view.getUint8(i + 8), support = view.getUint8(i + 9), terrain = packed & STATUS_MASK, lift = (packed >> 2) & STATUS_MASK;
    if ((packed & 0xe0) !== 0 || (support & ~SUPPORT_MASK) !== 0 || terrain === STATUS_NO_LIFT
      || (terrain === STATUS_VALID && !Number.isFinite(view.getFloat32(i, true)))
      || (lift <= STATUS_NO_LIFT && !Number.isFinite(view.getFloat32(i + 4, true)))) throw new Error('Invalid numeric companion');
  }
  return view;
}
