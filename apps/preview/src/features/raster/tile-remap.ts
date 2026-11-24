import type { MapTheme } from '../map/visual-theme';
import {
  createBitmapWorkspace,
  decodeAndRemapBitmap,
  remapRgbaInPlace,
  type RemapBitmapWorkspace,
  type RemapKind
} from './tile-remap-core';
import type { WorkerRemapRequest, WorkerRemapResponse } from './tile-remap.worker';

export { remapRgbaInPlace, type RemapKind };

let remapSupported: boolean | null = null;

export function canRemapTiles(): boolean {
  if (remapSupported !== null) return remapSupported;
  if (typeof OffscreenCanvas !== 'function' || typeof createImageBitmap !== 'function') {
    remapSupported = false;
    return false;
  }
  try {
    const probe = new OffscreenCanvas(1, 1);
    const ctx = probe.getContext('2d', { willReadFrequently: true });
    remapSupported = Boolean(ctx && typeof ctx.getImageData === 'function' && typeof ctx.putImageData === 'function');
  } catch {
    remapSupported = false;
  }
  return remapSupported;
}

export interface RemapTileOptions {
  readonly priority?: 'foreground' | 'background';
  readonly signal?: AbortSignal;
  readonly transferInput?: boolean;
}

interface QueuedTask {
  readonly id: number;
  readonly data: ArrayBuffer;
  readonly maskData: ArrayBuffer | null;
  readonly kind: RemapKind;
  readonly theme: MapTheme;
  readonly transferInput: boolean;
  readonly signal?: AbortSignal;
  readonly resolve: (bitmap: ImageBitmap) => void;
  readonly reject: (reason: unknown) => void;
  onAbort?: () => void;
}

interface PoolSlot {
  readonly worker: Worker;
  busy: boolean;
  activeTask: QueuedTask | null;
}

const fgQueue: QueuedTask[] = [];
const bgQueue: QueuedTask[] = [];
const inflight = new Map<number, QueuedTask>();
let pool: PoolSlot[] | null = null;
let workerUnavailable = false;
let nextTaskId = 1;

function abortError(): DOMException {
  return new DOMException('Tile remap aborted', 'AbortError');
}

function workerCount(): number {
  const hw = typeof navigator !== 'undefined' && Number.isFinite(navigator.hardwareConcurrency)
    ? navigator.hardwareConcurrency
    : 4;
  return Math.min(4, Math.max(2, hw - 1));
}

function ensurePool(): PoolSlot[] | null {
  if (workerUnavailable || typeof Worker !== 'function') return null;
  if (pool) return pool;
  try {
    const count = workerCount();
    const created: PoolSlot[] = [];
    for (let i = 0; i < count; i++) {
      const worker = new Worker(new URL('./tile-remap.worker.ts', import.meta.url), { type: 'module' });
      const slot: PoolSlot = { worker, busy: false, activeTask: null };
      worker.onmessage = (event: MessageEvent<WorkerRemapResponse>) => {
        slot.activeTask = null;
        slot.busy = false;
        const msg = event.data;
        const task = inflight.get(msg.id);
        if (task) {
          inflight.delete(msg.id);
          if (task.onAbort && task.signal) task.signal.removeEventListener('abort', task.onAbort);
          if ('bitmap' in msg) {
            if (task.signal?.aborted) {
              msg.bitmap.close();
              task.reject(abortError());
            } else {
              task.resolve(msg.bitmap);
            }
          } else {
            task.reject(new Error(msg.error));
          }
        }
        pumpPool();
      };
      worker.onerror = err => {
        const failed = slot.activeTask;
        slot.activeTask = null;
        slot.busy = false;
        if (failed && inflight.delete(failed.id)) {
          if (failed.onAbort && failed.signal) failed.signal.removeEventListener('abort', failed.onAbort);
          failed.reject(new Error(err.message || 'Tile remap worker error'));
        }
        pumpPool();
        console.error('Tile remap worker error', err);
      };
      created.push(slot);
    }
    pool = created;
    return pool;
  } catch {
    workerUnavailable = true;
    return null;
  }
}

function pumpPool(): void {
  const slots = ensurePool();
  if (!slots) return;
  for (const slot of slots) {
    if (slot.busy) continue;
    let task: QueuedTask | undefined;
    while (!task && (fgQueue.length > 0 || bgQueue.length > 0)) {
      const candidate = fgQueue.shift() ?? bgQueue.shift()!;
      if (candidate.signal?.aborted) {
        if (candidate.onAbort) candidate.signal.removeEventListener('abort', candidate.onAbort);
        candidate.reject(abortError());
        continue;
      }
      task = candidate;
    }
    if (!task) break;

    slot.busy = true;
    slot.activeTask = task;
    inflight.set(task.id, task);
    const dataBuf = task.transferInput ? task.data : task.data.slice(0);
    const maskBuf = task.maskData ? (task.transferInput ? task.maskData : task.maskData.slice(0)) : null;
    const transfer: Transferable[] = [dataBuf];
    if (maskBuf && maskBuf !== dataBuf) transfer.push(maskBuf);
    const req: WorkerRemapRequest = {
      id: task.id,
      data: dataBuf,
      maskData: maskBuf,
      kind: task.kind,
      theme: task.theme
    };
    slot.worker.postMessage(req, transfer);
  }
}

// Isolated workspace pool fallback when Web Workers are unavailable (e.g. headless test environments).
const fallbackIdle: RemapBitmapWorkspace[] = [];

async function runFallback(
  data: ArrayBuffer,
  kind: RemapKind,
  theme: MapTheme,
  maskData?: ArrayBuffer | null
): Promise<ImageBitmap> {
  const ws = fallbackIdle.pop() ?? createBitmapWorkspace();
  try {
    return await decodeAndRemapBitmap(ws, data, kind, theme, maskData);
  } finally {
    if (fallbackIdle.length < 4) fallbackIdle.push(ws);
  }
}

/**
 * Decodes and remaps a forecast tile off the main thread, returning a GPU-ready
 * ImageBitmap with foreground/background priority scheduling and zero WebP re-encoding.
 */
export function remapTileToBitmap(
  data: ArrayBuffer,
  kind: RemapKind,
  theme: MapTheme,
  maskData?: ArrayBuffer | null,
  options: RemapTileOptions = {}
): Promise<ImageBitmap> {
  if (options.signal?.aborted) return Promise.reject(abortError());
  if (theme === 'xcskies' || data.byteLength <= 48 || !canRemapTiles()) {
    return createImageBitmap(new Blob([data], { type: 'image/webp' }));
  }
  const slots = ensurePool();
  if (!slots) return runFallback(data, kind, theme, maskData);

  return new Promise<ImageBitmap>((resolve, reject) => {
    const id = nextTaskId++;
    const queue = options.priority === 'background' ? bgQueue : fgQueue;
    const task: QueuedTask = {
      id,
      data,
      maskData: maskData ?? null,
      kind,
      theme,
      transferInput: Boolean(options.transferInput),
      signal: options.signal,
      resolve,
      reject
    };
    if (options.signal) {
      const onAbort = () => {
        const idx = queue.indexOf(task);
        if (idx >= 0) {
          queue.splice(idx, 1);
          options.signal?.removeEventListener('abort', onAbort);
          reject(abortError());
        }
      };
      task.onAbort = onAbort;
      options.signal.addEventListener('abort', onAbort, { once: true });
    }
    queue.push(task);
    pumpPool();
  });
}
