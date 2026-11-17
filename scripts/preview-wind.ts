import { STATUS_VALID } from '@av/contracts/layers';
import { createHash } from 'node:crypto';
import { prepareGridGeometry } from '@av/contracts/geometry';
import { CELL_BYTES, SAMPLE_BLOCK_SIZE } from '@av/contracts';
import { WIND_FINE_CELL_BYTES, WIND_HEIGHTS, WIND_INDEX_ENTRIES, WIND_OVERVIEW_CELL_BYTES, WIND_OVERVIEW_TILE_SIZE, decodeTileMask, windLayout, windOverviewLayout } from '@av/contracts/wind-data';
import { encodeWindColumns } from '@av/forecast/wind';
import type { ManifestV5 } from '@av/contracts/publication';
import golden from './fixtures/gfs-wind-layout.json' with { type: 'json' };
import rrfs from './fixtures/rrfs-wind-layout.json' with { type: 'json' };

const gfsFineMask = `${golden.fineMask.slice(0, -1)}${'A'.repeat(160)}=`;

export function configureGfsWindGrid(manifest: ManifestV5) {
  const fine = manifest.surfaces.find(surface => surface.kind === 'fine')!;
  if (fine.grid.kind !== 'regular-latlon') throw new Error('Expected a regular GFS grid');
  fine.grid = { ...fine.grid, width: 14400, height: 7201, lon0: -180, lat0: 90, dx: 0.025, dy: -0.025, wrapLongitude: true, earthRadiusM: 6371229 };
  const count = Math.ceil(fine.grid.width / SAMPLE_BLOCK_SIZE) * Math.ceil(fine.grid.height / SAMPLE_BLOCK_SIZE);
  fine.samples.blockCount = count; fine.samples.storedCells = count;
  const shard = fine.samples.shards[0]; shard.blockCount = count; shard.storedCells = count; shard.bytes = count * fine.samples.channelCount * CELL_BYTES;
}

export function configureRrfsWindGrid(manifest: ManifestV5) {
  const base = { kind: 'lambert-conformal' as const, earthRadiusM: 6371229, centralMeridianDeg: -97.5, latitudeOfOriginDeg: 38.5,
    standardParallel1Deg: 38.5, standardParallel2Deg: 38.5, x0M: -2697520.1425219304, y0M: -1587306.1525566643, wrapLongitude: false as const };
  for (const surface of manifest.surfaces) {
    surface.grid = surface.kind === 'native' ? { ...base, width: 1799, height: 1059, dxM: 3000, dyM: 3000 } : { ...base, width: 3597, height: 2117, dxM: 1500, dyM: 1500 };
    const count = Math.ceil(surface.grid.width / SAMPLE_BLOCK_SIZE) * Math.ceil(surface.grid.height / SAMPLE_BLOCK_SIZE);
    surface.samples.blockCount = count; surface.samples.storedCells = count;
    const shard = surface.samples.shards[0]; shard.blockCount = count; shard.storedCells = count; shard.bytes = count * surface.samples.channelCount * CELL_BYTES;
  }
}

export function previewWindFixture(manifest: ManifestV5, globalGfs: boolean | 'rrfs' = false) {
  const native = manifest.surfaces.find(surface => surface.kind === 'native')!.grid;
  const fine = manifest.surfaces.find(surface => surface.kind === 'fine')!.grid;
  const levels = globalGfs === 'rrfs' ? 26 : globalGfs ? 22 : 3;
  const nativeLayout = windLayout(native.width, native.height, 16, levels);
  const fineLayout = windLayout(fine.width, fine.height, 64);
  const masks = globalGfs === 'rrfs' ? rrfs : { windMask: golden.windMask, fineMask: gfsFineMask };
  const windMask = globalGfs ? decodeTileMask(masks.windMask, nativeLayout.count) : null;
  const fineMask = globalGfs ? decodeTileMask(masks.fineMask, fineLayout.count) : null;
  const logicalTiles = (count: number, mask: typeof windMask) => {
    if (!mask) return null;
    const result = new Array<number>(mask.count);
    for (let logical = 0; logical < count; logical++) { const slot = mask.slot(logical); if (slot >= 0) result[slot] = logical; }
    return result;
  };
  const nativeSlots = logicalTiles(nativeLayout.count, windMask), fineSlots = logicalTiles(fineLayout.count, fineMask);
  const shards = (frame: string, kind: string, count: number, chunkBytes: number) => Array.from({ length: Math.ceil(count / WIND_INDEX_ENTRIES) }, (_, page) => {
    const length = Math.min(WIND_INDEX_ENTRIES, count - page * WIND_INDEX_ENTRIES);
    const placeholder = (field: string) => createHash('sha256').update(`non-integrity-preview-fixture/${frame}/${kind}/${page}/${field}`).digest('hex');
    return { sha256: placeholder('shard'), indexSha256: placeholder('index'), count: length, bytes: length * chunkBytes };
  });
  const strides = globalGfs ? [2, 4, 8, 16] : [2, 4, 8, 16, 32, 64];
  const values = (frame: number, x: number, y: number, height: number) => ({
    u: 4 + frame * 0.2 + x * 0.002 + height * 0.001,
    v: 2 + frame * 0.1 + y * 0.002 + height * 0.0005
  });
  const fineChunk = new Uint8Array(64 * 64 * WIND_FINE_CELL_BYTES);
  const fineView = new DataView(fineChunk.buffer);
  for (let i = 0; i < 64 * 64; i++) {
    fineView.setFloat32(i * WIND_FINE_CELL_BYTES, 100, true);
    fineView.setFloat32(i * WIND_FINE_CELL_BYTES + 4, 2100, true);
    fineView.setUint8(i * WIND_FINE_CELL_BYTES + 8, 16);
  }
  return {
    expected(frame: string, lat: number, lon: number, height: number) {
      const index = manifest.frames.findIndex(item => item.id === frame), point = prepareGridGeometry(native).geographicToGrid(lat, lon);
      return index < 0 || !point ? null : values(index, point.x, point.y, height);
    },
    descriptor(frame: string) {
      if (!manifest.frames.some(item => item.id === frame)) return null;
      return { version: 3, frame, levels, tileSize: 16, fineTileSize: 64,
        ...(globalGfs ? { windMask: masks.windMask, fineMask: masks.fineMask } : {}),
        wind: shards(frame, 'wind', windMask?.count ?? nativeLayout.count, nativeLayout.chunkBytes), fine: shards(frame, 'fine', fineMask?.count ?? fineLayout.count, fineLayout.chunkBytes),
        overview: strides.map(stride => { const layout = windOverviewLayout(native, stride); return { stride, shards: shards(frame, `overview-${stride}`, layout.count, layout.chunkBytes) }; }) };
    },
    chunk(frame: string, kind: string, tile: number): Uint8Array | null {
      const frameIndex = manifest.frames.findIndex(item => item.id === frame);
      if (frameIndex < 0 || !Number.isSafeInteger(tile) || tile < 0) return null;
      if (kind === 'fine') return tile < (fineSlots?.length ?? fineLayout.count) ? fineChunk : null;
      if (kind === 'wind') {
        if (tile >= (nativeSlots?.length ?? nativeLayout.count)) return null;
        const logical = nativeSlots?.[tile] ?? tile, across = Math.ceil(native.width / 16), tileX = logical % across, tileY = Math.floor(logical / across);
        return encodeWindColumns(Array.from({ length: 256 }, (_, index) => {
          const x = tileX * 16 + index % 16, y = tileY * 16 + Math.floor(index / 16);
          if (x >= native.width || y >= native.height) return null;
          return { surface: values(frameIndex, x, y, 0), levels: (globalGfs ? Array.from({ length: levels }, (_, i) => 110 + i * 200) : [110, 2100, 4100]).map(height => ({ height, wind: values(frameIndex, x, y, height - 100) })) };
        }));
      }
      const stride = Number(kind.replace(/^overview-/, ''));
      if (!strides.includes(stride) || kind !== `overview-${stride}`) return null;
      const layout = windOverviewLayout(native, stride);
      if (tile >= layout.count) return null;
      const bytes = new Uint8Array(layout.chunkBytes), view = new DataView(bytes.buffer), across = Math.ceil(layout.width / WIND_OVERVIEW_TILE_SIZE);
      for (let i = 0; i < WIND_OVERVIEW_TILE_SIZE ** 2; i++) {
        const x = (tile % across * WIND_OVERVIEW_TILE_SIZE + i % WIND_OVERVIEW_TILE_SIZE) * stride + (stride - 1) / 2;
        const y = (Math.floor(tile / across) * WIND_OVERVIEW_TILE_SIZE + Math.floor(i / WIND_OVERVIEW_TILE_SIZE)) * stride + (stride - 1) / 2;
        for (const [mode, height] of [0, ...WIND_HEIGHTS, 2000].entries()) {
          const offset = i * WIND_OVERVIEW_CELL_BYTES + mode * 9, wind = values(frameIndex, x, y, height);
          view.setFloat32(offset, wind.u, true); view.setFloat32(offset + 4, wind.v, true); view.setUint8(offset + 8, STATUS_VALID);
        }
      }
      return bytes;
    }
  };
}
