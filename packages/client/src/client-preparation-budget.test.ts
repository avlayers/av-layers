import { expect, it, vi } from 'vitest';
import { createPreparationBudget } from './client-preparation-budget';

it('reserves one shared allocation until its owner releases it', () => {
  const budget = createPreparationBudget(128);
  const lease = budget.reserve('numeric', 96)!;
  expect(lease.bytes).toBe(96);
  expect(budget.used).toBe(96);
  expect(budget.reserve('raster', 33)).toBeNull();
  expect(budget.used).toBe(96);
  expect(lease.resize(128)).toBe(true);
  expect(budget.used).toBe(128);
  expect(lease.resize(129)).toBe(false);
  expect(lease.bytes).toBe(128);
  expect(lease.resize(64)).toBe(true);
  const replacement = budget.reserve('raster', 64)!;
  expect(budget.used).toBe(128);
  lease.release();
  lease.release();
  expect(budget.used).toBe(64);
  expect(lease.bytes).toBe(0);
  expect(lease.resize(64)).toBe(false);
  replacement.release();
  expect(budget.used).toBe(0);
});

it('coalesces capacity recovery after an allocation batch settles', async () => {
  const budget = createPreparationBudget(128);
  const released = vi.fn();
  const unsubscribe = budget.onRelease(released);
  const first = budget.reserve('preview', 64)!;
  const second = budget.reserve('decode', 64)!;
  expect(first.resize(64)).toBe(true);
  first.release();
  second.resize(32);
  expect(released).not.toHaveBeenCalled();
  await Promise.resolve();
  expect(released).toHaveBeenCalledTimes(1);
  expect(budget.used).toBe(32);
  unsubscribe();
  second.release();
  await Promise.resolve();
  expect(released).toHaveBeenCalledTimes(1);
});

it('leaves no reservation after failed admission and supports zero-sized leases', () => {
  const budget = createPreparationBudget(128);
  expect(budget.reserve('oversized', 129)).toBeNull();
  const lease = budget.reserve('empty', 0)!;
  expect(budget.used).toBe(0);
  expect(lease.resize(128)).toBe(true);
  expect(budget.reserve('other', 1)).toBeNull();
  expect(lease.resize(0)).toBe(true);
  expect(budget.used).toBe(0);
  lease.release();
  expect(budget.used).toBe(0);
});

it('wakes later capacity consumers when a release listener throws', () => {
  const tasks: VoidFunction[] = [];
  const microtasks = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation(task => { tasks.push(task); });
  try {
    const budget = createPreparationBudget(128);
    const error = new Error('Broken recovery listener');
    const recovered = vi.fn();
    budget.onRelease(() => { throw error; });
    budget.onRelease(recovered);
    budget.reserve('response', 128)!.release();
    expect(tasks).toHaveLength(1);
    expect(() => tasks.shift()!()).not.toThrow();
    expect(recovered).toHaveBeenCalledTimes(1);
    expect(budget.used).toBe(0);
    expect(tasks).toHaveLength(1);
    expect(() => tasks.shift()!()).toThrow(error);
  } finally { microtasks.mockRestore(); }
});

it('rejects invalid allocation arithmetic before mutating the budget', () => {
  for (const limit of [0, -1, Number.NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(() => createPreparationBudget(limit)).toThrow(RangeError);
  const budget = createPreparationBudget(128);
  const lease = budget.reserve('preview', 64)!;
  for (const bytes of [-1, Number.NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => budget.reserve('invalid', bytes)).toThrow(RangeError);
    expect(() => lease.resize(bytes)).toThrow(RangeError);
    expect(budget.used).toBe(64);
  }
  lease.release();
});

it('moves an active lease exclusively within its originating budget', () => {
  const budget = createPreparationBudget(128), other = createPreparationBudget(128);
  const original = budget.reserve('response', 64)!;
  expect(other.transfer(original)).toBeNull();
  expect(budget.transfer({ bytes: 64, resize: () => true, release() {} })).toBeNull();
  expect(original.bytes).toBe(64);
  const moved = budget.transfer(original)!;
  expect(original.bytes).toBe(0);
  expect(original.resize(1)).toBe(false);
  original.release();
  expect(budget.transfer(original)).toBeNull();
  expect(budget.used).toBe(64);
  expect(moved.resize(96)).toBe(true);
  expect(budget.used).toBe(96);
  moved.release();
  expect(budget.used).toBe(0);
  expect(budget.transfer(moved)).toBeNull();
});

it('preserves configured foreground headroom across background reserves and resizing', () => {
  const budget = createPreparationBudget(128, { foregroundReserveBytes: 32 });
  const background = budget.reserve('numeric', 96, 'background')!;
  expect(budget.reserve('response', 1, 'background')).toBeNull();
  expect(background.resize(97)).toBe(false);
  const foreground = budget.reserve('response', 32, 'foreground')!;
  expect(budget.used).toBe(128);
  foreground.release(); background.release();
  expect(budget.used).toBe(0);
  expect(() => createPreparationBudget(128, { foregroundReserveBytes: 129 })).toThrow(RangeError);
});
