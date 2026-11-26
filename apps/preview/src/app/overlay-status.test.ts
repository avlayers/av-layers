import { describe, expect, it } from 'vitest';
import type { OverlayState } from '../features/raster/raster-overlay';
import { overlayNotices, shownTimeNote } from './overlay-status';

describe('overlayNotices', () => {
  const idle = { displayed: null, requested: null } as unknown as OverlayState;
  const ctx = { build: null, pendingModel: null, resolving: false, expired: false, timeZone: 'UTC' };

  it('says loading while Auto resolves a first build, and nothing shown once it settles empty', () => {
    expect(overlayNotices(idle, { ...ctx, resolving: true }).frameStatus).toBe('Loading forecast…');
    expect(overlayNotices(idle, ctx).frameStatus).toBe('No forecast shown');
  });
});

describe('shownTimeNote', () => {
  const build = { manifest: { frames: [{ id: 'a', validTime: '2026-11-26T13:00:00Z' }, { id: 'b', validTime: '2026-11-26T14:00:00Z' }, { id: 'c', validTime: '2026-11-27T14:00:00Z' }] } };
  const sel = (frame: string) => ({ build, layer: 'usable-lift-agl', frame }) as unknown as NonNullable<OverlayState['displayed']>;

  it('names the hour on screen while another loads, with the weekday across days', () => {
    expect(shownTimeNote({ displayed: sel('a'), requested: sel('a'), replacementFailed: false }, 'UTC')).toBe('');
    expect(shownTimeNote({ displayed: sel('a'), requested: sel('b'), replacementFailed: false }, 'UTC')).toBe('Showing 13:00 · loading');
    expect(shownTimeNote({ displayed: sel('b'), requested: sel('c'), replacementFailed: true }, 'UTC')).toBe('Showing Thu 14:00 · unavailable');
  });
});
