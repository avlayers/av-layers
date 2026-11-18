import { describe, expect, it, vi } from 'vitest';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { PinnedBuild } from '@av/client';
import { LIFT_COLORS, RAIN_COLORS } from '@av/contracts/layers';
import { fixtureBuild } from '../../../../../tests/forecast-fixture';
import { createPreviewStore, emptyOverlay } from '../../stores/app-store';
import { resolveChannelStyles } from '../map/channel-styles';
import { remapRgbaInPlace } from '../raster/tile-remap-core';
import { CloudLayerController } from './cloud-layer';
import { IsobarLayerController } from './isobar-layer';
import { decodePrecipRgbaToField, RainAnimator } from './rain-animation';
import { pilotHorizonFrameOrder, SynopticSampler, type SynopticField } from './synoptic-sampler';

function parseHex(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  return [
    Number.parseInt(clean.slice(0, 2), 16),
    Number.parseInt(clean.slice(2, 4), 16),
    Number.parseInt(clean.slice(4, 6), 16)
  ];
}

describe('scrub, layer-switch & pan/zoom performance invariants', () => {
  it('prioritizes +1..+8h scrub neighbors and multi-day same-hour jumps in pilotHorizonFrameOrder', () => {
    const frames = Array.from({ length: 24 }, (_, idx) => {
      const ts = new Date(Date.parse('2026-11-18T12:00:00Z') + idx * 3 * 3_600_000).toISOString();
      return { id: `f${String(idx).padStart(3, '0')}`, validTime: ts, intervalStart: ts, intervalEnd: ts };
    });
    const build = {
      manifest: {
        frames,
        artifacts: frames.map(f => ({ frame: f.id, layer: 'usable-lift-agl', tilesKey: `t/${f.id}` }))
      }
    } as unknown as PinnedBuild;

    const anchor = frames[0]!.id;
    const order = pilotHorizonFrameOrder(build, anchor);
    expect(order).not.toContain(anchor);
    expect(order).toHaveLength(frames.length - 1);
    // Immediate scrub neighbors come first
    expect(order[0]).toBe(frames[1]!.id);
    // Day +2 same-hour frame (index 16 = +48h) is promoted ahead of distant off-hour frames like index 11 (+33h)
    expect(order.indexOf(frames[16]!.id)).toBeLessThan(order.indexOf(frames[11]!.id));
  });

  it('fetches only visible synoptic channels and upgrades missing mslp-hpa in place without re-fetching clouds', async () => {
    const build = fixtureBuild({
      mapFrameCount: 6,
      createdAt: '2026-11-18T00:00:00Z',
      expiresAt: '2026-11-25T00:00:00Z'
    });
    if (!build.manifest.layers.includes('cloud-cover-total')) build.manifest.layers.push('cloud-cover-total');
    if (!build.manifest.layers.includes('cloud-cover-low')) build.manifest.layers.push('cloud-cover-low');
    if (!build.manifest.layers.includes('mslp-hpa')) build.manifest.layers.push('mslp-hpa');

    const calls: Array<{ frames: readonly string[]; layers: readonly string[] }> = [];
    const fakeApi = {
      samples: vi.fn(async (_b: unknown, req: { points: Array<{ lat: number; lon: number }>; frames: readonly string[]; layers: readonly string[] }) => {
        calls.push({ frames: req.frames, layers: req.layers });
        return {
          points: req.points.map((_pt, index) => ({
            index,
            sample: {
              frames: req.frames.map(id => ({
                id,
                layers: {
                  ...(req.layers.includes('cloud-cover-total') ? { 'cloud-cover-total': { value: 65 } } : {}),
                  ...(req.layers.includes('cloud-cover-low') ? { 'cloud-cover-low': { value: 40 } } : {}),
                  ...(req.layers.includes('mslp-hpa') ? { 'mslp-hpa': { value: 1016 } } : {})
                }
              }))
            }
          }))
        };
      })
    };

    const sampler = new SynopticSampler(fakeApi as never);
    const view = { west: 44.0, south: 39.8, east: 45.2, north: 40.8 };
    const frame0 = build.manifest.frames[0]!.id;

    // 1. Default state (Clouds ON, Isobars OFF): only requests cloud layers!
    const cloudOnly = await sampler.load(build, frame0, view, { needClouds: true, needMslp: false });
    expect(cloudOnly).not.toBeNull();
    expect(cloudOnly!.hasClouds).toBe(true);
    expect(cloudOnly!.hasMslp).toBe(false);
    expect(calls[0]!.layers).toEqual(['cloud-cover-total', 'cloud-cover-low']);

    // 2. Local pan inside padded box hits cache with 0 HTTP requests
    const pannedView = { west: 44.15, south: 39.88, east: 45.35, north: 40.88 };
    const cachedPan = sampler.findCached(build, frame0, pannedView, { needClouds: true, needMslp: false });
    expect(cachedPan).toBe(cloudOnly);
    expect(calls).toHaveLength(1);

    // 3. Toggling Isobars ON upgrades ONLY mslp-hpa while preserving existing cloud arrays!
    const upgraded = await sampler.load(build, frame0, view, { needClouds: true, needMslp: true });
    expect(upgraded).not.toBeNull();
    expect(upgraded!.hasClouds).toBe(true);
    expect(upgraded!.hasMslp).toBe(true);
    expect(upgraded!.total[0]).toBeCloseTo(0.65, 3);
    expect(upgraded!.mslp[0]).toBeCloseTo(1016, 3);
    expect(calls[1]!.layers).toEqual(['mslp-hpa']);

    // 4. Multi-frame horizon warm batches multiple frames per HTTP call
    sampler.warmHorizon(build, frame0, view, { needClouds: true, needMslp: false });
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(2));
    expect(calls[2]!.frames.length).toBeGreaterThanOrEqual(2);
    sampler.dispose();
  });

  it('skips redundant setData, updateImage, and setPaintProperty calls on cached cloud & isobar scrubs', () => {
    const sources = new Map<string, { updateImage?: ReturnType<typeof vi.fn>; setData?: ReturnType<typeof vi.fn> }>();
    const layers = new Set<string>();
    const setPaintProperty = vi.fn();
    const setLayoutProperty = vi.fn();

    const map = {
      getZoom: () => 7,
      getSource: (id: string) => sources.get(id),
      addSource: (id: string, spec: { type: string }) => {
        if (spec.type === 'image') sources.set(id, { updateImage: vi.fn() });
        else sources.set(id, { setData: vi.fn() });
      },
      removeSource: (id: string) => sources.delete(id),
      getLayer: (id: string) => layers.has(id),
      addLayer: (spec: { id: string }) => layers.add(spec.id),
      removeLayer: (id: string) => layers.delete(id),
      setPaintProperty,
      setLayoutProperty
    } as unknown as MapLibreMap;

    const total = new Float32Array(48).fill(0.8);
    const low = new Float32Array(48).fill(0.75);
    const mslp = new Float32Array(48);
    for (let i = 0; i < 48; i++) mslp[i] = 1008 + (i % 8) * 2.2;

    const field: SynopticField = {
      id: 'b1:f0:box:cp',
      buildId: 'b1',
      frame: 'f0',
      cols: 8,
      rows: 6,
      west: 43.5,
      south: 39.5,
      east: 46.0,
      north: 41.2,
      total,
      low,
      mslp,
      hasClouds: true,
      hasMslp: true
    };

    const styles = resolveChannelStyles('stone', { cloudStyle: 'auto', rainStyle: 'auto' });
    const iso = new IsobarLayerController(map);
    iso.paint(field, styles.isobar, true);

    const lineSetData = sources.get('av-isobars-lines')!.setData!;
    const paintCallsAfterFirst = setPaintProperty.mock.calls.length;
    const layoutCallsAfterFirst = setLayoutProperty.mock.calls.length;

    // Re-painting same field/zoom (or zooming within z >= 4.3) does zero setData & zero setPaintProperty!
    iso.paint(field, styles.isobar, true);
    expect(lineSetData).toHaveBeenCalledTimes(0);
    expect(setPaintProperty.mock.calls.length).toBe(paintCallsAfterFirst);
    expect(setLayoutProperty.mock.calls.length).toBe(layoutCallsAfterFirst);

    if (typeof OffscreenCanvas === 'function') {
      const clouds = new CloudLayerController(map, true);
      clouds.paint(field, styles, 0.7, true);
      const updateImg = sources.get('av-sky-clouds')?.updateImage;
      const contourSetData = sources.get('av-cloud-contours')?.setData;
      const uCount = updateImg?.mock.calls.length ?? 0;
      const cCount = contourSetData?.mock.calls.length ?? 0;
      const pCount = setPaintProperty.mock.calls.length;

      clouds.paint(field, styles, 0.7, true);
      expect(updateImg?.mock.calls.length ?? 0).toBe(uCount);
      expect(contourSetData?.mock.calls.length ?? 0).toBe(cCount);
      expect(setPaintProperty.mock.calls.length).toBe(pCount);
      clouds.clear();
    }
    iso.clear();
  });

  it('projects hundreds of raindrops with <= 4 calibrated map.project probes per frame in flat Mercator view', () => {
    const w = 64, h = 64;
    const rgba = new Uint8ClampedArray(w * h * 4);
    const [rr, rg, rb] = parseHex(RAIN_COLORS[Math.min(5, RAIN_COLORS.length - 1)]!);
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4] = rr;
      rgba[i * 4 + 1] = rg;
      rgba[i * 4 + 2] = rb;
      rgba[i * 4 + 3] = 255;
    }
    const field = decodePrecipRgbaToField(rgba, w, h, { west: 44, south: 40, east: 45, north: 41 }, 'rain-perf');
    expect(field.wetIndices.length).toBeGreaterThan(0);

    const DEG = Math.PI / 180;
    const mercY = (lat: number) => Math.asinh(Math.tan(lat * DEG));
    const centerLon = 44.5, centerLat = 40.5, centerMy = mercY(centerLat);
    const projectSpy = vi.fn(([lon, lat]: [number, number]) => ({
      x: 400 + (lon - centerLon) * 600,
      y: 300 + (centerMy - mercY(lat)) * 600 * (180 / Math.PI)
    }));

    const fakeCtx = {
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      arc: vi.fn(),
      ellipse: vi.fn(),
      closePath: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      drawImage: vi.fn(),
      createLinearGradient: () => ({ addColorStop: vi.fn() }),
      lineCap: 'round',
      lineWidth: 1,
      strokeStyle: '#fff',
      fillStyle: '#fff',
      globalAlpha: 1
    };

    const origDoc = globalThis.document;
    const origWin = globalThis.window;
    vi.stubGlobal('window', {
      devicePixelRatio: 1,
      matchMedia: () => ({ matches: true }) // Static reduced-motion draw triggers synchronous drawFrame(0)
    });
    vi.stubGlobal('document', {
      hidden: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      createElement: () => ({
        className: '',
        style: { cssText: '' },
        width: 800,
        height: 600,
        setAttribute: vi.fn(),
        getBoundingClientRect: () => ({ width: 800, height: 600 }),
        getContext: () => fakeCtx,
        remove: vi.fn()
      })
    });

    try {
      const host = { appendChild: vi.fn() };
      const map = {
        getCanvasContainer: () => host,
        getCanvas: () => ({ clientWidth: 800, clientHeight: 600 }),
        getCenter: () => ({ lng: centerLon, lat: centerLat }),
        getBounds: () => ({ getWest: () => 44.1, getEast: () => 44.9, getSouth: () => 40.1, getNorth: () => 40.9 }),
        project: projectSpy,
        on: vi.fn(),
        off: vi.fn()
      } as unknown as MapLibreMap;

      const animator = new RainAnimator(map, { darkChrome: false, opacity: 0.8, visible: true });
      projectSpy.mockClear();
      animator.setField(field);

      // Should draw many raindrops via drawImage while only calling map.project 4 times for calibration!
      expect(fakeCtx.drawImage.mock.calls.length).toBeGreaterThan(50);
      expect(projectSpy.mock.calls.length).toBe(4);
      animator.destroy();
    } finally {
      vi.stubGlobal('document', origDoc);
      vi.stubGlobal('window', origWin);
    }
  });

  it('produces identical RGBA output on empty and sparse tiles with ROI bounding-box culling', () => {
    const empty = new Uint8ClampedArray(64 * 64 * 4);
    remapRgbaInPlace(empty, 64, 64, 'lift', 'stone');
    expect(empty.every(v => v === 0)).toBe(true);

    const sparse = new Uint8ClampedArray(64 * 64 * 4);
    const [r, g, b] = parseHex(LIFT_COLORS[8]!);
    for (let y = 24; y < 32; y++) {
      for (let x = 20; x < 28; x++) {
        const off = (y * 64 + x) * 4;
        sparse[off] = r;
        sparse[off + 1] = g;
        sparse[off + 2] = b;
        sparse[off + 3] = 255;
      }
    }
    remapRgbaInPlace(sparse, 64, 64, 'lift', 'stone');
    // Interior of patch is opaque & remapped; far corners stay strictly 0
    expect(sparse[(28 * 64 + 24) * 4 + 3]).toBeGreaterThan(150);
    expect(sparse[3]).toBe(0);
    expect(sparse[(63 * 64 + 63) * 4 + 3]).toBe(0);
  });

  it('skips signal notification and object allocation when store writer patch has identical values', () => {
    const store = createPreviewStore({
      intent: {
        model: 'gfs', reference: 'agl', customLayer: null, opacity: 0.5, units: 'metric',
        windStyle: 'trails', windVisible: true, windVisibleOverride: null, windPaused: false,
        windHeight: 'surface', fixedWindHeight: 0, pointHorizon: 'day', requestedTime: null
      },
      forecast: {
        build: null, selectedFrame: null, pendingModel: null, expired: false, mapReady: false, mapFailed: false, layers: [],
        offsetMinutes: 0, mapCenter: { lat: 40.18, lng: 44.51 }, playing: false
      },
      overlay: emptyOverlay,
      wind: { status: 'ready', overview: false, displayed: true, supported: true },
      point: { open: false, location: '', horizonSelectable: false, horizonLabel: '24 hours', busy: false, status: '', wind: '' },
      location: { message: '', detail: '', busy: false },
      notices: { error: '', tileError: '', horizon: '', freshness: '', frameStatus: 'Full detail', overviewReady: 40, overviewTotal: 40, overviewFailed: 0, detailReady: 4, preparationLimited: false, scaleWidth: 64, scaleText: '10 km' }
    });

    const noticesBefore = store.view.notices.value;
    store.writer.notices({ frameStatus: 'Full detail', overviewReady: 40, tileError: '' });
    expect(store.view.notices.value).toBe(noticesBefore);

    const windBefore = store.view.wind.value;
    store.writer.wind({ status: 'ready', displayed: true });
    expect(store.view.wind.value).toBe(windBefore);
  });
});
