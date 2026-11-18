import type { GeoPoint } from '@av/client';

export interface ProjectableMap {
  project?(lngLat: [number, number]): { x: number; y: number };
  getContainer(): unknown;
}

export interface PointMarker {
  show(point: GeoPoint): void;
  sync(): void;
  clear(): void;
  dispose(): void;
}

/** Persistent map target dot anchored to the selected Windgram coordinate while open. */
export function createPointMarker(map: ProjectableMap, doc: Document = document): PointMarker {
  let point: [number, number] | null = null;
  let marker: HTMLElement | null = null;
  let disposed = false;

  const ensureElement = (): HTMLElement | null => {
    if (marker) return marker;
    const container = map.getContainer() as { append?: (...nodes: Node[]) => void } | null;
    if (!container || typeof container.append !== 'function' || typeof doc.createElement !== 'function') return null;
    const dot = doc.createElement('div');
    dot.className = 'point-marker';
    dot.setAttribute('aria-hidden', 'true');
    container.append(dot);
    marker = dot;
    return dot;
  };

  const sync = (): void => {
    if (disposed || !point || typeof map.project !== 'function') return;
    const dot = ensureElement();
    if (!dot) return;
    const projected = map.project(point);
    if (!Number.isFinite(projected.x) || !Number.isFinite(projected.y)) return;
    dot.style.left = `${Math.round(projected.x * 10) / 10}px`;
    dot.style.top = `${Math.round(projected.y * 10) / 10}px`;
  };

  const clear = (): void => {
    point = null;
    marker?.remove();
    marker = null;
  };

  return {
    show(next) {
      if (disposed || !Number.isFinite(next.lat) || !Number.isFinite(next.lon)) return;
      point = [next.lon, next.lat];
      sync();
    },
    sync,
    clear,
    dispose() {
      disposed = true;
      clear();
    }
  };
}
