import { describe, expect, it, vi } from 'vitest';
import { fixturePointSample, fixtureProfileBuild, fixtureProfileResponse } from '../../../tests/client-point-fixture.ts';
import { mountWindgram } from './dom.ts';
import { disposePointWindgram, renderPointWindgram } from './point-windgram.ts';
import { buildStitchedWindgramView, buildWindgramView, createPointForecast, readWindgram } from './model.ts';
import { findBestSoaringDayKey, formatDayWindowLabel, resolveStitchedDayWindow } from './point-view-mode.ts';
import { sceneData } from './scene-store.ts';
import { renderWindgramSvg } from './svg.ts';
import { getWindgramCalloutRenderer } from './windgram-callout.ts';
import { FakeElement, fixture, point, visit } from './windgram-test-fixture.ts';

describe('Stitched windgram', () => {
  it('stitches 3 daylight panels with zero plotHeight/plotWidth shrinkage, midnight isolation, interact-only hover, and chip-free bar controls', () => {
    // 3 days of daylight hours in Etc/GMT+5 (14..21 UTC = 09:00..16:00 local)
    const day1 = [14, 16, 18, 20];
    const day2 = [38, 40, 42, 44];
    const day3 = [62, 64, 66, 68];
    const day4 = [86, 88, 90];
    const { build, sample, profile, forecast } = fixture([...day1, ...day2, ...day3, ...day4], 15);
    const frames = profile.frames.map((frame, i) => ({ ...frame, layers: { ...frame.layers, ...sample.frames[i]!.layers } }));
    // Make Day 2 the clear best soaring day, and Day 3 strong but blown out by 45 km/h (12.5 m/s) gale surface winds.
    for (const i of [4, 5, 6, 7]) {
      frames[i]!.layers['usable-lift-msl']!.value = 2650;
      frames[i]!.layers['usable-lift-agl']!.value = 1150;
      frames[i]!.layers['thermal-velocity']!.value = 2.8;
    }
    for (const i of [8, 9, 10, 11]) {
      frames[i]!.layers['usable-lift-msl']!.value = 2750;
      frames[i]!.layers['usable-lift-agl']!.value = 1250;
      frames[i]!.layers['thermal-velocity']!.value = 2.9;
    }
    const site = forecast(frames);
    const allDays = [...new Set(site.hours.map(h => h.validAt.slice(0, 10)))];
    expect(allDays.length).toBeGreaterThanOrEqual(3);
    const win3 = resolveStitchedDayWindow(allDays, { focusDayKey: allDays[0] });
    expect(win3.windowDays).toHaveLength(3);
    expect(formatDayWindowLabel(win3.windowDays)).toContain('–');

    const hoursByDay = new Map(allDays.map(d => [d, site.hours.filter(h => h.validAt.startsWith(d)).map(h => ({ validAt: h.validAt }))]));
    const fhMap = new Map(site.hours.map(h => [h.validAt, {
      usableLiftTopM: h.mapLift.mslM,
      terrainM: h.mapLift.terrainM,
      thermalVelocityMps: h.thermalVelocityMps,
      surfaceWindMps: h.validAt.startsWith(allDays[2]!) ? 12.5 : h.surface.windSpeedMps,
    }]));
    expect(findBestSoaringDayKey(allDays.slice(0, 3), hoursByDay, fhMap)).toBe(allDays[1]);

    const oneDay = buildWindgramView(site, {
      unitSystem: 'metric', compact: true, heightRange: 'soaring', timeZone: site.site.timeZone,
      widthPx: 620, heightPx: 320, hours: { timeZone: site.site.timeZone, dateKey: allDays[0]! },
    });
    const threeDay = buildStitchedWindgramView(site, {
      unitSystem: 'metric', compact: true, heightRange: 'soaring', timeZone: site.site.timeZone,
      widthPx: 620, heightPx: 320, dateKeys: win3.windowDays, selectedDateKey: allDays[0], bestDateKey: allDays[1],
    });
    const threeDayInternal = sceneData(threeDay);
    // Zero shrinkage guarantee: 3-Day stitched view preserves identical plotHeight, plotWidth, top, and bottom.
    expect(threeDay.plotHeight).toBe(oneDay.plotHeight);
    expect(threeDay.plotWidth).toBe(oneDay.plotWidth);
    expect(threeDay.top).toBe(oneDay.top);
    expect(threeDay.bottom).toBe(oneDay.bottom);
    expect(threeDayInternal.dayPanels).toHaveLength(3);

    const stitchedSvg = renderWindgramSvg(threeDay);
    expect(stitchedSvg).toContain('windgram-stitched');
    expect(stitchedSvg.match(/data-night-seam/g)).toHaveLength(2);
    expect(stitchedSvg.match(/data-windgram-day=/g)).toHaveLength(3);
    // Each stitched day panel places its own isotherm temperature callout pills independently.
    const labelRects = [...stitchedSvg.matchAll(/class="wg-temperature-label"[^>]*><rect x="([^"]+)"/g)].map(m => Number(m[1]));
    for (const panel of threeDayInternal.dayPanels!) {
      expect(labelRects.some(x => x >= panel.left && x <= panel.left + panel.width)).toBe(true);
    }
    // Usable lift path has 3 separate per-day M subpaths.
    const liftPath = threeDayInternal.series.find(s => s.key === 'usableLiftTopM')?.path ?? '';
    expect(liftPath.match(/M/g)).toHaveLength(3);

    // Verify 3-Day default mode, initial today/first-day window anchoring even when Day 4 is selected on timeline,
    // chip-free bar, 0% resting clobber ('interact' trigger), 3d <-> 1d toggle, and stable SVG across cross-day selection.
    const head = new FakeElement('head');
    const owner = {
      head,
      getElementById: (id: string) => head.children.find(child => child.id === id) ?? null,
      createElement: (tag: string) => new FakeElement(tag, owner as unknown as Document),
      defaultView: Object.assign(new EventTarget(), {
        getComputedStyle: () => ({ maxHeight: '300px' }),
      }),
    };
    const root = owner.createElement('div');
    const onFrame = vi.fn();
    const onViewModeChange = vi.fn();
    const onVisibleDaysChange = vi.fn();
    // Omit viewMode -> defaults to '3d'; pass Day 4 frame (frames[12]) -> still opens starting on first day (win3.windowDays)!
    const update = renderPointWindgram(root as unknown as HTMLElement, { frames }, build, {
      point, frameId: frames[12]!.id, unitSystem: 'metric',
      onFrame, onViewModeChange, onVisibleDaysChange,
    });
    const bar = visit(root).find(el => el.className === 'av-windgram-bar')!;
    expect(bar.children).toHaveLength(2);
    const barText = visit(bar).map(el => el.textContent).join(' ');
    expect(barText).toContain('1-Day');
    expect(barText).toContain('3-Day');
    expect(barText).not.toContain('Sfc ');
    expect(barText).not.toContain('Cloud ');
    const host = visit(root).find(el => el.className === 'av-windgram-host')!;
    // Defaults to stitched 3-day view anchored to first/today window despite Day 4 timeline selection.
    expect(host.innerHTML).toContain('windgram-stitched');
    expect(onVisibleDaysChange).toHaveBeenLastCalledWith(win3.windowDays);
    // At rest in 'interact' mode, cursor group starts hidden (0% chart covered).
    expect(host.innerHTML).toContain('data-windgram-cursor="" visibility="hidden"');

    // Toggle to '1-Day' and back to '3-Day'.
    const btn1d = visit(bar).find(el => el.getAttribute('data-point-view') === '1d')!;
    const btn3d = visit(bar).find(el => el.getAttribute('data-point-view') === '3d')!;
    btn1d.dispatchEvent(new Event('click'));
    expect(onViewModeChange).toHaveBeenCalledExactlyOnceWith('1d');
    expect(host.innerHTML).not.toContain('windgram-stitched');
    btn3d.dispatchEvent(new Event('click'));
    expect(onViewModeChange).toHaveBeenLastCalledWith('3d');
    expect(host.innerHTML).toContain('windgram-stitched');

    // Jump back to Day 1 so win3 is active, then verify selecting Day 2 inside the same 3-day window does NOT rebuild host.innerHTML.
    update(frames[0]!.id);
    expect(onVisibleDaysChange).toHaveBeenLastCalledWith(win3.windowDays);
    const htmlSpy = vi.fn();
    let currentSvg = host.innerHTML;
    Object.defineProperty(host, 'innerHTML', {
      get: () => currentSvg,
      set: (next: string) => { htmlSpy(); currentSvg = next; },
    });
    update(frames[5]!.id);
    expect(htmlSpy).not.toHaveBeenCalled();

    disposePointWindgram(root as unknown as HTMLElement);
    expect(onVisibleDaysChange).toHaveBeenLastCalledWith(null);
  });

  it('preserves missing-height gaps in modeled ascent contours, truthful precip/cloud labels, DST accessible clock, RRFS isolated omega wording, and stitched run-switch ticks', () => {
    // 1) Missing native level height breaks modeled ascent contour across 2,500 m
    const { build, sample, profile } = fixture([18], 1);
    const gapFrame = profile.frames[0]!;
    gapFrame.profile.modelTerrainM = 400;
    gapFrame.layers['thermal-velocity']!.value = 0;
    gapFrame.profile.levels = [
      { pressureHpa: 880, heightM: 1000, temperatureC: 8, dewPointC: -5, uWindMps: 14, vWindMps: 0, omegaPaS: -18 },
      { pressureHpa: 750, heightM: null, temperatureC: 2, dewPointC: -8, uWindMps: 15, vWindMps: 0, omegaPaS: -18 },
      { pressureHpa: 620, heightM: 4000, temperatureC: -8, dewPointC: -18, uWindMps: 18, vWindMps: 0, omegaPaS: -18 },
    ];
    const gapSite = createPointForecast(build, point)(build.manifest.frames, new Map([[gapFrame.id, gapFrame]]));
    const gapView = buildWindgramView(gapSite, { unitSystem: 'metric', compact: false, heightRange: 'full', timeZone: gapSite.site.timeZone, hours: gapSite.hours });
    expect(readWindgram(gapView, 0, 2500).waveVelocityMps).toBeNull();
    const y2500 = gapView.bottom - ((2500 - gapView.floorM) / (gapView.topM - gapView.floorM)) * gapView.plotHeight;
    const wavePaths = sceneData(gapView).fields.filter(f => f.className.startsWith('wg-wave-')).map(f => f.path);
    for (const d of wavePaths) {
      for (const ring of d.split('Z').filter(Boolean)) {
        const ys = [...ring.matchAll(/[ML][-\d.]+\s+([-\d.]+)/g)].map(m => Number(m[1]));
        if (ys.length) {
          const minY = Math.min(...ys), maxY = Math.max(...ys);
          expect(y2500 > minY + 1 && y2500 < maxY - 1).toBe(false);
        }
      }
    }

    // 2) Callout labels: untyped 1 mm/h + CAPE 1200 + Shear, 100% sky cover with unknown local RH & precip, and dry inversion gated off Warm aloft
    const skyCodeEl = new FakeElement('text');
    const cloudText = new FakeElement('text');
    const hazardEl = new FakeElement('text');
    const bound = getWindgramCalloutRenderer('tile-2x2').bind({
      querySelector: (sel: string) =>
        sel === '[data-tile-sky-code]' ? skyCodeEl : sel === '[data-tile-cloud-text]' ? cloudText : sel === '[data-tile-hazard]' ? hazardEl : null,
    } as unknown as ParentNode);
    const dummyTel = { timeChip: '14:00', altChip: '', snappedToTol: false, canSnapToTol: false, calloutBadge: 'ALT', calloutMeteo: '', calloutSoar: '', hasPositiveClimb: false };

    const baseR = readWindgram(gapView, 0, 1000);
    bound.paint({
      aglText: '600 m AGL', mslText: '1,000 m MSL', useTol: false, telemetry: dummyTel,
      reading: { ...baseR, precipitationMmHr: 1.0, capeJkg: 1200, windShear: { lowerM: 800, upperM: 1200, vectorChangeMps: 4, perKmMps: 10 } },
      unitSystem: 'metric',
    });
    expect(hazardEl.textContent).toBe('1.0 mm/h · CAPE 1200 · Shr');

    bound.paint({
      aglText: '600 m AGL', mslText: '1,000 m MSL', useTol: false, telemetry: dummyTel,
      reading: {
        ...baseR,
        cloud: null,
        cloudLayers: [],
        activeCloudLayer: null,
        relativeHumidityPercent: null,
        cloudHumidityPercent: null,
        cloudCoverTotalPercent: 100,
        precipitationMmHr: null,
        capeJkg: 0,
        windShear: null,
      },
      unitSystem: 'metric',
    });
    expect(skyCodeEl.textContent).toBe('SKY 100%');
    expect(cloudText.textContent).toBe('Local RH — · Sky 100%');
    expect(hazardEl.textContent).toBe('Precip —');

    // Dry post-frontal subsidence inversion (0 mm/h precip, low RH) does NOT trigger warmLayerAloft
    const dryInvFrame = structuredClone(gapFrame);
    dryInvFrame.layers['sfc-temp-c']!.value = 8;
    dryInvFrame.layers['precip-rate'] = { ...dryInvFrame.layers['sfc-temp-c']!, value: 0 };
    dryInvFrame.profile.levels = [
      { pressureHpa: 840, heightM: 1600, temperatureC: -4, dewPointC: -16, uWindMps: 8, vWindMps: 0, omegaPaS: 0 },
      { pressureHpa: 790, heightM: 2100, temperatureC: 1.2, dewPointC: -15, uWindMps: 10, vWindMps: 0, omegaPaS: 0 },
    ];
    const dryInvSite = createPointForecast(build, point)(build.manifest.frames, new Map([[dryInvFrame.id, dryInvFrame]]));
    const dryInvView = buildWindgramView(dryInvSite, { unitSystem: 'metric', compact: false, timeZone: dryInvSite.site.timeZone, hours: dryInvSite.hours });
    expect(readWindgram(dryInvView, 0, 1800).warmLayerAloft).toBe(false);

    // 3) Accessible timestamp at America/New_York DST transition (Nov 1 06Z -> 01:00 EST)
    const dstFrames = [
      { id: 'f001', validTime: '2026-11-01T05:00:00.000Z', intervalStart: '2026-11-01T04:00:00.000Z', intervalEnd: '2026-11-01T05:00:00.000Z' },
      { id: 'f002', validTime: '2026-11-01T06:00:00.000Z', intervalStart: '2026-11-01T05:00:00.000Z', intervalEnd: '2026-11-01T06:00:00.000Z' },
    ];
    const dstBuild = fixtureProfileBuild({ frameHours: [1, 2], mapFrameCount: 2 });
    dstBuild.manifest.frames = dstFrames;
    const dstLoaded = new Map(dstFrames.map(df => [df.id, { ...profile.frames[0]!, ...df, id: df.id, layers: { ...profile.frames[0]!.layers, ...sample.frames[0]!.layers } }]));
    const nySite = createPointForecast(dstBuild, { lat: 40.7128, lon: -74.006 })(dstFrames, dstLoaded);
    const nyView = buildWindgramView(nySite, { unitSystem: 'metric', compact: true, timeZone: nySite.site.timeZone, hours: nySite.hours });
    const srEl = new FakeElement('p');
    srEl.id = 'dst-sr';
    const dstHost = new FakeElement('div');
    const dstChart = mountWindgram(dstHost as unknown as HTMLElement, {
      view: nyView,
      idPrefix: 'dst',
      readout: srEl as unknown as HTMLElement,
      selectedValidAt: '2026-11-01T06:00:00.000Z',
    });
    expect(srEl.textContent).toContain('01:00 EST (06:00 UTC)');
    dstChart.dispose();

    // 4) RRFS f018 missing omega in isolation vs alongside f021 never claims 'not published for this model'
    const rrfsBuild = fixtureProfileBuild({ frameHours: [18, 21], mapFrameCount: 2 });
    rrfsBuild.manifest.model = 'rrfs';
    const rrfsSample = fixturePointSample(rrfsBuild, `https://api.test/point?lat=${point.lat}&lon=${point.lon}&frame=f018,f021&layers=usable-lift-msl,usable-lift-agl`);
    const rrfsProfile = fixtureProfileResponse(rrfsBuild, `https://api.test/point?lat=${point.lat}&lon=${point.lon}&frame=f018,f021&layers=thermal-top-msl,pbl-height-agl,thermal-velocity,sfc-temp-c,wind-gust-10m,cloud-cover-total,cloud-cover-low`);
    rrfsProfile.frames[0]!.profile.levels = rrfsProfile.frames[0]!.profile.levels.map(l => ({ ...l, omegaPaS: null }));
    rrfsProfile.frames[1]!.profile.levels = rrfsProfile.frames[1]!.profile.levels.map(l => ({ ...l, omegaPaS: -1.5 }));
    const rrfsFrames = rrfsProfile.frames.map((f, i) => ({ ...f, layers: { ...f.layers, ...rrfsSample.frames[i]!.layers } }));
    const rrfsSiteIsolated = createPointForecast(rrfsBuild, point)([rrfsBuild.manifest.frames[0]!], new Map([[rrfsFrames[0]!.id, rrfsFrames[0]!]]));
    const rrfsIsolatedView = buildWindgramView(rrfsSiteIsolated, { unitSystem: 'metric', compact: true, timeZone: rrfsSiteIsolated.site.timeZone, hours: rrfsSiteIsolated.hours });
    const isolatedReason = readWindgram(rrfsIsolatedView, 0, 1800).verticalVelocityUnavailableReason;
    expect(isolatedReason).not.toContain('not published for this model');

    const rrfsSiteBoth = createPointForecast(rrfsBuild, point)(rrfsBuild.manifest.frames, new Map(rrfsFrames.map(f => [f.id, f])));
    const rrfsBothView = buildWindgramView(rrfsSiteBoth, { unitSystem: 'metric', compact: true, timeZone: rrfsSiteBoth.site.timeZone, hours: rrfsSiteBoth.hours });
    expect(readWindgram(rrfsBothView, 0, 1800).verticalVelocityUnavailableReason).toBe(isolatedReason);

    // 5) Stitched empty-panel ticks stay identical whether a shifted-alignment run is opened after an earlier run or fresh
    const wvPoint = { lat: 38.0, lon: -81.5 };
    const makeRunSite = (cycleIso: string, hours: readonly number[], pt = wvPoint) => {
      const cycleMs = Date.parse(cycleIso);
      const runBuild = fixtureProfileBuild({ frameHours: hours, mapFrameCount: 2 });
      runBuild.manifest.cycle = cycleIso;
      runBuild.manifest.frames = hours.map(h => ({
        id: `f${String(h).padStart(3, '0')}`,
        validTime: new Date(cycleMs + h * 3_600_000).toISOString(),
        intervalStart: new Date(cycleMs + (h - 3) * 3_600_000).toISOString(),
        intervalEnd: new Date(cycleMs + h * 3_600_000).toISOString(),
      }));
      const loadedRun = new Map(runBuild.manifest.frames.map(fr => [fr.id, { ...profile.frames[0]!, ...fr, id: fr.id }]));
      return createPointForecast(runBuild, pt)(runBuild.manifest.frames, loadedRun);
    };
    const siteRunA = makeRunSite('2026-11-24T06:00:00.000Z', [2, 5, 8, 11, 14, 17]); // aligned to 08Z (3a/6a/9a/12p/3p EST)
    const siteRunB = makeRunSite('2026-11-24T12:00:00.000Z', [1, 4, 7, 10, 13, 16]); // aligned to 13Z (8a/11a/2p EST)
    const siteRunBFresh = makeRunSite('2026-11-24T12:00:00.000Z', [1, 4, 7, 10, 13, 16], { lat: 38.0001, lon: -81.5 });
    const viewRunA = buildStitchedWindgramView(siteRunA, {
      unitSystem: 'metric', compact: true, timeZone: siteRunA.site.timeZone, widthPx: 420, heightPx: 280,
      dateKeys: ['2026-11-23', '2026-11-24', '2026-11-25'],
    });
    const viewRunBAfterA = buildStitchedWindgramView(siteRunB, {
      unitSystem: 'metric', compact: true, timeZone: siteRunB.site.timeZone, widthPx: 420, heightPx: 280,
      dateKeys: ['2026-11-23', '2026-11-24', '2026-11-25'],
    });
    const viewRunBFresh = buildStitchedWindgramView(siteRunBFresh, {
      unitSystem: 'metric', compact: true, timeZone: siteRunBFresh.site.timeZone, widthPx: 420, heightPx: 280,
      dateKeys: ['2026-11-23', '2026-11-24', '2026-11-25'],
    });
    const ticksA = sceneData(viewRunA).dayPanels![0]!.visibleAxisIndices.map(i => sceneData(viewRunA).timeAxis[i]!.label);
    const ticksBAfterA = sceneData(viewRunBAfterA).dayPanels![0]!.visibleAxisIndices.map(i => sceneData(viewRunBAfterA).timeAxis[i]!.label);
    const ticksBFresh = sceneData(viewRunBFresh).dayPanels![0]!.visibleAxisIndices.map(i => sceneData(viewRunBFresh).timeAxis[i]!.label);
    expect(ticksA).toEqual(['9a', '12p', '3p']);
    expect(ticksBAfterA).toEqual(['8a', '11a', '2p']);
    expect(ticksBAfterA).toEqual(ticksBFresh);
  });

  it('keeps 1-Day cropped to solar daylight on nocturnal frameIds, anchors chart floor at site ground without sub-model hatching, and omits vertical tower bars', () => {
    const head = new FakeElement('head');
    const owner = {
      head,
      getElementById: (id: string) => head.children.find(child => child.id === id) ?? null,
      createElement: (tag: string) => new FakeElement(tag, owner as unknown as Document),
      defaultView: new EventTarget(),
    };

    // Armenia point (Asia/Yerevan UTC+4) across 01Z..19Z (5a..11p local)
    const armPoint = { lat: 40.0096, lon: 44.6283 };
    const hours = Array.from({ length: 19 }, (_, i) => i + 1);
    const { build, sample, profile } = fixture(hours, hours.length);
    const frames = profile.frames.map((frame, i) => ({ ...frame, layers: { ...frame.layers, ...sample.frames[i]!.layers } }));
    for (const f of frames) {
      f.profile.modelTerrainM = 1495;
      f.layers['usable-lift-msl']!.value = 2400;
      f.layers['usable-lift-agl']!.value = 920;
    }

    const container = owner.createElement('div') as unknown as HTMLElement;
    const siteTerrainValley = {
      elevationM: 1480,
      status: 'valid' as const,
      interpolated: true,
      surfaceId: 'gfs-fine',
      surface: 'DSM',
      verticalDatum: 'EGM2008',
    };
    renderPointWindgram(container, { frames, siteTerrain: siteTerrainValley }, build, {
      point: armPoint,
      frameId: 'f001', // 01:00 UTC = 05:00 local (pre-sunrise)
      unitSystem: 'imperial',
      viewMode: '1d',
      onFrame: vi.fn(),
    });
    const host = visit(container as unknown as FakeElement).find(el => el.className === 'av-windgram-host')!;
    expect(host.innerHTML).not.toContain('>5a<');
    expect(host.innerHTML).not.toContain('>11p<');
    expect(host.innerHTML).toContain('data-height-series="modelTerrainM"');
    expect(host.innerHTML).not.toContain('class="windgram-missing"');
    disposePointWindgram(container);

    // Ridge case (Ground 1,450 m > model 1,248 m): floorM anchors at 1,450 m, clipping underground air
    for (const f of frames) f.profile.modelTerrainM = 1248;
    const ridgeSite = createPointForecast(build, armPoint, {
      siteTerrain: { ...siteTerrainValley, elevationM: 1450 },
    })(build.manifest.frames, new Map(frames.map(f => [f.id, f])));
    const ridgeDay = buildWindgramView(ridgeSite, {
      unitSystem: 'metric', compact: true, heightRange: 'soaring', timeZone: ridgeSite.site.timeZone,
      hours: { timeZone: ridgeSite.site.timeZone, dateKey: ridgeSite.hours[0]!.validAt.slice(0, 10) },
    });
    expect(ridgeDay.floorM).toBe(1450);
  });
});
