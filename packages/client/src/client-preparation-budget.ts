export interface PreparationLease {
  readonly bytes: number;
  resize(bytes: number): boolean;
  release(): void;
}

export interface PreparationBudget {
  readonly limit: number;
  readonly backgroundLimit: number;
  readonly used: number;
  reserve(category: string, bytes: number, priority?: 'foreground' | 'background'): PreparationLease | null;
  canReserve(bytes: number, priority?: 'foreground' | 'background'): boolean;
  transfer(lease: PreparationLease): PreparationLease | null;
  onRelease(listener: () => void): () => void;
  snapshot(): Readonly<Record<string, number>>;
}

function allocationSize(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError('Invalid preparation allocation');
}

export function createPreparationBudget(limit: number, options: { foregroundReserveBytes?: number } = {}): PreparationBudget {
  allocationSize(limit);
  if (limit === 0) throw new RangeError('Invalid preparation limit');
  const floor = options.foregroundReserveBytes ?? 0;
  allocationSize(floor);
  if (floor > limit) throw new RangeError('Invalid foreground reserve');
  let used = 0, pending = false;
  const owners = new WeakMap<PreparationLease, { category: string; bytes: number; priority: 'foreground' | 'background' }>();
  const categories = new Map<string, number>();
  const listeners = new Set<() => void>();
  const change = (category: string, delta: number) => {
    used += delta;
    const bytes = (categories.get(category) ?? 0) + delta;
    if (bytes) categories.set(category, bytes); else categories.delete(category);
    if (delta >= 0 || pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      for (const listener of [...listeners]) {
        if (!listeners.has(listener)) continue;
        try { listener(); } catch (error) { queueMicrotask(() => { throw error; }); }
      }
    });
  };
  const canReserve = (bytes: number, priority: 'foreground' | 'background' = 'foreground') => {
    allocationSize(bytes);
    return bytes <= limit - used - (priority === 'background' ? floor : 0);
  };
  const wrap = (state: { category: string; bytes: number; priority: 'foreground' | 'background' }): PreparationLease => {
    const lease: PreparationLease = {
      get bytes() { return owners.has(lease) ? state.bytes : 0; },
      resize(next) {
        allocationSize(next);
        if (!owners.has(lease)) return false;
        const delta = next - state.bytes;
        if (delta > 0 && !canReserve(delta, state.priority)) return false;
        state.bytes = next; change(state.category, delta); return true;
      },
      release() {
        if (!owners.delete(lease)) return;
        const previous = state.bytes; state.bytes = 0; change(state.category, -previous);
      }
    };
    owners.set(lease, state);
    return lease;
  };
  return {
    limit,
    backgroundLimit: limit - floor,
    get used() { return used; },
    snapshot: () => Object.fromEntries(categories),
    onRelease(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    canReserve,
    reserve(category, initial, priority = 'foreground') {
      if (!canReserve(initial, priority)) return null;
      change(category, initial);
      return wrap({ category, bytes: initial, priority });
    },
    transfer(lease) {
      const state = owners.get(lease);
      if (!state) return null;
      owners.delete(lease);
      return wrap(state);
    }
  };
}
