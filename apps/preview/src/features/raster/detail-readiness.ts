/** Detail-tile accounting for the requested frame: which viewport tiles are required, loaded, pending or errored. */
export type DetailReadiness = 'idle' | 'valid-empty' | 'complete' | 'partial' | 'failed' | 'timed-out';
interface Canonical { x?: number; y?: number; z?: number }
interface DetailSource { stationary: boolean; sourceLoaded: boolean; sourceErrored: boolean }

const canonicalKey = (tile: Canonical | undefined): string | null =>
  tile && Number.isFinite(tile.z) && Number.isFinite(tile.x) && Number.isFinite(tile.y) ? `${tile.z}/${tile.x}/${tile.y}` : null;

/** `z/x/y` of a MapLibre tile from a source event, or null when it carries no canonical id. */
export const tileKey = (tile: object): string | null => canonicalKey((tile as { tileID?: { canonical?: Canonical } }).tileID?.canonical);

/** Keys of `coveringTiles` results that intersect `bounds` (west, south, east, north degrees), or all of them without bounds. */
export function coveredTileKeys(covering: unknown, bounds: readonly number[] | undefined): string[] {
  const keys: string[] = [];
  for (const tile of Array.isArray(covering) ? covering as ({ canonical?: Canonical & { x: number; y: number; z: number } } | undefined)[] : []) {
    const canonical = tile?.canonical;
    if (!canonical) continue;
    if (bounds) {
      const n = 2 ** canonical.z, west = canonical.x / n * 360 - 180, east = (canonical.x + 1) / n * 360 - 180;
      const north = Math.atan(Math.sinh(Math.PI * (1 - 2 * canonical.y / n))) * 180 / Math.PI;
      const south = Math.atan(Math.sinh(Math.PI * (1 - 2 * (canonical.y + 1) / n))) * 180 / Math.PI;
      if (east <= bounds[0] || west >= bounds[2] || north <= bounds[1] || south >= bounds[3]) continue;
    }
    const key = canonicalKey(canonical);
    if (key) keys.push(key);
  }
  return keys;
}

export function classifyDetail(source: DetailSource, required: ReadonlySet<string>, loaded: ReadonlySet<string>, pending: ReadonlySet<string>, errored: ReadonlySet<string>): DetailReadiness {
  const { stationary, sourceLoaded, sourceErrored } = source;
  if (!stationary) return 'idle';
  if (sourceLoaded && required.size === 0 && pending.size === 0 && !sourceErrored) return 'valid-empty';
  if (sourceLoaded && required.size > 0 && pending.size === 0 && !sourceErrored && [...required].every(key => loaded.has(key))) return 'complete';
  if (sourceLoaded && required.size > 0 && pending.size === 0 && [...required].some(key => loaded.has(key)) && ([...required].some(key => errored.has(key)) || sourceErrored)) return 'partial';
  if (sourceErrored || (required.size > 0 && pending.size === 0 && ![...required].some(key => loaded.has(key)) && [...required].some(key => errored.has(key)))) return 'failed';
  return 'idle';
}

/** Tile-key sets and the readiness state they classify to. */
export class DetailTracker {
  state: DetailReadiness = 'idle';
  readonly required = new Set<string>();
  private readonly loaded = new Set<string>();
  private readonly pending = new Set<string>();
  private readonly errored = new Set<string>();

  loading(key: string): void { this.pending.add(key); }
  load(key: string): void { this.loaded.add(key); this.pending.delete(key); this.errored.delete(key); }
  abort(key: string): void { this.pending.delete(key); }
  error(key: string): void { this.errored.add(key); this.pending.delete(key); }
  /** Forgets the required set after a camera change; observed tiles stay. */
  invalidate(): void { this.required.clear(); this.state = 'idle'; }
  reset(): void {
    this.state = 'idle';
    this.required.clear(); this.loaded.clear(); this.pending.clear(); this.errored.clear();
  }
  require(keys: readonly string[]): void { for (const key of keys) this.required.add(key); }
  refresh(source: DetailSource): void { this.state = classifyDetail(source, this.required, this.loaded, this.pending, this.errored); }
  counts(): { requiredTiles: number; loadedTiles: number; pendingTiles: number; erroredTiles: number } {
    return { requiredTiles: this.required.size, loadedTiles: this.loaded.size, pendingTiles: this.pending.size, erroredTiles: this.errored.size };
  }
}
