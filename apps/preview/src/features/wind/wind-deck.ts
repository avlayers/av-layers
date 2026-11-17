import { MapLibreOverlay } from '@deck.gl/maplibre';
import { IconLayer, TextLayer } from '@deck.gl/layers';
import { seamInsertBefore, type PreparationBudget, type PreparationLease } from '@av/client';
import type { WindPreparedGrid } from '@av/client/wind';
import { STATUS_MASK, STATUS_VALID } from '@av/contracts/layers';
import { DISPLAY_KNOTS_PER_MPS, displayedWindSpeed, type WindSpeedSystem } from '@av/contracts/units';
import { encodeWindByte } from '@av/contracts/wind-data';
import type { Map } from 'maplibre-gl';
import { BARB_ICON_SIZE, CALM_BARB_KEY, WindBarbAtlas } from './wind-barbs-atlas';
import { WindParticleLayer } from './wind-particle-layer';

export interface WindField { sample(lat: number, lon: number): { u: number | null; v: number | null; status: number } }
export interface WindDeckOptions { style: 'trails' | 'barbs' | 'hybrid'; visible: boolean; paused: boolean; units: WindSpeedSystem }
interface BarbFeature { position: [number, number]; icon: string; angle: number; text: string; dynamic: boolean }

const MAX_LAT = 85.05112878, DEG = Math.PI / 180, DISPLAY_BYTES = 8 * 1024 * 1024, FALLBACK_GRID_SIZE = 128;
const FLAT_PARAMS = { depthWriteEnabled: false, depthCompare: 'always' as const };
const ATLAS_SAMPLER = { magFilter: 'linear' as const, minFilter: 'linear' as const };

const valid = (sample: ReturnType<WindField['sample']>): sample is { u: number; v: number; status: number } =>
  (sample.status & STATUS_MASK) === STATUS_VALID && sample.u !== null && sample.v !== null && Number.isFinite(sample.u) && Number.isFinite(sample.v);
const worldY = (lat: number, size: number) => (1 - Math.asinh(Math.tan(Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * DEG)) / Math.PI) * size / 2;
const latitude = (y: number, size: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / size))) / DEG;
const worldShift = (bounds: readonly [number, number, number, number], centerLon: number) =>
  bounds[2] - bounds[0] >= 359 ? 0 : 360 * Math.round((centerLon - (bounds[0] + bounds[2]) * 0.5) / 360);

/** deck.gl wind renderer: GPU Transform-Feedback streamlines plus map-plane barbs and SDF haloed labels. */
export class WindDeck {
  private overlay: MapLibreOverlay | null = null;
  private interleaved = false;
  private readonly atlas = new WindBarbAtlas();
  private field: WindField | null = null;
  private prepared: WindPreparedGrid | null = null;
  private fallbackPrepared: WindPreparedGrid | null = null;
  private fallbackKey = '';
  private options: WindDeckOptions = { style: 'trails', visible: true, paused: false, units: 'metric' };
  private frame: string | null = null;
  private generation = 0;
  private installedGeneration = 0;
  private renderedGeneration = 0;
  private features: BarbFeature[] = [];
  private labeledFeatures: BarbFeature[] = [];
  private particles = 1408;
  private lease: PreparationLease | null = null;
  private destroyed = false;

  constructor(private readonly map: Map, budget?: PreparationBudget) {
    this.lease = budget?.reserve('wind-display-gl', DISPLAY_BYTES, 'foreground') ?? null;
    this.overlay = this.mount(true) ?? this.mount(false);
    map.on('style.load', this.restore);
    map.on('load', this.ensureAttached);
    map.on('idle', this.ensureAttached);
  }

  get renderState(): { generation: number; frame: string | null; installedGeneration: number } {
    return { generation: this.renderedGeneration, frame: this.frame, installedGeneration: this.installedGeneration };
  }

  get memory(): { canvasBytes: number; glBytes: number; limited: boolean } {
    return { canvasBytes: 0, glBytes: this.lease?.bytes ?? 0, limited: !this.lease };
  }

  setData(field: WindField | null, prepared: WindPreparedGrid | null, frame: string | null, options: WindDeckOptions): void {
    if (this.destroyed) return;
    this.field = field;
    this.prepared = prepared;
    this.fallbackPrepared = null;
    this.fallbackKey = '';
    this.frame = frame;
    this.options = options;
    this.generation++;
    this.installedGeneration++;
    this.refreshBarbs();
    this.render();
  }

  setOptions(options: WindDeckOptions): void {
    if (this.destroyed) return;
    this.options = options;
    this.refreshBarbs();
    this.render();
  }

  clear(): void {
    if (this.destroyed) return;
    this.field = null;
    this.prepared = null;
    this.fallbackPrepared = null;
    this.fallbackKey = '';
    this.frame = null;
    this.features = [];
    this.labeledFeatures = [];
    this.generation++;
    this.installedGeneration++;
    this.render();
  }

  relievePressure(): boolean {
    if (this.particles <= 1024) return false;
    this.particles = 1024;
    this.render();
    return true;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.map.off('style.load', this.restore);
    this.map.off('load', this.ensureAttached);
    this.map.off('idle', this.ensureAttached);
    try { if (this.overlay) this.map.removeControl(this.overlay); this.overlay?.finalize(); } catch { /* map already removed the control */ }
    this.overlay = null;
    this.lease?.release();
    this.lease = null;
  }

  private readonly ensureAttached = (): void => {
    if (this.destroyed || !this.overlay || !this.interleaved) return;
    if (!this.map.isStyleLoaded?.()) return;
    const beforeId = seamInsertBefore(this.map);
    const groupId = beforeId ? `deck-maplibre-layer-group-before:${beforeId}` : 'deck-maplibre-layer-group-last';
    const hasContent = this.options.visible && !!(this.prepared || this.field);
    if (hasContent && !this.map.getLayer?.(groupId) && !this.map.getLayer?.('deck-maplibre-layer-group-last')) {
      this.render();
    }
  };

  private readonly restore = (): void => {
    if (this.destroyed) return;
    if (!this.overlay) {
      this.overlay = this.mount(true) ?? this.mount(false);
      if (this.overlay) this.render();
      return;
    }
    try {
      if (!this.map.hasControl(this.overlay)) this.map.addControl(this.overlay);
      this.render();
    } catch { /* style replacement in progress */ }
  };

  private mount(interleaved: boolean): MapLibreOverlay | null {
    try {
      const overlay = new MapLibreOverlay({
        interleaved,
        layers: [],
        onAfterRender: () => { this.renderedGeneration = this.installedGeneration; },
        onError: () => {}
      });
      this.map.addControl(overlay);
      this.interleaved = interleaved;
      return overlay;
    } catch {
      return null;
    }
  }

  private activePrepared(): WindPreparedGrid | null {
    if (this.prepared) return this.prepared;
    if (!this.field) return null;
    const bounds = this.map.getBounds();
    const west = bounds.getWest(), east = Math.max(west + 0.05, bounds.getEast());
    const south = Math.max(-MAX_LAT, bounds.getSouth()), north = Math.min(MAX_LAT, Math.max(south + 0.05, bounds.getNorth()));
    const padLon = Math.min(30, (east - west) * 0.2), padLat = (north - south) * 0.2;
    const b: [number, number, number, number] = [
      west - padLon,
      Math.max(-MAX_LAT, south - padLat),
      Math.min(west - padLon + 360, east + padLon),
      Math.min(MAX_LAT, north + padLat)
    ];
    const key = `${this.generation}:${b.map(v => v.toFixed(2)).join(',')}`;
    if (this.fallbackPrepared && this.fallbackKey === key) return this.fallbackPrepared;
    const size = FALLBACK_GRID_SIZE;
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      const lat = b[1] + (y + 0.5) / size * (b[3] - b[1]);
      for (let x = 0; x < size; x++) {
        const lon = b[0] + (x + 0.5) / size * (b[2] - b[0]);
        const s = this.field.sample(lat, lon);
        if (!valid(s)) continue;
        const off = (y * size + x) * 4;
        data[off] = encodeWindByte(s.u);
        data[off + 1] = encodeWindByte(s.v);
        data[off + 3] = 255;
      }
    }
    this.fallbackKey = key;
    this.fallbackPrepared = { key, height: 'surface', size, bounds: b, data };
    return this.fallbackPrepared;
  }

  private computeBounds(prepared: WindPreparedGrid): {
    gridBounds: [number, number, number, number];
    spawnBounds: [number, number, number, number];
    centerLon: number;
    zoom: number;
  } {
    const centerLon = this.map.getCenter().lng;
    const zoom = this.map.getZoom();
    const shift = worldShift(prepared.bounds, centerLon);
    const gridBounds: [number, number, number, number] = [
      prepared.bounds[0] + shift,
      prepared.bounds[1],
      prepared.bounds[2] + shift,
      prepared.bounds[3]
    ];
    const view = this.map.getBounds();
    const vw = view.getWest(), ve = Math.max(vw + 0.01, view.getEast());
    const vs = Math.max(-MAX_LAT, view.getSouth()), vn = Math.min(MAX_LAT, Math.max(vs + 0.01, view.getNorth()));
    const padLon = Math.min(30, (ve - vw) * 0.35), padLat = (vn - vs) * 0.35;
    const globalGrid = gridBounds[2] - gridBounds[0] >= 359;
    const spawnWest = globalGrid ? vw - padLon : Math.max(gridBounds[0], vw - padLon);
    const spawnEast = globalGrid ? Math.min(spawnWest + 360, ve + padLon) : Math.min(gridBounds[2], ve + padLon);
    const spawnSouth = Math.max(gridBounds[1], vs - padLat);
    const spawnNorth = Math.min(gridBounds[3], vn + padLat);
    const spawnBounds: [number, number, number, number] = spawnEast > spawnWest && spawnNorth > spawnSouth
      ? [spawnWest, spawnSouth, spawnEast, spawnNorth]
      : gridBounds;
    return { gridBounds, spawnBounds, centerLon, zoom };
  }

  private render(): void {
    if (!this.overlay) return;
    const visible = this.options.visible;
    const barbs = visible && this.options.style !== 'trails';
    const trails = visible && this.options.style !== 'barbs';
    const prepared = trails ? this.activePrepared() : null;
    const staticFeatures = barbs ? this.features.filter(feature => !feature.dynamic) : [];
    const dynamicFeatures = barbs ? this.features.filter(feature => feature.dynamic) : [];
    const beforeId = this.interleaved ? seamInsertBefore(this.map) : undefined;
    const boundsInfo = prepared ? this.computeBounds(prepared) : null;

    const layers = [
      ...(trails && prepared && boundsInfo ? [new WindParticleLayer({
        id: `av-wind-particles-${this.generation}`,
        prepared,
        gridBounds: boundsInfo.gridBounds,
        spawnBounds: boundsInfo.spawnBounds,
        numParticles: this.particles,
        paused: this.options.paused || (typeof document !== 'undefined' && document.hidden),
        centerLon: boundsInfo.centerLon,
        zoom: boundsInfo.zoom,
        beforeId,
        pickable: false
      })] : []),
      ...(barbs ? [
        new IconLayer<BarbFeature>({
          id: 'av-wind-barbs',
          data: staticFeatures,
          iconAtlas: this.atlas.canvas as unknown as string,
          iconMapping: this.atlas.mapping,
          textureParameters: ATLAS_SAMPLER,
          getIcon: feature => feature.icon,
          getPosition: feature => feature.position,
          getAngle: feature => -feature.angle,
          getSize: BARB_ICON_SIZE,
          sizeUnits: 'pixels',
          billboard: false,
          pickable: false,
          parameters: FLAT_PARAMS
        }),
        ...(dynamicFeatures.length ? [new IconLayer<BarbFeature>({
          id: 'av-wind-barbs-dynamic',
          data: dynamicFeatures,
          iconAtlas: this.atlas.dynamicImage as unknown as string,
          iconMapping: this.atlas.dynamicMapping,
          textureParameters: ATLAS_SAMPLER,
          getIcon: feature => feature.icon,
          getPosition: feature => feature.position,
          getAngle: feature => -feature.angle,
          getSize: BARB_ICON_SIZE,
          sizeUnits: 'pixels',
          billboard: false,
          pickable: false,
          parameters: FLAT_PARAMS
        })] : []),
        new TextLayer<BarbFeature>({
          id: 'av-wind-labels',
          data: this.labeledFeatures,
          getText: feature => feature.text,
          getPosition: feature => feature.position,
          getSize: 10,
          sizeUnits: 'pixels',
          billboard: true,
          getColor: [15, 23, 42, 255],
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          fontWeight: 600,
          fontSettings: { sdf: true, fontSize: 64, buffer: 12, radius: 16, smoothing: 0.12 },
          outlineWidth: 7,
          outlineColor: [255, 255, 255, 245],
          getPixelOffset: [0, 3],
          getTextAnchor: 'middle',
          getAlignmentBaseline: 'top',
          background: false,
          pickable: false,
          parameters: FLAT_PARAMS
        })
      ] : [])
    ];
    this.overlay.setProps({ layers });
  }

  private refreshBarbs(): void {
    this.features = this.sampleBarbs();
    this.labeledFeatures = this.features.filter(feature => feature.text.length > 0);
  }

  private sampleBarbs(): BarbFeature[] {
    if (!this.field || !this.options.visible || this.options.style === 'trails') return [];
    const bounds = this.map.getBounds(), zoom = this.map.getZoom(), size = 512 * 2 ** zoom, step = this.options.style === 'hybrid' ? 64 : 32;
    const x0 = Math.ceil(((bounds.getWest() + 180) / 360 * size - 16) / step), x1 = Math.floor(((bounds.getEast() + 180) / 360 * size - 16) / step);
    const y0 = Math.max(0, Math.ceil((worldY(bounds.getNorth(), size) - 16) / step)), y1 = Math.min(Math.floor(size / step), Math.floor((worldY(bounds.getSouth(), size) - 16) / step));
    const stride = Math.max(1, Math.ceil(Math.sqrt(Math.max(0, x1 - x0 + 1) * Math.max(0, y1 - y0 + 1) / 5000)));
    const features: BarbFeature[] = [];
    for (let y = Math.ceil(y0 / stride) * stride; y <= y1; y += stride) for (let x = Math.ceil(x0 / stride) * stride; x <= x1; x += stride) {
      const lon = (x * step + 16) / size * 360 - 180, lat = latitude(y * step + 16, size), sample = this.field.sample(lat, lon);
      if (!valid(sample)) continue;
      const speed = Math.hypot(sample.u, sample.v), speedText = displayedWindSpeed(speed, this.options.units);
      if (speedText === null || !Number.isFinite(speed)) continue;
      const icon = this.atlas.key(speed * DISPLAY_KNOTS_PER_MPS, lat < 0);
      if (!icon) continue;
      const direction = (Math.atan2(-sample.u, -sample.v) * 180 / Math.PI + 360) % 360;
      const text = icon === CALM_BARB_KEY ? '' : String(speedText);
      features.push({ position: [lon, lat], icon, angle: direction, text, dynamic: icon.startsWith('d') });
    }
    return features;
  }
}
