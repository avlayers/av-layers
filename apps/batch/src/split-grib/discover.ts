import type { SplitSource } from './source.js';
import { recentSourceCycles } from '../source.js';
import { DEFAULT_PROBE_TIMEOUT_MS } from '@av/contracts';
import { splitGribFieldUrl, validateSplitGribCycle } from './fields.js';
import pRetry, { AbortError } from 'p-retry';

/** Identifies systematic reads to upstream operators, as ECCC's usage policy asks. */
export const SPLIT_GRIB_USER_AGENT = 'av-layers-forecast (+https://github.com/avlayers/av-layers)';

const PROBE_CONCURRENCY = 4;
const PROBE_ATTEMPTS = 3;
const ADMISSION_WAIT_MINUTES = 40;
const ADMISSION_POLL_MS = 60_000;


interface SplitGribDiscoveryResult {
  readonly schemaVersion: 1;
  readonly model: string;
  readonly cycle: string;
  readonly forecastHours: readonly number[];
  readonly sentinelUrls: readonly string[];
}

export function candidateSplitGribCycles(source: SplitSource, now = new Date(), lag = source.upstream.discoveryLagHours, count = source.upstream.discoveryCandidates): string[] {
  return recentSourceCycles(now, source.model.forecast.cycleHoursUtc, lag, count);
}

/**
 * Sentinel URLs that must be present on DWD Open Data before a 00/06/12/18 UTC
 * Split GRIB main run is admitted. Probes cover field families and profile endpoints;
 * acquisition still checks every required object.
 */
export function splitGribRunSentinelUrls(source: SplitSource,
  cycleIso: string,
  options: {
    readonly lastForecastHour?: number;
    readonly baseUrl?: string;
  } = {}
): string[] {
  const cycle = validateSplitGribCycle(source, cycleIso);
  const lastHour = options.lastForecastHour ?? source.model.forecast.hours.at(-1)!;
  const firstHour = source.model.forecast.hours[0]!;
  const lowestLevel = source.levels[0]!;
  const highestLevel = source.levels.at(-1)!;
  // Surface and auxiliary fields at the first frame as well as the last: DWD posts some post-processed fields
  // (ICON-EU MH) for the whole run well after the model fields, so the last hour alone can admit too early.
  const surfaceAt = (hour: number) => [
    ...[source.fields.surfacePressure, source.fields.temperature2m, source.fields.specificHumidity2m, source.fields.sensibleHeatFlux, source.fields.latentHeatFlux]
      .map(field => splitGribFieldUrl(source, field, cycle, { hour, baseUrl: options.baseUrl })),
    ...(source.model.layers.includes('precip-rate') ? [splitGribFieldUrl(source, source.fields.precipitation!, cycle, { hour, baseUrl: options.baseUrl })] : []),
    ...Object.values(source.upstream.auxSurface ?? {}).map(spec => splitGribFieldUrl(source, spec.field, cycle, { hour, baseUrl: options.baseUrl })),
    ...Object.values(source.upstream.auxLevels ?? {}).flatMap(spec => [lowestLevel, highestLevel].map(level => splitGribFieldUrl(source, spec.field, cycle, { hour, level, baseUrl: options.baseUrl })))
  ];
  const surfaceTail = [...new Set([...surfaceAt(lastHour), ...(firstHour === lastHour ? [] : surfaceAt(firstHour))])];
  const coordinateSentinels = source.upstream.nativeGrid
    ? [source.upstream.nativeGrid.latitude.field, source.upstream.nativeGrid.longitude.field]
        .map(field => splitGribFieldUrl(source, field, cycle, { baseUrl: options.baseUrl }))
    : [];
  if (source.model.capabilities.verticalCoordinate === 'isobaric') {
    return [
      ...coordinateSentinels,
      splitGribFieldUrl(source, source.fields.staticTerrain, cycle, { baseUrl: options.baseUrl }),
      ...surfaceTail,
      ...[source.fields.height!, source.fields.temperature].flatMap(field => [lowestLevel, highestLevel].map(level => splitGribFieldUrl(source, field, cycle, { hour: lastHour, level, baseUrl: options.baseUrl })))
    ];
  }
  const topHalfLevel = source.halfLevels[0]!;
  const bottomHalfLevel = source.halfLevels.at(-1)!;
  return [
    ...coordinateSentinels,
    splitGribFieldUrl(source, source.fields.staticTerrain, cycle, { baseUrl: options.baseUrl }),
    ...[topHalfLevel, bottomHalfLevel].map(level => splitGribFieldUrl(source, source.fields.halfLevelHeight!, cycle, { level, baseUrl: options.baseUrl })),
    ...surfaceTail,
    ...[source.fields.temperature, source.fields.pressure!].flatMap(field => [lowestLevel, highestLevel].map(level => splitGribFieldUrl(source, field, cycle, { hour: lastHour, level, baseUrl: options.baseUrl })))
  ];
}

function probeFailure(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined;
  const code = cause && typeof cause === 'object' && 'code' in cause ? ` (${String(cause.code)})` : '';
  return `${error instanceof Error ? error.message : String(error)}${code}`.slice(0, 256);
}

class ProbeFailure extends Error {
  constructor(message: string, readonly final = false) { super(message); }
}

async function probeSentinel(url: string, fetchFn: typeof fetch, signal: AbortSignal): Promise<string | undefined> {
  try {
    await pRetry(async () => {
      let response: Response;
      try { response = await fetchFn(url, { headers: { Range: 'bytes=0-0', 'User-Agent': SPLIT_GRIB_USER_AGENT }, signal: AbortSignal.any([signal, AbortSignal.timeout(DEFAULT_PROBE_TIMEOUT_MS)]) }); }
      catch (error) { signal.throwIfAborted(); throw new ProbeFailure(probeFailure(error)); }
      try {
        if (response.ok) return;
        const failure = `HTTP ${response.status}`;
        throw response.status !== 408 && response.status !== 429 && response.status < 500 ? new AbortError(new ProbeFailure(failure, true)) : new ProbeFailure(failure);
      } finally { await response.body?.cancel(); }
    }, { retries: PROBE_ATTEMPTS - 1, minTimeout: 250, signal });
  } catch (error) {
    signal.throwIfAborted();
    if (!(error instanceof ProbeFailure)) throw error;
    return error.final ? error.message : `${error.message} after ${PROBE_ATTEMPTS} attempts`;
  }
}

export async function discoverSplitGribRun(source: SplitSource,
  options: {
    readonly now?: Date;
    readonly baseUrl?: string;
    readonly fetchImpl?: typeof fetch;
    readonly signal?: AbortSignal;
    readonly cacheDir?: string;
  } = {}
): Promise<SplitGribDiscoveryResult> {
  options.signal?.throwIfAborted();
  const fetchFn = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl;
  const candidates = candidateSplitGribCycles(source, options.now);
  const DISCOVERY_TIMEOUT_MS = source.upstream.discoveryCandidates * DEFAULT_PROBE_TIMEOUT_MS;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error('Split GRIB discovery deadline exceeded')), DISCOVERY_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  const failures: string[] = [];

  try {
    for (const cycle of candidates) {
      options.signal?.throwIfAborted();
      if (deadline.signal.aborted) break;
      const sentinelUrls = splitGribRunSentinelUrls(source, cycle, { baseUrl });
      let complete = true;
      for (let offset = 0; offset < sentinelUrls.length; offset += PROBE_CONCURRENCY) {
        options.signal?.throwIfAborted();
        const urls = sentinelUrls.slice(offset, offset + PROBE_CONCURRENCY);
        const probes = await Promise.allSettled(urls.map(url => probeSentinel(url, fetchFn, signal)));
        options.signal?.throwIfAborted();
        const failed = probes.flatMap((probe, index) => {
          const reason = probe.status === 'rejected' ? probeFailure(probe.reason) : probe.value;
          return reason ? [`${urls[index]}: ${reason}`] : [];
        });
        if (failed.length || deadline.signal.aborted) { failures.push(`${cycle}: ${failed.join(', ') || 'discovery deadline exceeded'}`); complete = false; break; }
      }
      if (complete) {
        return {
          schemaVersion: 1,
          model: source.model.modelId,
          cycle,
          forecastHours: source.model.forecast.hours,
          sentinelUrls
        };
      }
    }

    throw new Error(`No complete ${source.upstream.provider} Split GRIB main run found across candidate cycles${deadline.signal.aborted ? '; discovery deadline exceeded' : ''}: ${failures.join('; ')}`);
  } finally { clearTimeout(timer); }
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Probes every sentinel of one cycle and returns the failures, empty when the cycle is complete. */
async function probeSplitGribCycle(sentinelUrls: readonly string[], fetchFn: typeof fetch, signal: AbortSignal): Promise<string[]> {
  for (let offset = 0; offset < sentinelUrls.length; offset += PROBE_CONCURRENCY) {
    signal.throwIfAborted();
    const urls = sentinelUrls.slice(offset, offset + PROBE_CONCURRENCY);
    const probes = await Promise.allSettled(urls.map(url => probeSentinel(url, fetchFn, signal)));
    signal.throwIfAborted();
    const failed = probes.flatMap((probe, index) => {
      const reason = probe.status === 'rejected' ? probeFailure(probe.reason) : probe.value;
      return reason ? [`${urls[index]}: ${reason}`] : [];
    });
    if (failed.length) return failed;
  }
  return [];
}

/**
 * Admits a pinned cycle with the discovery sentinels, waiting up to 40 min for late objects: a trigger can fire
 * before the provider has posted every field. The build deadline starts after admission.
 */
export async function admitSplitGribRun(source: SplitSource, cycleIso: string,
  options: { readonly baseUrl?: string; readonly fetchImpl?: typeof fetch; readonly signal?: AbortSignal } = {}
): Promise<SplitGribDiscoveryResult> {
  const cycle = validateSplitGribCycle(source, cycleIso);
  const fetchFn = options.fetchImpl ?? fetch;
  const signal = options.signal ?? new AbortController().signal;
  const sentinelUrls = splitGribRunSentinelUrls(source, cycle, { baseUrl: options.baseUrl });
  for (let attempt = 0; ; attempt++) {
    const failed = await probeSplitGribCycle(sentinelUrls, fetchFn, signal);
    if (!failed.length) return { schemaVersion: 1, model: source.model.modelId, cycle, forecastHours: source.model.forecast.hours, sentinelUrls };
    const error = `${failed.length} sentinel(s) unavailable: ${failed.slice(0, 2).join(', ')}`;
    if (attempt >= ADMISSION_WAIT_MINUTES) throw new Error(`Pinned ${source.upstream.provider} Split GRIB cycle ${cycle} is incomplete after ${ADMISSION_WAIT_MINUTES} min: ${error}`);
    console.error(JSON.stringify({ phase: 'cycle-admission', cycle, state: 'waiting', error }));
    await pause(ADMISSION_POLL_MS, signal);
  }
}
