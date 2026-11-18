import type { Map } from 'maplibre-gl';
import {
  ApiClient, clampOpacity,
  type ForecastRequestHandle, type ForecastRequestSpec, type PinnedBuild
} from '@av/client';
import {
  resolveChannelStyles,
  type CloudStyleChoice,
  type RainStyleChoice,
  type ResolvedChannelStyles
} from '../map/channel-styles';
import type { MapTheme } from '../map/visual-theme';
import { canRemapTiles } from '../raster/tile-remap';
import { CloudLayerController } from './cloud-layer';
import { IsobarLayerController } from './isobar-layer';
import { RainLayerController, type LiveRainRenderState } from './rain-layer';
import { rawMapViewBounds, SynopticSampler, type SynopticField } from './synoptic-sampler';

const MOVE_SETTLE_MS = 32;
const WARM_IDLE_MS = 120;

/**
 * Thin coordinator delegating synoptic weather channels to independent, decoupled controllers:
 * - `SynopticSampler` (`cloud-cover-total`, `cloud-cover-low`, `mslp-hpa` multi-frame sampling & warming)
 * - `CloudLayerController` (zoom-adaptive billowy cloud/shadow decks + vector overcast contours)
 * - `RainLayerController` (`#1` Inner Vignette Cuff + Crisp Dry Halo + intensity-coupled `RainAnimator`)
 * - `IsobarLayerController` (2 / 4 hPa sea-level pressure contours & H / L centers)
 */
export class SkyComposite {
  private readonly supported: boolean;
  private readonly sampler: SynopticSampler;
  private readonly clouds: CloudLayerController;
  private readonly rain: RainLayerController;
  private readonly isobars: IsobarLayerController;

  private build: PinnedBuild | null = null;
  private frame: string | null = null;
  private theme: MapTheme;
  private cloudStyle: CloudStyleChoice;
  private rainStyle: RainStyleChoice;
  private styles: ResolvedChannelStyles;
  private opacity: number;
  private cloudsVisible: boolean;
  private rainVisible: boolean;
  private isobarsVisible: boolean;
  private peeking = false;
  private playing = false;
  private moveTimer: ReturnType<typeof setTimeout> | null = null;
  private warmTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  private readonly onMoveStart = (): void => {
    if (this.moveTimer !== null) { clearTimeout(this.moveTimer); this.moveTimer = null; }
    this.cancelWarmTimer();
    this.sampler.pauseWarming();
    this.rain.pauseWarming();
  };

  private readonly onMoveEnd = (): void => {
    if (this.disposed || !this.supported || !this.build || !this.frame || this.peeking) return;
    if (!this.cloudsVisible && !this.isobarsVisible && !this.rainVisible) return;
    if (this.moveTimer !== null) clearTimeout(this.moveTimer);
    this.moveTimer = setTimeout(() => {
      this.moveTimer = null;
      if (this.disposed || !this.build || !this.frame || this.peeking) return;
      this.syncActiveFrame(true);
    }, MOVE_SETTLE_MS);
  };

  constructor(
    private readonly map: Map,
    api: ApiClient,
    baseUrl: string,
    options: {
      theme: MapTheme;
      cloudStyle?: CloudStyleChoice;
      rainStyle?: RainStyleChoice;
      opacity: number;
      cloudsVisible: boolean;
      rainVisible: boolean;
      isobarsVisible: boolean;
      fetchImpl?: typeof fetch;
      request?: (spec: ForecastRequestSpec) => ForecastRequestHandle;
    }
  ) {
    this.theme = options.theme;
    this.cloudStyle = options.cloudStyle ?? 'auto';
    this.rainStyle = options.rainStyle ?? 'auto';
    this.styles = resolveChannelStyles(this.theme, { cloudStyle: this.cloudStyle, rainStyle: this.rainStyle });
    this.opacity = options.opacity;
    this.cloudsVisible = options.cloudsVisible;
    this.rainVisible = options.rainVisible;
    this.isobarsVisible = options.isobarsVisible;

    this.supported = typeof map.addSource === 'function' && typeof map.getStyle === 'function' && canRemapTiles();
    this.sampler = new SynopticSampler(api);
    this.clouds = new CloudLayerController(map, this.supported);
    this.isobars = new IsobarLayerController(map);
    this.rain = new RainLayerController(map, baseUrl, this.supported, {
      styles: this.styles,
      opacity: this.opacity,
      visible: this.rainVisible,
      fetchImpl: options.fetchImpl,
      request: options.request
    });

    if (this.supported) {
      map.on('movestart', this.onMoveStart);
      map.on('moveend', this.onMoveEnd);
    }
  }

  select(build: PinnedBuild, frame: string): void {
    if (!this.supported || this.disposed) return;
    if (build.expiresAtMs <= Date.now()) { this.clear(); return; }
    const buildChanged = this.build !== build;
    this.build = build;
    this.frame = frame;
    if (buildChanged) {
      this.cancelWarmTimer();
      this.sampler.pauseWarming();
      this.rain.pauseWarming();
    }
    this.syncActiveFrame(!this.playing);
  }

  /** Pre-fetches synoptic and/or rain data for an upcoming frame or hovered channel button. */
  prepare(build: PinnedBuild, frame: string, channel?: 'clouds' | 'rain' | 'isobars'): void {
    if (!this.supported || this.disposed || build.expiresAtMs <= Date.now()) return;
    const raw = rawMapViewBounds(this.map);
    const wantClouds = channel ? channel === 'clouds' : this.cloudsVisible;
    const wantIso = channel ? channel === 'isobars' : this.isobarsVisible;
    const wantRain = channel ? channel === 'rain' : this.rainVisible;

    if ((wantClouds || wantIso) && !this.sampler.findCached(build, frame, raw, { needClouds: wantClouds, needMslp: wantIso })) {
      void this.sampler.load(build, frame, raw, { needClouds: wantClouds, needMslp: wantIso });
    }
    if (wantRain && !this.rain.findCachedField(build, frame, raw)) {
      this.rain.warmHorizon(build, frame, raw);
    }
  }

  setPlayback(playing: boolean): void {
    if (this.playing === playing) return;
    this.playing = playing;
    if (playing) {
      this.cancelWarmTimer();
      this.sampler.pauseWarming();
      this.rain.pauseWarming();
    } else if (this.build && this.frame && !this.peeking) {
      this.scheduleHorizonWarm();
    }
  }

  setTheme(theme: MapTheme): void {
    if (this.theme === theme || !this.supported || this.disposed) return;
    this.theme = theme;
    this.recomputeStyles();
  }

  setChannelStyles(patch: { cloudStyle?: CloudStyleChoice; rainStyle?: RainStyleChoice }): void {
    if (!this.supported || this.disposed) return;
    const nextCloud = patch.cloudStyle ?? this.cloudStyle;
    const nextRain = patch.rainStyle ?? this.rainStyle;
    if (nextCloud === this.cloudStyle && nextRain === this.rainStyle) return;
    this.cloudStyle = nextCloud;
    this.rainStyle = nextRain;
    this.recomputeStyles();
  }

  setOpacity(opacity: number): void {
    const clamped = clampOpacity(opacity);
    if (this.opacity === clamped) return;
    this.opacity = clamped;
    if (!this.supported || this.disposed) return;
    this.clouds.syncVisibilityAndStyle(this.styles, this.opacity, this.cloudsVisible && !this.peeking);
    this.rain.syncStyleAndVisibility(this.styles, this.opacity, this.rainVisible && !this.peeking);
  }

  setVisibility(state: { cloudsVisible?: boolean; rainVisible?: boolean; isobarsVisible?: boolean; peeking?: boolean }): void {
    if (!this.supported || this.disposed) return;
    const prevClouds = this.cloudsVisible, prevRain = this.rainVisible, prevIso = this.isobarsVisible, prevPeek = this.peeking;
    if (state.cloudsVisible !== undefined) this.cloudsVisible = state.cloudsVisible;
    if (state.rainVisible !== undefined) this.rainVisible = state.rainVisible;
    if (state.isobarsVisible !== undefined) this.isobarsVisible = state.isobarsVisible;
    if (state.peeking !== undefined) this.peeking = state.peeking;

    if (prevClouds === this.cloudsVisible && prevRain === this.rainVisible && prevIso === this.isobarsVisible && prevPeek === this.peeking) {
      return;
    }

    const showClouds = this.cloudsVisible && !this.peeking;
    const showRain = this.rainVisible && !this.peeking;
    const showIso = this.isobarsVisible && !this.peeking;

    this.clouds.syncVisibilityAndStyle(this.styles, this.opacity, showClouds);
    this.isobars.syncStyleAndVisibility(this.styles.isobar, showIso);
    this.rain.syncStyleAndVisibility(this.styles, this.opacity, showRain);

    const revealedAny = ((!prevClouds && this.cloudsVisible) || (!prevIso && this.isobarsVisible) || (!prevRain && this.rainVisible) || (prevPeek && !this.peeking));
    if (revealedAny && this.build && this.frame && !this.peeking) {
      this.syncActiveFrame(!this.playing);
    }
  }

  clear(): void {
    if (!this.supported) return;
    if (this.moveTimer !== null) { clearTimeout(this.moveTimer); this.moveTimer = null; }
    this.cancelWarmTimer();
    this.sampler.resetActive();
    this.build = null;
    this.frame = null;
    this.clouds.clear();
    this.isobars.clear();
    this.rain.clear();
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.moveTimer !== null) { clearTimeout(this.moveTimer); this.moveTimer = null; }
    this.cancelWarmTimer();
    if (this.supported) {
      this.map.off('movestart', this.onMoveStart);
      this.map.off('moveend', this.onMoveEnd);
      this.clear();
    }
    this.rain.dispose();
    this.sampler.dispose();
  }

  private cancelWarmTimer(): void {
    if (this.warmTimer !== null) {
      clearTimeout(this.warmTimer);
      this.warmTimer = null;
    }
  }

  private scheduleHorizonWarm(): void {
    this.cancelWarmTimer();
    if (this.disposed || this.playing || this.peeking || !this.build || !this.frame) return;
    const build = this.build, frame = this.frame;
    this.warmTimer = setTimeout(() => {
      this.warmTimer = null;
      if (this.disposed || this.playing || this.peeking || this.build !== build || this.frame !== frame) return;
      if (this.map.isMoving?.()) return;
      const raw = rawMapViewBounds(this.map);
      if (this.cloudsVisible || this.isobarsVisible) {
        this.sampler.warmHorizon(build, frame, raw, {
          needClouds: this.cloudsVisible,
          needMslp: this.isobarsVisible
        });
      }
      if (this.rainVisible) {
        this.rain.warmHorizon(build, frame, raw);
      }
    }, WARM_IDLE_MS);
  }

  private paintSynopticField(field: SynopticField): void {
    const showClouds = this.cloudsVisible && !this.peeking;
    const showIso = this.isobarsVisible && !this.peeking;
    if (showClouds) this.clouds.paint(field, this.styles, this.opacity, true);
    else this.clouds.syncVisibilityAndStyle(this.styles, this.opacity, false);
    if (showIso) this.isobars.paint(field, this.styles.isobar, true);
    else this.isobars.syncStyleAndVisibility(this.styles.isobar, false);
  }

  private syncActiveFrame(allowWarm: boolean): void {
    const build = this.build, frame = this.frame;
    if (!build || !frame) return;

    const showClouds = this.cloudsVisible && !this.peeking;
    const showRain = this.rainVisible && !this.peeking;
    const showIso = this.isobarsVisible && !this.peeking;
    const raw = rawMapViewBounds(this.map);

    let synopticReady = !(showClouds || showIso);
    if (showClouds || showIso) {
      const cached = this.sampler.findCached(build, frame, raw, {
        needClouds: showClouds,
        needMslp: showIso
      });
      if (cached) {
        this.paintSynopticField(cached);
        synopticReady = true;
      } else {
        void this.refreshSynoptic(build, frame, raw, allowWarm);
      }
    } else {
      this.clouds.syncVisibilityAndStyle(this.styles, this.opacity, false);
      this.isobars.syncStyleAndVisibility(this.styles.isobar, false);
    }

    let rainReady = !showRain;
    if (showRain) {
      rainReady = this.rain.tryPaintCached(build, frame, raw, {
        styles: this.styles,
        opacity: this.opacity,
        visible: true
      });
      if (!rainReady) {
        void this.refreshRain(build, frame, raw, allowWarm);
      }
    } else {
      this.rain.syncStyleAndVisibility(this.styles, this.opacity, false);
    }

    if (allowWarm && synopticReady && rainReady) {
      this.scheduleHorizonWarm();
    }
  }

  private recomputeStyles(): void {
    this.styles = resolveChannelStyles(this.theme, { cloudStyle: this.cloudStyle, rainStyle: this.rainStyle });
    const showClouds = this.cloudsVisible && !this.peeking;
    const showRain = this.rainVisible && !this.peeking;
    const showIso = this.isobarsVisible && !this.peeking;
    const raw = rawMapViewBounds(this.map);

    const current = this.build && this.frame
      ? (this.sampler.findCached(this.build, this.frame, raw, { needClouds: showClouds, needMslp: showIso }) ?? this.sampler.current)
      : null;
    if (current && this.build && current.buildId === this.build.manifest.buildId && current.frame === this.frame) {
      this.paintSynopticField(current);
    } else {
      this.clouds.syncVisibilityAndStyle(this.styles, this.opacity, showClouds);
      this.isobars.syncStyleAndVisibility(this.styles.isobar, showIso);
    }
    this.rain.repaintCurrent(raw, this.styles, this.opacity, showRain);
  }

  private async refreshSynoptic(build: PinnedBuild, frame: string, raw: ReturnType<typeof rawMapViewBounds>, allowWarm: boolean): Promise<void> {
    if (this.peeking || (!this.cloudsVisible && !this.isobarsVisible)) return;
    const field = await this.sampler.load(build, frame, raw, {
      needClouds: this.cloudsVisible,
      needMslp: this.isobarsVisible
    });
    if (!field || this.disposed || this.build !== build || this.frame !== frame) return;
    this.paintSynopticField(field);
    if (allowWarm) this.scheduleHorizonWarm();
  }

  private async refreshRain(build: PinnedBuild, frame: string, raw: ReturnType<typeof rawMapViewBounds>, allowWarm: boolean): Promise<void> {
    if (this.peeking || !this.rainVisible) return;
    const readLive = (): LiveRainRenderState | null => {
      if (this.disposed || this.build !== build || this.frame !== frame) return null;
      return {
        styles: this.styles,
        opacity: this.opacity,
        visible: this.rainVisible && !this.peeking
      };
    };
    const painted = await this.rain.refresh(build, frame, raw, {
      styles: this.styles,
      opacity: this.opacity,
      visible: this.rainVisible && !this.peeking
    }, readLive);
    if (painted && allowWarm && !this.disposed && this.build === build && this.frame === frame) {
      this.scheduleHorizonWarm();
    }
  }
}
