import { MapLibreOverlay } from '@deck.gl/maplibre';
import { IconLayer, TextLayer } from '@deck.gl/layers';
import { ParticleLayer } from 'weatherlayers-gl';
import { DISPLAY_KNOTS_PER_MPS, displayedWindSpeed, type WindSpeedSystem } from '@av/contracts/units';
import { STATUS_MASK, STATUS_VALID } from '@av/contracts/layers';
import type { Map } from 'maplibre-gl';
import type { WindPreparedGrid } from '@av/client/wind';
import type { PreparationBudget, PreparationLease } from '@av/client';
import { BARB_ICON_SIZE, WindBarbAtlas } from './wind-barbs-atlas';

export interface WindField { sample(lat: number, lon: number): { u: number | null; v: number | null; status: number } }
export interface WindDeckOptions { style: 'trails' | 'barbs' | 'hybrid'; visible: boolean; paused: boolean; units: WindSpeedSystem }
interface BarbFeature { position: [number, number]; icon: string; angle: number; text: string; dynamic: boolean }

const MAX_LAT = 85.05112878, DEG = Math.PI / 180, DISPLAY_BYTES = 5 * 1024 * 1024;
const valid = (sample: ReturnType<WindField['sample']>): sample is { u: number; v: number; status: number } =>
  (sample.status & STATUS_MASK) === STATUS_VALID && sample.u !== null && sample.v !== null && Number.isFinite(sample.u) && Number.isFinite(sample.v);
const worldY = (lat: number, size: number) => (1 - Math.asinh(Math.tan(Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * DEG)) / Math.PI) * size / 2;
const latitude = (y: number, size: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / size))) / DEG;

/** deck.gl/WeatherLayers wind renderer: GPU particles plus map-plane barb icons and upright labels. */
export class WindDeck {
  private overlay: MapLibreOverlay | null = null;
  private readonly atlas = new WindBarbAtlas();
  private field: WindField | null = null;
  private prepared: WindPreparedGrid | null = null;
  private options: WindDeckOptions = { style: 'trails', visible: true, paused: false, units: 'metric' };
  private frame: string | null = null;
  private generation = 0;
  private installedGeneration = 0;
  private renderedGeneration = 0;
  private features: BarbFeature[] = [];
  private particles = 2048;
  private atlasUrl = '';
  private lease: PreparationLease | null = null;
  private destroyed = false;

  constructor(private readonly map: Map, private readonly budget?: PreparationBudget) {
    this.atlasUrl = this.atlas.canvas.toDataURL('image/png');
    this.lease = budget?.reserve('wind-display-gl', DISPLAY_BYTES, 'foreground') ?? null;
    this.overlay = this.mount(true) ?? this.mount(false);
    map.on('style.load', this.restore);
  }

  get renderState(): { generation: number; frame: string | null; installedGeneration: number } {
    return { generation: this.renderedGeneration, frame: this.frame, installedGeneration: this.installedGeneration };
  }

  get memory(): { canvasBytes: number; glBytes: number; limited: boolean } {
    return { canvasBytes: 0, glBytes: this.lease?.bytes ?? 0, limited: !this.lease };
  }

  setData(field: WindField | null, prepared: WindPreparedGrid | null, frame: string | null, options: WindDeckOptions): void {
    if (this.destroyed) return;
    this.field = field; this.prepared = prepared; this.frame = frame; this.options = options;
    this.generation++; this.installedGeneration++;
    this.features = this.sampleBarbs();
    this.render();
  }

  setOptions(options: WindDeckOptions): void {
    if (this.destroyed) return;
    this.options = options;
    this.features = this.sampleBarbs();
    this.render();
  }

  clear(): void {
    if (this.destroyed) return;
    this.field = null; this.prepared = null; this.frame = null; this.features = [];
    this.generation++; this.installedGeneration++;
    this.render();
  }

  relievePressure(): boolean {
    if (this.particles <= 1024) return false;
    this.particles = 1024; this.render(); return true;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.map.off('style.load', this.restore);
    try { if (this.overlay) this.map.removeControl(this.overlay); this.overlay?.finalize(); } catch { /* map already removed the control */ }
    this.overlay = null; this.lease?.release(); this.lease = null;
  }

  private readonly restore = (): void => {
    if (this.destroyed || !this.overlay) return;
    try { if (!this.map.hasControl(this.overlay)) this.map.addControl(this.overlay); } catch { /* style replacement in progress */ }
  };

  private mount(interleaved: boolean): MapLibreOverlay | null {
    try {
      const overlay = new MapLibreOverlay({ interleaved, layers: [], onAfterRender: () => { this.renderedGeneration = this.installedGeneration; }, onError: () => {} });
      this.map.addControl(overlay); return overlay;
    } catch { return null; }
  }

  private render(): void {
    if (!this.overlay) return;
    const visible = this.options.visible, barbs = visible && this.options.style !== 'trails', trails = visible && this.options.style !== 'barbs';
    const staticFeatures = this.features.filter(feature => !feature.dynamic), dynamicFeatures = this.features.filter(feature => feature.dynamic);
    const width = this.map.getCanvas().clientWidth, height = this.map.getCanvas().clientHeight;
    const layers = [
      ...(trails && this.prepared ? [new ParticleLayer({
        id: `av-wind-particles-${this.generation}`,
        image: { data: this.prepared.data, width: this.prepared.size, height: this.prepared.size },
        imageUnscale: [-100, 100], imageType: 'VECTOR', imageInterpolation: 'NEAREST',
        bounds: this.prepared.bounds as unknown as [number, number, number, number], numParticles: this.particles, maxAge: 32, speedFactor: 0.6,
        width, height, animate: !this.options.paused && !document.hidden, opacity: 0.9, color: [255, 255, 255]
      })] : []),
      ...(barbs ? [
        new IconLayer<BarbFeature>({
          id: 'av-wind-barbs', data: staticFeatures, iconAtlas: this.atlasUrl, iconMapping: this.atlas.mapping,
          getIcon: feature => feature.icon, getPosition: feature => feature.position, getAngle: feature => feature.angle,
          getSize: BARB_ICON_SIZE, sizeUnits: 'pixels', billboard: false, pickable: false
        }),
        ...(dynamicFeatures.length ? [new IconLayer<BarbFeature>({
          id: 'av-wind-barbs-dynamic', data: dynamicFeatures, iconAtlas: this.atlas.dynamicUrl, iconMapping: this.atlas.dynamicMapping,
          getIcon: feature => feature.icon, getPosition: feature => feature.position, getAngle: feature => feature.angle,
          getSize: BARB_ICON_SIZE, sizeUnits: 'pixels', billboard: false, pickable: false
        })] : []),
        new TextLayer<BarbFeature>({
          id: 'av-wind-labels', data: this.features, getText: feature => feature.text,
          getPosition: feature => feature.position, getSize: 10, sizeUnits: 'pixels', billboard: true,
          getColor: [15, 23, 42], fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          getTextAnchor: 'middle', getAlignmentBaseline: 'top', background: false, pickable: false
        })
      ] : [])
    ];
    this.overlay.setProps({ layers });
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
      features.push({ position: [lon, lat], icon, angle: direction, text: String(speedText), dynamic: icon.startsWith('d') });
    }
    return features;
  }
}

