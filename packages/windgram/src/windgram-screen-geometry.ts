// Cached inverse screen transform for one mounted chart SVG, cleared each microtask.

export interface ScreenGeometry {
  readonly inverse: DOMMatrix;
  readonly bounds: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number };
  readonly vw: number;
  readonly vh: number;
}

export function createScreenGeometry(host: HTMLElement, svg: SVGSVGElement | null, ownerDocument: Document | undefined) {
  let cachedGeo: ScreenGeometry | null = null;
  let geoClearScheduled = false;

  const invalidateGeometry = () => {
    cachedGeo = null;
  };

  const readGeometry = (): ScreenGeometry | null => {
    const matrix = svg?.getScreenCTM?.() ?? null;
    if (!matrix || typeof host.getBoundingClientRect !== 'function') return null;
    const bounds = host.getBoundingClientRect();
    if (
      cachedGeo &&
      cachedGeo.bounds.left === bounds.left &&
      cachedGeo.bounds.top === bounds.top &&
      cachedGeo.bounds.right === bounds.right &&
      cachedGeo.bounds.bottom === bounds.bottom
    ) {
      return cachedGeo;
    }
    const viewport = ownerDocument?.defaultView;
    const geo: ScreenGeometry = {
      inverse: matrix.inverse(),
      bounds: { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom },
      vw: viewport?.innerWidth ?? Infinity,
      vh: viewport?.innerHeight ?? Infinity,
    };
    cachedGeo = geo;
    if (!geoClearScheduled) {
      geoClearScheduled = true;
      queueMicrotask(() => {
        geoClearScheduled = false;
        cachedGeo = null;
      });
    }
    return geo;
  };

  return { read: readGeometry, invalidate: invalidateGeometry };
}
