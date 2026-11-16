import type { ImageSource, Map } from 'maplibre-gl';
import { clampOpacity, frameTileUrl, layerMaxZoom, previewRasterLayer, seamInsertBefore, type PinnedBuild, type RasterTileSourceProtocol, type RasterTileSourceTransport } from '@av/client';
import type { LayerId } from '@av/contracts/layers';
import { renderedFrames } from '@av/contracts/publication';
import { RASTER_TILE_SIZE } from '@av/contracts/format';
import { PLAYBACK_STEP_MS } from '../timeline/timeline-model';
import { boundsAreaKm2, createViewportWarmth } from '../map/viewport-policy';
import { planRasterCrop, requiredSourceZoom } from './raster-crop';

const DECODE_CAP = 768 * 1024 * 1024;
const MAX_TILES = 64;
const MAX_EDGE = 4096;
const LATITUDE_LIMIT = 85.0511287798066;
interface Window { west: number; east: number; top: number; bottom: number }
interface Tile { x: number; y: number; z: number; canonicalX: number; drawX: number; drawY: number }
interface Box { left: number; right: number; top: number; bottom: number; z: number }
interface Geometry extends Window { tiles: Tile[]; width: number; height: number; zoom: number; coordinates: [[number, number], [number, number], [number, number], [number, number]] }
interface Context { build: PinnedBuild; layer: LayerId; geometry: Geometry; requiredZoom: number; frames: string[] }
const warmth = createViewportWarmth();

export { FOCUS_DWELL_MS } from '../map/viewport-policy';
interface Job { context: Context; frame: string; controller: AbortController }
export interface RasterOverviewState { ready: number; total: number; failed: number }

function viewport(map: Map): Window | null {
  const bounds = map.getBounds();
  let west = bounds.getWest(), east = bounds.getEast();
  const north = Math.min(LATITUDE_LIMIT, bounds.getNorth()), south = Math.max(-LATITUDE_LIMIT, bounds.getSouth());
  if (![west, east, north, south].every(Number.isFinite) || north <= south) return null;
  if (east <= west) east += 360;
  if (east <= west) return null;
  const middle = (west + east) / 2, span = Math.min(360, east - west);
  // Shift the entire rectangle together so dateline corners retain their separation.
  const shift = Math.floor((middle + 180) / 360) * 360;
  west = (middle - span / 2 - shift + 180) / 360;
  east = west + span / 360;
  const y = (latitude: number) => Math.max(0, Math.min(1, (1 - Math.asinh(Math.tan(latitude * Math.PI / 180)) / Math.PI) / 2));
  return { west, east, top: y(north), bottom: y(south) };
}

function deviceHoldsTimeline(): boolean {
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return memory === undefined || memory > 4;
}

function tileBox(window: Window, z: number): Box | null {
  const count = 2 ** z;
  const left = Math.floor(window.west * count), right = Math.ceil(window.east * count) - 1;
  const top = Math.floor(window.top * count), bottom = Math.min(count - 1, Math.ceil(window.bottom * count) - 1);
  if (right < left || bottom < top || left < -count || right >= count * 2) return null;
  return { left, right, top, bottom, z };
}

function expand(box: Box, margin: number): Box {
  const count = 2 ** box.z;
  return {
    z: box.z,
    left: Math.max(-count, box.left - margin),
    right: Math.min(count * 2 - 1, box.right + margin),
    top: Math.max(0, box.top - margin),
    bottom: Math.min(count - 1, box.bottom + margin)
  };
}

function fits(box: Box, frames: number): boolean {
  const cols = box.right - box.left + 1, rows = box.bottom - box.top + 1;
  if (cols < 1 || rows < 1 || cols * rows > MAX_TILES) return false;
  if (cols * RASTER_TILE_SIZE > MAX_EDGE || rows * RASTER_TILE_SIZE > MAX_EDGE) return false;
  return frames * cols * rows * RASTER_TILE_SIZE * RASTER_TILE_SIZE * 4 <= DECODE_CAP;
}

function toGeometry(box: Box): Geometry {
  const count = 2 ** box.z, tiles: Tile[] = [];
  const originX = box.left * RASTER_TILE_SIZE, originY = box.top * RASTER_TILE_SIZE;
  for (let y = box.top; y <= box.bottom; y++) for (let x = box.left; x <= box.right; x++) tiles.push({
    x, y, z: box.z, canonicalX: ((x % count) + count) % count, drawX: x * RASTER_TILE_SIZE - originX, drawY: y * RASTER_TILE_SIZE - originY
  });
  const latitude = (y: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / count))) * 180 / Math.PI;
  let west = box.left / count * 360 - 180, east = (box.right + 1) / count * 360 - 180;
  const shift = Math.floor(((west + east) / 2 + 180) / 360) * 360;
  west -= shift; east -= shift;
  return {
    west: box.left / count, east: (box.right + 1) / count, top: box.top / count, bottom: (box.bottom + 1) / count,
    tiles, zoom: box.z,
    width: (box.right - box.left + 1) * RASTER_TILE_SIZE,
    height: (box.bottom - box.top + 1) * RASTER_TILE_SIZE,
    coordinates: [[west, latitude(box.top)], [east, latitude(box.top)], [east, latitude(box.bottom + 1)], [west, latitude(box.bottom + 1)]]
  };
}

function requiredZoom(map: Map, maxzoom: number): number {
  const covering = typeof map.coveringTiles === 'function'
    ? map.coveringTiles({ tileSize: RASTER_TILE_SIZE, minzoom: 0, maxzoom, roundZoom: true })
      .map(tile => ({ z: tile?.canonical?.z ?? tile?.overscaledZ })).filter(tile => Number.isFinite(tile.z))
    : null;
  const zoom = covering ? requiredSourceZoom(covering) : null;
  return zoom ?? Math.max(0, Math.min(maxzoom, Math.round(map.getZoom())));
}

/** Native-pixel crop for small views; the mosaic remains the wide-view fallback. */
function cropGeometry(map: Map, maxzoom: number, frames: number): Geometry | null {
  const window = viewport(map), bounds = map.getBounds();
  if (!window || window.bottom <= window.top) return null;
  const west = bounds.getWest(), east = bounds.getEast(), south = bounds.getSouth(), north = bounds.getNorth();
  const area = boundsAreaKm2([west, south, east, north]);
  if (!warmth.update(area)) return null;
  const zoom = requiredZoom(map, maxzoom);
  const crop = planRasterCrop([west, south, east, north], zoom);
  if (!crop || frames * crop.bytes > DECODE_CAP) return null;
  return {
    west: window.west, east: window.east, top: window.top, bottom: window.bottom,
    tiles: crop.tiles, width: crop.width, height: crop.height, zoom, coordinates: crop.coordinates
  };
}

/** Padded tile mosaic for a rested camera. Shrink the margin before dropping zoom. */
function geometry(map: Map, maxzoom: number, frames: number): Geometry | null {
  const crop = cropGeometry(map, maxzoom, frames);
  if (crop) return crop;
  const window = viewport(map);
  if (!window || window.bottom <= window.top || !Number.isFinite(map.getZoom())) return null;
  const target = Math.max(0, Math.min(maxzoom, Math.round(map.getZoom())));
  const retained = deviceHoldsTimeline() ? frames : Math.min(frames, 5);
  for (let z = target; z >= 0; z--) {
    const base = tileBox(window, z);
    if (!base) continue;
    const span = Math.min(base.right - base.left + 1, base.bottom - base.top + 1);
    const padded = expand(base, Math.max(1, Math.ceil(span / 2)));
    if (fits(padded, retained)) return toGeometry(padded);
    const ring = expand(base, 1);
    if (fits(ring, retained)) return toGeometry(ring);
    if (fits(base, retained)) return toGeometry(base);
  }
  return null;
}

/** Decoded images for every map frame of one rested build and layer. */
export class RasterOverview {
  readonly id = `av-overview-${crypto.randomUUID()}`;
  private readonly blendId: string;
  readonly supported: boolean;
  private playing = false;
  private readonly canvas: OffscreenCanvas | null;
  private readonly transport: RasterTileSourceTransport | null;
  private context: Context | null = null;
  private selected: string | null = null;
  private shown: string | null = null;
  private readonly images = new globalThis.Map<string, ImageBitmap>();
  private readonly unavailable = new Set<string>();
  private readonly retried = new Set<string>();
  private job: Job | null = null;
  private expiry: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly map: Map, private readonly protocol: RasterTileSourceProtocol, private readonly onReady: () => void) {
    this.blendId = `${this.id}-blend`;
    this.canvas = typeof OffscreenCanvas === 'function' && typeof createImageBitmap === 'function' && typeof map.getCanvas === 'function'
      ? new OffscreenCanvas(RASTER_TILE_SIZE, RASTER_TILE_SIZE) : null;
    this.supported = !!this.canvas?.getContext('2d') && typeof this.canvas.transferToImageBitmap === 'function';
    if (this.canvas) { this.canvas.width = 0; this.canvas.height = 0; }
    this.transport = this.supported ? protocol.createSource(false) : null;
  }

  get state(): RasterOverviewState {
    const frames = this.context?.frames ?? [];
    return { ready: frames.filter(frame => this.images.has(frame)).length, total: frames.length, failed: frames.filter(frame => this.unavailable.has(frame)).length };
  }

  select(build: PinnedBuild, layer: LayerId, frame: string): void {
    if (!this.supported || this.disposed) return;
    if (build.expiresAtMs <= Date.now() || !build.templates[layer] || !renderedFrames(build.manifest).some(value => value.id === frame)) { this.clear(); return; }
    const required = requiredZoom(this.map, layerMaxZoom(build.manifest, layer));
    if (this.context?.build !== build || this.context.layer !== layer || this.context.requiredZoom !== required || !this.covers()) {
      this.clear();
      const frames = renderedFrames(build.manifest);
      const area = geometry(this.map, layerMaxZoom(build.manifest, layer), frames.length);
      if (!area) return;
      this.canvas!.width = area.width; this.canvas!.height = area.height;
      this.context = { build, layer, geometry: area, requiredZoom: required, frames: [] };
      this.protocol.setBuildExpiry(build.manifest.buildId, build.expiresAtMs);
      this.expiry = setTimeout(() => this.refresh(), Math.min(build.expiresAtMs - Date.now(), 2_147_000_000));
    }
    this.selected = frame;
    this.window();
    if (this.unavailable.delete(frame) || this.job?.frame !== frame) this.retried.delete(frame);
    if (this.job && this.job.frame !== frame && !this.images.has(frame)) this.job.controller.abort();
    this.pump();
  }

  setPlayback(playing: boolean): void {
    this.playing = playing;
    if (!playing) this.removeBlend();
  }

  coversView(): boolean { return this.covers(); }

  hasExtent(): boolean { return this.context !== null; }

  ready(build: PinnedBuild, layer: LayerId, frame: string): boolean {
    return !this.disposed && this.context?.build === build && this.context.layer === layer && build.expiresAtMs > Date.now() && this.images.has(frame) && this.covers();
  }

  show(build: PinnedBuild, layer: LayerId, frame: string, opacity: number): boolean {
    if (!this.ready(build, layer, frame)) return false;
    const coordinates = this.context!.geometry.coordinates;
    if (!this.map.getSource(this.id)) {
      this.map.addSource(this.id, { type: 'image', coordinates });
      this.map.addLayer({ ...previewRasterLayer(0), id: this.id, source: this.id, paint: { ...previewRasterLayer(0).paint, 'raster-opacity-transition': { duration: 0, delay: 0 } } }, seamInsertBefore(this.map));
    }
    if (this.shown !== frame) {
      const previous = this.playing && this.shown ? this.images.get(this.shown) : undefined;
      (this.map.getSource(this.id) as ImageSource).updateImage({ image: this.images.get(frame)!, coordinates });
      this.shown = frame;
      if (previous) this.crossfade(previous, coordinates);
    }
    this.map.setPaintProperty(this.id, 'raster-opacity', clampOpacity(opacity));
    return true;
  }

  hide(): void {
    if (this.map.getLayer(this.id)) this.map.setPaintProperty(this.id, 'raster-opacity', 0);
    if (this.map.getLayer(this.blendId)) this.map.setPaintProperty(this.blendId, 'raster-opacity', 0);
  }

  refresh(): void { if (this.context && this.context.build.expiresAtMs <= Date.now()) { this.clear(); this.onReady(); } }

  clear(): void {
    this.job?.controller.abort();
    this.context = null; this.selected = null; this.shown = null;
    if (this.expiry !== null) clearTimeout(this.expiry); this.expiry = null;
    this.removeBlend();
    if (this.map.getLayer(this.id)) this.map.removeLayer(this.id);
    if (this.map.getSource(this.id)) this.map.removeSource(this.id);
    for (const image of this.images.values()) image.close();
    this.images.clear(); this.unavailable.clear(); this.retried.clear();
    if (this.canvas) { this.canvas.width = 0; this.canvas.height = 0; }
  }

  destroy(): void { this.disposed = true; this.clear(); this.transport?.dispose(); }

  private crossfade(image: ImageBitmap, coordinates: Geometry['coordinates']): void {
    const id = this.blendId;
    if (!this.map.getSource(id)) {
      this.map.addSource(id, { type: 'image', coordinates });
      this.map.addLayer({ ...previewRasterLayer(1), id, source: id, paint: { ...previewRasterLayer(1).paint, 'raster-opacity-transition': { duration: 0, delay: 0 } } }, seamInsertBefore(this.map));
    }
    (this.map.getSource(id) as ImageSource).updateImage({ image, coordinates });
    this.map.setPaintProperty(id, 'raster-opacity-transition', { duration: 0, delay: 0 });
    this.map.setPaintProperty(id, 'raster-opacity', 1);
    this.map.setPaintProperty(id, 'raster-opacity-transition', { duration: PLAYBACK_STEP_MS, delay: 0 });
    queueMicrotask(() => { if (this.playing && this.map.getLayer(id)) this.map.setPaintProperty(id, 'raster-opacity', 0); });
  }

  private removeBlend(): void {
    if (this.map.getLayer(this.blendId)) this.map.removeLayer(this.blendId);
    if (this.map.getSource(this.blendId)) this.map.removeSource(this.blendId);
  }

  private covers(): boolean {
    const current = viewport(this.map), area = this.context?.geometry;
    if (!current || !area) return false;
    const shift = Math.round((area.west + area.east - current.west - current.east) / 2), epsilon = 1e-9;
    return current.top >= area.top - epsilon && current.bottom <= area.bottom + epsilon
      && (area.east - area.west >= 1 - epsilon || (current.west + shift >= area.west - epsilon && current.east + shift <= area.east + epsilon));
  }

  private window(): void {
    if (!this.context || !this.selected) return;
    const frames = renderedFrames(this.context.build.manifest).map(frame => frame.id), index = frames.indexOf(this.selected);
    const retained = deviceHoldsTimeline() ? frames.slice() : frames.slice(Math.max(0, index - 2), index + 3);
    if (this.shown && !retained.includes(this.shown)) retained.push(this.shown);
    this.context.frames = retained;
    for (const [frame, image] of this.images) if (!retained.includes(frame)) { image.close(); this.images.delete(frame); }
  }

  private pump(): void {
    const context = this.context;
    if (this.disposed || this.job || !context || context.build.expiresAtMs <= Date.now()) return;
    const all = renderedFrames(context.build.manifest), idx = new globalThis.Map(all.map((f, i) => [f.id, i])), selected = idx.get(this.selected ?? '') ?? -1;
    const frame = context.frames.filter(f => !this.images.has(f) && !this.unavailable.has(f))
      .sort((a, b) => Math.abs((idx.get(a) ?? 0) - selected) - Math.abs((idx.get(b) ?? 0) - selected))[0];
    if (!frame || this.context !== context || this.disposed || this.job) return;
    const job: Job = { context, frame, controller: new AbortController() }; this.job = job;
    void this.load(job).then(image => {
      if (!this.current(job) || !context.frames.includes(frame)) { image.close(); return; }
      const previous = this.images.get(frame);
      this.images.set(frame, image);
      if (previous && previous !== image) previous.close();
      this.retried.delete(frame);
      this.onReady();
    }).catch(() => {
      if (!this.current(job)) return;
      if (frame === this.selected && !this.retried.has(frame)) { this.retried.add(frame); return; }
      this.unavailable.add(frame); this.onReady();
    }).finally(() => {
      if (this.job === job) this.job = null;
      this.pump();
    });
  }

  private current(job: Job): boolean {
    return !this.disposed && this.context === job.context && !job.controller.signal.aborted && job.context.build.expiresAtMs > Date.now();
  }

  private async load(job: Job): Promise<ImageBitmap> {
    const context = this.canvas!.getContext('2d')!, area = job.context.geometry;
    context.clearRect(0, 0, area.width, area.height);
    const template = frameTileUrl(job.context.build.templates[job.context.layer], job.frame);
    for (let offset = 0; offset < area.tiles.length; offset += 2) {
      const results = await Promise.allSettled(area.tiles.slice(offset, offset + 2).map(async tile => {
        const url = template.replaceAll('{z}', String(tile.z)).replaceAll('{x}', String(tile.canonicalX)).replaceAll('{y}', String(tile.y));
        const response = await this.protocol.load({ url: this.transport!.url(url) }, job.controller);
        if (!this.current(job)) throw new Error('Overview cancelled');
        const image = await createImageBitmap(new Blob([response.data], { type: 'image/webp' }));
        if (!this.current(job) || image.width !== RASTER_TILE_SIZE || image.height !== RASTER_TILE_SIZE) { image.close(); throw new Error('Invalid overview tile'); }
        return { tile, image };
      }));
      try {
        if (!this.current(job) || results.some(result => result.status === 'rejected')) throw new Error('Incomplete overview');
        for (const result of results) if (result.status === 'fulfilled') {
          const { tile, image } = result.value;
          context.drawImage(image, tile.drawX, tile.drawY, RASTER_TILE_SIZE, RASTER_TILE_SIZE);
        }
      } finally {
        for (const result of results) if (result.status === 'fulfilled') result.value.image.close();
      }
    }
    if (!this.current(job)) throw new Error('Overview cancelled');
    return this.canvas!.transferToImageBitmap();
  }
}
