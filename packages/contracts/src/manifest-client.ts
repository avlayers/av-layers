import { CELL_BYTES } from './format.js';
import { isLayerId } from './layers.js';
import { methodDescriptorSchema } from './method-schemas.js';
import { manifestV5Schema, type ManifestV5 } from './publication.js';

const EXTRA_ID = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_EXTRAS = 8;
const MAX_TEXT = 80;
const MAX_DESCRIPTOR_JSON = 4096;
const TIME_SUPPORT = ['valid-time', 'interval-mean', 'interval-maximum', 'interval-flux-endpoint-profile'];
const VERTICAL = ['MSL', 'model-AGL', 'terrain-AGL', 'surface', 'pressure-level'];
const SCHEMA_ERROR = 'latest response does not match contract schema';

export interface ExtraScalarField {
  id: string;
  surfaceId: string;
  descriptor: Record<string, unknown>;
  method: Record<string, unknown>;
}

export interface PublishedSurface {
  id: string;
  kind: 'native' | 'fine';
  layers: readonly string[];
  coverage: { id: unknown; hash: unknown; maskKey: unknown; maxZoom: unknown; gridHash: unknown };
}

export interface PublishedIdentity {
  method: { id: string; hash: string };
  surfaces: readonly PublishedSurface[];
}

interface MutableMethod { outputs?: unknown; [key: string]: unknown }
interface MutableShard { storedCells?: unknown; bytes?: number; frameCount?: unknown }
interface MutableCoverage { id?: unknown; hash?: unknown; maskKey?: unknown; maxZoom?: unknown; gridHash?: unknown }
interface MutableSurface {
  id?: unknown;
  kind?: unknown;
  layers?: unknown;
  coverage?: MutableCoverage;
  samples?: { format?: unknown; channelCount?: number; shards?: MutableShard[] };
}
interface MutableManifest {
  layers: string[];
  frames?: unknown[];
  mapFrameCount?: number;
  method?: { id?: string };
  descriptors?: { layers?: Record<string, Record<string, unknown>>; methods?: Record<string, MutableMethod> };
  surfaces?: MutableSurface[];
  artifacts?: Array<{ layer?: unknown }>;
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= MAX_TEXT;
}

function readExtra(descriptor: unknown, methods: Record<string, MutableMethod>): Record<string, unknown> {
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) throw new Error('Unsupported contract');
  const record = descriptor as Record<string, unknown>;
  if (record.kind !== 'scalar' || record.delivery !== 'samples-only' || record.palette !== undefined) throw new Error('Unsupported scalar layout');
  if (typeof record.id !== 'string' || !EXTRA_ID.test(record.id) || !text(record.label) || !text(record.quantity) || !text(record.units)) throw new Error('Unsupported contract');
  if (typeof record.methodId !== 'string' || !methods[record.methodId]) throw new Error('Unsupported contract');
  if (!TIME_SUPPORT.includes(String(record.timeSupport)) || !VERTICAL.includes(String(record.verticalReference))) throw new Error('Unsupported contract');
  for (const key of ['supportsNoLift', 'supportsLiftFlags', 'zeroOnNoLiftInterpolation', 'hideNonPositiveValues'] as const) {
    if (typeof record[key] !== 'boolean') throw new Error('Unsupported contract');
  }
  if (record.noLiftSampleValue !== null && (typeof record.noLiftSampleValue !== 'number' || !Number.isFinite(record.noLiftSampleValue))) throw new Error('Unsupported contract');
  if (record.definition !== undefined) {
    if (!record.definition || typeof record.definition !== 'object' || Array.isArray(record.definition)) throw new Error('Unsupported contract');
    const definition = record.definition as Record<string, unknown>;
    if (definition.version !== 1 || typeof definition.id !== 'string' || definition.id.length < 1 || definition.id.length > 96) throw new Error('Unsupported contract');
  }
  if (JSON.stringify(record).length > MAX_DESCRIPTOR_JSON) throw new Error('Unsupported contract');
  return record;
}

function suffix(ids: readonly string[], extra: ReadonlySet<string>): boolean {
  let started = false;
  for (const id of ids) {
    const unknown = extra.has(id);
    if (started && !unknown) return false;
    if (unknown) started = true;
  }
  return true;
}

function frameCount(manifest: MutableManifest, kind: unknown): number {
  const frames = manifest.frames?.length ?? 0;
  return kind === 'fine' ? manifest.mapFrameCount ?? frames : frames;
}

/** Project a manifest onto the strict schema, keeping appended sample-only scalars beside it.
 * Shard byte lengths on the projection follow the known channel count. `extraScalars` keeps the published descriptor and method.
 * `publication` keeps the published method id and each surface's id, kind, layer list, and coverage. Appended scalars stay on `extraScalars`.
 */
export function projectClientManifest(value: unknown): { manifest: ManifestV5; extraScalars: ExtraScalarField[]; publication?: PublishedIdentity } {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { layers?: unknown }).layers)) throw new Error(SCHEMA_ERROR);
  const listed = (value as { layers: unknown[] }).layers;
  if (listed.some(id => typeof id !== 'string') || new Set(listed).size !== listed.length) throw new Error(SCHEMA_ERROR);
  const layers = listed as string[];
  const unknown = layers.filter(id => !isLayerId(id));
  if (!unknown.length) {
    const parsed = manifestV5Schema.safeParse(value);
    if (!parsed.success) throw new Error(SCHEMA_ERROR);
    return { manifest: parsed.data, extraScalars: [] };
  }
  if (unknown.length > MAX_EXTRAS) throw new Error('Unsupported contract');
  const copy = structuredClone(value) as MutableManifest;
  const descriptors = copy.descriptors?.layers;
  const methods = copy.descriptors?.methods;
  const surfaces = copy.surfaces;
  if (!descriptors || !methods || !surfaces || !copy.method) throw new Error('Unsupported contract');
  const extra = new Set(unknown);
  if (!suffix(copy.layers, extra) || (copy.artifacts ?? []).some(item => typeof item.layer === 'string' && extra.has(item.layer))) throw new Error('Unsupported scalar layout');
  const extraScalars: ExtraScalarField[] = unknown.map(id => {
    const owners = surfaces.filter(surface => Array.isArray(surface.layers) && surface.layers.includes(id));
    if (owners.length !== 1 || owners[0]?.kind !== 'native' || typeof owners[0].id !== 'string') throw new Error('Unsupported scalar layout');
    const descriptor = readExtra(descriptors[id], methods);
    const method = methods[String(descriptor.methodId)];
    const admitted = methodDescriptorSchema.safeParse(method);
    if (!method || descriptor.id !== id || !admitted.success || admitted.data.id !== descriptor.methodId || !admitted.data.outputs.includes(id)) throw new Error('Unsupported contract');
    return { id, surfaceId: owners[0].id, descriptor: structuredClone(descriptor), method: structuredClone(method) };
  });
  const publishedMethodId = copy.method.id;
  const publishedMethodIds: string[] = [];
  for (const layer of copy.layers) {
    const methodId = descriptors[layer]?.methodId;
    if (typeof methodId !== 'string') throw new Error('Unsupported contract');
    if (!publishedMethodIds.includes(methodId)) publishedMethodIds.push(methodId);
  }
  if (typeof publishedMethodId !== 'string' || publishedMethodId !== publishedMethodIds.join('+')) throw new Error('Unsupported contract');
  const publishedSurfaces: PublishedSurface[] = [];
  copy.layers = copy.layers.filter(id => !extra.has(id));
  for (const id of extra) delete descriptors[id];
  for (const surface of surfaces) {
    if (!Array.isArray(surface.layers) || surface.layers.some(id => typeof id !== 'string')) throw new Error('Unsupported contract');
    const published = surface.layers as string[];
    const coverage = surface.coverage;
    if (!suffix(published, extra) || typeof surface.id !== 'string' || (surface.kind !== 'native' && surface.kind !== 'fine') || !coverage) throw new Error('Unsupported scalar layout');
    const layers = published.filter(id => !extra.has(id));
    if (!layers.length) throw new Error('Unsupported scalar layout');
    const samples = surface.samples;
    if (!samples || !Array.isArray(samples.shards)) throw new Error('Unsupported contract');
    const frames = frameCount(copy, surface.kind);
    admitSampleBytes(samples, published.length, frames);
    publishedSurfaces.push({
      id: surface.id, kind: surface.kind, layers: [...published],
      coverage: { id: coverage.id, hash: coverage.hash, maskKey: coverage.maskKey, maxZoom: coverage.maxZoom, gridHash: coverage.gridHash }
    });
    surface.layers = layers;
    const channels = frames * layers.length;
    samples.channelCount = channels;
    for (const shard of samples.shards) {
      const stored = shard.storedCells;
      const shardChannels = Number(shard.frameCount) * layers.length;
      if (typeof stored !== 'number' || !Number.isSafeInteger(stored) || stored < 1 || !Number.isSafeInteger(shardChannels) || shardChannels < 1) throw new Error('Unsupported contract');
      shard.bytes = stored * shardChannels * CELL_BYTES;
    }
  }
  for (const method of Object.values(methods)) {
    if (!Array.isArray(method.outputs)) throw new Error('Unsupported contract');
    method.outputs = method.outputs.filter(id => typeof id === 'string' && !extra.has(id));
  }
  const methodIds: string[] = [];
  for (const layer of copy.layers) {
    const methodId = descriptors[layer]?.methodId;
    if (typeof methodId !== 'string') throw new Error('Unsupported contract');
    if (!methodIds.includes(methodId)) methodIds.push(methodId);
  }
  const referenced = new Set(Object.values(descriptors).map(layer => layer.methodId).filter((id): id is string => typeof id === 'string'));
  for (const id of Object.keys(methods)) if (!referenced.has(id)) delete methods[id];
  for (const method of Object.values(methods)) if (!Array.isArray(method.outputs) || !method.outputs.length) throw new Error('Unsupported scalar layout');
  copy.method.id = methodIds.join('+');
  const parsed = manifestV5Schema.safeParse(copy);
  if (!parsed.success) throw new Error('Unsupported contract');
  return { manifest: parsed.data, extraScalars, publication: { method: { id: publishedMethodId, hash: parsed.data.method.hash }, surfaces: publishedSurfaces } };
}

function admitSampleBytes(samples: NonNullable<MutableSurface['samples']>, layerCount: number, frames: number): void {
  const channels = frames * layerCount;
  if (samples.format !== 'frame-group-block-shards-v1' || !Number.isSafeInteger(channels) || samples.channelCount !== channels || !samples.shards) throw new Error('Unsupported contract');
  for (const shard of samples.shards) {
    const stored = shard.storedCells;
    const shardChannels = Number(shard.frameCount) * layerCount;
    if (typeof stored !== 'number' || !Number.isSafeInteger(stored) || stored < 1 || !Number.isSafeInteger(shardChannels) || shardChannels < 1) throw new Error('Unsupported contract');
    const bytes = stored * shardChannels * CELL_BYTES;
    if (!Number.isSafeInteger(bytes) || shard.bytes !== bytes) throw new Error('Unsupported contract');
  }
}

function knownLayerIds(layers: unknown): string[] | undefined {
  if (!Array.isArray(layers)) return;
  const known = layers.filter((id): id is string => typeof id === 'string' && isLayerId(id));
  return known.length && known.length < layers.length ? known : undefined;
}

function surfaceStamp(surfaces: ReadonlyArray<{ id?: unknown; kind?: unknown; layers?: unknown; coverage?: PublishedSurface['coverage'] }>): string {
  return JSON.stringify(surfaces.map(surface => {
    const coverage = surface?.coverage;
    return {
      id: surface?.id, kind: surface?.kind, layers: surface?.layers,
      coverage: coverage && { id: coverage.id, hash: coverage.hash, maskKey: coverage.maskKey, maxZoom: coverage.maxZoom, gridHash: coverage.gridHash }
    };
  }));
}

function admitCatalog(value: { models: unknown[] }): unknown {
  for (const model of value.models) {
    const surfaces = (model as { surfaces?: unknown } | null)?.surfaces;
    if (surfaces === undefined) continue;
    if (!Array.isArray(surfaces)) throw new Error('Unsupported contract');
    for (const surface of surfaces) {
      if (!surface || typeof surface !== 'object') throw new Error('Unsupported contract');
      const layers = (surface as { layers?: unknown }).layers;
      if (!Array.isArray(layers) || layers.some(id => typeof id !== 'string')) throw new Error('Unsupported contract');
      const ids = layers as string[], extraIds = ids.filter(id => !isLayerId(id));
      if (!extraIds.length) continue;
      if (extraIds.length > MAX_EXTRAS || extraIds.some(id => !EXTRA_ID.test(id)) || !suffix(ids, new Set(extraIds))) throw new Error('Unsupported contract');
      const known = ids.filter(isLayerId);
      if (!known.length) throw new Error('Unsupported contract');
      (surface as { layers: string[] }).layers = known;
    }
  }
  return value;
}

function admitSample(sample: { surfaces?: unknown }, publication: PublishedIdentity): void {
  const surfaces = sample.surfaces;
  if (!Array.isArray(surfaces) || surfaceStamp(surfaces) !== surfaceStamp(publication.surfaces)) throw new Error('sample surfaces do not match pinned build');
  for (const surface of surfaces) {
    if (!surface || typeof surface !== 'object') throw new Error('Unsupported contract');
    const known = knownLayerIds((surface as { layers?: unknown }).layers);
    if (known) (surface as { layers: string[] }).layers = known;
  }
}

/** Drop admitted suffix layer ids after the published surface list matches the pinned build. Catalog checks stay bounded. */
export function projectKnownResponse(value: unknown, publication?: PublishedIdentity): unknown {
  if (!value || typeof value !== 'object') return value;
  const record = value as { models?: unknown; points?: unknown; surfaces?: unknown };
  if (!publication) return Array.isArray(record.models) ? admitCatalog(record as { models: unknown[] }) : value;
  if ('points' in record) {
    if (!Array.isArray(record.points)) throw new Error('Unsupported contract');
    for (const point of record.points) {
      const sample = (point as { sample?: unknown } | null)?.sample;
      if (!point || typeof point !== 'object' || !sample || typeof sample !== 'object') throw new Error('Unsupported contract');
      admitSample(sample as { surfaces?: unknown }, publication);
    }
    return value;
  }
  admitSample(record, publication);
  return value;
}
