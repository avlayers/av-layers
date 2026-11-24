import {
  ApiClient, assertNotExpired, AUTO_MODEL_ID, normalizePoint, resolveAutoBuild,
  type AutoForecastSelection, type GeoPoint, type PinnedBuild
} from '@av/client';
import type { GeographicBounds } from '@av/contracts/geometry';
import type { CatalogModelEntry, ModelId } from '@av/contracts/publication';
import type { PreviewIntent, PreviewWriter } from '../../stores/app-store';
import { committedFrame, LIFT_LAYERS, resumeModelFor } from './forecast-model';

const AUTO_METADATA_CACHE_TTL_MS = 15_000;

export interface ForecastHooks {
  readonly onLoading: (model: ModelId) => void;
  readonly onBuild: (build: PinnedBuild, frame: string | null, resolved: boolean) => void;
  readonly onSameBuild: (frame: string) => void;
  readonly onCleared: (message: string) => void;
  readonly onExpired: () => void;
  readonly onUrl: (mode: 'push' | 'replace') => void;
  readonly watchExpiry: (build: PinnedBuild, expire: () => void) => () => void;
  readonly startTimer: () => void;
  readonly stopTimer: () => void;
}

export interface ForecastSessionOptions {
  readonly api: ApiClient;
  readonly writer: Pick<PreviewWriter, 'forecast' | 'intent' | 'notices'>;
  readonly intent: () => Pick<PreviewIntent, 'model' | 'reference' | 'customLayer' | 'requestedTime'>;
  readonly center: () => GeoPoint;
  readonly bounds?: () => GeographicBounds | null;
  readonly globe?: () => boolean;
  readonly mapFailed: () => boolean;
  readonly aborted: () => boolean;
  readonly now: () => number;
  readonly hooks: ForecastHooks;
}

export interface ForecastSession {
  load(model: ModelId, resolved?: AutoForecastSelection): Promise<void>;
  loadAuto(): Promise<void>;
  cancelAuto(): void;
  commitFrame(frameId: string, requestedTime: string): void;
  ensureLive(): boolean;
  expire(): void;
  suspend(): ModelId | null;
  resume(model: ModelId): void;
  dispose(): void;
  readonly build: PinnedBuild | null;
  readonly selectedFrame: string | null;
  readonly pendingModel: ModelId | null;
  readonly expired: boolean;
}

/** Forecast discovery, selection commitment, cancellation and expiry for the preview. */
export function createForecastSession(options: ForecastSessionOptions): ForecastSession {
  const { api, writer, intent, hooks } = options;
  let build: PinnedBuild | null = null, selectedFrame: string | null = null, pendingModel: ModelId | null = null, expired = false;
  let buildFromAuto = false;
  let loadAbort: AbortController | null = null, autoAbort: AbortController | null = null, resumeModel: ModelId | null = null;
  let disposeExpiry = (): void => {}, destroyed = false;
  let cachedCatalog: { models: CatalogModelEntry[]; expiresAtMs: number } | null = null;
  const cachedBuilds = new Map<string, { build: PinnedBuild; cacheExpiresAtMs: number }>();

  const autoApi: Pick<ApiClient, 'catalog' | 'latest' | 'sample'> = {
    async catalog(reqOptions) {
      const now = options.now();
      if (cachedCatalog && cachedCatalog.expiresAtMs > now) return cachedCatalog.models;
      const models = await api.catalog(reqOptions);
      if (!reqOptions?.signal?.aborted) {
        cachedCatalog = { models, expiresAtMs: options.now() + AUTO_METADATA_CACHE_TTL_MS };
      }
      return models;
    },
    async latest(model, reqOptions) {
      const now = options.now();
      if (!expired && build?.manifest.model === model && build.expiresAtMs > now) return build;
      const entry = cachedBuilds.get(model);
      if (entry && entry.cacheExpiresAtMs > now && entry.build.expiresAtMs > now) return entry.build;
      const fetched = await api.latest(model, reqOptions);
      const completedAt = options.now();
      if (!reqOptions?.signal?.aborted && fetched.expiresAtMs > completedAt) {
        cachedBuilds.set(model, { build: fetched, cacheExpiresAtMs: completedAt + AUTO_METADATA_CACHE_TTL_MS });
      }
      return fetched;
    },
    sample(targetBuild, reqOptions) {
      return api.sample(targetBuild, reqOptions);
    }
  };

  function setPending(pending: ModelId | null): void { pendingModel = pending; writer.forecast({ pendingModel: pending }); }
  function commitBuild(next: PinnedBuild, frame: string | null, fromAuto: boolean): void {
    build = next; selectedFrame = frame; expired = false; buildFromAuto = fromAuto;
    const now = options.now();
    if (next.expiresAtMs > now) {
      cachedBuilds.set(next.manifest.model, { build: next, cacheExpiresAtMs: now + AUTO_METADATA_CACHE_TTL_MS });
    }
    writer.forecast({ build: next, selectedFrame: frame, expired: false });
  }
  function clearBuild(): void {
    build = null; selectedFrame = null; buildFromAuto = false;
    writer.forecast({ build: null, selectedFrame: null });
  }

  function commitFrame(frameId: string, requestedTime: string): void {
    selectedFrame = frameId;
    writer.forecast({ selectedFrame: frameId });
    writer.intent({ requestedTime });
  }

  function ensureLive(): boolean {
    if (!build || options.mapFailed()) return false;
    try { assertNotExpired(build.manifest.expiresAt, options.now()); return true; }
    catch { expire(); return false; }
  }

  function expire(): void {
    if (expired || destroyed) return;
    expired = true;
    cachedCatalog = null;
    cachedBuilds.clear();
    writer.forecast({ expired: true });
    hooks.stopTimer(); loadAbort?.abort(); disposeExpiry();
    hooks.onExpired();
    if (intent().model === AUTO_MODEL_ID) void loadAuto();
  }

  async function loadAuto(): Promise<void> {
    if (intent().model !== AUTO_MODEL_ID || options.mapFailed() || options.aborted() || destroyed) return;
    autoAbort?.abort();
    const request = new AbortController(); autoAbort = request;
    const raw = options.center();
    const located = Number.isFinite(raw.lat) && Number.isFinite(raw.lon);
    const viewBounds = options.bounds?.() ?? null;
    const time = Date.parse(intent().requestedTime ?? '');
    const custom = intent().customLayer;
    const layers = custom ? [custom, ...LIFT_LAYERS] : intent().reference === 'agl' ? [...LIFT_LAYERS] : [...LIFT_LAYERS].reverse();
    if (!build) writer.notices({ freshness: 'Finding a forecast for this location…' });
    try {
      const next = await resolveAutoBuild(autoApi, {
        ...(located ? normalizePoint(raw.lat, raw.lon) : {}),
        ...(viewBounds ? { bounds: viewBounds } : {}),
        ...(!expired && build ? { currentBuild: build } : {}),
        globe: options.globe?.() ?? false,
        now: options.now,
        layers, signal: request.signal, ...(Number.isFinite(time) ? { validTimeMs: time } : {})
      });
      if (destroyed || request.signal.aborted || autoAbort !== request || intent().model !== AUTO_MODEL_ID) return;
      if (next) {
        if (!expired && build?.manifest.model === next.build.manifest.model && build.manifest.buildId === next.build.manifest.buildId) {
          buildFromAuto = true;
          if (selectedFrame !== null && selectedFrame !== next.frame.id) hooks.onSameBuild(next.frame.id);
          selectedFrame = next.frame.id;
          writer.forecast({ selectedFrame: next.frame.id });
          if (intent().requestedTime !== null && next.frame.validTime) {
            writer.intent({ requestedTime: next.frame.validTime });
          }
          hooks.onBuild(next.build, next.frame.id, true);
          hooks.startTimer();
          hooks.onUrl('replace');
        } else await load(AUTO_MODEL_ID, next);
        return;
      }
      if (!expired && buildFromAuto && build && build.expiresAtMs > options.now()) {
        hooks.onUrl('replace');
        return;
      }
      hooks.stopTimer(); disposeExpiry(); clearBuild();
      hooks.onCleared('No active forecast builds available.');
      hooks.onUrl('replace');
    } catch (error) {
      if (!request.signal.aborted) writer.notices({ error: error instanceof Error ? error.message : String(error) });
    } finally { if (autoAbort === request) autoAbort = null; }
  }

  async function load(model: ModelId, resolved?: AutoForecastSelection): Promise<void> {
    if (options.mapFailed() || destroyed) return;
    resumeModel = null;
    if (model === AUTO_MODEL_ID && !resolved) {
      loadAbort?.abort(); loadAbort = null;
      if (!buildFromAuto && build !== null) {
        hooks.stopTimer(); disposeExpiry(); clearBuild();
      }
      setPending(null); writer.intent({ model });
      await loadAuto(); return;
    }
    if (model !== AUTO_MODEL_ID) autoAbort?.abort();
    hooks.stopTimer(); disposeExpiry();
    loadAbort?.abort();
    if (resolved) {
      loadAbort = null;
      writer.intent({ model });
      setPending(null);
      commitBuild(resolved.build, resolved.frame.id, true);
      if (intent().requestedTime !== null && resolved.frame.validTime) {
        writer.intent({ requestedTime: resolved.frame.validTime });
      }
      hooks.onLoading(model);
      hooks.onBuild(resolved.build, resolved.frame.id, true);
      disposeExpiry = hooks.watchExpiry(resolved.build, expire);
      hooks.startTimer();
      hooks.onUrl('replace');
      return;
    }
    const request = new AbortController(); loadAbort = request;
    writer.intent({ model });
    setPending(model); clearBuild(); writer.forecast({ expired: false });
    hooks.onLoading(model);
    try {
      const next = await api.latest(model, { signal: request.signal });
      if (destroyed || request.signal.aborted || loadAbort !== request) return;
      const committed = committedFrame(next, intent().requestedTime, options.now());
      commitBuild(next, committed.id, false);
      if (committed.validTime) writer.intent({ requestedTime: committed.validTime });
      hooks.onBuild(next, committed.id, false);
      disposeExpiry = hooks.watchExpiry(next, expire);
      hooks.startTimer();
      setPending(null);
      hooks.onUrl('replace');
    } catch (error) {
      if (request.signal.aborted || loadAbort !== request || (error instanceof DOMException && error.name === 'AbortError')) return;
      clearBuild(); hooks.onCleared(error instanceof Error ? error.message : String(error));
    } finally {
      if (loadAbort === request) { loadAbort = null; setPending(null); }
    }
  }

  return {
    load, loadAuto, cancelAuto() { autoAbort?.abort(); }, commitFrame, ensureLive, expire,
    suspend() {
      resumeModel = resumeModelFor(pendingModel, intent().model);
      cachedCatalog = null; cachedBuilds.clear();
      loadAbort?.abort(); autoAbort?.abort(); hooks.stopTimer();
      return resumeModel;
    },
    resume(model) { resumeModel = null; void load(model); },
    dispose() {
      if (destroyed) return;
      destroyed = true;
      loadAbort?.abort(); autoAbort?.abort(); disposeExpiry(); hooks.stopTimer();
    },
    get build() { return build; },
    get selectedFrame() { return selectedFrame; },
    get pendingModel() { return pendingModel; },
    get expired() { return expired; }
  };
}
