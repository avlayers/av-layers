import { describe, expect, it, vi } from 'vitest';
import { computePointRevealPan, computePointRevealTarget, easePointIntoClearView } from './point-camera';

describe('point-camera', () => {
  it('centers the tapped point into the unobscured upper map space above #point-card on mobile', () => {
    const target = computePointRevealTarget({
      pointPx: { x: 210, y: 610 },
      viewport: { width: 390, height: 844 },
      cardRect: { left: 8, top: 386, right: 382, bottom: 774 },
      topbarBottomPx: 84,
    });
    expect(target).not.toBeNull();
    expect(target!.targetX).toBe(195);
    // Usable vertical space is between topbar (94px) and sheet top (374px) -> ~234px, well above the sheet!
    expect(target!.targetY).toBeGreaterThan(190);
    expect(target!.targetY).toBeLessThan(265);
    expect(target!.centerOffset[1]).toBeLessThan(-150);
  });

  it('anticipates the full Windgram sheet on mobile even while #point-card is still in its 28px loading state', () => {
    const target = computePointRevealTarget({
      pointPx: { x: 195, y: 422 },
      viewport: { width: 390, height: 844 },
      // Tiny 28px loading strip near the bottom before SVG renders:
      cardRect: { left: 8, top: 748, right: 382, bottom: 776 },
      topbarBottomPx: 84,
    });
    expect(target).not.toBeNull();
    // Must target the upper usable space (< 260px), never full-screen center (~420px) behind the sheet.
    expect(target!.targetY).toBeLessThan(260);
    expect(target!.centerOffset[1]).toBeLessThan(-160);
  });

  it('lifts the estimated mobile sheet above a taller measured dock', () => {
    const at = (bottomClearancePx: number) => computePointRevealTarget({
      pointPx: { x: 195, y: 700 },
      viewport: { width: 390, height: 844 },
      cardRect: { left: 8, top: 748, right: 382, bottom: 776 },
      topbarBottomPx: 84,
      bottomClearancePx,
    })!.targetY;
    expect(at(160)).toBeLessThan(at(68));
  });

  it('keeps the desktop camera stationary when the point is already in clear view', () => {
    const offset = computePointRevealPan({
      pointPx: { x: 920, y: 360 },
      viewport: { width: 1280, height: 800 },
      cardRect: { left: 12, top: 58, right: 662, bottom: 520 },
    });
    expect(offset).toBeNull();
  });

  it('pans horizontally on desktop when the tapped point falls underneath #point-card', () => {
    const target = computePointRevealTarget({
      pointPx: { x: 240, y: 310 },
      viewport: { width: 1280, height: 800 },
      cardRect: { left: 12, top: 58, right: 662, bottom: 520 },
    });
    expect(target).not.toBeNull();
    expect(target!.targetX).toBeGreaterThan(700);
    expect(target!.panBy[0]).toBeLessThan(-460);
  });

  it('prefers map.easeTo with exact centerOffset + pointCamera eventData and respects reduced motion', () => {
    const easeTo = vi.fn();
    const map = {
      project: () => ({ x: 195, y: 500 }),
      easeTo,
      getContainer: () => ({
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 390, bottom: 844, width: 390, height: 844 }),
      }),
    };
    const card = {
      hidden: false,
      getBoundingClientRect: () => ({ left: 8, top: 386, right: 382, bottom: 774, width: 374, height: 388 }),
    };
    const topbar = {
      getBoundingClientRect: () => ({ left: 12, top: 12, right: 330, bottom: 84, width: 318, height: 72 }),
    };
    const root = {
      ownerDocument: { defaultView: { matchMedia: () => ({ matches: true }) } },
      querySelector: (selector: string) => (selector === '#point-card' ? card : selector === '#topbar' ? topbar : null),
    } as unknown as ParentNode;

    expect(easePointIntoClearView(map, root, { lat: 37.65, lon: -79.8 })).toBe(true);
    expect(easeTo).toHaveBeenCalledOnce();
    const [opts, eventData] = easeTo.mock.calls[0]!;
    expect(opts.center).toEqual([-79.8, 37.65]);
    expect(opts.offset[0]).toBe(0);
    expect(opts.offset[1]).toBeLessThan(-150);
    expect(opts.duration).toBe(0);
    expect(eventData).toEqual({ pointCamera: true });
  });
});
