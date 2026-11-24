import { getProduct } from '@av/contracts/models';
import { CELL_BYTES, computeFreshness, createRecipeIdentity, createWholeDomainDescriptors, getProvenanceReference,
  latestV5Schema, layerSurface, manifestV5Schema, planWholeDomainGrid,
  renderedLayers, SAMPLE_BLOCK_SIZE, validateArtifactRecordsV5, type ManifestV5 } from '@av/contracts';
import type { PinnedBuild } from '@av/client';

export const FIXTURE_BUILD_ID = '20261030T000000Z-00000000-0000-4000-8000-000000000000';
const DEFAULT_CYCLE = '2026-10-30T00:00:00.000Z';
const DEFAULT_CREATED_AT = '2026-10-30T00:00:01.000Z';
const DEFAULT_EXPIRES_AT = '2026-11-06T00:00:01.000Z';
const ZERO_HASH = '0'.repeat(64);
const DEFAULT_FRAMES: ManifestV5['frames'] = [3, 6, 9, 12, 15, 18, 21, 24].map(hour => ({
  id: `f${String(hour).padStart(3, '0')}`,
  validTime: new Date(Date.parse(DEFAULT_CYCLE) + hour * 3_600_000).toISOString(),
  intervalStart: new Date(Date.parse(DEFAULT_CYCLE) + (hour - 3) * 3_600_000).toISOString(),
  intervalEnd: new Date(Date.parse(DEFAULT_CYCLE) + hour * 3_600_000).toISOString()
}));

/** Whole-domain publication metadata for browser and discovery tests. */
export function fixtureManifestV5(overrides: Partial<ManifestV5> = {}): ManifestV5 {
  const model = overrides.model ?? 'gfs';
  const product = getProduct(model) ?? getProduct('gfs')!;
  const buildId = overrides.buildId ?? FIXTURE_BUILD_ID, prefix = `builds/${model}/${buildId}`;
  const frames = overrides.frames ?? structuredClone(DEFAULT_FRAMES);
  const layers = overrides.layers ?? ['usable-lift-msl', 'usable-lift-agl', 'precip-rate'];
  const count = overrides.mapFrameCount ?? frames.length;
  const descriptors = overrides.descriptors ?? createWholeDomainDescriptors(product);
  const grids = planWholeDomainGrid(product.grid, 2);
  const surfaces = (['native', 'fine'] as const).flatMap(kind => {
    const selected = layers.filter(layer => layerSurface(layer) === kind);
    if (!selected.length) return [];
    const id = `${model}-${kind}`, grid = grids[kind], hash = (kind === 'native' ? 'a' : 'b').repeat(64);
    const blockCount = Math.ceil(grid.width / SAMPLE_BLOCK_SIZE) * Math.ceil(grid.height / SAMPLE_BLOCK_SIZE);
    const surfaceFrames = kind === 'fine' ? count : frames.length;
    const channelCount = selected.length * surfaceFrames;
    return [{
      id, kind, grid, gridHash: hash,
      coverage: { id, hash, gridHash: hash, maskKey: `coverage/${hash}/manifest.json`, maxZoom: kind === 'fine' ? 9 : 7 },
      layers: selected,
      samples: {
        format: 'frame-group-block-shards-v1' as const, blockSize: SAMPLE_BLOCK_SIZE, channelOrder: 'frame-then-layer' as const,
        channelCount, coverageHash: hash, blockCount, storedCells: blockCount,
        shards: [{ group: 0, firstFrame: 0, frameCount: surfaceFrames, blockShard: 0, firstBlock: 0, blockCount, storedCells: blockCount,
          bytes: blockCount * channelCount * CELL_BYTES, key: `${prefix}/surfaces/${id}/samples/g0-b0.bin`, sha256: hash }]
      },
      ...(kind === 'fine' ? { terrain: { dataId: hash, key: `terrain/prepared/${hash}/manifest.json`, sha256: hash,
        verticalDatum: 'EGM2008', surface: 'DSM', gridHash: hash, coverageHash: hash, layoutVersion: 1 as const } } : {})
    }];
  });
  const artifacts = frames.slice(0, count).flatMap(frame => renderedLayers(layers, descriptors.layers).map(layer => ({
    layer, frame: frame.id, tilesKey: `${prefix}/${layer}/${frame.id}.pmtiles`, tilesSha256: 'a'.repeat(64)
  })));
  const manifest = manifestV5Schema.parse({
    version: 5,
    model,
    buildId,
    cycle: DEFAULT_CYCLE,
    createdAt: DEFAULT_CREATED_AT,
    expiresAt: DEFAULT_EXPIRES_AT,
    palettes: ['lift', 'rain'],
    metrics: {},
    tool: { pmtiles: '1.31.2' },
    ...overrides,
    frames,
    layers,
    descriptors,
    surfaces: overrides.surfaces ?? surfaces,
    artifacts: overrides.artifacts ?? artifacts,
    recipe: overrides.recipe ?? createRecipeIdentity(product, 'a'.repeat(64)),
    method: overrides.method ?? { hash: ZERO_HASH, id: [...new Set(layers.map(layer => descriptors.layers[layer].methodId))].join('+') },
    source: { model: 'gfs', provider: 'NOAA', provenanceSha256: ZERO_HASH, ...overrides.source, provenanceKey: `${prefix}/provenance.json` }
  });
  validateArtifactRecordsV5(manifest);
  getProvenanceReference(manifest);
  return manifest;
}

export function fixtureLatest(manifest = fixtureManifestV5(), baseUrl = 'https://api.test') {
  return latestV5Schema.parse({
    pointer: { version: 1, model: manifest.model, latestBuildId: manifest.buildId, retained: [{ buildId: manifest.buildId, manifestKey: `builds/${manifest.model}/${manifest.buildId}/manifest.json`, cycle: manifest.cycle, expiresAt: manifest.expiresAt }] },
    manifest,
    templates: Object.fromEntries(renderedLayers(manifest.layers, manifest.descriptors.layers).map(layer => [layer,
      `${baseUrl}/tiles/${manifest.model}/${manifest.buildId}/${layer}/{frame}/{z}/{x}/{y}.webp`])),
    freshness: computeFreshness(manifest, Date.parse(manifest.createdAt))
  });
}

export function fixtureBuild(overrides: Partial<ManifestV5> = {}, baseUrl = 'https://api.test'): PinnedBuild {
  const { manifest, templates } = fixtureLatest(fixtureManifestV5(overrides), baseUrl);
  return { manifest: manifest!, templates: templates! as PinnedBuild['templates'], expiresAtMs: Date.parse(manifest!.expiresAt) };
}
