import { describe, expect, it } from 'vitest';
import type { OverlayState } from '../features/raster/raster-overlay';
import { overlayNotices } from './overlay-status';

describe('overlayNotices', () => {
  const idle = { displayed: null, requested: null } as unknown as OverlayState;
  const ctx = { build: null, pendingModel: null, resolving: false, expired: false, playing: false, timeZone: 'UTC' };

  it('says loading while Auto resolves a first build, and nothing shown once it settles empty', () => {
    expect(overlayNotices(idle, { ...ctx, resolving: true }).frameStatus).toBe('Loading forecast…');
    expect(overlayNotices(idle, ctx).frameStatus).toBe('No forecast shown');
  });
});
