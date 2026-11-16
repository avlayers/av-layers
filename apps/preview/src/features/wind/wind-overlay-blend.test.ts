import { afterEach, expect, it, vi } from 'vitest';
import type { Map } from 'maplibre-gl';
import { PLAYBACK_STEP_MS } from '../timeline/timeline-model';
import { WindOverlay } from './wind-overlay';

const gl = vi.hoisted(() => ({ setFields: vi.fn(), setPrepared: vi.fn(), setMotion: vi.fn(), destroy: vi.fn() }));
vi.mock('./wind-gl', () => ({ attachWindGl: () => gl }));

class Canvas extends EventTarget {
  style: Record<string, string> = {};
  width = 0;
  height = 0;
  getContext(): object {
    return { setTransform: () => {}, clearRect: () => {}, fillRect: () => {}, beginPath: () => {}, stroke: () => {} };
  }
  setAttribute(): void {}
  remove(): void {}
}

function overlay(): WindOverlay {
  const doc = Object.assign(new EventTarget(), { hidden: false, createElement: () => new Canvas() });
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', { devicePixelRatio: 1 });
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  const map = {
    getCanvasContainer: () => ({ appendChild: () => {} }),
    getCanvas: () => ({ clientWidth: 64, clientHeight: 64 }),
    on: () => {},
    off: () => {},
    getBounds: () => ({ getWest: () => -1, getEast: () => 1, getNorth: () => 1, getSouth: () => -1 }),
    getZoom: () => 0,
    getBearing: () => 0,
    getPitch: () => 0,
    project: () => ({ x: 0, y: 0 }),
    unproject: () => ({ lng: 0, lat: 0 })
  };
  return new WindOverlay(map as unknown as Map);
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); gl.setFields.mockClear(); gl.setPrepared.mockClear(); });

it('keeps a playback blend until the step ends, then syncs the GPU to the current field only', () => {
  const now = vi.spyOn(performance, 'now').mockReturnValue(1_000);
  const view = overlay();
  const previous = { sample: () => ({ status: 0, u: 10, v: 0 }) };
  const next = { sample: () => ({ status: 2, u: null, v: null }) };
  view.setField(previous);
  view.setField(next, 'swap');
  view.setOptions({ paused: true });
  expect(gl.setFields).toHaveBeenLastCalledWith(previous, next);
  now.mockReturnValue(1_000 + PLAYBACK_STEP_MS);
  view.setOptions({ paused: false });
  expect(gl.setFields).toHaveBeenLastCalledWith(null, next);
  view.destroy();
});


it('uploads a prepared lattice instead of reconstructing it from a field', () => {
  const view = overlay();
  const prepared = { bounds: [0, 0, 1, 1] as [number, number, number, number], data: new Uint8Array(16), size: 2, height: 'surface' as const, key: 'prepared:surface' };
  view.setPrepared(prepared);
  expect(gl.setPrepared).toHaveBeenLastCalledWith(prepared);
  expect(gl.setFields).not.toHaveBeenCalled();
  view.setField({ sample: () => ({ status: 0, u: 1, v: 1 }) });
  expect(gl.setFields).toHaveBeenCalled();
});

it('installs field and prepared data before renderer synchronization', () => {
  const view = overlay();
  const prepared = { bounds: [0, 0, 1, 1] as [number, number, number, number], data: new Uint8Array(16), size: 2, height: 'surface' as const, key: 'prepared:install' };
  view.install({ sample: () => ({ status: 0, u: 1, v: 1 }) }, prepared);
  expect(gl.setPrepared).toHaveBeenLastCalledWith(prepared);
  expect(gl.setFields).not.toHaveBeenCalled();
});
