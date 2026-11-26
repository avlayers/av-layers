/**
 * Coastline and border outline for day previews: water and boundary features from the basemap's rendered
 * vector tiles, drawn once per settled view into two small canvases (land and water below the raster,
 * boundaries above it) and centre-cropped like `RasterOverview.drawPreview`. While the map moves, or when
 * the basemap layers are missing, nothing is drawn and the previews show the raster alone.
 */
import type { Map as MapLibreMap, MapGeoJSONFeature } from 'maplibre-gl';
import { themeOption, type MapTheme } from '../../themes/registry';

type ScaffoldMap = Pick<MapLibreMap, 'queryRenderedFeatures' | 'project' | 'getCanvas' | 'getLayer' | 'on' | 'off'>;
type Target = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Surface = HTMLCanvasElement | OffscreenCanvas;

interface PreviewGeography {
  /** Land and water under the raster; false when there is no scaffold for this view. */
  drawBase(target: Target, width: number, height: number): boolean;
  /** Boundaries over the raster. */
  drawLines(target: Target, width: number, height: number): void;
  destroy(): void;
}

const WATER_LAYERS = ['water'];
const BORDER_LAYERS = ['admin_country', 'admin_disputed', 'admin_sub'];
const SCAFFOLD_MAX_PX = 360;
const MAX_POINTS = 60_000;

/** `active` says whether any preview is shown; the build waits until one is. */
export function createPreviewGeography(map: ScaffoldMap, theme: () => MapTheme, changed: () => void, active: () => boolean = () => true, createSurface = defaultSurface): PreviewGeography {
  let base: Surface | null = null, lines: Surface | null = null, builtTheme: MapTheme | null = null;
  let moving = false, stale = true;
  const onMoveStart = () => { moving = true; };
  const onMoveEnd = () => { moving = false; stale = true; };
  const onData = (event: { sourceId?: string; dataType?: string }) => { if (event.dataType === 'source' && event.sourceId === 'openmaptiles') stale = true; };
  const onIdle = () => {
    if (!stale || moving || !active()) return;
    stale = false;
    build();
    changed();
  };
  map.on('movestart', onMoveStart);
  map.on('moveend', onMoveEnd);
  map.on('sourcedata', onData);
  map.on('idle', onIdle);

  function build(): void {
    base = lines = null;
    builtTheme = theme();
    const canvas = map.getCanvas(), viewW = canvas.clientWidth, viewH = canvas.clientHeight;
    if (!(viewW > 0) || !(viewH > 0)) return;
    const water = layersPresent(WATER_LAYERS), borders = layersPresent(BORDER_LAYERS);
    if (!water.length) return;
    const scale = Math.min(1, SCAFFOLD_MAX_PX / Math.max(viewW, viewH));
    const w = Math.max(1, Math.round(viewW * scale)), h = Math.max(1, Math.round(viewH * scale));
    const t = themeOption(builtTheme).basemap;
    const waterFeatures = query(water), borderFeatures = borders.length ? query(borders) : [];
    // Dense coastlines are skipped before any projection work, not after it.
    let points = 0;
    for (const feature of waterFeatures) for (const ring of polygonRings(feature)) points += ring.length;
    for (const feature of borderFeatures) for (const line of lineStrings(feature)) points += line.length;
    if (points > MAX_POINTS) return;
    const trace = (target: Target, rings: number[][][]) => {
      for (const ring of rings) {
        ring.forEach(([lng, lat], i) => {
          const p = map.project([lng, lat]);
          if (i === 0) target.moveTo(p.x * scale, p.y * scale); else target.lineTo(p.x * scale, p.y * scale);
        });
      }
    };
    const baseSurface = createSurface(w, h), baseContext = baseSurface?.getContext('2d') as Target | null;
    if (!baseSurface || !baseContext) return;
    baseContext.fillStyle = landTone(t.relief) ?? t.ocean;
    baseContext.fillRect(0, 0, w, h);
    baseContext.fillStyle = t.ocean;
    // Each feature fills on its own: tile-clipped neighbours overlap, and one even-odd path would cancel them out.
    for (const feature of waterFeatures) {
      baseContext.beginPath();
      trace(baseContext, polygonRings(feature));
      baseContext.fill('evenodd');
    }
    const lineSurface = borders.length ? createSurface(w, h) : null, lineContext = lineSurface?.getContext('2d') as Target | null;
    if (lineSurface && lineContext) {
      lineContext.lineJoin = 'round';
      for (const feature of borderFeatures) {
        const country = feature.layer.id !== 'admin_sub';
        lineContext.strokeStyle = country ? t.borderMajor : t.borderMinor;
        lineContext.lineWidth = country ? 1.1 : 0.7;
        lineContext.setLineDash(feature.layer.id === 'admin_country' ? [] : [3, 2]);
        lineContext.beginPath();
        trace(lineContext, lineStrings(feature));
        lineContext.stroke();
      }
    }
    base = baseSurface;
    lines = lineSurface;
  }

  function layersPresent(ids: readonly string[]): string[] {
    return ids.filter(id => { try { return Boolean(map.getLayer(id)); } catch { return false; } });
  }

  function query(layers: string[]): MapGeoJSONFeature[] {
    try { return map.queryRenderedFeatures({ layers }); } catch { return []; }
  }

  function ready(): boolean {
    if (moving) return false;
    // A theme change rebuilds on the next idle rather than inside a paint.
    if (builtTheme !== null && builtTheme !== theme()) { stale = true; base = lines = null; builtTheme = null; return false; }
    return base !== null;
  }

  return {
    drawBase(target, width, height) {
      if (!ready() || !base) return false;
      centreCrop(target, base, width, height);
      return true;
    },
    drawLines(target, width, height) {
      if (!ready() || !lines) return;
      centreCrop(target, lines, width, height);
    },
    destroy() {
      base = lines = null;
      // The map may already be torn down by the time the page lifecycle ends.
      if (typeof map.off !== 'function') return;
      map.off('movestart', onMoveStart);
      map.off('moveend', onMoveEnd);
      map.off('sourcedata', onData);
      map.off('idle', onIdle);
    }
  };
}

/** Same centre-crop as `RasterOverview.drawPreview`: the view's centre at the target's aspect. */
export function centreCrop(target: Target, source: Surface, width: number, height: number): void {
  const aspect = width / height;
  let sw = source.width, sh = source.height;
  if (sw / sh > aspect) sw = sh * aspect; else sh = sw / aspect;
  target.drawImage(source, (source.width - sw) / 2, (source.height - sh) / 2, sw, sh, 0, 0, width, height);
}

/** The relief colour just above sea level, from an `interpolate` expression over elevation. */
export function landTone(relief: readonly unknown[]): string | null {
  for (let i = 3; i + 1 < relief.length; i += 2) {
    const stop = relief[i], color = relief[i + 1];
    if (typeof stop === 'number' && stop > 0 && typeof color === 'string') return color;
  }
  return null;
}

function polygonRings(feature: MapGeoJSONFeature): number[][][] {
  const g = feature.geometry;
  if (g.type === 'Polygon') return g.coordinates;
  if (g.type === 'MultiPolygon') return g.coordinates.flat();
  return [];
}

function lineStrings(feature: MapGeoJSONFeature): number[][][] {
  const g = feature.geometry;
  if (g.type === 'LineString') return [g.coordinates];
  if (g.type === 'MultiLineString') return g.coordinates;
  return [];
}

function defaultSurface(width: number, height: number): Surface | null {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  return canvas;
}
