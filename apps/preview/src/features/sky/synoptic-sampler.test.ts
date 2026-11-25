import { describe, expect, it } from 'vitest';
import type { ApiClient, PinnedBuild } from '@av/client';
import { SynopticSampler } from './synoptic-sampler';

const build = { manifest: { buildId: 'b1', layers: ['cloud-cover-total', 'cloud-cover-low'], frames: [], descriptors: {} }, expiresAtMs: Date.now() + 60_000 } as unknown as PinnedBuild;

function sampler(cells: (index: number) => Record<string, { status: string; value: number | null }>) {
  const api = {
    samples: async (_build: PinnedBuild, request: { points: unknown[] }) => ({
      points: request.points.map((_p, i) => ({ sample: { frames: [{ id: 'f0', layers: cells(i) }] } }))
    })
  } as unknown as ApiClient;
  return new SynopticSampler(api);
}
const view = { west: 40, south: 35, east: 50, north: 45 };

describe('SynopticSampler cloud cells', () => {
  it('keeps valid total cloud when low cloud is unavailable, and leaves low unknown', async () => {
    const field = await sampler(() => ({ 'cloud-cover-total': { status: 'valid', value: 80 }, 'cloud-cover-low': { status: 'unavailable', value: null } })).load(build, 'f0', view);
    expect(field!.hasClouds).toBe(true);
    expect([...field!.total].every(v => Math.abs(v - 0.8) < 1e-6)).toBe(true);
    expect([...field!.low].every(Number.isNaN)).toBe(true);
  });

  it('marks unknown total cloud as unknown and the field as evaluated without clouds', async () => {
    const field = await sampler(() => ({ 'cloud-cover-total': { status: 'unavailable', value: null }, 'cloud-cover-low': { status: 'valid', value: 40 } })).load(build, 'f0', view);
    expect(field!.hasClouds).toBe(false);
    expect(field!.cloudsEvaluated).toBe(true);
    expect([...field!.total].every(Number.isNaN)).toBe(true);
  });
});
