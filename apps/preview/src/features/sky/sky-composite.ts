import type { Map } from 'maplibre-gl';
import {
  ApiClient, clampOpacity,
  type ForecastRequestHandle, type ForecastRequestSpec, type PinnedBuild
} from '@av/client';
import { resolveChannelStyles, type ResolvedChannelStyles } from '../map/channel-styles';
import type { ChannelView, MapChannel } from '../../channels/channel';
import type { MapTheme } from '../../themes/registry';
import { canRemapTiles } from '../raster/tile-remap';
import { CloudLayerController } from './cloud-layer';
import { IsobarLayerController } from './isobar-layer';
import { RainLayerController, type LiveRainRenderState } from './rain-layer';
import { rawMapViewBounds, SynopticSampler, type SynopticField } from './synoptic-sampler';

const MOVE_SETTLE_MS = 32;
const WARM_IDLE_MS = 120;

type SkyChannel = 'clouds' | 'isobars' | 'rain';
const SKY_CHANNELS: readonly SkyChannel[] = ['clouds', 'isobars', 'rain'];
/** Per visible sky channel: drawing the selected build and frame, waiting for it, or without data for it. */
export type SkyStatus = Partial<Record<SkyChannel, 'ready' | 'loading' | 'unavailable'>>;

/**
 * Thin coordinator delegating synoptic weather channels to independent, decoupled controllers:
 * - `SynopticSampler` (`cloud-cover-total`, `cloud-cover-low`, `mslp-hpa` multi-frame sampling & warming)
 * - `CloudLayerController` (zoom-adaptive billowy cloud/shadow decks + vector overcast contours)
 * - `RainLayerController` (`#1` Inner Vignette Cuff + Crisp Dry Halo + intensity-coupled `RainAnimator`)
 * - `IsobarLayerController` (2 / 4 hPa sea-level pressure contours & H / L centers)
 */
export class SkyComposite implements MapChannel {
  private readonly supported: boolean;
  private readonly sampler: SynopticSampler;
  private readonly clouds: CloudLayerController;
  private readonly rain: RainLayerController;
  private readonly isobars: IsobarLayerController;

  private build: PinnedBuild | null = null;
  private frame: string | null = null;
  private theme: MapTheme;
  private styles: ResolvedChannelStyles;
  private opacity: number;
  private cloudsVisible: boolean;
  private rainVisible: boolean;
  private isobarsVisible: boolean;
  private peeking = false;
  private playing = false;
  private moveTimer: ReturnType<typeof setTimeout> | null = null;
  private warmTimer: ReturnType<typeof setTimeout> | null = null;
  private synopticSeq = 0;
  private rainSeq = 0;
  private disposed = false;
  /** `buildId:frame` each channel currently draws; a channel whose key differs from the selection stays hidden. */
  private readonly painted: Record<SkyChannel, string | null> = { clouds: null, isobars: null, rain: null };
  private readonly pending: Record<SkyChannel, 'loading' | 'unavailable' | null> = { clouds: null, isobars: null, rain: null };
  private lastStatus = '';
  private readonly onStatus: (status: SkyStatus) => void;

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
      opacity: number;
      cloudsVisible: boolean;
      rainVisible: boolean;
      isobarsVisible: boolean;
      fetchImpl?: typeof fetch;
      request?: (spec: ForecastRequestSpec) => ForecastRequestHandle;
      onStatus?: (status: SkyStatus) => void;
    }
  ) {
    this.onStatus = options.onStatus ?? (() => {});
    this.theme = options.theme;
    this.styles = resolveChannelStyles(this.theme);
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
  prepare(build: PinnedBuild, frame: string, channel?: SkyChannel): void {
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
    } else {
      this.syncShown();
      if (this.build && this.frame && !this.peeking) this.scheduleHorizonWarm();
    }
  }

  update(view: ChannelView): void {
    this.setTheme(view.theme);
    this.setOpacity(view.opacity);
    this.setVisibility(view);
  }

  setTheme(theme: MapTheme): void {
    if (this.theme === theme || !this.supported || this.disposed) return;
    this.theme = theme;
    this.recomputeStyles();
  }

  setOpacity(opacity: number): void {
    const clamped = clampOpacity(opacity);
    if (this.opacity === clamped) return;
    this.opacity = clamped;
    if (!this.supported || this.disposed) return;
    this.clouds.syncVisibilityAndStyle(this.styles, this.opacity, this.shown('clouds'));
    this.rain.syncStyleAndVisibility(this.styles, this.opacity, this.shown('rain'));
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
    this.syncShown();

    const revealedAny = ((!prevClouds && this.cloudsVisible) || (!prevIso && this.isobarsVisible) || (!prevRain && this.rainVisible) || (prevPeek && !this.peeking));
    if (revealedAny && this.build && this.frame && !this.peeking) {
      this.syncActiveFrame(!this.playing);
    } else {
      this.emitStatus();
    }
  }

  clear(): void {
    if (!this.supported) return;
    if (this.moveTimer !== null) { clearTimeout(this.moveTimer); this.moveTimer = null; }
    this.cancelWarmTimer();
    this.sampler.resetActive();
    this.build = null;
    this.frame = null;
    this.synopticSeq++;
    for (const channel of SKY_CHANNELS) { this.painted[channel] = null; this.pending[channel] = null; }
    this.clouds.clear();
    this.isobars.clear();
    this.rain.clear();
    this.emitStatus();
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

  private selection(): string | null {
    return this.build && this.frame ? `${this.build.manifest.buildId}:${this.frame}` : null;
  }

  private wanted(channel: SkyChannel): boolean {
    if (this.peeking) return false;
    return channel === 'clouds' ? this.cloudsVisible : channel === 'isobars' ? this.isobarsVisible : this.rainVisible;
  }

  /**
   * Visible and drawing the selected build and frame. During playback a channel keeps the previous hour
   * of the same build while the next one loads, so animation does not flash blank.
   */
  private shown(channel: SkyChannel): boolean {
    const selected = this.selection(), painted = this.painted[channel];
    if (!this.wanted(channel) || selected === null || painted === null) return false;
    return painted === selected || (this.playing && this.pending[channel] === 'loading' && painted.startsWith(`${this.build!.manifest.buildId}:`));
  }

  private syncShown(): void {
    this.clouds.syncVisibilityAndStyle(this.styles, this.opacity, this.shown('clouds'));
    this.isobars.syncStyleAndVisibility(this.styles.isobar, this.shown('isobars'));
    this.rain.syncStyleAndVisibility(this.styles, this.opacity, this.shown('rain'));
  }

  /** Marks a channel loading; outside playback it hides another hour so that never stands in for the selection. */
  private awaitChannel(channel: SkyChannel): void {
    if (this.painted[channel] === this.selection()) return;
    this.pending[channel] = 'loading';
    if (!this.playing) this.painted[channel] = null;
  }

  /** Marks a channel still waiting on the selection as unavailable once its load settles. */
  private settleChannel(channel: SkyChannel, selected: string): void {
    if (this.selection() === selected && this.painted[channel] !== selected && this.pending[channel] === 'loading') {
      this.pending[channel] = 'unavailable';
    }
  }

  private emitStatus(): void {
    const status: SkyStatus = {};
    for (const channel of SKY_CHANNELS) {
      if (!this.wanted(channel) || !this.selection()) continue;
      status[channel] = this.painted[channel] === this.selection() ? 'ready' : this.pending[channel] ?? 'loading';
    }
    const key = JSON.stringify(status);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    this.onStatus(status);
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

  /** Paints the channels `field` has data for; a channel the field evaluated without valid cells stays empty. */
  private paintSynopticField(field: SynopticField): void {
    const key = `${field.buildId}:${field.frame}`;
    const published = this.build?.manifest.layers ?? [];
    if (this.wanted('clouds')) {
      if (field.hasClouds) { this.clouds.paint(field, this.styles, this.opacity, true); this.painted.clouds = key; this.pending.clouds = null; }
      else if (field.cloudsEvaluated || !published.includes('cloud-cover-total')) { this.painted.clouds = null; this.pending.clouds = 'unavailable'; }
    }
    if (this.wanted('isobars')) {
      if (field.hasMslp) { this.isobars.paint(field, this.styles.isobar, true); this.painted.isobars = key; this.pending.isobars = null; }
      else if (field.mslpEvaluated || !published.includes('mslp-hpa')) { this.painted.isobars = null; this.pending.isobars = 'unavailable'; }
    }
    this.syncShown();
  }

  private syncActiveFrame(allowWarm: boolean): void {
    const build = this.build, frame = this.frame;
    if (!build || !frame) return;

    const showClouds = this.wanted('clouds');
    const showIso = this.wanted('isobars');
    const raw = rawMapViewBounds(this.map);

    let synopticReady = !(showClouds || showIso);
    if (showClouds || showIso) {
      const seq = ++this.synopticSeq;
      const cached = this.sampler.findCached(build, frame, raw, {
        needClouds: showClouds,
        needMslp: showIso
      });
      if (cached) {
        this.paintSynopticField(cached);
        synopticReady = true;
      } else {
        if (showClouds) this.awaitChannel('clouds');
        if (showIso) this.awaitChannel('isobars');
        void this.refreshSynoptic(build, frame, raw, allowWarm, seq);
      }
    } else {
      this.synopticSeq++;
    }

    let rainReady = !this.wanted('rain');
    if (this.wanted('rain')) {
      if (!build.templates['precip-rate']) {
        this.rain.clear();
        this.painted.rain = null;
        this.pending.rain = 'unavailable';
        rainReady = true;
      } else {
        rainReady = this.rain.tryPaintCached(build, frame, raw, {
          styles: this.styles,
          opacity: this.opacity,
          visible: true
        });
        if (rainReady) {
          this.painted.rain = this.selection();
          this.pending.rain = null;
        } else {
          this.awaitChannel('rain');
          void this.refreshRain(build, frame, raw, allowWarm);
        }
      }
    }

    this.syncShown();
    this.emitStatus();
    if (allowWarm && synopticReady && rainReady) {
      this.scheduleHorizonWarm();
    }
  }

  private recomputeStyles(): void {
    this.styles = resolveChannelStyles(this.theme);
    const raw = rawMapViewBounds(this.map);
    const current = this.build && this.frame
      ? (this.sampler.findCached(this.build, this.frame, raw, { needClouds: this.wanted('clouds'), needMslp: this.wanted('isobars') }) ?? this.sampler.current)
      : null;
    if (current && this.build && current.buildId === this.build.manifest.buildId && current.frame === this.frame) {
      this.paintSynopticField(current);
    } else {
      this.syncShown();
    }
    this.rain.repaintCurrent(this.styles, this.opacity, this.shown('rain'));
  }

  private async refreshSynoptic(
    build: PinnedBuild,
    frame: string,
    raw: ReturnType<typeof rawMapViewBounds>,
    allowWarm: boolean,
    seq = ++this.synopticSeq
  ): Promise<void> {
    if (this.peeking || (!this.cloudsVisible && !this.isobarsVisible)) return;
    const selected = `${build.manifest.buildId}:${frame}`;
    const field = await this.sampler.load(build, frame, raw, {
      needClouds: this.cloudsVisible,
      needMslp: this.isobarsVisible
    });
    if (seq !== this.synopticSeq || this.disposed || this.build !== build || this.frame !== frame) return;
    // Evicted by a newer prefetch: the selection still needs this hour, so ask again.
    if (field === undefined) { void this.refreshSynoptic(build, frame, rawMapViewBounds(this.map), allowWarm); return; }
    if (field) this.paintSynopticField(field);
    this.settleChannel('clouds', selected);
    this.settleChannel('isobars', selected);
    this.syncShown();
    this.emitStatus();
    if (field && allowWarm) this.scheduleHorizonWarm();
  }

  private async refreshRain(build: PinnedBuild, frame: string, raw: ReturnType<typeof rawMapViewBounds>, allowWarm: boolean): Promise<void> {
    if (this.peeking || !this.rainVisible) return;
    const selected = `${build.manifest.buildId}:${frame}`, seq = ++this.rainSeq;
    const readLive = (): LiveRainRenderState | null => {
      if (this.disposed || this.build !== build || this.frame !== frame) return null;
      return {
        styles: this.styles,
        opacity: this.opacity,
        visible: this.wanted('rain')
      };
    };
    const painted = await this.rain.refresh(build, frame, raw, {
      styles: this.styles,
      opacity: this.opacity,
      visible: this.wanted('rain')
    }, readLive);
    if (seq !== this.rainSeq || this.disposed || this.build !== build || this.frame !== frame) return;
    if (painted) { this.painted.rain = selected; this.pending.rain = null; }
    else this.settleChannel('rain', selected);
    this.syncShown();
    this.emitStatus();
    if (painted && allowWarm) this.scheduleHorizonWarm();
  }
}
