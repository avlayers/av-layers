import { describe, expect, it, vi } from 'vitest';
import { centreCrop, createPreviewGeography, landTone } from './preview-geography';

function recorder() {
  const calls: string[] = [];
  const context = new Proxy({} as Record<string, unknown>, {
    get: (target, key: string) => target[key] ?? ((...args: unknown[]) => { calls.push(`${key}(${args.filter(a => typeof a === 'number').join(',')})`); }),
    set: (target, key: string, value) => { target[key] = value; calls.push(`${key}=${value}`); return true; }
  });
  return { calls, context: context as unknown as CanvasRenderingContext2D };
}

function fakeMap(layers = ['water', 'admin_country']) {
  const handlers = new Map<string, (event?: unknown) => void>();
  const map = {
    on: vi.fn((type: string, fn: (event?: unknown) => void) => { handlers.set(type, fn); }),
    off: vi.fn((type: string) => { handlers.delete(type); }),
    getLayer: (id: string) => (layers.includes(id) ? { id } : undefined),
    getCanvas: () => ({ clientWidth: 720, clientHeight: 360 }),
    project: ([lng, lat]: [number, number]) => ({ x: lng, y: lat }),
    queryRenderedFeatures: ({ layers: wanted }: { layers: string[] }) => [
      ...(wanted.includes('water') ? [{ layer: { id: 'water' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [720, 0], [720, 100], [0, 0]]] } }] : []),
      ...(wanted.includes('admin_country') ? [{ layer: { id: 'admin_country' }, geometry: { type: 'LineString', coordinates: [[0, 200], [720, 200]] } }] : [])
    ]
  };
  return { map: map as never, fire: (type: string, event?: unknown) => handlers.get(type)?.(event), handlers };
}

const surface = (width: number, height: number) => {
  const { calls, context } = recorder();
  return Object.assign({ width, height, getContext: () => context, calls }) as unknown as OffscreenCanvas;
};

describe('preview geography', () => {
  it('builds land, water and borders once the view settles, at most 360px wide', () => {
    const { map, fire } = fakeMap();
    const changed = vi.fn();
    const made: OffscreenCanvas[] = [];
    const geography = createPreviewGeography(map, () => 'classic', changed, undefined, (w, h) => { const s = surface(w, h); made.push(s); return s; });
    const target = recorder();
    expect(geography.drawBase(target.context, 80, 40)).toBe(false);
    fire('idle');
    expect(changed).toHaveBeenCalledTimes(1);
    expect(made.map(s => [s.width, s.height])).toEqual([[360, 180], [360, 180]]);
    const base = (made[0] as unknown as { calls: string[] }).calls;
    expect(base).toContain('fillStyle=#cadbb8');
    expect(base).toContain('moveTo(0,0)');
    expect(base).toContain('lineTo(360,50)');
    expect((made[1] as unknown as { calls: string[] }).calls).toContain('lineTo(360,100)');
    expect(geography.drawBase(target.context, 80, 40)).toBe(true);
    geography.drawLines(target.context, 80, 40);
    expect(target.calls.filter(c => c.startsWith('drawImage'))).toHaveLength(2);
  });

  it('draws nothing while the map moves and rebuilds after it settles', () => {
    const { map, fire } = fakeMap();
    const changed = vi.fn();
    const geography = createPreviewGeography(map, () => 'classic', changed, undefined, surface);
    fire('idle');
    fire('movestart');
    expect(geography.drawBase(recorder().context, 80, 40)).toBe(false);
    fire('idle');
    expect(changed).toHaveBeenCalledTimes(1);
    fire('moveend');
    fire('idle');
    expect(changed).toHaveBeenCalledTimes(2);
    fire('idle');
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('is skipped without the basemap water layer, and unhooks on destroy', () => {
    const { map, fire, handlers } = fakeMap([]);
    const geography = createPreviewGeography(map, () => 'classic', () => {}, undefined, surface);
    fire('idle');
    expect(geography.drawBase(recorder().context, 80, 40)).toBe(false);
    geography.destroy();
    expect(handlers.size).toBe(0);
  });

  it('fills each water feature on its own and waits while no preview is shown', () => {
    const { map, fire } = fakeMap();
    const query = (map as unknown as { queryRenderedFeatures: (o: { layers: string[] }) => unknown[] }).queryRenderedFeatures;
    (map as unknown as { queryRenderedFeatures: unknown }).queryRenderedFeatures = (o: { layers: string[] }) => o.layers.includes('water') ? [...query(o), ...query(o)] : query(o);
    let shown = false;
    const made: OffscreenCanvas[] = [];
    const geography = createPreviewGeography(map, () => 'classic', () => {}, () => shown, (w, h) => { const s = surface(w, h); made.push(s); return s; });
    fire('idle');
    expect(made).toHaveLength(0);
    shown = true;
    fire('idle');
    expect((made[0] as unknown as { calls: string[] }).calls.filter(c => c.startsWith('fill('))).toHaveLength(2);
    geography.destroy();
  });

  it('crops the centre of the view at the target aspect', () => {
    const target = recorder();
    centreCrop(target.context, { width: 360, height: 180 } as OffscreenCanvas, 100, 100);
    expect(target.calls).toEqual(['drawImage(90,0,180,180,0,0,100,100)']);
  });

  it('reads the first land colour above sea level', () => {
    expect(landTone(['interpolate', ['linear'], ['elevation'], -1, '#a', 0, '#a', 0.5, '#b', 350, '#c'])).toBe('#b');
    expect(landTone([])).toBeNull();
  });
});
