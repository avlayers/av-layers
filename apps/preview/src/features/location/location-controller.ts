import type { Map } from 'maplibre-gl';

const CACHED_POSITION_TTL_MS = 120_000;
const LOCATE_ATTEMPTS: ReadonlyArray<PositionOptions> = [
  { enableHighAccuracy: false, maximumAge: CACHED_POSITION_TTL_MS, timeout: 3_000 },
  { enableHighAccuracy: true, maximumAge: CACHED_POSITION_TTL_MS, timeout: 6_000 },
  { enableHighAccuracy: false, maximumAge: CACHED_POSITION_TTL_MS, timeout: 5_000 }
];
const WARM_REFRESH_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  maximumAge: 0,
  timeout: 6_000
};

interface LocationControllerOptions {
  readonly map: Map;
  readonly publish: { message(message: string): void; detail(detail: string): void; busy(busy: boolean): void };
  readonly isAborted: () => boolean;
  readonly isMapFailed: () => boolean;
  readonly now?: () => number;
}

interface LocationController {
  locate(): void;
  reset(): void;
  dispose(): void;
}

const LOCATE_MESSAGES = (error: GeolocationPositionError): string =>
  error.code === 1 ? 'Location permission denied' : error.code === 3 ? 'Location timed out' : 'Location unavailable';

/** Geolocation, map centering and the transient located marker. */
export function createLocationController(options: LocationControllerOptions): LocationController {
  const { map, publish, now = Date.now } = options;
  let revision = 0, coldInFlight = false, warmInFlight = false, marker: HTMLElement | null = null, point: [number, number] | null = null, timer: ReturnType<typeof setTimeout> | null = null;
  let cachedFix: { point: [number, number]; atMs: number } | null = null;

  const positionMarker = (): void => {
    if (!marker || !point) return;
    const projected = map.project(point);
    marker.style.transform = `translate3d(${projected.x}px, ${projected.y}px, 0) translate(-50%, -50%)`;
  };
  const clearMarker = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    map.off('move', positionMarker);
    marker?.remove();
    marker = point = null;
  };
  const show = (message: string, detail = ''): void => { publish.message(message); publish.detail(detail); };
  const finish = (request: number): void => {
    if (request === revision) {
      coldInFlight = false;
      warmInFlight = false;
      publish.busy(false);
    }
  };
  const presentFix = (next: [number, number]): void => {
    clearMarker();
    map.jumpTo({ center: next, zoom: Math.max(map.getZoom(), 10) });
    const dot = Object.assign(document.createElement('div'), { className: 'location-pulse' });
    dot.setAttribute('aria-hidden', 'true');
    marker = dot; point = next;
    map.getContainer().append(dot);
    positionMarker(); map.on('move', positionMarker);
    timer = setTimeout(clearMarker, 2000);
  };
  const cameraStillNear = (target: [number, number], targetZoom: number): boolean => {
    if (typeof map.getCenter !== 'function') return true;
    const center = map.getCenter();
    const zoomOk = typeof map.getZoom !== 'function' || Math.abs(map.getZoom() - targetZoom) < 1e-2;
    return zoomOk && Math.abs(center.lng - target[0]) < 1e-4 && Math.abs(center.lat - target[1]) < 1e-4;
  };

  function locate(): void {
    if (options.isMapFailed()) return;
    if (!navigator.geolocation) { show('Location unavailable'); return; }
    const warm = cachedFix && now() - cachedFix.atMs < CACHED_POSITION_TTL_MS ? cachedFix.point : null;
    if (warm) {
      publish.busy(false);
      show('');
      presentFix(warm);
      if (coldInFlight || warmInFlight) return;
      const warmZoom = map.getZoom();
      const request = ++revision;
      warmInFlight = true;
      try {
        navigator.geolocation.getCurrentPosition(position => {
          if (request !== revision || options.isAborted()) return;
          const next: [number, number] = [position.coords.longitude, position.coords.latitude];
          cachedFix = { point: next, atMs: now() };
          finish(request);
          if (cameraStillNear(warm, warmZoom) && (Math.abs(next[0] - warm[0]) >= 1e-3 || Math.abs(next[1] - warm[1]) >= 1e-3)) {
            presentFix(next);
          }
        }, () => {
          if (request !== revision || options.isAborted()) return;
          finish(request);
        }, WARM_REFRESH_OPTIONS);
      } catch {
        finish(request);
      }
      return;
    }
    if (coldInFlight) return;
    const request = ++revision;
    coldInFlight = true;
    warmInFlight = false;
    publish.busy(true);
    show('Locating…');
    const requestLocate = (attempt: number): void => {
      try {
        navigator.geolocation.getCurrentPosition(position => {
          if (request !== revision || options.isAborted()) return;
          const next: [number, number] = [position.coords.longitude, position.coords.latitude];
          cachedFix = { point: next, atMs: now() };
          finish(request);
          show('');
          presentFix(next);
        }, error => {
          if (request !== revision || options.isAborted()) return;
          if ((error.code === 2 || error.code === 3) && attempt < LOCATE_ATTEMPTS.length - 1) {
            requestLocate(attempt + 1);
            return;
          }
          finish(request);
          show(LOCATE_MESSAGES(error), error.message);
        }, LOCATE_ATTEMPTS[attempt] ?? LOCATE_ATTEMPTS[0]);
      } catch {
        finish(request);
        show('Location unavailable');
      }
    };
    requestLocate(0);
  }

  return {
    locate,
    reset() { revision++; coldInFlight = false; warmInFlight = false; clearMarker(); cachedFix = null; publish.busy(false); show(''); },
    dispose() { revision++; coldInFlight = false; warmInFlight = false; clearMarker(); cachedFix = null; }
  };
}
