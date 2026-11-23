import type { Map } from 'maplibre-gl';

export interface LocationControllerOptions {
  readonly map: Map;
  readonly publish: { message(message: string): void; detail(detail: string): void; busy(busy: boolean): void };
  readonly isAborted: () => boolean;
  readonly isMapFailed: () => boolean;
}

export interface LocationController {
  locate(): void;
  reset(): void;
  dispose(): void;
}

const LOCATE_MESSAGES = (error: GeolocationPositionError): string =>
  error.code === 1 ? 'Location permission denied' : error.code === 3 ? 'Location timed out' : 'Location unavailable';

/** Geolocation, map centering and the transient located marker. */
export function createLocationController(options: LocationControllerOptions): LocationController {
  const { map, publish } = options;
  let revision = 0, marker: HTMLElement | null = null, point: [number, number] | null = null, timer: ReturnType<typeof setTimeout> | null = null;

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
  const finish = (request: number): void => { if (request === revision) publish.busy(false); };

  function locate(): void {
    if (options.isMapFailed()) return;
    const request = ++revision;
    if (!navigator.geolocation) { show('Location unavailable'); return; }
    publish.busy(true);
    show('Locating…');
    // Chrome often reports position-unavailable for the request that showed the permission prompt,
    // then succeeds on a precise retry. A third try uses the network provider.
    const accuracies = [true, true, false];
    const requestLocate = (attempt: number): void => {
      try {
        navigator.geolocation.getCurrentPosition(position => {
          if (request !== revision || options.isAborted()) return;
          finish(request);
          show('');
          clearMarker();
          const next: [number, number] = [position.coords.longitude, position.coords.latitude];
          map.jumpTo({ center: next, zoom: Math.max(map.getZoom(), 10) });
          const dot = Object.assign(document.createElement('div'), { className: 'location-pulse' });
          dot.setAttribute('aria-hidden', 'true');
          marker = dot; point = next;
          map.getContainer().append(dot);
          positionMarker(); map.on('move', positionMarker);
          timer = setTimeout(clearMarker, 2000);
        }, error => {
          if (request !== revision || options.isAborted()) return;
          if (error.code === 2 && attempt < accuracies.length - 1) { requestLocate(attempt + 1); return; }
          finish(request);
          show(LOCATE_MESSAGES(error), error.message);
        }, { enableHighAccuracy: accuracies[attempt] ?? false, maximumAge: 300_000, timeout: 10_000 });
      } catch {
        finish(request);
        show('Location unavailable');
      }
    };
    requestLocate(0);
  }

  return {
    locate,
    reset() { revision++; clearMarker(); publish.busy(false); show(''); },
    dispose() { revision++; clearMarker(); }
  };
}
