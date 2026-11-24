import { expect, it } from 'vitest';
import { CELL_BYTES, sparseCoverageFromDense, STATUS_NO_LIFT, STATUS_OUTSIDE, STATUS_VALID, type CoverageMask, type RegularLatLonGrid } from '@av/contracts';
import { planSample, sampleFromContributors, sampleGrid, type GridField } from './sampler.js';
import { packedCellsFromRange, planShardedPackedSample, prepareShardedSamplePackLayout } from './sample-pack.js';

function packRange(fields: readonly GridField[], layout: ReturnType<typeof prepareShardedSamplePackLayout>, plan: ReturnType<typeof planShardedPackedSample>): Uint8Array {
  const bytes = new Uint8Array(layout.shards[plan.shard]!.byteLength);
  const view = new DataView(bytes.buffer);
  const stride = layout.channelCount * CELL_BYTES;
  for (let ordinal = 0; ordinal < layout.blockCount; ordinal++) {
    const block = layout.block(ordinal);
    if (block.shard !== plan.shard) continue;
    const base = block.byteOffset;
    for (let r = 0; r < block.height; r++) {
      const rowOffset = (block.row + r) * layout.grid.width;
      for (let c = 0; c < block.width; c++) {
        const column = layout.grid.wrapLongitude ? (block.column + c) % layout.grid.width : block.column + c;
        const gridIndex = rowOffset + column;
        const cellOffset = base + (r * block.width + c) * stride;
        for (let ch = 0; ch < fields.length; ch++) {
          const offset = cellOffset + ch * CELL_BYTES;
          view.setFloat32(offset, fields[ch]!.values[gridIndex]!, true);
          bytes[offset + 4] = fields[ch]!.flags[gridIndex]!;
        }
      }
    }
  }
  return bytes.subarray(plan.byteRange.offset, plan.byteRange.offset + plan.byteRange.length);
}

it('packs sparse block shards with seam overlap and matches full-grid bilinear sampling', () => {
  const grid: RegularLatLonGrid = {
    kind: 'regular-latlon', width: 20, height: 18, wrapLongitude: true,
    earthRadiusM: 6371229, lon0: 0, lat0: 17, dx: 18, dy: -1
  };
  const mask: CoverageMask = {
    grid,
    output: new Uint8Array(Math.ceil((grid.width * grid.height) / 8)).fill(0xff),
    halo: new Uint8Array(Math.ceil((grid.width * grid.height) / 8)),
    tiles: new Uint8Array([1]),
    maxZoom: 0
  };
  const coverage = sparseCoverageFromDense({ width: grid.width, height: grid.height, wrapLongitude: grid.wrapLongitude, gridHash: 'a'.repeat(64), output: mask.output, halo: mask.halo });
  const layout = prepareShardedSamplePackLayout(grid, coverage.blockIds, 4);
  expect(layout.blockCount).toBe(4);

  const fields = [0, 1, 2, 3].map(channel => {
    const values = new Float32Array(grid.width * grid.height);
    const flags = new Uint8Array(grid.width * grid.height);
    for (let i = 0; i < values.length; i++) {
      values[i] = (i + 1) * 10 + channel;
      flags[i] = i % 7 === 0 ? STATUS_NO_LIFT : STATUS_VALID;
    }
    flags[3] = STATUS_OUTSIDE;
    values[3] = NaN;
    return { values, flags };
  });

  for (const [lat, lon] of [[16.4, 9], [0.5, 351], [1.2, 288], [16.8, 54]] as const) {
    const sample = planSample(grid, lat, lon)!;
    const packed = planShardedPackedSample(layout, sample, [1, 3]);
    expect(packed.byteRange.length).toBeLessThanOrEqual(19 * 4 * CELL_BYTES);
    const range = packRange(fields, layout, packed);
    for (const channel of [1, 3]) {
      const cells = packedCellsFromRange(packed, range, channel);
      expect(sampleFromContributors(sample, cells, 'usable-lift-msl')).toEqual(sampleGrid(grid, fields[channel]!, lat, lon, 'usable-lift-msl'));
    }
  }
});
