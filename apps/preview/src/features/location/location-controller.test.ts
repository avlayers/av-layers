import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Map } from 'maplibre-gl';
import { createLocationController } from './location-controller';

function createHarness(initialNow = 1_000_000) {
  let nowMs = initialNow;
  let zoom = 6;
  let center = { lng: 0, lat: 20 };
  const moveHandlers = new Set<() => void>();
  const appended: HTMLElement[] = [];
  const map = {
    getZoom: () => zoom,
    getCenter: () => center,
    jumpTo: vi.fn(({ center: nextCenter, zoom: nextZoom }: { center: [number, number]; zoom: number }) => {
      center = { lng: nextCenter[0], lat: nextCenter[1] };
      zoom = nextZoom;
    }),
    project: ([lng, lat]: [number, number]) => ({ x: lng * 2, y: lat * 2 }),
    on: (_event: string, fn: () => void) => { moveHandlers.add(fn); },
    off: (_event: string, fn: () => void) => { moveHandlers.delete(fn); },
    getContainer: () => ({ append: (el: HTMLElement) => { appended.push(el); } })
  } as unknown as Map;

  const messages: string[] = [];
  const details: string[] = [];
  const busyStates: boolean[] = [];

  const controller = createLocationController({
    map,
    publish: {
      message: msg => messages.push(msg),
      detail: d => details.push(d),
      busy: b => busyStates.push(b)
    },
    isAborted: () => false,
    isMapFailed: () => false,
    now: () => nowMs
  });

  return {
    controller,
    map,
    messages,
    details,
    busyStates,
    appended,
    setNow(next: number) { nowMs = next; },
    setCenter(lng: number, lat: number) { center = { lng, lat }; }
  };
}

describe('location controller', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('requests a fast coarse fix first and jumps the map to at least zoom 10', () => {
    const h = createHarness();
    const calls: PositionOptions[] = [];
    vi.stubGlobal('document', {
      createElement: () => ({ style: {}, setAttribute() {}, remove: vi.fn() })
    });
    vi.stubGlobal('navigator', {
      geolocation: {
        getCurrentPosition: (success: PositionCallback, _error?: PositionErrorCallback, options?: PositionOptions) => {
          calls.push(options ?? {});
          success({ coords: { longitude: -78.5, latitude: 38.7 } } as GeolocationPosition);
        }
      }
    });

    h.controller.locate();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ enableHighAccuracy: false, timeout: 3_000 });
    expect(h.map.jumpTo).toHaveBeenCalledWith({ center: [-78.5, 38.7], zoom: 10 });
    expect(h.busyStates).toEqual([true, false]);
    expect(h.messages.at(-1)).toBe('');
  });

  it('retries across position-unavailable and timeout errors but stops immediately on permission denied', () => {
    const h = createHarness();
    const calls: PositionOptions[] = [];
    vi.stubGlobal('document', {
      createElement: () => ({ style: {}, setAttribute() {}, remove: vi.fn() })
    });
    vi.stubGlobal('navigator', {
      geolocation: {
        getCurrentPosition: (success: PositionCallback, error?: PositionErrorCallback, options?: PositionOptions) => {
          calls.push(options ?? {});
          if (calls.length === 1) {
            error?.({ code: 3, message: 'Timed out' } as GeolocationPositionError);
            return;
          }
          if (calls.length === 2) {
            error?.({ code: 2, message: 'Unavailable' } as GeolocationPositionError);
            return;
          }
          success({ coords: { longitude: -105.27, latitude: 40.015 } } as GeolocationPosition);
        }
      }
    });

    h.controller.locate();
    expect(calls).toHaveLength(3);
    expect(calls.map(c => c.enableHighAccuracy)).toEqual([false, true, false]);
    expect(h.map.jumpTo).toHaveBeenCalledWith({ center: [-105.27, 40.015], zoom: 10 });

    // Permission denied stops immediately without retrying.
    calls.length = 0;
    h.controller.reset();
    vi.stubGlobal('navigator', {
      geolocation: {
        getCurrentPosition: (_success: PositionCallback, error?: PositionErrorCallback, options?: PositionOptions) => {
          calls.push(options ?? {});
          error?.({ code: 1, message: 'Denied' } as GeolocationPositionError);
        }
      }
    });
    h.controller.locate();
    expect(calls).toHaveLength(1);
    expect(h.messages.at(-1)).toBe('Location permission denied');
  });

  it('uses a warm cached fix immediately and does not hijack the camera if the user pans before background refresh completes', () => {
    const h = createHarness();
    let calls = 0;
    let pendingSuccess: PositionCallback = () => {};
    vi.stubGlobal('document', {
      createElement: () => ({ style: {}, setAttribute() {}, remove: vi.fn() })
    });
    vi.stubGlobal('navigator', {
      geolocation: {
        getCurrentPosition: (success: PositionCallback) => {
          calls += 1;
          if (calls === 1) {
            success({ coords: { longitude: -78.5, latitude: 38.7 } } as GeolocationPosition);
          } else {
            pendingSuccess = success;
          }
        }
      }
    });

    // Cold click populates the cache.
    h.controller.locate();
    expect(h.map.jumpTo).toHaveBeenCalledTimes(1);

    // Warm click within TTL jumps immediately without setting busy(true).
    h.setNow(1_010_000);
    h.busyStates.length = 0;
    h.controller.locate();
    expect(h.busyStates).toEqual([false]);
    expect(h.map.jumpTo).toHaveBeenCalledTimes(2);

    // User pans away while background refresh is in flight; resolving refresh updates cache without hijacking camera.
    h.setCenter(-79.0, 39.0);
    pendingSuccess({ coords: { longitude: -78.52, latitude: 38.72 } } as GeolocationPosition);
    expect(h.map.jumpTo).toHaveBeenCalledTimes(2);
  });
});
