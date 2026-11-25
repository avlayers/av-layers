import { normalizeLon, type GeographicBounds } from '@av/contracts/geometry';
import { encodeWindByte } from '@av/contracts/wind-data';
import type { PreparationBudget } from './client-preparation-budget.ts';
import type { RequestPriority } from './client-request-scheduler.ts';
import { WindCapacityError } from './client-wind-cache.ts';

type WindHeight = 'surface' | number | 'lift';
export interface WindPreparedGrid {
  readonly bounds: GeographicBounds;
  readonly data: Uint8Array<ArrayBuffer>;
  readonly size: number;
  readonly height: WindHeight;
  readonly key: string;
  readonly retain?: () => () => void;
}
export interface WindPreparationOptions {
  readonly signal?: AbortSignal;
  readonly size?: number;
}
export interface WindPreparationTask {
  readonly height: WindHeight;
  readonly controller: AbortController;
  step(): boolean;
  finish(): WindPreparedGrid;
  cancel(reason?: unknown): void;
}

export const DEFAULT_PREPARED_GRID_SIZE = 128;
export const WIND_PREPARED_GRID_BYTES = DEFAULT_PREPARED_GRID_SIZE * DEFAULT_PREPARED_GRID_SIZE * 4;
const PREPARED_GRID_LIMIT = 4, PREPARATION_SLICE_MS = 4, PREPARATION_SLICE_ROWS = 8;

/** Positive, unwrapped longitude interval aligned to the world copy nearest the window center. */
export function preparedBounds(bounds: GeographicBounds): GeographicBounds {
  const [west, south, east, north] = bounds;
  const span = east >= west ? east - west : east + 360 - west;
  const start = normalizeLon(west + span / 2) - span / 2;
  return [start, south, start + span, north];
}

/**
 * Up to four retained RGBA grids (u, v, unused, alpha) and at most one unfinished preparation. Each grid's
 * bytes stay leased from the budget until the store and every `retain()` caller release it.
 */
export class WindPreparedGrids {
  /** Bytes allocated to retained and in-progress grids. */
  bytes = 0;
  private readonly grids = new Map<string, { grid: WindPreparedGrid; release(): void }>();
  private preparing?: WindPreparationTask;
  constructor(private readonly budget?: PreparationBudget) {}

  has(key: string): boolean {
    return this.grids.has(key);
  }

  /**
   * Return the cached grid for `key`, or a row-by-row task that samples `bounds` and commits it on finish.
   * The task throws an AbortError once `live()` turns false.
   */
  begin(key: string, height: WindHeight, size: number, bounds: GeographicBounds, priority: RequestPriority,
    sample: (lat: number, lon: number) => { status: string; u: number | null; v: number | null }, live: () => boolean): WindPreparedGrid | WindPreparationTask {
    this.preparing?.cancel();
    const cached = this.grids.get(key);
    if (cached) return cached.grid;
    if (this.grids.size >= PREPARED_GRID_LIMIT) {
      const oldest = this.grids.keys().next().value!;
      this.grids.get(oldest)!.release(); this.grids.delete(oldest);
    }
    const lease = this.budget?.reserve('wind-prepared', size * size * 4, priority);
    if (this.budget && !lease) throw new WindCapacityError();
    let data: Uint8Array<ArrayBuffer>;
    try { data = new Uint8Array(new ArrayBuffer(size * size * 4)); } catch (error) { lease?.release(); throw error; }
    this.bytes += data.byteLength;
    let references = 1;
    const release = () => {
      if (--references === 0) { this.bytes -= data.byteLength; lease?.release(); }
    };
    const [west, south, east, north] = preparedBounds(bounds);
    const span = east - west, controller = new AbortController();
    let row = 0, settled = false;
    const grid: WindPreparedGrid = { bounds: [west, south, east, north], data, size, height, key, retain: () => {
      if (!references) throw new Error('Wind prepared grid is released');
      references++;
      let retained = true;
      return () => { if (retained) { retained = false; release(); } };
    } };
    const check = () => {
      controller.signal.throwIfAborted();
      if (!live()) throw new DOMException('Wind preparation superseded', 'AbortError');
    };
    const task: WindPreparationTask = {
      height, controller,
      step: () => {
        check();
        const lat = south + (north - south) * (row + 0.5) / size;
        for (let x = 0; x < size; x++) {
          const point = sample(lat, normalizeLon(west + span * (x + 0.5) / size));
          if (point.status !== 'valid' || point.u === null || point.v === null) continue;
          const offset = (row * size + x) * 4;
          data[offset] = encodeWindByte(point.u); data[offset + 1] = encodeWindByte(point.v); data[offset + 3] = 255;
        }
        return ++row < size;
      },
      finish: () => {
        check(); settled = true;
        this.grids.set(key, { grid, release });
        if (this.preparing === task) this.preparing = undefined;
        return grid;
      },
      cancel: reason => {
        if (settled) return;
        settled = true; controller.abort(reason ?? new DOMException('Wind preparation cancelled', 'AbortError'));
        release();
        if (this.preparing === task) this.preparing = undefined;
      }
    };
    this.preparing = task;
    return task;
  }

  /** Release grids for other heights and cancel an unfinished preparation of another height. */
  trim(height: WindHeight): void {
    if (this.preparing && this.preparing.height !== height) this.preparing.cancel();
    for (const [key, item] of this.grids) if (item.grid.height !== height) { item.release(); this.grids.delete(key); }
  }

  clear(): void {
    this.preparing?.cancel();
    for (const item of this.grids.values()) item.release();
    this.grids.clear();
  }
}

/** Complete every row in this turn. */
export function finishPreparation(task: WindPreparationTask): WindPreparedGrid {
  try {
    while (task.step()) { /* The synchronous API completes every row in this turn. */ }
    return task.finish();
  } finally { task.cancel(); }
}

/** Yield to a macrotask after each row batch; `signal` or a superseding call cancels the task. */
export async function finishPreparationSliced(task: WindPreparationTask, signal?: AbortSignal): Promise<WindPreparedGrid> {
  const abort = () => task.cancel(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    let started = performance.now(), rows = 0;
    while (task.step()) {
      if (++rows < PREPARATION_SLICE_ROWS && performance.now() - started < PREPARATION_SLICE_MS) continue;
      await new Promise<void>((resolve, reject) => {
        const cancelled = () => { clearTimeout(timer); task.controller.signal.removeEventListener('abort', cancelled); reject(task.controller.signal.reason); };
        const timer = setTimeout(() => { task.controller.signal.removeEventListener('abort', cancelled); resolve(); }, 0);
        task.controller.signal.addEventListener('abort', cancelled, { once: true });
        if (task.controller.signal.aborted) cancelled();
      });
      rows = 0; started = performance.now();
    }
    return task.finish();
  } finally {
    signal?.removeEventListener('abort', abort);
    task.cancel();
  }
}
