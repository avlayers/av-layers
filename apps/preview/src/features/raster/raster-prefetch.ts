import type { Map } from 'maplibre-gl';
import { frameTileUrl, layerMaxZoom, planViewportPrefetch, type RasterTileSourceProtocol, viewportTiles } from '@av/client';
import type { LayerId } from '@av/contracts/layers';
import { renderedFrames } from '@av/contracts/publication';
import { pairedLiftLayer } from '../../layers/registry';
import { boundsAreaKm2, cameraBounds, createViewportWarmth } from '../map/viewport-policy';
import { matches, type RasterSelection, type Slot } from './raster-slots';

type Direction = 1 | -1 | undefined;

/** Selections to prepare next after `slot`, most likely first: the preferred one, the paired lift layer, adjacent frames, then sibling layers. */
export function predictSelections(slot: RasterSelection | null, preferred: RasterSelection | null, direction: Direction): RasterSelection[] {
  if (!slot) return [];
  const selections: RasterSelection[] = [];
  const add = (layer: LayerId, frame: string | undefined) => {
    if (!frame || !slot.build.templates[layer]) return;
    const v = { build: slot.build, layer, frame };
    if (!matches(v, slot) && !selections.some(i => matches(i, v))) selections.push(v);
  };
  if (preferred?.build === slot.build) add(preferred.layer, preferred.frame);
  const frames = renderedFrames(slot.build.manifest), index = frames.findIndex(f => f.id === slot.frame);
  const siblings = (Object.keys(slot.build.templates) as LayerId[]).filter(id => id !== slot.layer);
  const primary = pairedLiftLayer(slot.layer) ?? siblings[0];
  if (!direction && primary) add(primary, slot.frame);
  const step = frames[index + (direction ?? 1)] ? direction ?? 1 : -(direction ?? 1);
  for (const offset of direction ? [step, 2 * step, -step] : [step, -step, 2 * step]) add(slot.layer, frames[index + offset]?.id);
  for (const sib of siblings) add(sib, slot.frame);
  return selections;
}

/** Other frame ids of `slot`'s build, playback direction first, nearest first. */
export function timelineFrames(slot: RasterSelection, direction: Direction): string[] {
  const frames = renderedFrames(slot.build.manifest), index = frames.findIndex(f => f.id === slot.frame);
  const before = frames.slice(0, index).reverse(), after = frames.slice(index + 1);
  return (direction === -1 ? [...before, ...after] : [...after, ...before]).map(f => f.id);
}

interface PrefetchHost {
  readonly map: Map;
  protocol(): RasterTileSourceProtocol | null;
  /** The displayed slot when it matches the request and the camera is still. */
  target(): Slot | null;
  /** Whether `slot` is still displayed for the request and byte warming may continue. */
  current(slot: Slot): boolean;
  disposed(): boolean;
  prepared(): Slot[];
  preferred(): RasterSelection | undefined;
  direction(): Direction;
  /** Live required detail keys of the requested frame. */
  requiredKeys(): ReadonlySet<string>;
  refreshRequired(): void;
  emit(): void;
}

/**
 * Warms tile bytes for frames around the displayed one, and records frames whose bytes are cached
 * (`readyFrames`). Small viewports warm the viewport plan; wide ones walk the timeline with the required keys.
 */
export class BytePrefetcher {
  private readonly jobs = new globalThis.Map<string, AbortController>();
  private readonly promises = new globalThis.Map<string, Promise<boolean>>();
  private readonly warmth = createViewportWarmth();
  private readonly ready = new Set<string>();
  private done = false;
  private cursor = 0;
  private running = false;
  private evictions = 0;

  constructor(private readonly host: PrefetchHost) {}

  get readyFrames(): string[] { return [...this.ready]; }
  clearReady(): void { this.ready.clear(); }
  /** Forgets ready frames when the protocol cache evicted since the last call. */
  syncEvictions(generation: number): void {
    if (generation !== this.evictions) { this.evictions = generation; if (this.ready.size) this.ready.clear(); }
  }

  /** Aborts jobs outside `keep`'s frame and restarts planning. */
  cancel(keep?: RasterSelection): void {
    const template = keep && frameTileUrl(keep.build.templates[keep.layer], keep.frame);
    const prefix = template?.slice(0, template.indexOf('{z}'));
    for (const [url, ctrl] of this.jobs) if (!prefix || !url.startsWith(prefix)) { ctrl.abort(); this.jobs.delete(url); }
    this.done = false; this.cursor = 0; this.promises.clear();
  }

  private one(url: string): Promise<boolean> {
    const existing = this.promises.get(url);
    if (existing) return existing;
    const protocol = this.host.protocol();
    if (!protocol) return Promise.resolve(false);
    const ctrl = new AbortController(); this.jobs.set(url, ctrl);
    const promise = protocol.prefetch(url, ctrl.signal).then(() => true).catch(() => false).finally(() => {
      if (this.jobs.get(url) === ctrl) this.jobs.delete(url);
      if (this.promises.get(url) === promise) this.promises.delete(url);
    });
    this.promises.set(url, promise);
    return promise;
  }

  run(): void {
    const host = this.host, map = host.map, slot = host.target();
    if (!slot || !host.protocol() || this.done) return;
    this.done = true;
    const bounds = map.getBounds(), z = Math.min(layerMaxZoom(slot.build.manifest, slot.layer), Math.max(0, Math.round(map.getZoom()) + 1));
    const tiles = viewportTiles({ west: bounds.getWest(), east: bounds.getEast(), south: bounds.getSouth(), north: bounds.getNorth() }, z);
    const prepared = host.prepared();
    const warming = this.warmth.update(boundsAreaKm2(cameraBounds(map))), timeline = timelineFrames(slot, host.direction());
    if (warming && !host.requiredKeys().size) host.refreshRequired();
    const useKeyedHorizon = warming && host.requiredKeys().size > 0;
    if (!useKeyedHorizon) {
      const urls = planViewportPrefetch({ build: slot.build, activeLayer: slot.layer, activeFrame: slot.frame, viewportTiles: tiles,
        preferred: host.preferred(), direction: host.direction(), prepared, timelineFrames: warming ? timeline : timeline.slice(0, 4) });
      for (const url of new Set(urls)) void this.one(url);
    }
    const preparedFrames = new Set(prepared.map(item => item.frame));
    for (const frame of warming ? timeline : timeline.slice(0, 4)) if (preparedFrames.has(frame) && !this.ready.has(frame)) { this.ready.add(frame); host.emit(); }
    const template = slot.build.templates[slot.layer];
    if (!useKeyedHorizon || this.running || !template) return;
    const perFrame = host.requiredKeys().size;
    const batch = timeline.slice(this.cursor, this.cursor + Math.max(1, Math.floor(64 / Math.min(perFrame, 64))));
    if (!batch.length) return;
    this.running = true; this.cursor += batch.length;
    const jobs = batch.map(async frame => {
      const frameTemplate = frameTileUrl(template, frame);
      const frameUrls = [...host.requiredKeys()].map(key => {
        const [z, x, y] = key.split('/');
        return frameTemplate.replaceAll('{z}', z!).replaceAll('{x}', x!).replaceAll('{y}', y!);
      });
      if (!frameUrls.length) return false;
      let ok = true;
      for (let index = 0; index < frameUrls.length; index += 64) {
        const results = await Promise.all(frameUrls.slice(index, index + 64).map(url => this.one(url)));
        if (!results.every(Boolean)) { ok = false; break; }
      }
      if (ok && !host.disposed()) { this.ready.add(frame); host.emit(); }
      return ok;
    });
    void Promise.all(jobs).finally(() => {
      this.running = false;
      if (host.current(slot) && this.cursor < timeline.length && this.warmth.warming) {
        this.done = false; queueMicrotask(() => this.run());
      }
    });
  }
}
