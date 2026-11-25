import { describe, expect, it } from 'vitest';
import type { OverlayState } from '../features/raster/raster-overlay';
import { overlayNotices, skyStatusText } from './overlay-status';

describe('skyStatusText', () => {
  it('is empty when every visible sky channel draws the selected hour', () => {
    expect(skyStatusText({ clouds: 'ready', rain: 'ready' })).toBe('');
    expect(skyStatusText({})).toBe('');
  });

  it('names waiting and missing channels separately', () => {
    expect(skyStatusText({ clouds: 'loading', isobars: 'unavailable', rain: 'loading' })).toBe('Clouds, rain loading… · Pressure unavailable');
  });
});

describe('overlayNotices', () => {
  const idle = { displayed: null, requested: null } as unknown as OverlayState;
  const ctx = { build: null, pendingModel: null, resolving: false, expired: false, playing: false, timeZone: 'UTC' };

  it('says loading while Auto resolves a first build, and nothing shown once it settles empty', () => {
    expect(overlayNotices(idle, { ...ctx, resolving: true }).frameStatus).toBe('Loading forecast…');
    expect(overlayNotices(idle, ctx).frameStatus).toBe('No forecast shown');
  });
});
