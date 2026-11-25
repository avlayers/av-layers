import { afterEach, describe, expect, it, vi } from 'vitest';
import { disposePointWindgram, renderPointWindgram } from './point-windgram.ts';
import { buildStitchedWindgramView, buildWindgramView, createPointForecast, readWindgram } from './model.ts';
import { sceneData } from './scene-store.ts';
import { localDateKey } from './internal-meteo.ts';
import { renderWindgramKey } from './svg.ts';
import { buildWindgramTelemetry } from './windgram-readout.ts';
import { analyzeHourCloudLayers } from './windgram-clouds.ts';
import { getWindgramCalloutRenderer } from './windgram-callout.ts';
import { hourSampling } from './windgram-sampling.ts';
import { FakeElement, fixture, point, visit } from './windgram-test-fixture.ts';

afterEach(() => vi.unstubAllGlobals());

describe('Point windgram panel', () => {
  it('reuses the mounted day chart across later-day progress pages and updates on resize or mode change', () => {
    const head = new FakeElement('head');
    const otherHead = new FakeElement('head');
    vi.stubGlobal('document', { head: otherHead, createElement: (tag: string) => new FakeElement(tag) });
    let resizeCallback: (() => void) | null = null;
    const disconnected = vi.fn();
    let maxHeight = '50%';
    const owner = {
      head,
      getElementById: (id: string) => head.children.find(child => child.id === id) ?? null,
      createElement: (tag: string) => new FakeElement(tag, owner as unknown as Document),
      defaultView: Object.assign(new EventTarget(), {
        getComputedStyle: () => ({ maxHeight }),
        ResizeObserver: class {
          constructor(callback: () => void) { resizeCallback = callback; }
          observe(): void {}
          disconnect(): void { disconnected(); }
        }
      })
    };
    const { build, sample, profile } = fixture([14, 15, 29, 38, 39]);
    const frames = profile.frames.map((frame, i) => ({ ...frame, layers: { ...frame.layers, ...sample.frames[i].layers } }));
    const root = owner.createElement('div');
    const container = root as unknown as HTMLElement;
    const onFrame = vi.fn();

    renderPointWindgram(container, { frames: frames.slice(0, 2) }, build, {
      point, frameId: 'f014', unitSystem: 'metric', viewMode: '1d', totalFrames: 5, loading: true, onFrame
    });
    const host = visit(root).find(el => el.className === 'av-windgram-host')!;
    expect(host.ownerDocument).toBe(owner);
    expect(head.children).toHaveLength(2);
    expect(otherHead.children).toHaveLength(0);
    // A percentage can remain unresolved in computed style. The chart keeps its natural height.
    expect(Number(/viewBox="0 0 420 (\d+)"/.exec(host.innerHTML)?.[1])).toBeGreaterThan(286);
    maxHeight = '286px';
    resizeCallback!();
    expect(host.innerHTML).toContain('viewBox="0 0 420 286"');
    const htmlSpy = vi.fn();
    let currentHtml = host.innerHTML;
    Object.defineProperty(host, 'innerHTML', {
      get: () => currentHtml,
      set: (next: string) => { htmlSpy(); currentHtml = next; }
    });

    // Appending later-day frames keeps Day 1's mounted SVG untouched.
    const update = renderPointWindgram(container, { frames }, build, {
      point, frameId: 'f014', unitSystem: 'metric', viewMode: '1d', totalFrames: 5, loading: false, onFrame
    });
    expect(htmlSpy).not.toHaveBeenCalled();

    // Magnetic TOL + free-height inspection mounts directly with zero mode-toggle checkbox,
    // a 1-line telemetry strip, and a visual chart key popover.
    expect(visit(root).some(el => el.tag === 'input' && el.type === 'checkbox')).toBe(false);
    expect(host.getAttribute('aria-label')).toContain('magnetic snap on Top of Lift');
    const bar = visit(root).find(el => el.className === 'av-windgram-bar')!;
    expect(bar).toBeDefined();
    expect(visit(bar).map(el => el.textContent).join(' ')).toContain('Key');
    const keyCard = visit(bar).find(el => el.className === 'av-windgram-key')!;
    expect(keyCard.innerHTML).toContain('Strong Thermal');
    expect(keyCard.innerHTML).toContain('Inversion');

    // Selecting an hour with no usable lift keeps 'MSL no usable lift · AGL no usable lift' hidden below the chart.
    frames[1].layers['usable-lift-msl'] = { ...frames[1].layers['usable-lift-msl']!, value: null, status: 'no-usable-lift' };
    frames[1].layers['usable-lift-agl'] = { ...frames[1].layers['usable-lift-agl']!, value: 0, status: 'no-usable-lift' };
    renderPointWindgram(container, { frames }, build, {
      point, frameId: 'f015', unitSystem: 'metric', viewMode: '1d', totalFrames: 5, loading: false, onFrame
    });
    const liftSummaryEl = visit(root).find(el => el.className === 'av-windgram-lift-summary')!;
    expect(liftSummaryEl.hidden).toBe(true);
    expect(visit(bar).map(el => el.textContent).join(' ')).not.toContain('no usable lift');
    update('f014');

    // Resizing the host recomputes the chart width.
    host.clientWidth = 640;
    resizeCallback!();
    expect(htmlSpy).toHaveBeenCalledOnce();
    expect(host.innerHTML).toContain('viewBox="0 0 640');

    const press = (key: string) => host.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key }));
    let frameId = 'f014';
    for (let count = 0; count < 6 && frameId !== 'f038'; count++) {
      onFrame.mockClear();
      press('ArrowRight');
      frameId = String(onFrame.mock.calls.at(-1)?.[0] ?? frameId);
      update(frameId);
    }
    expect(frameId).toBe('f038');

    disposePointWindgram(container);
    expect(disconnected).toHaveBeenCalledOnce();
  });

  it('aligns Windgram Key swatches, ranges, 15 kt white lapse barb, 50 kt pennant, scientific wording, and trigger glyph', () => {
    const hybridMetric = renderWindgramKey('metric', true, 'hybrid-climb');
    const hybridImperial = renderWindgramKey('imperial', false, 'hybrid-climb');
    const lapseMetric = renderWindgramKey('metric', false, 'lapse');

    // Hybrid: 6 quantitative climb swatches with 6 visible/accessible ranges, 1.2 m/s / 236 ft/min sink stated, sky/inversion separated
    expect(hybridMetric.match(/class="wg-key-band"/g)).toHaveLength(6);
    expect(hybridMetric).toContain('includes 1.2 m/s sink');
    expect(hybridImperial).toContain('includes 236 ft/min sink');
    expect(hybridMetric).toContain('wg-key-backdrops');
    expect(hybridMetric).toContain('Neutral sky');
    expect(hybridMetric).toContain('Inversion lid');

    // Lapse: 8 quantitative swatches with 8 visible/accessible ranges, 15 kt barb colored white (#ffffff), 50 kt filled pennant drawn
    expect(lapseMetric.match(/class="wg-key-band"/g)).toHaveLength(8);
    const barb15Match = lapseMetric.match(/data-key-barb="15"[^>]*>([\s\S]*?)<\/g>/);
    expect(barb15Match?.[1]).toContain('stroke="#ffffff"');
    expect(barb15Match?.[1]).not.toContain('#78ff78');
    const barb50Match = lapseMetric.match(/data-key-barb="50"[^>]*>([\s\S]*?)<\/g>/);
    expect(barb50Match?.[1]).toContain('Z" fill="#ffffff"');
    expect(lapseMetric).toContain('data-key-hover-dial');
    expect(lapseMetric).toContain('Barb points to wind source; hover arrow points downwind');

    // Scientific wording: modeled ascent aloft, inferred moisture ranges, separate lift line samples, missing hours or heights, secondary disclosure
    expect(hybridMetric).toContain('Modeled ascent aloft');
    expect(hybridMetric).not.toContain('stable wave');
    expect(hybridMetric).toContain('Inferred moisture');
    expect(hybridMetric).toContain('83–&lt;89%, 89–&lt;94%, ≥94%');
    expect(hybridMetric).not.toMatch(/SCT\/BKN/i);
    expect(hybridMetric).toContain('Native lift estimate');
    expect(hybridMetric).toContain('Unavailable hours or heights');
    expect(hybridMetric).toContain('<details class="wg-key-more">');
  });

  it('adopts shared Constructable Stylesheets without DOM <style> nodes when supported, emits zero inline style attributes in keys/barbs, and keeps CSS band colors in sync', async () => {
    const { adoptDocumentStyleSheet } = await import('./style-registry.ts');
    const chartCss = (await import('./styles/windgram-chart.css?inline')).default;
    const panelCss = (await import('./styles/windgram-panel.css?inline')).default;
    const { WINDGRAM_CLIMB_BANDS } = await import('./windgram-climb.ts');
    const { WINDGRAM_STABILITY } = await import('./windgram-stability.ts');

    // 1) Shared CSSStyleSheet adoption across multiple documents in the same realm
    let constructed = 0;
    class MockCSSStyleSheet {
      text = '';
      constructor() { constructed++; }
      replaceSync(css: string) { this.text = css; }
    }
    const win = { CSSStyleSheet: MockCSSStyleSheet };
    const docA = { defaultView: win, adoptedStyleSheets: [] as MockCSSStyleSheet[], head: new FakeElement('head') };
    const docB = { defaultView: win, adoptedStyleSheets: [] as MockCSSStyleSheet[], head: new FakeElement('head') };
    adoptDocumentStyleSheet(docA as unknown as Document, 'test-sheet', '.x{color:red}');
    adoptDocumentStyleSheet(docA as unknown as Document, 'test-sheet', '.x{color:red}');
    adoptDocumentStyleSheet(docB as unknown as Document, 'test-sheet', '.x{color:red}');
    expect(constructed).toBe(1);
    expect(docA.adoptedStyleSheets).toHaveLength(1);
    expect(docB.adoptedStyleSheets[0]).toBe(docA.adoptedStyleSheets[0]);
    expect(docA.head.children).toHaveLength(0);

    // 2) Zero inline style="..." attributes in rendered keys across modes, and no host #app selector leak in windgram-panel.css
    expect(renderWindgramKey('metric', true, 'hybrid-climb')).not.toContain('style=');
    expect(renderWindgramKey('imperial', false, 'lapse')).not.toContain('style=');
    expect(panelCss).not.toContain('#app');

    // 3) 1:1 color sync between TS band definitions and CSS stylesheets
    for (const band of WINDGRAM_CLIMB_BANDS) {
      expect(chartCss).toContain(`.${band.className} { fill: ${band.color.toLowerCase()}; }`);
      expect(panelCss).toContain(`.wg-key-seg.${band.className} { background: ${band.color.toLowerCase()}; }`);
    }
    for (const stab of WINDGRAM_STABILITY) {
      expect(chartCss).toContain(`.meteo-gram-stab-${stab.className} { fill: ${stab.color.toLowerCase()}; }`);
      expect(panelCss).toContain(`.wg-key-seg.meteo-gram-stab-${stab.className} { background: ${stab.color.toLowerCase()}; }`);
    }
  });

  it('keeps nighttime selection authoritative without daytime hour substitution, prevents wraparound on horizon stepping, clips stitched panel symbols, and enforces exact scientific callout/shear/key rules', () => {
    // 1) F01 & F04: Nighttime selection on a daylight-cropped chart never substitutes a daytime hour or wraps around on ArrowRight/ArrowLeft
    const head = new FakeElement('head');
    const owner = {
      head,
      getElementById: (id: string) => head.children.find(child => child.id === id) ?? null,
      createElement: (tag: string) => new FakeElement(tag, owner as unknown as Document),
      defaultView: new EventTarget(),
    };
    const { build, sample, profile } = fixture([1, 6, 9, 12, 18], 5);
    const frames = profile.frames.map((frame, i) => ({ ...frame, layers: { ...frame.layers, ...sample.frames[i]!.layers } }));
    const armPoint = { lat: 40.18, lon: 44.51 }; // Asia/Yerevan (UTC+4): f001=05:00 (pre-sunrise), f006=10:00, f009=13:00, f012=16:00, f018=22:00 (post-sunset)
    // Make f012 (16:00 local) wet/convective and f018 (22:00 local) dry/calm so any hour substitution is immediately detectable
    frames[3]!.layers['precipitation-mm-hr'] = { ...frames[3]!.layers['sfc-temp-c']!, value: 0.3 };
    frames[3]!.layers['cape-jkg'] = { ...frames[3]!.layers['sfc-temp-c']!, value: 43 };
    frames[4]!.layers['precipitation-mm-hr'] = { ...frames[4]!.layers['sfc-temp-c']!, value: 0 };
    frames[4]!.layers['cape-jkg'] = { ...frames[4]!.layers['sfc-temp-c']!, value: 0 };
    frames[4]!.layers['usable-lift-msl']!.value = 1500;
    frames[4]!.layers['usable-lift-agl']!.value = 0;
    frames[4]!.layers['thermal-velocity']!.value = 0;

    const steppedFrames: string[] = [];
    const container = owner.createElement('div') as unknown as HTMLElement;
    const handle = renderPointWindgram(container, { frames }, build, {
      point: armPoint,
      frameId: 'f018',
      mapFrameId: 'f018',
      unitSystem: 'metric',
      viewMode: '1d',
      onFrame: id => steppedFrames.push(id),
    });
    const nodes = visit(container as unknown as FakeElement);
    const timeLine = nodes.find(el => el.className === 'av-point-time')!;
    const srReadout = nodes.find(el => el.className === 'windgram-readout')!;
    const host = nodes.find(el => el.className === 'av-windgram-host')!;

    // Clock line is visible at nighttime even when pointFrame.id === mapFrameId, and readout announces 22:00 (18:00 UTC) with CAPE 0 J/kg instead of 16:00 (CAPE 43 J/kg)
    expect(timeLine.hidden).toBe(false);
    expect(timeLine.textContent).toContain('22:00');
    expect(srReadout.textContent).toContain('22:00 (18:00 UTC)');
    expect(srReadout.textContent).not.toContain('16:00');
    expect(srReadout.textContent).toContain('CAPE 0 J/kg');
    expect(srReadout.textContent).not.toContain('CAPE 43 J/kg');

    const press = (key: string) => host.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key }));
    // F04: ArrowRight at the end of the horizon (f018) is a no-op (never jumps backward to f001/f006!)
    press('ArrowRight');
    expect(steppedFrames).toEqual([]);
    // ArrowLeft from f018 steps cleanly to the preceding daylight hour (f012)
    press('ArrowLeft');
    expect(steppedFrames).toEqual(['f012']);

    // Pre-sunrise boundary (f001 = 05:00 local): ArrowLeft is a no-op, ArrowRight advances to first daylight hour (f006)
    steppedFrames.length = 0;
    handle('f001', 'metric', 'f001');
    expect(timeLine.hidden).toBe(false);
    expect(srReadout.textContent).toContain('05:00 (01:00 UTC)');
    press('ArrowLeft');
    expect(steppedFrames).toEqual([]);
    press('ArrowRight');
    expect(steppedFrames).toEqual(['f006']);
    disposePointWindgram(container);

    // 2) F02: Peak climb fallback in tile-2x2 never labels a column peak as "▲ Cu base"
    const climbVal = new FakeElement('text');
    const climbSub = new FakeElement('text');
    const skyCodeEl = new FakeElement('text');
    const cloudText = new FakeElement('text');
    const hazardEl = new FakeElement('text');
    const rainBg = new FakeElement('rect');
    const tileMap = new Map<string, FakeElement>([
      ['[data-tile-climb-val]', climbVal],
      ['[data-tile-climb-sub]', climbSub],
      ['[data-tile-sky-code]', skyCodeEl],
      ['[data-tile-cloud-text]', cloudText],
      ['[data-tile-hazard]', hazardEl],
      ['[data-tile-rain-bg]', rainBg],
    ]);
    const bound = getWindgramCalloutRenderer('tile-2x2').bind({
      querySelector: (sel: string) => tileMap.get(sel) ?? null,
    } as unknown as ParentNode);
    const site = createPointForecast(build, armPoint)(build.manifest.frames, new Map(frames.map(f => [f.id, f])));
    const view = buildWindgramView(site, { unitSystem: 'metric', compact: false, heightRange: 'soaring', timeZone: site.site.timeZone, hours: site.hours });
    const baseR = readWindgram(view, 1, 2000);
    const dummyLift = site.hours[1]!.mapLift;

    const belowGateReading = {
      ...baseR,
      cloudCapped: true,
      nativeThermalTopM: 2600,
      heightM: 2000,
      estimatedClimbMps: 0.07999,
      peakClimbMps: 1.7,
    };
    const belowGateTel = buildWindgramTelemetry(sceneData(view), belowGateReading, dummyLift, true, true);
    expect(belowGateTel.calloutSoar).toContain('Peak +1.7 m/s');
    bound.paint({ aglText: '500 m AGL', mslText: '2,000 m MSL', useTol: true, telemetry: belowGateTel, reading: belowGateReading, unitSystem: 'metric' });
    expect(climbVal.textContent).toBe('+1.7 m/s');
    expect(climbSub.textContent).toBe('▲ Peak lift');

    const aboveGateReading = { ...belowGateReading, estimatedClimbMps: 0.08 };
    const aboveGateTel = buildWindgramTelemetry(sceneData(view), aboveGateReading, dummyLift, true, true);
    expect(aboveGateTel.calloutSoar).toContain('Climb +0.1 m/s');
    bound.paint({ aglText: '500 m AGL', mslText: '2,000 m MSL', useTol: true, telemetry: aboveGateTel, reading: aboveGateReading, unitSystem: 'metric' });
    expect(climbVal.textContent).toBe('+0.1 m/s');
    expect(climbSub.textContent).toBe('▲ Cu base');

    // 3) F03: Stitched multi-day panels never spill discrete barbs, freezing marks, or cloud glyphs outside their own panel bounds
    const multiDayHours = [6, 9, 12, 15, 18, 30, 33, 36, 39, 42];
    const multiFix = fixture(multiDayHours, multiDayHours.length);
    const multiFrames = multiFix.profile.frames.map((frame, i) => ({
      ...frame,
      layers: { ...frame.layers, ...multiFix.sample.frames[i]!.layers },
    }));
    for (const f of multiFrames) {
      f.layers['surface-lcl-msl'] = { ...f.layers['sfc-temp-c']!, value: 2100 };
      f.profile.levels = [
        { pressureHpa: 880, heightM: 1700, temperatureC: 6, dewPointC: 5.8, uWindMps: 6, vWindMps: 3, omegaPaS: 0 },
        { pressureHpa: 800, heightM: 2300, temperatureC: -2, dewPointC: -2.2, uWindMps: 8, vWindMps: 4, omegaPaS: 0 },
      ];
    }
    const multiSite = createPointForecast(multiFix.build, armPoint)(
      multiFix.build.manifest.frames,
      new Map(multiFrames.map(f => [f.id, f])),
    );
    const dayKeys = [...new Set(multiSite.hours.map(h => localDateKey(h.validAt, multiSite.site.timeZone)))];
    const stitched = sceneData(
      buildStitchedWindgramView(multiSite, {
        unitSystem: 'metric',
        timeZone: multiSite.site.timeZone,
        dateKeys: dayKeys,
      }),
    );
    const panelForHour = (hourIdx: number) =>
      stitched.dayPanels!.find(p => hourIdx >= p.startHourIndex && hourIdx <= p.endHourIndex)!;
    for (const barb of stitched.barbs) {
      const p = panelForHour(barb.hourIndex);
      expect(barb.x).toBeGreaterThanOrEqual(p.left);
      expect(barb.x).toBeLessThanOrEqual(p.left + p.width);
    }
    for (const frz of stitched.freezing) {
      const p = panelForHour(frz.hourIndex);
      expect(frz.x).toBeGreaterThanOrEqual(p.left);
      expect(frz.x).toBeLessThanOrEqual(p.left + p.width);
    }
    for (const cld of stitched.clouds) {
      const p = panelForHour(cld.hourIndex);
      expect(cld.x).toBeGreaterThanOrEqual(p.left);
      expect(cld.x).toBeLessThanOrEqual(p.left + p.width);
    }

    // 4) F05A, F05B, F06, F07: Cloud fraction vs RH moist layer, missing humidity with 80% sky cover, dry top at LCL, and full-precision icing + precip
    // F05A: Supplied 0.5% cloud cover + 95% RH moist layer preserves SKY 1% and reports Moist RH instead of OVC 90% or Clear
    const f05aHour = {
      ...site.hours[1]!,
      surface: {
        ...site.hours[1]!.surface,
        cloudCoverTotalPercent: 0.5,
        cloudCoverLowPercent: 0.5,
      },
      levels: [
        { pressureHpa: 880, heightM: 1700, temperatureC: 10, dewPointC: 9.3, uWindMps: 3, vWindMps: 2, omegaPaS: 0 },
        { pressureHpa: 850, heightM: 2000, temperatureC: 8, dewPointC: 7.3, uWindMps: 4, vWindMps: 2, omegaPaS: 0 },
      ],
    };
    const f05aAnalysis = analyzeHourCloudLayers(f05aHour, hourSampling(f05aHour), 4000);
    bound.paint({
      aglText: '100 m AGL',
      mslText: '1,600 m MSL',
      useTol: false,
      telemetry: belowGateTel,
      reading: {
        ...baseR,
        heightM: 1600,
        cloudCoverTotalPercent: 0.5,
        cloudCoverLowPercent: 0.5,
        relativeHumidityPercent: 70,
        cloudHumidityPercent: 70,
        cloud: null,
        cloudLayers: f05aAnalysis.layers,
        activeCloudLayer: null,
        nearestCloudBaseAboveM: 1700,
      },
      unitSystem: 'metric',
    });
    expect(skyCodeEl.textContent).toBe('SKY 1%');
    expect(cloudText.textContent).toBe('Moist RH · Base +100 m');

    // F05B: 80% total cloud cover with all humidity/dewpoint absent renders SKY 80% + Local RH — · Sky 80% (never HI 80% / Clear · High cirrus)
    const f05bHour = {
      ...site.hours[1]!,
      surface: {
        ...site.hours[1]!.surface,
        cloudCoverTotalPercent: 80,
        cloudCoverLowPercent: null,
      },
      levels: site.hours[1]!.levels.map(l => ({ ...l, dewPointC: null })),
    };
    const f05bAnalysis = analyzeHourCloudLayers(f05bHour, hourSampling(f05bHour), 4000);
    expect(f05bAnalysis.highCloudOnly).toBe(false);
    bound.paint({
      aglText: '500 m AGL',
      mslText: '2,000 m MSL',
      useTol: false,
      telemetry: belowGateTel,
      reading: {
        ...baseR,
        cloudCoverTotalPercent: 80,
        cloudCoverLowPercent: null,
        relativeHumidityPercent: null,
        cloudHumidityPercent: null,
        cloud: null,
        cloudLayers: [],
        activeCloudLayer: null,
        highCloudOnly: f05bAnalysis.highCloudOnly,
      },
      unitSystem: 'metric',
    });
    expect(skyCodeEl.textContent).toBe('SKY 80%');
    expect(cloudText.textContent).toBe('Local RH — · Sky 80%');

    // F06: Dry parcel top exactly at LCL (1,800 m) with cuPotentialM = 0 has depthM = 0 (no artificial 120 m cloud thickness)
    const f06Hour = {
      ...site.hours[1]!,
      surfaceLclM: 1800,
      effectiveCloudLimitM: 1800,
      thermalTopM: 1800,
      cuPotentialM: 0,
      cloudCapped: true,
      overdeveloped: false,
      levels: site.hours[1]!.levels.map(l => ({ ...l, dewPointC: l.temperatureC !== null ? l.temperatureC - 12 : null })),
    };
    const f06Analysis = analyzeHourCloudLayers(f06Hour, hourSampling(f06Hour), 4000);
    expect(f06Analysis.convectiveLayer?.depthM).toBe(0);
    expect(f06Analysis.convectiveLayer?.topM).toBe(1800);

    // F07: Exact 4-row table at -10 °C (14 °F)
    const paintF07 = (rh: number, precipMmHr: number) => {
      bound.paint({
        aglText: '900 m AGL',
        mslText: '2,400 m MSL',
        useTol: false,
        telemetry: belowGateTel,
        reading: {
          ...baseR,
          temperatureF: 14, // -10 °C
          dewPointC: -10.5,
          relativeHumidityPercent: rh,
          cloudHumidityPercent: rh,
          cloud: rh >= 94 ? 'humidity' : null,
          precipitationMmHr: precipMmHr,
          capeJkg: 0,
          windShear: null,
        },
        unitSystem: 'metric',
      });
      return hazardEl.textContent;
    };
    expect(paintF07(93.49, 0)).toBe('Dry');
    expect(paintF07(93.51, 0)).toBe('Dry');
    expect(paintF07(94.0, 0)).toBe('❄ Icing risk');
    expect(paintF07(96.0, 1.0)).toBe('1.0 mm/h · ❄ Icing risk');
    expect(rainBg.getAttribute('class')).toContain('is-danger');

    // 5) F08: Low-level wind jet at 15 m and 20 m model AGL is captured in maxDepartureFromSurfaceMps
    for (const aglM of [15, 20, 21]) {
      const jetFix = fixture([12], 1);
      const jf = {
        ...jetFix.profile.frames[0]!,
        layers: { ...jetFix.profile.frames[0]!.layers, ...jetFix.sample.frames[0]!.layers },
      };
      jf.profile.modelTerrainM = 100;
      jf.layers['usable-lift-msl']!.value = 1000;
      jf.layers['thermal-top-msl']!.value = 1000;
      jf.layers['thermal-velocity']!.value = 2.0;
      jf.layers['wind-10m-u'] = { ...jf.layers['sfc-temp-c']!, value: 2 };
      jf.layers['wind-10m-v'] = { ...jf.layers['sfc-temp-c']!, value: 0 };
      jf.profile.levels = [
        { pressureHpa: 990, heightM: 100 + aglM, temperatureC: 15, dewPointC: 5, uWindMps: 25, vWindMps: 0, omegaPaS: 0 },
        { pressureHpa: 900, heightM: 1000, temperatureC: 6, dewPointC: 0, uWindMps: 2, vWindMps: 0, omegaPaS: 0 },
      ];
      const jetSite = createPointForecast(jetFix.build, armPoint)(
        jetFix.build.manifest.frames,
        new Map([[jf.id, jf]]),
      );
      const jetScene = buildWindgramView(jetSite, {
        unitSystem: 'metric',
        compact: false,
        heightRange: 'soaring',
        timeZone: jetSite.site.timeZone,
        hours: jetSite.hours,
      });
      expect(readWindgram(jetScene, 0, 500).publishedLayerWind?.maxDepartureFromSurfaceMps).toBeCloseTo(23, 5);
    }

    // 6) F16 & F17: Southern Hemisphere key barb mirroring and "Weak inv" lapse label
    const northKey = renderWindgramKey('metric', false, 'hybrid-climb', false);
    const southKey = renderWindgramKey('metric', false, 'hybrid-climb', true);
    expect(southKey).not.toBe(northKey);
    const lapseKey = renderWindgramKey('metric', false, 'lapse', false);
    expect(lapseKey).toContain('Weak inv');
    expect(lapseKey).not.toContain('Very stbl');
  });
});
