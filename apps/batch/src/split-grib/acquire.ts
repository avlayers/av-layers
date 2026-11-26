import { MAX_SPLIT_OBJECT_BYTES, type SplitSource } from './source.js';
import { copySourceIndices, sourceWindowStart } from '../source.js';
import { recoverTrailingWindow } from '@av/forecast/intervals';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import pRetry from 'p-retry';
import { retriable } from '../retriable.js';
import { createNodeJ2kDecoderPool, type J2kDecoderPool } from '@azohra/meteo.grib/j2k-node';
import { DEFAULT_REQUEST_TIMEOUT_MS, gridVectorToEarth, prepareGridGeometry, sourceIntervalHours } from '@av/contracts';
import type { IsobaricFrame, ModelLevelFrame, NormalizedFrame } from '@av/forecast';
import { readLocalFile } from '../local-file.js';
import { discoverSplitGribRun, SPLIT_GRIB_USER_AGENT } from './discover.js';
import {
  formatSplitGribRunStamp,
  splitGribFieldUrl,
  validateSplitGribCycle,
  verifySplitGribFieldMetadata
} from './fields.js';
import { decodeSplitGribFieldAsync, type DecodedSplitGribField } from './grib.js';
import { createAuxiliaryTargets, type NormalizedFrameTarget } from '../provider.js';
import type { AuxSurfaceId, AuxLevelId, AuxField } from '@av/forecast/inputs';
import { MAX_NATIVE_MAPPING_DISTANCE_M, prepareNativeMapping } from './native-grid.js';

const DEFAULT_CONCURRENCY = 8;
const MAX_CONCURRENCY = 32;
const MAX_TRANSFER_ATTEMPTS = 3;
const RETRYABLE_HTTP_STATUS = [408, 429, 500, 502, 503, 504];
/** A session stops reading from a mirror once it has failed this many objects and more than a fifth of its tries. */
const MIRROR_FAILURE_LIMIT = 3;
/** A mirror read gets less time than the primary so a stalled mirror costs little before the fallback. */
const MIRROR_TIMEOUT_MS = 10_000;

interface SplitGribObjectReceipt {
  readonly field: string;
  readonly hour: number;
  readonly level: number | null;
  readonly url: string;
  readonly compressedBytes: number;
  readonly expandedBytes: number;
  readonly sha256: string;
  readonly cacheHit: boolean;
  readonly normalization?: { units: string; scale: number };
}

interface SplitGribTransportStats {
  [key: string]: unknown;
  downloads: number;
  cacheHits: number;
  downloadedBytes: number;
  retries: number;
  /** Summed wall time of object transfers, including failed mirror tries and retry backoff; overlapping transfers each count. */
  downloadMs: number;
  /** Summed wall time of object decodes, including any wait for a JPEG 2000 decoder worker. */
  decodeMs: number;
  mirrorDownloads: number;
  mirrorFallbacks: number;
}

/** A field object's canonical URL (receipts and cache key) and the hosts to read it from, fastest first. */
interface SplitGribObjectLocation {
  readonly url: string;
  readonly mirrors: readonly { readonly url: string; readonly mirror: MirrorHealth }[];
}

interface MirrorHealth { tries: number; failures: number }

const mirrorUsable = ({ tries, failures }: MirrorHealth): boolean => failures < MIRROR_FAILURE_LIMIT || failures * 5 < tries;

interface SplitGribAcquisitionOptions {
  readonly cycle?: string;
  readonly activeIndices: Uint32Array;
  readonly cacheDir: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly concurrency?: number;
  readonly signal?: AbortSignal;
  readonly readOnlyCache?: boolean;
  readonly offline?: boolean;
}

interface SplitGribStaticGeometryCache {
  readonly cycle: string;
  readonly terrainM: Float32Array;
  readonly missingTerrain: Uint8Array;
  readonly hgtM: Float32Array[];
  readonly missingHgt: Uint8Array[];
  readonly receipts: readonly SplitGribObjectReceipt[];
}

const sha256Hex = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let failed = false, failure: unknown;
  const worker = async (): Promise<void> => {
    while (!failed && nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      try { results[current] = await fn(items[current]!); }
      catch (error) { if (!failed) { failed = true; failure = error; } }
    }
  };
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker()
  );
  await Promise.all(workers);
  if (failed) throw failure;
  return results;
}

class InvalidSplitGribResponse extends Error {}

async function readObjectBody(response: Response): Promise<Uint8Array> {
  const declaredBytes = response.headers.get('content-length');
  if (declaredBytes !== null && (!/^\d+$/.test(declaredBytes) || Number(declaredBytes) > MAX_SPLIT_OBJECT_BYTES)) {
    await response.body?.cancel().catch(() => {});
    throw new InvalidSplitGribResponse('Split GRIB object byte length out of bounds');
  }
  if (!response.body) throw new InvalidSplitGribResponse('Empty Split GRIB object body');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_SPLIT_OBJECT_BYTES) throw new InvalidSplitGribResponse('Split GRIB object byte length out of bounds');
      chunks.push(value);
    }
    if (!size) throw new InvalidSplitGribResponse('Empty Split GRIB object body');
    return Buffer.concat(chunks, size);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}

async function loadSplitGribField(
  location: SplitGribObjectLocation,
  cacheDir: string,
  stats: SplitGribTransportStats,
  options: { readonly fetchImpl?: typeof fetch; readonly signal?: AbortSignal; readonly readOnlyCache?: boolean; readonly offline?: boolean },
  decode: (bytes: Uint8Array) => Promise<DecodedSplitGribField> | DecodedSplitGribField
): Promise<{ readonly decoded: DecodedSplitGribField; readonly compressedBytes: number; readonly sha256: string; readonly cacheHit: boolean }> {
  options.signal?.throwIfAborted();
  const { url } = location;
  const timedDecode = async (bytes: Uint8Array): Promise<DecodedSplitGribField> => {
    const started = performance.now();
    try { return await decode(bytes); } finally { stats.decodeMs += performance.now() - started; }
  };
  const keyHash = createHash('sha256').update(url).digest('hex');
  const fileName = url.split('/').at(-1) ?? `${keyHash}.grib2`;
  const cachePath = join(cacheDir, 'objects', `${keyHash.slice(0, 16)}-${fileName}`);

  let cached: Buffer | undefined;
  try {
    cached = await readLocalFile(cachePath, MAX_SPLIT_OBJECT_BYTES);
    options.signal?.throwIfAborted();
    const decoded = await timedDecode(cached);
    options.signal?.throwIfAborted();
    stats.cacheHits += 1;
    return { decoded, compressedBytes: cached.byteLength, sha256: sha256Hex(cached), cacheHit: true };
  } catch (error) {
    options.signal?.throwIfAborted();
    if (options.readOnlyCache || options.offline) {
      throw new Error(`Split GRIB offline cache miss or invalid object ${url}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (!cached && code && code !== 'ENOENT') throw error;
  }

  const fetchFn = options.fetchImpl ?? fetch;
  const transfer = async (target: string, timeoutMs: number): Promise<Uint8Array> => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await fetchFn(target, { headers: { 'User-Agent': SPLIT_GRIB_USER_AGENT }, signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const message = `HTTP ${response.status} for ${target}`;
      if (!RETRYABLE_HTTP_STATUS.includes(response.status)) throw new InvalidSplitGribResponse(message);
      throw new Error(message);
    }
    return await readObjectBody(response);
  };
  const keep = async (buffer: Uint8Array, decoded: DecodedSplitGribField) => {
    stats.downloads += 1;
    stats.downloadedBytes += buffer.byteLength;
    await mkdir(dirname(cachePath), { recursive: true });
    const tmpPath = `${cachePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmpPath, buffer, { flag: 'wx', signal: options.signal });
      options.signal?.throwIfAborted();
      await rename(tmpPath, cachePath);
    } finally { await rm(tmpPath, { force: true }).catch(() => {}); }
    return { decoded, compressedBytes: buffer.byteLength, sha256: sha256Hex(buffer), cacheHit: false };
  };

  // A mirror serves the same path. It gets one try per object, decode included, so an error page or a truncated
  // object falls back to the primary instead of failing the frame; the primary keeps its own retries.
  for (const { url: mirrorUrl, mirror } of location.mirrors) {
    if (!mirrorUsable(mirror)) continue;
    mirror.tries += 1;
    const started = performance.now();
    let bytes: Uint8Array;
    try { bytes = await transfer(mirrorUrl, MIRROR_TIMEOUT_MS); } catch {
      options.signal?.throwIfAborted();
      mirror.failures += 1;
      stats.mirrorFallbacks += 1;
      continue;
    } finally { stats.downloadMs += performance.now() - started; }
    let decoded: DecodedSplitGribField;
    try { decoded = await timedDecode(bytes); } catch {
      options.signal?.throwIfAborted();
      mirror.failures += 1;
      stats.mirrorFallbacks += 1;
      continue;
    }
    options.signal?.throwIfAborted();
    stats.mirrorDownloads += 1;
    return await keep(bytes, decoded);
  }

  const transferStarted = performance.now();
  let buffer: Uint8Array;
  try {
    buffer = await pRetry(async attempt => {
      if (attempt > 1) stats.retries += 1;
      try { return await transfer(url, DEFAULT_REQUEST_TIMEOUT_MS); } catch (error) { throw retriable(error); }
    }, { retries: MAX_TRANSFER_ATTEMPTS - 1, minTimeout: 125, randomize: true, signal: options.signal,
      shouldRetry: ({ error }) => !(error instanceof InvalidSplitGribResponse) });
  } finally { stats.downloadMs += performance.now() - transferStarted; }
  options.signal?.throwIfAborted();
  const decoded = await timedDecode(buffer);
  options.signal?.throwIfAborted();
  return await keep(buffer, decoded);
}

type WindowField = Pick<DecodedSplitGribField, 'values' | 'missing' | 'product'> & Partial<Pick<DecodedSplitGribField, 'representation'>>;

/** Recover the configured trailing flux mean and orientation. */
export function recoverSplitGribFlux(source: SplitSource, role: 'sensibleHeatFlux' | 'latentHeatFlux',
  current: WindowField, previous: WindowField | null, hour: number
): { readonly values: Float32Array; readonly missing: Uint8Array } {
  return recoverWindow(source, current, previous, hour, 'mean', source.upstream.fields[role].scale);
}

function recoverWindow(source: SplitSource, current: WindowField, previous: WindowField | null, hour: number,
  statistic: 'mean' | 'accumulation', outputSign: 1 | -1 = 1
): { readonly values: Float32Array; readonly missing: Uint8Array } {
  if (!Number.isInteger(hour) || hour < 1) {
    throw new Error(`Split GRIB window recovery requires forecast hour >= 1, got ${hour}`);
  }
  const start = sourceWindowStart(source.model.forecast, hour), previousHour = hour - sourceIntervalHours(source.model.forecast, hour);
  if (previousHour > start && !previous) {
    throw new Error(`Split GRIB window recovery for f${hour} requires companion f${hour - sourceIntervalHours(source.model.forecast, hour)}`);
  }
  return recoverTrailingWindow({
    currentValues: current.values,
    currentMissing: current.missing,
    companionValues: previousHour > start ? previous!.values : null,
    companionMissing: previousHour > start ? previous!.missing : null,
    currentHours: hour - start,
    previousHours: previousHour - start,
    statistic,
    packingErrorCurrent: current.representation?.packingError ?? 0,
    packingErrorPrevious: previous?.representation?.packingError ?? 0,
    outputSign
  });
}

function frameValues({ values }: DecodedSplitGribField): Float32Array {
  if (!(values instanceof Float32Array)) throw new Error('Split GRIB frame values require Float32 data');
  return values;
}

/** Build midpoint heights from configured interfaces and verify ground agreement. */
function computeSplitGribModelLevelHeights(source: SplitSource,
  hsurf: Pick<DecodedSplitGribField, 'values' | 'missing'>,
  halfLevelsByLevel: ReadonlyMap<number, Pick<DecodedSplitGribField, 'values' | 'missing'>>,
  modelLevels: readonly number[] = source.modelLevels
): { readonly hgtM: Float32Array[]; readonly missingHgt: Uint8Array[] } {
  const count = hsurf.values.length;
  const bottomHalfLevel = source.halfLevels.at(-1)!;
  const bottomHalf = halfLevelsByLevel.get(bottomHalfLevel);
  if (!bottomHalf) {
    throw new Error(`Split GRIB static geometry requires HHL half-level ${bottomHalfLevel}`);
  }

  for (let i = 0; i < count; i += 1) {
    if (hsurf.missing[i] === 0 && bottomHalf.missing[i] === 0) {
      const diff = Math.abs(bottomHalf.values[i]! - hsurf.values[i]!);
      if (diff > 1.0) {
        throw new Error(
          `Split GRIB HHL level ${bottomHalfLevel} (${bottomHalf.values[i]}) disagrees with HSURF (${hsurf.values[i]}) at active cell ${i}`
        );
      }
    }
  }

  const hgtM: Float32Array[] = [];
  const missingHgt: Uint8Array[] = [];

  for (const level of modelLevels) {
    const upper = halfLevelsByLevel.get(level);
    const lower = halfLevelsByLevel.get(level + 1);
    if (!upper || !lower) {
      throw new Error(`Split GRIB missing HHL half-level ${level} or ${level + 1}`);
    }
    const levelHgt = new Float32Array(count);
    const levelMissing = new Uint8Array(count);

    for (let i = 0; i < count; i += 1) {
      if (
        upper.missing[i] !== 0 ||
        lower.missing[i] !== 0 ||
        !Number.isFinite(upper.values[i]!) ||
        !Number.isFinite(lower.values[i]!)
      ) {
        levelHgt[i] = NaN;
        levelMissing[i] = 1;
        continue;
      }
      const upperM = upper.values[i]!;
      const lowerM = lower.values[i]!;
      if (upperM <= lowerM) {
        throw new Error(
          `Split GRIB HHL half-levels inverted at level ${level} (upper=${upperM}, lower=${lowerM})`
        );
      }
      levelHgt[i] = 0.5 * (upperM + lowerM);
      levelMissing[i] = 0;
    }

    hgtM.push(levelHgt);
    missingHgt.push(levelMissing);
  }

  return { hgtM, missingHgt };
}


export async function createSplitGribAcquisitionSession(source: SplitSource, options: SplitGribAcquisitionOptions) {
  options.signal?.throwIfAborted();
  const baseUrl = options.baseUrl;
  const maxConcurrency = source.upstream.nativeGrid ? DEFAULT_CONCURRENCY : MAX_CONCURRENCY;
  const concurrency = options.concurrency ?? source.upstream.fetchConcurrency ?? DEFAULT_CONCURRENCY;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > maxConcurrency) throw new Error(`Split GRIB concurrency must be an integer from 1 to ${maxConcurrency}`);
  const activeIndices = copySourceIndices(options.activeIndices, source.grid.width * source.grid.height);
  const cycle = validateSplitGribCycle(source,
    options.cycle ??
      (
        await discoverSplitGribRun(source, {
          baseUrl,
          fetchImpl: options.fetchImpl,
          signal: options.signal,
          cacheDir: options.cacheDir
        })
      ).cycle
  );

  const stats: SplitGribTransportStats = {
    downloads: 0,
    cacheHits: 0,
    downloadedBytes: 0,
    retries: 0,
    downloadMs: 0,
    decodeMs: 0,
    mirrorDownloads: 0,
    mirrorFallbacks: 0
  };
  // A test or fixture base URL replaces every host, so mirrors apply only to the configured upstream.
  const mirrors = baseUrl ? [] : (source.upstream.mirrorUrlTemplates ?? []).map(template => ({ template, health: { tries: 0, failures: 0 } }));

  let staticGeometryPromise: Promise<SplitGribStaticGeometryCache> | null = null;
  let nativeMappingPromise: Promise<{ indices: Uint32Array; receipts: SplitGribObjectReceipt[]; sha256: string }> | null = null;
  let j2kPoolPromise: Promise<J2kDecoderPool> | null = null;
  let closingPromise: Promise<void> | null = null;
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const closeJ2kPool = async (): Promise<void> => {
    const pending = j2kPoolPromise;
    j2kPoolPromise = null;
    if (pending) {
      const pool = await pending.catch(() => null);
      await pool?.close();
    }
  };
  signal.addEventListener('abort', () => { void closeJ2kPool(); }, { once: true });
  const getJ2kPool = (): Promise<J2kDecoderPool> => {
    signal.throwIfAborted();
    return j2kPoolPromise ??= createNodeJ2kDecoderPool({ size: Math.min(concurrency, 4) }).then(async pool => {
      if (signal.aborted) {
        await pool.close();
        signal.throwIfAborted();
      }
      return pool;
    }, error => {
      j2kPoolPromise = null;
      throw error;
    });
  };
  let active: Promise<NormalizedFrame> | undefined;
  const fluxCache = new Map<
    string,
    Promise<{ readonly decoded: DecodedSplitGribField; readonly receipt: SplitGribObjectReceipt }>
  >();
  const isIsobaric = source.model.capabilities.verticalCoordinate === 'isobaric';
  const needsWindRotation = source.grid.kind === 'rotated-latlon' &&
    Boolean(source.upstream.auxSurface?.u10mMps || source.upstream.auxLevels?.uWindMps);
  let windRotations: { cos: Float32Array; sin: Float32Array } | null = needsWindRotation ? (() => {
    const geometry = prepareGridGeometry(source.grid);
    const width = source.grid.width;
    const cos = new Float32Array(activeIndices.length);
    const sin = new Float32Array(activeIndices.length);
    for (let i = 0; i < activeIndices.length; i++) {
      const cell = activeIndices[i]!;
      const x = cell % width, y = (cell - x) / width;
      const geo = geometry.gridToGeographic(x, y);
      const metrics = geo ? geometry.rotationAndMetrics(geo.lat, geo.lon) : null;
      if (!metrics) throw new Error(`Invalid rotated wind metrics at active cell ${cell}`);
      cos[i] = metrics.cos;
      sin[i] = metrics.sin;
    }
    return { cos, sin };
  })() : null;

  const loadDecodedField = async (
    field: string,
    hour: number,
    level: number | null = null,
    target?: { values: Float32Array; missing: Uint8Array },
    indices?: Uint32Array
  ): Promise<{ readonly decoded: DecodedSplitGribField; readonly receipt: SplitGribObjectReceipt }> => {
    const selected = indices ?? (source.upstream.nativeGrid ? (await getNativeMapping()).indices : activeIndices);
    const url = splitGribFieldUrl(source, field, cycle, { hour, level, baseUrl });
    const location: SplitGribObjectLocation = { url, mirrors: mirrors.map(({ template, health }) => ({
      url: splitGribFieldUrl(source, field, cycle, { hour, level, urlTemplate: template }), mirror: health })) };
    const spec = source.specs[field]!;
    const normalization = spec.normalization;
    const native = source.upstream.nativeGrid;
    const coordinateLimit = native ? (field === native.latitude.field ? 90 : field === native.longitude.field ? 180 : null) : null;
    const { decoded, compressedBytes, sha256, cacheHit } = await loadSplitGribField(
      location,
      options.cacheDir,
      stats,
      { fetchImpl: options.fetchImpl, signal, readOnlyCache: options.readOnlyCache, offline: options.offline },
      async bytes => {
        const decoded = await decodeSplitGribFieldAsync(source, bytes, selected, target, {
          sentinel: spec.sentinel,
          j2kPool: getJ2kPool
        });
        verifySplitGribFieldMetadata(source, decoded, field, cycle, { hour, level });
        if (coordinateLimit !== null) for (let i = 0; i < decoded.values.length; i++) {
          if (decoded.missing[i] || !Number.isFinite(decoded.values[i]) || Math.abs(decoded.values[i]!) > coordinateLimit) {
            throw new Error(`Invalid native coordinate ${field} at cell ${selected[i]}`);
          }
        }
        return decoded;
      }
    );
    return {
      decoded,
      receipt: {
        field,
        hour,
        level,
        url,
        compressedBytes,
        expandedBytes: decoded.expandedBytes,
        sha256,
        cacheHit,
        ...(normalization ? { normalization } : {})
      }
    };
  };

  const getNativeMapping = () => nativeMappingPromise ??= (async () => {
    const native = source.upstream.nativeGrid!;
    const indices = Uint32Array.from({ length: native.pointCount }, (_, i) => i);
    const latitude = await loadDecodedField(native.latitude.field, 0, null, undefined, indices);
    const longitude = await loadDecodedField(native.longitude.field, 0, null, undefined, indices);
    signal.throwIfAborted();
    if (source.grid.kind !== 'regular-latlon') throw new Error('Native mapping requires a regular-latlon output grid');
    const mapping = prepareNativeMapping(source.grid, activeIndices, latitude.decoded.values, longitude.decoded.values);
    return { indices: mapping, receipts: [latitude.receipt, longitude.receipt], sha256: sha256Hex(new Uint8Array(mapping.buffer)) };
  })().catch(error => { nativeMappingPromise = null; throw error; });

  const getFluxField = (
    field: string,
    hour: number
  ): Promise<{ readonly decoded: DecodedSplitGribField; readonly receipt: SplitGribObjectReceipt }> => {
    const key = `${field}:${hour}`;
    const existing = fluxCache.get(key);
    if (existing) {
      return existing;
    }
    const pending = loadDecodedField(field, hour, null).catch(error => {
      fluxCache.delete(key);
      throw error;
    });
    fluxCache.set(key, pending);
    return pending;
  };

  const getStaticGeometry = (): Promise<SplitGribStaticGeometryCache> => {
    if (staticGeometryPromise) {
      return staticGeometryPromise;
    }
    staticGeometryPromise = (async () => {
      const hsurfRes = await loadDecodedField(source.fields.staticTerrain, 0, null);
      const mappingReceipts = source.upstream.nativeGrid ? (await getNativeMapping()).receipts : [];
      if (isIsobaric) {
        return {
          cycle,
          terrainM: frameValues(hsurfRes.decoded),
          missingTerrain: hsurfRes.decoded.missing,
          hgtM: [],
          missingHgt: [],
          receipts: [...mappingReceipts, hsurfRes.receipt]
        };
      }
      const hhlResults = await mapConcurrent(source.halfLevels, concurrency, level =>
        loadDecodedField(source.fields.halfLevelHeight!, 0, level)
      );
      const halfMap = new Map<number, DecodedSplitGribField>();
      for (let i = 0; i < source.halfLevels.length; i += 1) {
        halfMap.set(source.halfLevels[i]!, hhlResults[i]!.decoded);
      }
      const { hgtM, missingHgt } = computeSplitGribModelLevelHeights(source,
        hsurfRes.decoded,
        halfMap,
        source.modelLevels
      );
      return {
        cycle,
        terrainM: frameValues(hsurfRes.decoded),
        missingTerrain: hsurfRes.decoded.missing,
        hgtM,
        missingHgt,
        receipts: [...mappingReceipts, hsurfRes.receipt, ...hhlResults.map(r => r.receipt)]
      };
    })().catch(error => {
      staticGeometryPromise = null;
      throw error;
    });
    return staticGeometryPromise;
  };

  const scaleInstantaneousFlux = (role: 'sensibleHeatFlux' | 'latentHeatFlux', decoded: DecodedSplitGribField): { readonly values: Float32Array; readonly missing: Uint8Array } => {
    const scale = source.upstream.fields[role].scale;
    const values = frameValues(decoded);
    const missing = decoded.missing;
    for (let i = 0; i < values.length; i++) {
      if (missing[i] || !Number.isFinite(values[i]!)) {
        values[i] = NaN;
        missing[i] = 1;
      } else {
        const scaled = values[i]! * scale;
        values[i] = Object.is(scaled, -0) ? 0 : scaled;
      }
    }
    return { values, missing };
  };

  const acquireFrame = async (hour: number, target?: NormalizedFrameTarget): Promise<NormalizedFrame> => {
    const previousHour = hour - sourceIntervalHours(source.model.forecast, hour);
    for (const key of fluxCache.keys()) if (!key.endsWith(`:${previousHour}`)) fluxCache.delete(key);
    const staticGeom = await getStaticGeometry();
    const levels = source.levels;
    const instantaneousFluxes = source.specs[source.fields.sensibleHeatFlux]!.templateNumber === 0 &&
      source.specs[source.fields.latentHeatFlux]!.templateNumber === 0;
    const windowNeedsCompanion = previousHour > sourceWindowStart(source.model.forecast, hour);
    const fluxNeedsCompanion = !instantaneousFluxes && windowNeedsCompanion;
    const resetHours = source.model.forecast.statisticsResetHours;
    const retainCompanion = resetHours === null || hour % resetHours !== 0;
    const { auxSurface, auxLevels } = createAuxiliaryTargets(activeIndices.length, levels.length,
      Object.keys(source.upstream.auxSurface ?? {}) as AuxSurfaceId[], Object.keys(source.upstream.auxLevels ?? {}) as AuxLevelId[], target);
    const auxiliaryTargets = new Map<string, AuxField>();
    const auxiliaryRequests = [
      ...Object.entries(source.upstream.auxSurface ?? {}).map(([id, spec]) => {
        auxiliaryTargets.set(`${spec.field}:null`, auxSurface[id as AuxSurfaceId]!);
        return { field: spec.field, hour, level: null };
      }),
      ...Object.entries(source.upstream.auxLevels ?? {}).flatMap(([id, spec]) => levels.map((level, index) => {
        auxiliaryTargets.set(`${spec.field}:${level}`, auxLevels[id as AuxLevelId]![index]!);
        return { field: spec.field, hour, level };
      }))
    ];

    const surfaceFields = [source.fields.surfacePressure, source.fields.temperature2m, source.fields.specificHumidity2m, source.fields.sensibleHeatFlux, source.fields.latentHeatFlux];
    const precipitationField = source.model.layers.includes('precip-rate') ? source.fields.precipitation : undefined;
    const precipitationNeedsCompanion = Boolean(precipitationField) && windowNeedsCompanion;
    const precipitationRequests = precipitationField ? [
      { field: precipitationField, hour, level: null },
      ...(precipitationNeedsCompanion ? [{ field: precipitationField, hour: previousHour, level: null }] : [])
    ] : [];
    const profileFields = isIsobaric
      ? [source.fields.height!, source.fields.temperature]
      : [source.fields.temperature, source.fields.pressure!];
    const requests = [
      ...surfaceFields.map(field => ({ field, hour, level: null })),
      ...(fluxNeedsCompanion ? [source.fields.sensibleHeatFlux, source.fields.latentHeatFlux].map(field => ({ field, hour: previousHour, level: null })) : []),
      ...profileFields.flatMap(field => levels.map(level => ({ field, hour, level }))),
      ...precipitationRequests,
      ...auxiliaryRequests
    ];
    const fields = await mapConcurrent(requests, concurrency, request => {
      const isStatisticalWindow = ((request.field === source.fields.sensibleHeatFlux || request.field === source.fields.latentHeatFlux) && !instantaneousFluxes) || request.field === precipitationField;
      if (isStatisticalWindow && (request.hour === previousHour || retainCompanion)) {
        return getFluxField(request.field, request.hour);
      }
      return loadDecodedField(request.field, request.hour, request.level, auxiliaryTargets.get(`${request.field}:${request.level}`) ?? (target ? (() => {
        if (request.field === source.fields.surfacePressure) return { values: target.surfacePressurePa, missing: target.missing.surfacePressure };
        if (request.field === source.fields.temperature2m) return { values: target.temp2mK, missing: target.missing.temp2m };
        if (request.field === source.fields.specificHumidity2m) return { values: target.specificHumidity2mKgKg, missing: target.missing.humidity2m };
        if (request.field === source.fields.sensibleHeatFlux) return instantaneousFluxes ? { values: target.sensibleHeatFluxWm2, missing: target.missing.sensibleHeatFlux } : undefined;
        if (request.field === source.fields.latentHeatFlux) return instantaneousFluxes ? { values: target.latentHeatFluxWm2, missing: target.missing.latentHeatFlux } : undefined;
        if (request.field === precipitationField) return undefined;
        const index = levels.indexOf(request.level!);
        if (request.field === source.fields.height) return { values: target.hgtM[index]!, missing: target.missing.hgt[index]! };
        return request.field === source.fields.temperature ? { values: target.tempK[index]!, missing: target.missing.temp[index]! }
          : { values: target.pressurePa![index]!, missing: target.missing.pressure![index]! };
      })() : undefined));
    });
    const [psRes, t2mRes, qv2mRes, ashflCurr, alhflCurr] = fields;
    const ashflPrev = fluxNeedsCompanion ? fields[surfaceFields.length] : null;
    const alhflPrev = fluxNeedsCompanion ? fields[surfaceFields.length + 1] : null;
    const profileOffset = surfaceFields.length + (fluxNeedsCompanion ? 2 : 0);
    const firstProfileResults = fields.slice(profileOffset, profileOffset + levels.length);
    const secondProfileResults = fields.slice(profileOffset + levels.length, profileOffset + 2 * levels.length);
    const precipitationIndex = profileOffset + 2 * levels.length;
    const precipitation = precipitationField ? recoverWindow(source, fields[precipitationIndex]!.decoded,
      precipitationNeedsCompanion ? fields[precipitationIndex + 1]!.decoded : null, hour, 'accumulation') : undefined;
    for (const [configured, output] of [[source.upstream.auxSurface, auxSurface], [source.upstream.auxLevels, auxLevels]] as const) {
      for (const [name, spec] of Object.entries(configured ?? {})) {
        const selected = output[name as keyof typeof output] as AuxField | readonly AuxField[];
        for (const field of Array.isArray(selected) ? selected : [selected as AuxField]) {
          if (spec.scale !== 1) for (let i = 0; i < field.values.length; i++) if (!field.missing[i]) field.values[i] *= spec.scale;
        }
      }
    }
    const gridRelativeByKey = new Map<string, boolean>();
    for (let i = 0; i < requests.length; i++) {
      const req = requests[i]!, grid = fields[i]!.decoded.grid;
      gridRelativeByKey.set(`${req.field}:${req.level}`, grid.kind === 'rotated-latlon' && grid.uvRelativeToGrid);
    }
    const shouldRotatePair = (uField: string | undefined, vField: string | undefined, level: number | null): boolean => {
      if (!uField || !vField || source.grid.kind !== 'rotated-latlon') return false;
      const uRel = gridRelativeByKey.get(`${uField}:${level}`) ?? false;
      const vRel = gridRelativeByKey.get(`${vField}:${level}`) ?? false;
      if (uRel !== vRel) throw new Error(`Split GRIB wind component uvRelativeToGrid mismatch for ${uField}/${vField}`);
      return uRel;
    };
    const normalizeWind = (u: AuxField | undefined, v: AuxField | undefined, rotate: boolean) => {
      if (!u || !v) return;
      for (let i = 0; i < activeIndices.length; i++) {
        if (u.missing[i] || v.missing[i] || !Number.isFinite(u.values[i]) || !Number.isFinite(v.values[i])) {
          u.missing[i] = v.missing[i] = 1; u.values[i] = v.values[i] = NaN;
        } else if (rotate && windRotations) {
          const earth = gridVectorToEarth(u.values[i]!, v.values[i]!, { cos: windRotations.cos[i]!, sin: windRotations.sin[i]! });
          u.values[i] = earth.east;
          v.values[i] = earth.north;
        }
      }
    };
    normalizeWind(auxSurface.u10mMps, auxSurface.v10mMps, shouldRotatePair(source.upstream.auxSurface?.u10mMps?.field, source.upstream.auxSurface?.v10mMps?.field, null));
    for (let i = 0; i < levels.length; i++) {
      normalizeWind(auxLevels.uWindMps?.[i], auxLevels.vWindMps?.[i], shouldRotatePair(source.upstream.auxLevels?.uWindMps?.field, source.upstream.auxLevels?.vWindMps?.field, levels[i]!));
    }

    const sensible = instantaneousFluxes
      ? scaleInstantaneousFlux('sensibleHeatFlux', ashflCurr.decoded)
      : recoverSplitGribFlux(source, 'sensibleHeatFlux', ashflCurr.decoded, ashflPrev?.decoded ?? null, hour);
    const latent = instantaneousFluxes
      ? scaleInstantaneousFlux('latentHeatFlux', alhflCurr.decoded)
      : recoverSplitGribFlux(source, 'latentHeatFlux', alhflCurr.decoded, alhflPrev?.decoded ?? null, hour);
    if (target) {
      target.terrainM.set(staticGeom.terrainM); target.missing.terrain.set(staticGeom.missingTerrain);
      if (!isIsobaric) {
        for (let i = 0; i < staticGeom.hgtM.length; i++) { target.hgtM[i]!.set(staticGeom.hgtM[i]!); target.missing.hgt[i]!.set(staticGeom.missingHgt[i]!); }
      }
      if (!instantaneousFluxes) {
        target.sensibleHeatFluxWm2.set(sensible.values); target.missing.sensibleHeatFlux.set(sensible.missing);
        target.latentHeatFluxWm2.set(latent.values); target.missing.latentHeatFlux.set(latent.missing);
      }
      if (precipitation && target.precipitationMmPerHour && target.missing.precipitation) {
        target.precipitationMmPerHour.set(precipitation.values); target.missing.precipitation.set(precipitation.missing);
      }
    }

    const cycleMs = Date.parse(cycle);
    const startIso = new Date(cycleMs + previousHour * 3_600_000).toISOString();
    const endIso = new Date(cycleMs + hour * 3_600_000).toISOString();
    const sourceStartIso = new Date(cycleMs + sourceWindowStart(source.model.forecast, hour) * 3_600_000).toISOString();
    const capturedAt = new Date().toISOString();
    const runStamp = formatSplitGribRunStamp(source, cycle);
    const precipitationOutput = precipitation && target?.precipitationMmPerHour && target.missing.precipitation
      ? { values: target.precipitationMmPerHour, missing: target.missing.precipitation } : precipitation;

    const hourlyReceipts: SplitGribObjectReceipt[] = fields.map(result => result.receipt);
    const commonFrame = {
      cycle,
      hour,
      validAt: endIso,
      capturedAt,
      grid: source.grid,
      activeIndices: new Uint32Array(activeIndices),
      terrainM: target?.terrainM ?? new Float32Array(staticGeom.terrainM),
      surfacePressurePa: frameValues(psRes.decoded),
      temp2mK: frameValues(t2mRes.decoded),
      specificHumidity2mKgKg: frameValues(qv2mRes.decoded),
      sensibleHeatFluxWm2: target?.sensibleHeatFluxWm2 ?? sensible.values,
      latentHeatFluxWm2: target?.latentHeatFluxWm2 ?? latent.values,
      ...(precipitationOutput ? { precipitationMmPerHour: precipitationOutput.values } : {}),
      ...(Object.keys(auxSurface).length ? { auxSurface } : {}),
      ...(Object.keys(auxLevels).length ? { auxLevels } : {}),
      intervals: {
        profileTime: endIso,
        fluxWindow: { start: startIso, end: endIso },
        fluxSourceWindow: instantaneousFluxes ? { start: endIso, end: endIso } : { start: sourceStartIso, end: endIso },
        ...(precipitation ? { precipitationWindow: { start: startIso, end: endIso }, precipitationSourceWindow: { start: sourceStartIso, end: endIso } } : {}),
        usedCompanion: fluxNeedsCompanion || precipitationNeedsCompanion
      }
    };

    const gridReceipt = source.upstream.nativeGrid ? {
      gridKind: 'regridded-regular-lat-lon',
      nativeGrid: { number: source.upstream.nativeGrid.number, uuid: source.upstream.nativeGrid.uuid, pointCount: source.upstream.nativeGrid.pointCount },
      remapping: { method: 'nearest-cell', maxDistanceM: MAX_NATIVE_MAPPING_DISTANCE_M, sha256: (await getNativeMapping()).sha256 }
    } : {
      gridKind: source.grid.kind
    };

    if (isIsobaric) {
      const hgtResults = firstProfileResults;
      const tempResults = secondProfileResults;
      const frame: IsobaricFrame = {
        ...commonFrame,
        pressureLevelsHpa: [...source.pressureLevelsHpa],
        hgtM: target?.hgtM ?? hgtResults.map(r => frameValues(r.decoded)),
        tempK: target?.tempK ?? tempResults.map(r => frameValues(r.decoded)),
        missing: {
          terrain: target?.missing.terrain ?? new Uint8Array(staticGeom.missingTerrain),
          surfacePressure: psRes.decoded.missing,
          temp2m: t2mRes.decoded.missing,
          humidity2m: qv2mRes.decoded.missing,
          sensibleHeatFlux: target?.missing.sensibleHeatFlux ?? sensible.missing,
          latentHeatFlux: target?.missing.latentHeatFlux ?? latent.missing,
          ...(precipitationOutput ? { precipitation: precipitationOutput.missing } : {}),
          hgt: target?.missing.hgt ?? hgtResults.map(r => r.decoded.missing),
          temp: target?.missing.temp ?? tempResults.map(r => r.decoded.missing)
        },
        receipt: {
          schemaVersion: 1,
          provider: source.upstream.provider,
          model: source.model.modelId,
          ...gridReceipt,
          runStamp,
          cycle,
          hour,
          validAt: endIso,
          capturedAt,
          pressureLevelsHpa: [...source.pressureLevelsHpa],
          staticObjects: staticGeom.receipts.length,
          hourlyObjects: hourlyReceipts.length,
          objects: [...staticGeom.receipts, ...hourlyReceipts]
        }
      };
      return frame;
    }

    const modelTResults = firstProfileResults;
    const modelPResults = secondProfileResults;
    const frame: ModelLevelFrame = {
      ...commonFrame,
      pressurePa: modelPResults.map(r => frameValues(r.decoded)),
      hgtM: target?.hgtM ?? staticGeom.hgtM.map(arr => new Float32Array(arr)),
      tempK: modelTResults.map(r => frameValues(r.decoded)),
      missing: {
        terrain: target?.missing.terrain ?? new Uint8Array(staticGeom.missingTerrain),
        surfacePressure: psRes.decoded.missing,
        temp2m: t2mRes.decoded.missing,
        humidity2m: qv2mRes.decoded.missing,
        sensibleHeatFlux: target?.missing.sensibleHeatFlux ?? sensible.missing,
        latentHeatFlux: target?.missing.latentHeatFlux ?? latent.missing,
        ...(precipitationOutput ? { precipitation: precipitationOutput.missing } : {}),
        pressure: modelPResults.map(r => r.decoded.missing),
        hgt: target?.missing.hgt ?? staticGeom.missingHgt.map(arr => new Uint8Array(arr)),
        temp: modelTResults.map(r => r.decoded.missing)
      },
      receipt: {
        schemaVersion: 1,
        provider: source.upstream.provider,
        model: source.model.modelId,
        ...gridReceipt,
        runStamp,
        cycle,
        hour,
        validAt: endIso,
        capturedAt,
        modelLevels: [...source.modelLevels],
        staticObjects: staticGeom.receipts.length,
        hourlyObjects: hourlyReceipts.length,
        objects: [...staticGeom.receipts, ...hourlyReceipts]
      }
    };
    return frame;
  };

  return {
    cycle,
    get stats(): Readonly<SplitGribTransportStats> {
      return { ...stats };
    },
    async acquire(hour: number, target?: NormalizedFrameTarget): Promise<NormalizedFrame> {
      signal.throwIfAborted();
      if (!source.model.forecast.hours.includes(hour)) {
        throw new Error(`Unsupported Split GRIB forecast hour ${hour}`);
      }
      if (active) throw new Error('Split GRIB acquisition session already has an active frame');
      active = acquireFrame(hour, target);
      try {
        const frame = await active;
        signal.throwIfAborted();
        return frame;
      } finally {
        // Only this hour's pair can be reused as the next frame's companions.
        for (const key of fluxCache.keys()) if (!key.endsWith(`:${hour}`)) fluxCache.delete(key);
        // Decoder workers keep their WASM heaps; release them so raster admission, which reads RSS, sees the memory free.
        await closeJ2kPool();
        active = undefined;
      }
    },
    close(): Promise<void> {
      controller.abort(new Error('Split GRIB acquisition session is closed'));
      return closingPromise ??= (async () => {
        await Promise.allSettled([active, closeJ2kPool()]);
        fluxCache.clear();
        staticGeometryPromise = null;
        nativeMappingPromise = null;
        windRotations = null;
      })();
    }
  };
}
