import type { Grid } from '@av/contracts/geometry';
import { WIND_FRAME_LIMIT, assertWindFrameLayout, decodeTileMask, parseWindFrame, windLayout, type TileMask, type WindFrame } from '@av/contracts/wind-data';
import type { CachedBytes, WindDataCache } from './client-wind-cache.ts';
import type { WindTransport } from './client-wind-transport.ts';

/** A validated frame descriptor with its tile layouts and the cache entry that holds its bytes. */
interface WindFrameLayout {
  readonly entry: CachedBytes;
  readonly descriptor: WindFrame;
  readonly windMask?: TileMask;
  readonly fineMask?: TileMask;
  readonly windBytes: number;
  readonly fineBytes: number;
}

const validate = (bytes: Uint8Array, frame: string, grids: { native: Grid; fine: Grid }): WindFrame => {
  const parsed = parseWindFrame(bytes);
  if (parsed.frame !== frame) throw new Error('Numeric frame mismatch');
  assertWindFrameLayout(parsed, grids);
  return parsed;
};

/**
 * Load the descriptor at `root` through the shared cache and check it against the manifest grids.
 * Returns `null` when the frame is missing or the build's product is unavailable, which it records.
 */
export async function loadWindFrame(transport: WindTransport, cache: WindDataCache, request: { root: string; frame: string; buildId: string; expiresAtMs: number; native: Grid; fine: Grid; signal: AbortSignal }): Promise<WindFrameLayout | null> {
  const { root, frame, native, fine } = request, grids = { native, fine };
  const entry = transport.hold(cache.take(root, WIND_FRAME_LIMIT, request.expiresAtMs, transport.foreground));
  const pending = entry.used === null ? entry.pending ?? cache.start([entry], async owner => {
    const used = await transport.read(root, 'application/json', [entry], owner);
    if (typeof used === 'number') {
      validate(entry.bytes.subarray(0, used), frame, grids);
      entry.used = used;
    }
    return used;
  }, cache.reserveResponse(WIND_FRAME_LIMIT, transport.foreground)) : undefined;
  const used = entry.used ?? await transport.wait(pending!, request.signal);
  if (used === 'product-unavailable') { cache.markBuildUnavailable(request.buildId); return null; }
  if (typeof used !== 'number') return null;
  const descriptor = validate(entry.bytes.subarray(0, used), frame, grids);
  entry.used = used;
  const windTotal = windLayout(native.width, native.height, descriptor.tileSize, descriptor.levels);
  const fineTotal = windLayout(fine.width, fine.height, descriptor.fineTileSize);
  return {
    entry, descriptor,
    windMask: decodeTileMask(descriptor.windMask, windTotal.count) ?? undefined,
    fineMask: decodeTileMask(descriptor.fineMask, fineTotal.count) ?? undefined,
    windBytes: windTotal.chunkBytes, fineBytes: fineTotal.chunkBytes
  };
}
