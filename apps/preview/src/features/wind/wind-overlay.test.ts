import { afterEach, expect, it, vi } from 'vitest';
import { WindOverlay } from './wind-overlay';

const deck = vi.hoisted(() => ({ instances: [] as Array<{ data: unknown[]; options: unknown[]; cleared: number; destroyed: number; pressure: number; renderState: { generation: number; frame: string | null; installedGeneration: number }; memory: { canvasBytes: number; glBytes: number; limited: boolean } }> }));
vi.mock('./wind-deck', () => ({
  WindDeck: class {
    data: unknown[] = []; options: unknown[] = []; cleared = 0; destroyed = 0; pressure = 0;
    renderState = { generation: 0, frame: null, installedGeneration: 0 };
    memory = { canvasBytes: 0, glBytes: 0, limited: false };
    constructor(public map: unknown, public budget: unknown) { deck.instances.push(this as never); }
    setData(field: unknown, prepared: unknown, frame: unknown, options: unknown) { this.data.push({ field, prepared, frame, options }); }
    setOptions(options: unknown) { this.options.push(options); }
    clear() { this.cleared++; }
    destroy() { this.destroyed++; }
    relievePressure() { this.pressure++; return true; }
  }
}));

function fixture(budget?: { reserve: () => unknown; used: number; onRelease: () => () => void }) {
  const handlers = new Map<string, Set<() => void>>();
  const map = {
    on: (name: string, listener: () => void) => { const set = handlers.get(name) ?? new Set(); set.add(listener); handlers.set(name, set); },
    off: (name: string, listener: () => void) => handlers.get(name)?.delete(listener),
    emit: (name: string) => { for (const listener of handlers.get(name) ?? []) listener(); }
  };
  const overlay = new WindOverlay(map as never, { budget: budget as never });
  const instance = deck.instances.at(-1)!;
  return { map, overlay, instance };
}

afterEach(() => { deck.instances.length = 0; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('installs retained data, forwards options, and releases replaced grids', () => {
  const first = { retain: vi.fn(() => vi.fn()) }, second = { retain: vi.fn(() => vi.fn()) };
  const field = { sample: () => ({ status: 0, u: 1, v: 2 }) };
  const { overlay, instance } = fixture();
  overlay.install(field, first as never, 'replace', 'f001');
  expect(first.retain).toHaveBeenCalledOnce();
  expect(instance.data.at(-1)).toMatchObject({ field, prepared: first, frame: 'f001' });
  overlay.install(field, first as never, 'replace', 'f001');
  expect(instance.data).toHaveLength(1);
  overlay.install(field, second as never, 'replace', 'f002');
  expect(first.retain!.mock.results[0]!.value).toHaveBeenCalledOnce();
  expect(second.retain).toHaveBeenCalledOnce();
  overlay.setOptions({ style: 'barbs', units: 'imperial' });
  expect(instance.options.at(-1)).toMatchObject({ style: 'barbs', units: 'imperial' });
  overlay.clear();
  expect(instance.data.at(-1)).toMatchObject({ field: null, prepared: null, frame: null });
  overlay.destroy();
  expect(instance.destroyed).toBe(1);
  expect(second.retain!.mock.results[0]!.value).toHaveBeenCalledOnce();
});

it('delegates render state, memory, pressure, and map events', () => {
  const { map, overlay, instance } = fixture();
  instance.renderState = { generation: 3, frame: 'f003', installedGeneration: 4 };
  instance.memory = { canvasBytes: 0, glBytes: 1024, limited: true };
  expect(overlay.renderState).toEqual({ generation: 3, frame: 'f003', installedGeneration: 4 });
  expect(overlay.displayMemory).toEqual({ canvasBytes: 0, glBytes: 1024, limited: true });
  expect(overlay.relievePressure()).toBe(true);
  expect(instance.pressure).toBe(1);
  const before = instance.options.length;
  map.emit('moveend'); map.emit('resize');
  expect(instance.options.length).toBe(before + 2);
  map.emit('webglcontextlost');
  expect(instance.options.length).toBe(before + 2);
  map.emit('webglcontextrestored');
  expect(instance.data).toHaveLength(1);
  overlay.destroy();
});
