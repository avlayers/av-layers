import { Map as PreviewMap, type MapOptions } from 'maplibre-gl';
import { recognizeViewport, TILE_SIZE, type BenchLayer, type PixelProbe } from '../../scripts/preview-pixels';
import { matchesWind, measureWindCall } from '../../scripts/preview-observe';
import { boundsAreaKm2, cameraBounds } from './src/features/map/viewport-policy';
export * from 'maplibre-gl';

interface TextureMemory { bytes: number; peakBytes: number; rasterBytes: number; peakRasterBytes: number; textures: number; peakTextures: number }
interface InputSample { index: number; targetFrame: string; layer: BenchLayer; inputAt: number; inputEpochMs: number; finishedEpochMs: number | null; sceneMs: number | null; firstCorrectMs: number | null; detailedMs: number | null; combinedMs: number | null; combinedRasterFrame: string | null; combinedWind: WindObservation | null; paintedWindFrames: (string | null)[]; windReadyAtInput: string[]; rasterReadyAtInput: RasterReadiness; targetReadyAtInput: boolean; outcome: 'pending' | 'superseded' | 'combined' | 'detail' | 'scene-only' | 'timeout'; timedOut: boolean; renders: number; pixels?: number[][]; sources: number }
interface WindObservation { frame: string; height: 'surface' | number | 'lift'; sample: { status: string; u: number | null; v: number | null } }
interface RasterReadiness { preview: string[]; native: string[] }
interface SceneCommit { index: number; frame: string; epochMs: number }
interface Metric { count: number; totalMs: number; maxMs: number }
interface ObserverStats extends Metric { sampleCount: number; p50Ms: number | null; p95Ms: number | null }
interface Telemetry { metrics: Record<string, Metric>; observer: Record<string, ObserverStats>; managed: Record<string, { limit: number; used: number; peak: number; peakCategories: Record<string, number> }>; axisFirstObservedMs: { raster: number | null; native: number | null; wind: number | null; combined: number | null }; longTasks: { supported: boolean; count: number; totalMs: number; maxMs: number }; animation: { callbacks: number; gapsOver50Ms: number; estimatedMissed60Hz: number; maxGapMs: number } }
export interface PreviewBench {
  ready: Promise<void>;
  select(index: number, until?: 'combined' | 'detail'): Promise<InputSample>;
  layer(reference: BenchLayer): Promise<InputSample>;
  drag(indices: number[], intervalMs: number): Promise<{ samples: InputSample[]; staleFramePaints: number; lastTarget: InputSample }>;
  pointerStart(): number;
  pointerEnd(start: number): Promise<InputSample[]>;
  trace(): { epochMs: number; playhead: number; scene: number | null; sceneCount: number };
  sceneEvents(start: number): SceneCommit[];
  telemetry(): Telemetry;
  camera(): { bounds: [number, number, number, number]; areaKm2: number | null; zoom: number; center: [number, number]; moveEnds: number; height: string | number | null; rasterQuality: string; windQuality: string; windPreparation: unknown; windMemory: unknown };
  area(targetKm2: number): void;
  center(longitude: number, latitude: number): void;
  settled(): boolean;
  snapshot(): { sources: number; peakSources: number; renderer: string; frames: string[]; canonicalZoom: number | null; memory: TextureMemory; decoded: ReturnType<typeof decodedMemory.snapshot>; initialFirstCorrectMs: number | null; initialDetailedMs: number | null; overviewReady: number; overviewTotal: number; viewportQuality: 'overview' | 'detail' | null; selectedIndex: number; displayedIndex: number; wind: WindObservation | null; windReady: string[]; rasterReady: RasterReadiness; mismatchedWindRenders: number; width: number; height: number };
  pan(longitude: number): void;
  resetPeaks(): void;
}
declare global { interface Window { bench: PreviewBench; __benchObserver?: 'instrumented' | 'control'; __benchWindState?: () => { installed: WindObservation | null; ready: string[]; height?: string | number; preparation?: unknown; memory?: unknown }; __benchRasterReady?: () => RasterReadiness; __benchTimelineSelected?: (index: number) => void; __benchTimelinePosition?: (index: number) => { day: string; x: number; y: number } | null; __benchSceneCommit?: (index: number, frame: string) => void; __benchRecord?: (name: string, milliseconds: number) => void; __benchWindCall?: (kind: 'grid' | 'sampler', cached: boolean | null, call: () => unknown, built: () => boolean | null) => unknown; __benchBudgetId?: () => number; __benchManaged?: (id: number, limit: number, used: number, category: string, categoryBytes: number) => void } }

const control = window.__benchObserver === 'control';
const telemetry: Telemetry = { metrics: {}, observer: {}, managed: {}, axisFirstObservedMs: { raster: null, native: null, wind: null, combined: null }, longTasks: { supported: false, count: 0, totalMs: 0, maxMs: 0 }, animation: { callbacks: 0, gapsOver50Ms: 0, estimatedMissed60Hz: 0, maxGapMs: 0 } };
window.__benchRecord = (name, milliseconds) => { const metric = telemetry.metrics[name] ??= { count: 0, totalMs: 0, maxMs: 0 }; metric.count++; metric.totalMs += milliseconds; metric.maxMs = Math.max(metric.maxMs, milliseconds); };
window.__benchWindCall = (kind, cached, call, built) => measureWindCall(kind, cached, call, built, window.__benchRecord!);
const observerSamples: Record<string, number[]> = {};
function observerCost(start: number, kind: string) {
  const elapsed = performance.now() - start;
  for (const name of ['all', kind]) { const stats = telemetry.observer[name] ??= { count: 0, totalMs: 0, maxMs: 0, sampleCount: 0, p50Ms: null, p95Ms: null }, samples = observerSamples[name] ??= []; stats.count++; stats.totalMs += elapsed; stats.maxMs = Math.max(stats.maxMs, elapsed); samples[(stats.count - 1) % 4096] = elapsed; }
}
let budgetId = 0;
window.__benchBudgetId = () => ++budgetId;
window.__benchManaged = (id, limit, used, category, categoryBytes) => {
  if (id > 16) return;
  const value = telemetry.managed[String(id)] ??= { limit, used: 0, peak: 0, peakCategories: {} };
  value.used = used; value.peak = Math.max(value.peak, used); value.peakCategories[category] = Math.max(value.peakCategories[category] ?? 0, categoryBytes);
};
if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
  telemetry.longTasks.supported = true;
  new PerformanceObserver(list => { for (const entry of list.getEntries()) { telemetry.longTasks.count++; telemetry.longTasks.totalMs += entry.duration; telemetry.longTasks.maxMs = Math.max(telemetry.longTasks.maxMs, entry.duration); } }).observe({ type: 'longtask', buffered: true });
}
let previousFrame = 0, frameWindowEnd = 0;
function observeFrame(now: number) {
  if (now > frameWindowEnd) { previousFrame = 0; setTimeout(() => { frameWindowEnd = performance.now() + 500; requestAnimationFrame(observeFrame); }, 4500); return; }
  const data = telemetry.animation;
  if (previousFrame) { const gap = now - previousFrame; data.maxGapMs = Math.max(data.maxGapMs, gap); if (gap > 50) data.gapsOver50Ms++; data.estimatedMissed60Hz += Math.max(0, Math.floor(gap / (1000 / 60)) - 1); }
  previousFrame = now; data.callbacks++; requestAnimationFrame(observeFrame);
}
frameWindowEnd = performance.now() + 500; requestAnimationFrame(observeFrame);

type GL = WebGLRenderingContext | WebGL2RenderingContext;
interface Level { width: number; height: number; bytes: number; bytesPerPixel: number }
interface Allocation { levels: globalThis.Map<number, Level> }

// Count requested texture storage, including textures retained by MapLibre's pool.
function textureAccounting(): { snapshot(): TextureMemory; resetPeaks(): void } {
  const allocations = new globalThis.Map<WebGLTexture, Allocation>();
  const states = new WeakMap<GL, { unit: number; bound: globalThis.Map<string, WebGLTexture | null> }>();
  let peakBytes = 0, peakRasterBytes = 0, peakTextures = 0;
  const totals = () => {
    let bytes = 0, rasterBytes = 0;
    for (const allocation of allocations.values()) {
      const size = [...allocation.levels.values()].reduce((sum, level) => sum + level.bytes, 0);
      bytes += size;
      const base = allocation.levels.get(0);
      if (base?.width === 256 && base.height === 256 && base.bytesPerPixel === 4) rasterBytes += size;
    }
    return { bytes, rasterBytes, textures: allocations.size };
  };
  function changed() { const now = totals(); peakBytes = Math.max(peakBytes, now.bytes); peakRasterBytes = Math.max(peakRasterBytes, now.rasterBytes); peakTextures = Math.max(peakTextures, now.textures); }
  function state(gl: GL) {
    let value = states.get(gl);
    if (!value) { value = { unit: gl.TEXTURE0, bound: new globalThis.Map() }; states.set(gl, value); }
    return value;
  }
  function allocation(gl: GL, target: number): Allocation | undefined {
    const current = state(gl), texture = current.bound.get(`${current.unit}/${target}`);
    return texture ? allocations.get(texture) : undefined;
  }
  const pixelBytes = (format: number) => ({ 6406: 1, 6407: 3, 6408: 4, 6409: 1, 6410: 2, 33321: 1, 33323: 2, 32849: 3, 32856: 4, 35907: 4, 33325: 2, 33327: 4, 34842: 8, 34836: 16 }[format] ?? 4);
  function level(value: Allocation | undefined, index: number, width: number, height: number, bytesPerPixel: number) {
    if (!value) return;
    value.levels.set(index, { width, height, bytesPerPixel, bytes: width * height * bytesPerPixel }); changed();
  }
  function wrap(prototype: object, name: string, after: (gl: GL, args: unknown[], result: unknown) => void) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (!descriptor || typeof descriptor.value !== 'function') return;
    const original = descriptor.value as (...args: unknown[]) => unknown;
    Object.defineProperty(prototype, name, { ...descriptor, value: function (this: GL, ...args: unknown[]) {
      const started = name === 'texImage2D' || name === 'texSubImage2D' ? performance.now() : 0;
      const result = Reflect.apply(original, this, args);
      if (started) window.__benchRecord?.('gl-upload-submission', performance.now() - started);
      after(this, args, result); return result;
    } });
  }
  for (const prototype of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype]) {
    wrap(prototype, 'createTexture', (_gl, _args, texture) => { if (texture) { allocations.set(texture as WebGLTexture, { levels: new globalThis.Map() }); changed(); } });
    wrap(prototype, 'deleteTexture', (_gl, [texture]) => { allocations.delete(texture as WebGLTexture); });
    wrap(prototype, 'activeTexture', (gl, [unit]) => { state(gl).unit = Number(unit); });
    wrap(prototype, 'bindTexture', (gl, [target, texture]) => { const current = state(gl); current.bound.set(`${current.unit}/${target}`, texture as WebGLTexture | null); });
    wrap(prototype, 'texStorage2D', (gl, args) => {
      const [target, levels, format, width, height] = args.map(Number), value = allocation(gl, target);
      for (let index = 0; index < levels; index++) level(value, index, Math.max(1, width >> index), Math.max(1, height >> index), pixelBytes(format));
    });
    wrap(prototype, 'texImage2D', (gl, args) => {
      const [target, index, format] = args.map(Number), source = args[5] as { width?: number; height?: number } | null;
      const width = args.length >= 9 ? Number(args[3]) : source?.width ?? 0, height = args.length >= 9 ? Number(args[4]) : source?.height ?? 0;
      level(allocation(gl, target), index, width, height, pixelBytes(format));
    });
    wrap(prototype, 'texSubImage2D', () => {});
    wrap(prototype, 'generateMipmap', (gl, [target]) => {
      const value = allocation(gl, Number(target)), base = value?.levels.get(0);
      if (base) for (let index = 1; Math.max(base.width, base.height) >> index; index++) level(value, index, Math.max(1, base.width >> index), Math.max(1, base.height >> index), base.bytesPerPixel);
    });
  }
  return {
    snapshot() { return { ...totals(), peakBytes, peakRasterBytes, peakTextures }; },
    resetPeaks() { const now = totals(); peakBytes = now.bytes; peakRasterBytes = now.rasterBytes; peakTextures = now.textures; }
  };
}
const memory = textureAccounting();

function decodedAccounting() {
  interface Allocation { kind: 'bitmap' | 'canvas'; bytes: number }
  const tracked = new WeakMap<object, Allocation>();
  let bitmapBytes = 0, canvasBytes = 0, pendingDecodeBytes = 0, pendingDecodes = 0, peakPixelBytes = 0, peakPendingDecodes = 0;
  const changed = () => { peakPixelBytes = Math.max(peakPixelBytes, bitmapBytes + canvasBytes + pendingDecodeBytes); peakPendingDecodes = Math.max(peakPendingDecodes, pendingDecodes); };
  const release = (record: Allocation) => { if (record.kind === 'bitmap') bitmapBytes -= record.bytes; else canvasBytes -= record.bytes; record.bytes = 0; };
  // Weak tracking preserves GC ownership; explicit close and finalization release the same allocation once.
  const finalized = new FinalizationRegistry<Allocation>(release);
  const track = (target: ImageBitmap | OffscreenCanvas | HTMLCanvasElement, kind: Allocation['kind']) => {
    const previous = tracked.get(target); if (previous) release(previous);
    const record = previous ?? { kind, bytes: 0 }; record.bytes = target.width * target.height * 4;
    if (kind === 'bitmap') bitmapBytes += record.bytes; else canvasBytes += record.bytes;
    if (!previous) { tracked.set(target, record); finalized.register(target, record, record); }
    changed();
  };
  const create = globalThis.createImageBitmap;
  globalThis.createImageBitmap = ((...args: Parameters<typeof createImageBitmap>) => {
    const started = performance.now();
    const source = args[0], width = 'width' in source ? Number(source.width) : TILE_SIZE, height = 'height' in source ? Number(source.height) : TILE_SIZE;
    const bytes = width * height * 4; pendingDecodeBytes += bytes; pendingDecodes++; changed();
    return (Reflect.apply(create, globalThis, args) as Promise<ImageBitmap>).then(bitmap => {
      window.__benchRecord?.('image-bitmap-decode-elapsed', performance.now() - started); pendingDecodeBytes -= bytes; pendingDecodes--; track(bitmap, 'bitmap'); return bitmap;
    }, error => { window.__benchRecord?.('image-bitmap-decode-elapsed', performance.now() - started); pendingDecodeBytes -= bytes; pendingDecodes--; throw error; });
  }) as typeof createImageBitmap;
  const close = ImageBitmap.prototype.close;
  ImageBitmap.prototype.close = function () { const record = tracked.get(this); if (record) { release(record); finalized.unregister(record); tracked.delete(this); } return close.call(this); };
  const NativeCanvas = OffscreenCanvas;
  if (typeof OffscreenCanvasRenderingContext2D !== 'undefined') {
    const draw = OffscreenCanvasRenderingContext2D.prototype.drawImage;
    OffscreenCanvasRenderingContext2D.prototype.drawImage = function (this: OffscreenCanvasRenderingContext2D, ...args: Parameters<typeof draw>) { const start = performance.now(); try { return Reflect.apply(draw, this, args); } finally { window.__benchRecord?.('offscreen-draw-submission', performance.now() - start); } } as typeof draw;
  }
  globalThis.OffscreenCanvas = class extends NativeCanvas { constructor(width: number, height: number) { super(width, height); track(this, 'canvas'); } };
  const transfer = NativeCanvas.prototype.transferToImageBitmap;
  NativeCanvas.prototype.transferToImageBitmap = function () { const bitmap = transfer.call(this); track(bitmap, 'bitmap'); return bitmap; };
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...args: Parameters<typeof getContext>) {
    const context = Reflect.apply(getContext, this, args);
    if (args[0] === '2d') track(this, 'canvas');
    return context;
  } as typeof getContext;
  for (const prototype of [NativeCanvas.prototype, HTMLCanvasElement.prototype]) for (const name of ['width', 'height']) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (!descriptor?.set) continue;
    Object.defineProperty(prototype, name, { ...descriptor, set(this: OffscreenCanvas | HTMLCanvasElement, value: number) { descriptor.set!.call(this, value); if (tracked.has(this)) track(this, 'canvas'); } });
  }
  return { snapshot: () => ({ bitmapBytes, canvasBytes, pendingDecodeBytes, pendingDecodes, peakPixelBytes, peakPendingDecodes }) };
}
const decodedMemory = decodedAccounting();

/** Vite-only Map wrapper: the product still mounts its real main module and controls. */
export class Map extends PreviewMap {
  constructor(options: MapOptions) {
    super({ ...options, canvasContextAttributes: { ...options.canvasContextAttributes, preserveDrawingBuffer: !control } });
    installBench(this);
  }
}

function installBench(map: PreviewMap): void {
  const time = document.querySelector<HTMLInputElement>('#time')!;
  const canvas = map.getCanvas(), gl = canvas.getContext('webgl2')!;
  if (!gl) throw new Error('WebGL2 is required by the benchmark');
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
  const sources = () => Object.keys(map.getStyle().sources).filter(id => id.startsWith('av-overlay-') || id.startsWith('av-overview-')).length;
  const samples: InputSample[] = [];
  let frames: string[] = [], expectedWind: ({ u: number; v: number } | null)[] = [], detailZoom = 8, transparent = false, wind = false, renders = 0, peakSources = 0, displayedIndex = -1, staleFramePaints = 0, mismatchedWindRenders = 0;
  let initialFirstCorrectMs: number | null = null, initialDetailedMs: number | null = null;
  let moveEnds = 0;
  map.on('moveend', () => { moveEnds++; });
  let nextProbe = 0, probeDirty = true, probeTimer: ReturnType<typeof setTimeout> | undefined;
  let viewportQuality: 'overview' | 'detail' | null = null;
  let waiting: { sample: InputSample; render: number; until: 'combined' | 'detail'; resolve: (sample: InputSample) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | undefined;
  let requested: { until: 'combined' | 'detail'; resolve: (sample: InputSample) => void; reject: (error: Error) => void } | undefined;
  let readyResolve!: () => void;
  const ready = new Promise<void>(resolve => { readyResolve = resolve; });
  const selectedLayer = (): BenchLayer => document.querySelector('#ref-msl')?.getAttribute('aria-pressed') === 'true' ? 'msl' : 'agl';
  void fetch('/bench/config.json').then(response => response.json()).then((config: { frames: string[]; transparent: boolean; wind: boolean; detailZoom: number; expectedWind: ({ u: number; v: number } | null)[] }) => { frames = config.frames; expectedWind = config.expectedWind; detailZoom = config.detailZoom; transparent = config.transparent; wind = config.wind; map.triggerRepaint(); });
  setInterval(() => {
    const started = performance.now();
    try {
    if (!frames.length) return;
    const raster = window.__benchRasterReady?.(), winds = window.__benchWindState?.().ready, now = performance.now();
    const rasterFull = !!raster && frames.every(frame => raster.preview.includes(frame) || raster.native.includes(frame));
    const nativeFull = !!raster && frames.every(frame => raster.native.includes(frame));
    const windFull = !!winds && frames.every(frame => winds.includes(frame));
    if (rasterFull) telemetry.axisFirstObservedMs.raster ??= now;
    if (nativeFull) telemetry.axisFirstObservedMs.native ??= now;
    if (wind && windFull) telemetry.axisFirstObservedMs.wind ??= now;
    if (rasterFull && (!wind || windFull)) telemetry.axisFirstObservedMs.combined ??= now;
    } finally { observerCost(started, 'axis-readiness'); }
  }, 250);
  function finish(outcome: InputSample['outcome']) {
    if (!waiting) return;
    waiting.sample.outcome = outcome;
    waiting.sample.finishedEpochMs = performance.timeOrigin + performance.now();
    const value = { ...waiting.sample, renders: renders - waiting.render, sources: sources() };
    clearTimeout(waiting.timer); samples.push(value); waiting.resolve(value); waiting = undefined;
  }
  function begin(layer = selectedLayer(), index = Number(time.value)) {
    const observerStarted = performance.now();
    try {
    finish('superseded');
    const observer = requested;
    requested = undefined;
    const inputAt = performance.now(), windReadyAtInput = window.__benchWindState?.().ready ?? [], rasterReadyAtInput = window.__benchRasterReady?.() ?? { preview: [], native: [] };
    const sample: InputSample = { index, targetFrame: frames[index], layer, inputAt, inputEpochMs: performance.timeOrigin + inputAt, finishedEpochMs: null, sceneMs: null, firstCorrectMs: null, detailedMs: null, combinedMs: null, combinedRasterFrame: null, combinedWind: null, paintedWindFrames: [], windReadyAtInput, rasterReadyAtInput, targetReadyAtInput: (rasterReadyAtInput.preview.includes(frames[index]) || rasterReadyAtInput.native.includes(frames[index])) && (!wind || windReadyAtInput.includes(frames[index])), outcome: 'pending', timedOut: false, renders: 0, sources: sources() };
    waiting = { sample, render: renders, until: observer?.until ?? 'detail', resolve: observer?.resolve ?? (() => {}), reject: observer?.reject ?? (() => {}),
      timer: setTimeout(() => { if (waiting) { waiting.sample.timedOut = true; finish('timeout'); } }, 15000) };
    probeDirty = true;
    } finally { observerCost(observerStarted, 'input-readiness'); }
  }
  let timelineIndex = -1, sceneIndex: number | null = null;
  const sceneEvents: SceneCommit[] = [];
  window.__benchSceneCommit = (index, frame) => { if (sceneEvents.length >= 4096) throw new Error('Benchmark scene event limit exceeded'); sceneIndex = index; sceneEvents.push({ index, frame, epochMs: performance.timeOrigin + performance.now() }); probeDirty = true; if (waiting?.sample.index === index && waiting.sample.targetFrame === frame) { waiting.sample.sceneMs ??= performance.now() - waiting.sample.inputAt; if (control) finish('scene-only'); } };
  window.__benchTimelineSelected = index => {
    if (index < 0 || index === timelineIndex) return;
    timelineIndex = index;
    if (waiting?.sample.index !== index && frames[index]) begin(selectedLayer(), index);
  };
  time.addEventListener('input', () => begin(), { capture: true });
  for (const layer of ['agl', 'msl'] as const) document.querySelector(`#ref-${layer}`)!.addEventListener('click', () => begin(layer), { capture: true });
  function select(index: number, until: 'combined' | 'detail' = 'detail'): Promise<InputSample> {
    if (index < 0 || index >= frames.length || !Number.isInteger(index)) throw new Error('Unknown benchmark frame');
    return new Promise((resolve, reject) => {
      requested = { resolve, reject, until }; time.value = String(index); time.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  map.on('render', () => {
    const observerStarted = performance.now();
    let category = 'render-skip';
    try {
    renders++; peakSources = Math.max(peakSources, sources());
    if (control) { if (frames.length && !time.disabled && map.isStyleLoaded()) readyResolve(); return; }
    if (!probeDirty && observerStarted < nextProbe) { if (!probeTimer) probeTimer = setTimeout(() => { probeTimer = undefined; map.triggerRepaint(); }, Math.max(0, nextProbe - observerStarted)); return; }
    probeDirty = false; nextProbe = observerStarted + (waiting ? 100 : 250);
    category = 'frame-probe';
    const probes: PixelProbe[] = [0.02, 0.5, 0.98].flatMap(x => [0.02, 0.5, 0.98].map(y => {
      const px = Math.floor(canvas.width * x), py = Math.floor(canvas.height * y), pixel = new Uint8Array(4);
      gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      const position = map.unproject([(px + 0.5) / canvas.width * canvas.clientWidth, (1 - (py + 0.5) / canvas.height) * canvas.clientHeight]);
      return { pixel: [...pixel], u: ((position.lng + 180) / 360 % 1 + 1) % 1, v: (1 - Math.asinh(Math.tan(position.lat * Math.PI / 180)) / Math.PI) / 2 };
    }));
    const layer = selectedLayer(), opacity = Number(document.querySelector<HTMLInputElement>('#opacity')!.value);
    const match = recognizeViewport(probes, layer, opacity, transparent, frames.length, detailZoom);
    viewportQuality = match?.index === Number(time.value) ? match.quality : null;
    if (!match) return;
    const observed = window.__benchWindState?.().installed ?? null;
    if (wind && observed && observed.frame !== frames[match.index]) mismatchedWindRenders++;
    if (displayedIndex !== match.index && match.index !== Number(time.value)) staleFramePaints++;
    displayedIndex = match.index;
    if (match.index === Number(time.value) && !time.disabled) {
      initialFirstCorrectMs ??= performance.now();
      if (match.quality === 'detail') { initialDetailedMs ??= performance.now(); readyResolve(); }
    }
    if (waiting?.sample.index === match.index && sceneIndex === match.index && waiting.sample.layer === layer) {
      const windFrame = observed?.frame ?? null;
      if (!waiting.sample.paintedWindFrames.includes(windFrame)) waiting.sample.paintedWindFrames.push(windFrame);
      waiting.sample.firstCorrectMs ??= performance.now() - waiting.sample.inputAt;
      waiting.sample.pixels = probes.map(probe => [...probe.pixel]);
      const expected = expectedWind[match.index];
      if (wind && matchesWind(observed, frames[match.index], 1500, expected) && waiting.sample.combinedMs === null) {
        waiting.sample.combinedMs = performance.now() - waiting.sample.inputAt;
        waiting.sample.combinedRasterFrame = frames[match.index]; waiting.sample.combinedWind = structuredClone(observed);
      }
      if (match.quality === 'detail') waiting.sample.detailedMs ??= performance.now() - waiting.sample.inputAt;
      if (waiting.until === 'combined' && waiting.sample.combinedMs !== null) finish('combined');
      else if (waiting.sample.detailedMs !== null && (!wind || waiting.sample.combinedMs !== null)) finish('detail');
    }
    } finally { observerCost(observerStarted, category); }
  });
  window.bench = {
    ready, select,
    layer(reference) { return new Promise((resolve, reject) => { requested = { resolve, reject, until: 'detail' }; document.querySelector<HTMLButtonElement>(`#ref-${reference}`)!.click(); }); },
    async drag(indices, intervalMs) {
      const first = samples.length, stale = staleFramePaints;
      let last: Promise<InputSample> | undefined;
      for (const index of indices) { last = select(index); await new Promise(resolve => setTimeout(resolve, intervalMs)); }
      const final = await last;
      return { samples: samples.slice(first), staleFramePaints: staleFramePaints - stale, lastTarget: final! };
    },
    pointerStart() { return samples.length; },
    trace() { return { epochMs: performance.timeOrigin + performance.now(), playhead: timelineIndex, scene: sceneEvents.at(-1)?.index ?? null, sceneCount: sceneEvents.length }; },
    sceneEvents(start) { return sceneEvents.slice(start); },
    camera() { const bounds = cameraBounds(map), center = map.getCenter(), state = window.__benchWindState?.(); return { bounds, areaKm2: boundsAreaKm2(bounds), zoom: map.getZoom(), center: [center.lng, center.lat], moveEnds, height: state?.height ?? null, rasterQuality: document.querySelector<HTMLElement>('#frame-status')?.dataset.quality ?? 'unknown', windQuality: document.querySelector<HTMLElement>('.wind-controls')?.dataset.quality ?? 'unknown', windPreparation: state?.preparation ?? null, windMemory: state?.memory ?? null }; },
    area(targetKm2) {
      if (!Number.isFinite(targetKm2) || targetKm2 < 1000 || targetKm2 > 1000000) throw new Error('Invalid viewport area');
      const center = map.getCenter(), y = (1 - Math.asinh(Math.tan(center.lat * Math.PI / 180)) / Math.PI) / 2;
      const lat = (value: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * value))) * 180 / Math.PI;
      let low = 3, high = 15;
      for (let i = 0; i < 32; i++) { const zoom = (low + high) / 2, size = 512 * 2 ** zoom, dx = canvas.clientWidth / (2 * size) * 360, dy = canvas.clientHeight / (2 * size), area = boundsAreaKm2([center.lng - dx, lat(y + dy), center.lng + dx, lat(y - dy)]); if (area === null || area < targetKm2) high = zoom; else low = zoom; }
      map.jumpTo({ zoom: (low + high) / 2 });
    },
    center(longitude, latitude) { map.jumpTo({ center: [longitude, latitude] }); },
    telemetry() { for (const [name, samples] of Object.entries(observerSamples)) { const sorted = [...samples].sort((a, b) => a - b), stats = telemetry.observer[name]; stats.sampleCount = sorted.length; stats.p50Ms = sorted[Math.floor((sorted.length - 1) * 0.5)] ?? null; stats.p95Ms = sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null; } return structuredClone(telemetry); },
    async pointerEnd(start) {
      if (waiting) await new Promise<void>(resolve => { const previous = waiting!.resolve; waiting!.resolve = value => { previous(value); resolve(); }; });
      return samples.slice(start);
    },
    settled() { return !waiting && (control || viewportQuality === 'detail') && map.loaded() && map.areTilesLoaded() && !map.isMoving(); },
    snapshot() { const started = performance.now(); try { const timeline = document.querySelector<HTMLElement>('#timeline-status'), windState = window.__benchWindState?.(); const zooms = map.coveringTiles({ tileSize: 256, minzoom: 0, maxzoom: 9, roundZoom: true }).map(tile => tile.canonical.z); return { sources: sources(), peakSources, renderer, frames, canonicalZoom: zooms.length ? Math.max(...zooms) : null, memory: memory.snapshot(), decoded: decodedMemory.snapshot(), initialFirstCorrectMs, initialDetailedMs, overviewReady: Number(timeline?.dataset.ready ?? 0), overviewTotal: Number(timeline?.dataset.total ?? 0), viewportQuality, selectedIndex: Number(time.value), displayedIndex, wind: windState?.installed ?? null, windReady: windState?.ready ?? [], rasterReady: window.__benchRasterReady?.() ?? { preview: [], native: [] }, mismatchedWindRenders, width: canvas.width, height: canvas.height }; } finally { observerCost(started, 'snapshot'); } },
    pan(longitude) { map.jumpTo({ center: [longitude, 40] }); },
    resetPeaks() { peakSources = sources(); memory.resetPeaks(); }
  };
}
