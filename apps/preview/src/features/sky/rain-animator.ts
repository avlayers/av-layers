import type { Map as MapLibreMap } from 'maplibre-gl';
import { calibrateMercatorProjector, invMercY, type FastMercatorProjector } from './mercator';
import { alignedTo, lonWindow } from './lon-window';
import { MIN_RAIN_MMH, samplePrecipMmh, type PrecipBounds, type PrecipField } from './precip-field';
import {
  buildViewportSpawnDistribution,
  pickFromCdf,
  rainVisualProfileForMmh,
  type ViewportSpawnDistribution
} from './rain-spawn';
import { getRainSpriteAtlas, SLANT_TAN, SPRITE_CELL_H, SPRITE_CELL_W } from './rain-sprites';

const MAX_DROPS = 2_500;
const MAX_SPLASHES = 100;

interface RainDrop {
  lon: number;
  lat: number;
  my: number;
  mmh: number;
  tier: 0 | 1 | 2 | 3;
  age: number;
  life: number;
  speed: number;
  scale: number;
  alpha: number;
  depth: number;
}

interface RainSplash {
  lon: number;
  lat: number;
  my: number;
  age: number;
  life: number;
  maxRx: number;
  doubleRing: boolean;
}

/**
 * Screen-space 60 fps particle renderer for tapered optical raindrops and downpour splash ripples.
 */
export class RainAnimator {
  private readonly canvas: HTMLCanvasElement | null;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly drops: RainDrop[] = [];
  private readonly splashes: RainSplash[] = [];
  private readonly projScratch: [number, number] = [0, 0];
  private field: PrecipField | null = null;
  private spawnDist: ViewportSpawnDistribution | null = null;
  private activeDropCount = 0;
  private darkChrome: boolean;
  private opacity: number;
  private visible: boolean;
  private rafId: number | null = null;
  private lastTickMs = 0;
  private rngState = 0x9e3779b9;
  private splashCursor = 0;
  private cssW = 0;
  private cssH = 0;
  private dpr = 1;
  private cachedProjector: FastMercatorProjector | null | undefined = undefined;
  private cachedProjLon = Number.NaN;
  private cachedProjLat = Number.NaN;
  private disposed = false;

  private readonly onResize = (): void => {
    this.cachedProjector = undefined;
    this.syncCanvasSize();
    this.rebuildViewportDistribution(true);
    if (!this.rafId && this.shouldRenderStatic()) this.drawFrame(0);
  };

  private readonly onCameraMove = (): void => {
    this.cachedProjector = undefined;
    if (!this.rafId && this.shouldRenderStatic()) this.drawFrame(0);
  };

  private readonly onCameraMoveEnd = (): void => {
    this.cachedProjector = undefined;
    this.rebuildViewportDistribution(false);
    if (!this.rafId && this.shouldRenderStatic()) this.drawFrame(0);
  };

  private readonly onVisibilityChange = (): void => {
    this.syncLoop();
  };

  constructor(
    private readonly map: MapLibreMap,
    options: { darkChrome: boolean; opacity: number; visible: boolean }
  ) {
    this.darkChrome = options.darkChrome;
    this.opacity = options.opacity;
    this.visible = options.visible;

    const host = (
      (typeof (map as { getCanvasContainer?: () => HTMLElement }).getCanvasContainer === 'function'
        ? (map as { getCanvasContainer: () => HTMLElement }).getCanvasContainer()
        : null)
      ?? (typeof map.getContainer === 'function' ? map.getContainer() : null)
    );

    if (typeof document !== 'undefined' && host && typeof host.appendChild === 'function' && typeof map.project === 'function') {
      const el = document.createElement('canvas');
      el.className = 'av-rain-canvas';
      el.setAttribute('aria-hidden', 'true');
      host.appendChild(el);
      this.canvas = el;
      this.ctx = el.getContext('2d');
      this.syncCanvasSize();
      map.on('resize', this.onResize);
      map.on('move', this.onCameraMove);
      map.on('moveend', this.onCameraMoveEnd);
      document.addEventListener('visibilitychange', this.onVisibilityChange);
    } else {
      this.canvas = null;
      this.ctx = null;
    }

    for (let i = 0; i < MAX_DROPS; i++) {
      this.drops.push({
        lon: 0, lat: 0, my: 0, mmh: 0, tier: 1,
        age: 0, life: 0.45, speed: 300, scale: 0.85, alpha: 0.85, depth: 1
      });
    }
    for (let i = 0; i < MAX_SPLASHES; i++) {
      this.splashes.push({ lon: 0, lat: 0, my: 0, age: 1, life: 0.3, maxRx: 6, doubleRing: false });
    }
  }

  setField(field: PrecipField | null): void {
    if (this.disposed || this.field === field) return;
    this.field = field;
    this.rebuildViewportDistribution(true);
    if (!field || field.wetIndices.length === 0) {
      this.clearCanvas();
    }
    this.syncLoop();
  }

  setDarkChrome(darkChrome: boolean): void {
    if (this.darkChrome === darkChrome || this.disposed) return;
    this.darkChrome = darkChrome;
    if (!this.rafId && this.shouldRenderStatic()) this.drawFrame(0);
  }

  setOpacity(opacity: number): void {
    if (this.opacity === opacity) return;
    this.opacity = opacity;
    if (!this.rafId && this.shouldRenderStatic()) this.drawFrame(0);
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible || this.disposed) return;
    this.visible = visible;
    if (!visible) this.clearCanvas();
    this.syncLoop();
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopLoop();
    if (this.canvas) {
      this.map.off('resize', this.onResize);
      this.map.off('move', this.onCameraMove);
      this.map.off('moveend', this.onCameraMoveEnd);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibilityChange);
      this.canvas.remove();
    }
  }

  private rand(): number {
    let x = this.rngState | 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rngState = x;
    return (x >>> 0) * (1 / 4294967296);
  }

  private prefersReducedMotion(): boolean {
    return typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  private hasActiveRain(): boolean {
    return Boolean(
      this.ctx && this.visible && this.opacity > 0.02
      && this.field && this.field.wetIndices.length > 0
      && this.spawnDist && this.spawnDist.indices.length > 0
    );
  }

  private shouldRenderStatic(): boolean {
    return this.hasActiveRain() && this.prefersReducedMotion();
  }

  private currentViewBounds(): PrecipBounds {
    if (typeof this.map.getBounds !== 'function') {
      return this.field ?? { west: -180, south: -60, east: 180, north: 60 };
    }
    const b = this.map.getBounds();
    const view = lonWindow(b.getWest(), b.getSouth(), b.getEast(), b.getNorth());
    return this.field ? alignedTo(view, this.field) : view;
  }

  private computeTargetDropCount(dist: ViewportSpawnDistribution): number {
    if (dist.indices.length === 0) return 0;
    const screenArea = Math.max(120_000, this.cssW * this.cssH);
    const wetScreenPx = dist.visibleWetFraction * screenArea;
    const intensityDensity = 0.16 + Math.min(2.6, Math.pow(dist.meanWetMmh, 0.72) * 0.36 + Math.max(0, dist.peakVisibleMmh - 0.8) * 0.08);
    const areaDriven = (wetScreenPx / 520) * intensityDensity;
    const minCluster = dist.peakVisibleMmh >= 5 ? 120 : dist.peakVisibleMmh >= 1.5 ? 64 : 26;
    const maxViewportCap = Math.min(MAX_DROPS, Math.round(screenArea / 460));
    return Math.max(minCluster, Math.min(maxViewportCap, Math.round(areaDriven)));
  }

  private rebuildViewportDistribution(reseedAll: boolean): void {
    const field = this.field;
    if (!field || field.wetIndices.length === 0) {
      this.spawnDist = null;
      this.activeDropCount = 0;
      return;
    }
    const view = this.currentViewBounds();
    const dist = buildViewportSpawnDistribution(field, view);
    const prevCount = this.activeDropCount;
    this.spawnDist = dist;
    this.activeDropCount = this.computeTargetDropCount(dist);

    if (dist.indices.length > 0) {
      const start = reseedAll ? 0 : prevCount;
      for (let i = start; i < this.activeDropCount; i++) {
        this.respawnDrop(this.drops[i]!, field, dist, true);
      }
      if (reseedAll) {
        for (const s of this.splashes) s.age = s.life;
      }
    }
  }

  private respawnDrop(
    drop: RainDrop,
    field: PrecipField,
    dist: ViewportSpawnDistribution,
    randomPhase: boolean
  ): void {
    const cellIdx = pickFromCdf(dist.cdf, dist.indices, this.rand());
    const r = (cellIdx / field.cols) | 0;
    const c = cellIdx - r * field.cols;
    const u = (c + this.rand()) / field.cols;
    const v = (r + this.rand()) / field.rows;
    const lon = field.west + u * (field.east - field.west);
    const my = field.yNorth - v * (field.yNorth - field.ySouth);
    const lat = invMercY(my);
    const mmh = Math.max(MIN_RAIN_MMH, samplePrecipMmh(field, lon, lat, my));
    const profile = rainVisualProfileForMmh(mmh);
    const isForeground = this.rand() < 0.42;
    const depth = isForeground ? (1.02 + this.rand() * 0.22) : (0.70 + this.rand() * 0.22);

    drop.lon = lon;
    drop.lat = lat;
    drop.my = my;
    drop.mmh = mmh;
    drop.tier = profile.tier;
    drop.depth = depth;
    drop.speed = profile.speedPxPerSec * depth * (0.90 + this.rand() * 0.20);
    drop.scale = profile.scale * depth * (0.88 + this.rand() * 0.24);
    drop.alpha = profile.alpha * (isForeground ? 1 : 0.74);
    drop.life = (0.28 + (1 - Math.min(1, mmh / 20)) * 0.22 + this.rand() * 0.14) / Math.max(0.75, depth * 0.9);
    drop.age = randomPhase ? this.rand() * drop.life : 0;
  }

  private spawnSplash(lon: number, lat: number, my: number, mmh: number): void {
    const s = this.splashes[this.splashCursor]!;
    this.splashCursor = (this.splashCursor + 1) % MAX_SPLASHES;
    s.lon = lon;
    s.lat = lat;
    s.my = my;
    s.age = 0;
    s.life = 0.24 + this.rand() * 0.14;
    s.maxRx = 3.6 + Math.min(6.4, Math.sqrt(mmh) * 1.05);
    s.doubleRing = mmh >= 11;
  }

  private syncCanvasSize(): void {
    const canvas = this.canvas;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = typeof window !== 'undefined' ? Math.min(2, Math.max(1, window.devicePixelRatio || 1)) : 1;
    const w = Math.max(1, Math.round(rect.width || this.map.getCanvas?.()?.clientWidth || 1));
    const h = Math.max(1, Math.round(rect.height || this.map.getCanvas?.()?.clientHeight || 1));
    this.cssW = w;
    this.cssH = h;
    this.dpr = dpr;
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (canvas.width !== pw) canvas.width = pw;
    if (canvas.height !== ph) canvas.height = ph;
  }

  private clearCanvas(): void {
    if (!this.ctx || !this.canvas) return;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private syncLoop(): void {
    if (!this.hasActiveRain() || (typeof document !== 'undefined' && document.hidden)) {
      this.stopLoop();
      if (!this.visible || !this.hasActiveRain()) this.clearCanvas();
      return;
    }
    if (this.prefersReducedMotion()) {
      this.stopLoop();
      this.drawFrame(0);
      return;
    }
    if (this.rafId !== null || typeof requestAnimationFrame !== 'function') return;
    this.lastTickMs = performance.now();
    const tick = (now: number): void => {
      this.rafId = null;
      if (this.disposed || !this.hasActiveRain() || (typeof document !== 'undefined' && document.hidden)) return;
      const dt = Math.min(0.055, Math.max(0.004, (now - this.lastTickMs) * 0.001));
      this.lastTickMs = now;
      this.drawFrame(dt);
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopLoop(): void {
    if (this.rafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.rafId);
    }
    this.rafId = null;
  }

  private drawFrame(dt: number): void {
    const ctx = this.ctx, field = this.field, dist = this.spawnDist;
    if (!ctx || !field || !dist || dist.indices.length === 0) return;
    if (this.cssW <= 1 || this.cssH <= 1) this.syncCanvasSize();
    const atlas = getRainSpriteAtlas();
    if (!atlas) return;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);

    const dark = this.darkChrome;
    const masterAlpha = Math.min(1, 0.50 + this.opacity * 0.50);
    const center = this.map.getCenter();
    const centerLon = center.lng;
    const centerLat = center.lat;
    if (this.cachedProjector === undefined || centerLon !== this.cachedProjLon || centerLat !== this.cachedProjLat) {
      this.cachedProjector = calibrateMercatorProjector(this.map, centerLon, centerLat);
      this.cachedProjLon = centerLon;
      this.cachedProjLat = centerLat;
    }
    const fastProj = this.cachedProjector;
    const casingStroke = dark ? '#020814' : '#0c1424';
    const coreStroke = dark ? '#e0f2fe' : '#ffffff';
    const casingBaseAlpha = dark ? 0.72 : 0.58;
    const coreBaseAlpha = dark ? 0.94 : 0.95;

    // 1. Expanding puddle splash ripples under moderate-to-heavy cores (>= 3.2 mm/h)
    ctx.lineCap = 'round';
    for (let i = 0; i < MAX_SPLASHES; i++) {
      const s = this.splashes[i]!;
      if (s.age >= s.life) continue;
      if (dt > 0) {
        s.age += dt;
        if (s.age >= s.life) continue;
      }
      const wrappedLon = s.lon + 360 * Math.floor((centerLon - s.lon) / 360 + 0.5);
      let px: number, py: number;
      if (fastProj) {
        px = fastProj.cx + (wrappedLon - fastProj.cLon) * fastProj.kx;
        py = fastProj.cy + (fastProj.cMy - s.my) * fastProj.ky;
      } else {
        this.projScratch[0] = wrappedLon;
        this.projScratch[1] = s.lat;
        const pt = this.map.project(this.projScratch);
        px = pt.x;
        py = pt.y;
      }
      if (px < -24 || px > this.cssW + 24 || py < -24 || py > this.cssH + 24) continue;

      const t = s.age / s.life;
      const rx = 1.4 + (s.maxRx - 1.4) * Math.sqrt(t);
      const ry = rx * 0.40;
      const fade = (1 - t) * masterAlpha;

      ctx.beginPath();
      ctx.ellipse(px, py, rx, ry, 0, 0, Math.PI * 2);
      if (s.doubleRing && t > 0.22) {
        const rx2 = rx * 0.56;
        ctx.moveTo(px + rx2, py);
        ctx.ellipse(px, py, rx2, ry * 0.56, 0, 0, Math.PI * 2);
      }
      ctx.strokeStyle = casingStroke;
      ctx.globalAlpha = casingBaseAlpha * fade;
      ctx.lineWidth = 2.3;
      ctx.stroke();

      ctx.strokeStyle = coreStroke;
      ctx.globalAlpha = coreBaseAlpha * fade;
      ctx.lineWidth = 1.05;
      ctx.stroke();
    }

    // 2. Multi-depth tapered optical raindrop sprites scaled by local mm/h
    const atlasRowY = dark ? SPRITE_CELL_H : 0;
    const count = fastProj ? this.activeDropCount : Math.min(this.activeDropCount, 480);

    for (let i = 0; i < count; i++) {
      const drop = this.drops[i]!;
      if (dt > 0) {
        drop.age += dt;
        if (drop.age >= drop.life) {
          if (drop.mmh >= 3.2 && this.rand() < Math.min(0.65, 0.14 + drop.mmh * 0.032)) {
            this.spawnSplash(drop.lon, drop.lat, drop.my, drop.mmh);
          }
          this.respawnDrop(drop, field, dist, false);
        }
      }

      const wrappedLon = drop.lon + 360 * Math.floor((centerLon - drop.lon) / 360 + 0.5);
      let px: number, py: number;
      if (fastProj) {
        px = fastProj.cx + (wrappedLon - fastProj.cLon) * fastProj.kx;
        py = fastProj.cy + (fastProj.cMy - drop.my) * fastProj.ky;
      } else {
        this.projScratch[0] = wrappedLon;
        this.projScratch[1] = drop.lat;
        const pt = this.map.project(this.projScratch);
        px = pt.x;
        py = pt.y;
      }
      if (px < -48 || px > this.cssW + 48 || py < -64 || py > this.cssH + 64) continue;

      const phase = drop.age / Math.max(0.05, drop.life);
      const env = phase < 0.16 ? phase / 0.16 : phase > 0.88 ? (1 - phase) / 0.12 : 1;
      const travel = (phase - 0.5) * drop.speed * drop.life * 0.58;
      const tipX = px + travel * SLANT_TAN;
      const tipY = py + travel;

      const dw = SPRITE_CELL_W * 0.52 * drop.scale;
      const dh = SPRITE_CELL_H * 0.52 * drop.scale;
      ctx.globalAlpha = Math.min(1, drop.alpha * env * masterAlpha);
      ctx.drawImage(
        atlas as CanvasImageSource,
        drop.tier * SPRITE_CELL_W,
        atlasRowY,
        SPRITE_CELL_W,
        SPRITE_CELL_H,
        tipX - dw * 0.64,
        tipY - dh + 4.5 * drop.scale,
        dw,
        dh
      );
    }
    ctx.globalAlpha = 1;
  }
}
