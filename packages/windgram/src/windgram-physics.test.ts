import { describe, expect, it } from 'vitest';
import { buildStitchedWindgramView, buildWindgramView, createPointForecast, readWindgram } from './model.ts';
import { sceneData } from './scene-store.ts';
import { renderWindgramKey, renderWindgramSvg } from './svg.ts';
import { omegaToVerticalVelocityMps } from './windgram-atmosphere.ts';
import { classifyConvectiveCloudRegime } from './windgram-clouds.ts';
import { getWindgramCalloutRenderer } from './windgram-callout.ts';
import { windBarbSpeedColor } from './windgram-wind-tiers.ts';
import { FakeElement, fixture, point } from './windgram-test-fixture.ts';

describe('Windgram physics', () => {
  it('renders Concept 1 hybrid-climb physics by default: Lenschow climb dome bounded by TOL, inversion lids, contoured RH cloud decks, OVC ceiling strip, active Cu only at LCL, no root SVG title tooltip, and pluggable lapse mode', () => {
    const day1 = [14, 16, 18, 20];
    const day2 = [38, 40, 42, 44];
    const { sample, profile, forecast } = fixture([...day1, ...day2], 8);
    const frames = profile.frames.map((frame, i) => ({ ...frame, layers: { ...frame.layers, ...sample.frames[i]!.layers } }));

    // Day 1: morning surface inversion at 14Z (7a/9a), strong Cu-capped afternoon thermal at 18Z (thermalTop=2850 >= LCL=2800), and 100% high overcast at 18Z-20Z.
    frames[0]!.layers['usable-lift-msl']!.value = null;
    frames[0]!.layers['usable-lift-msl']!.status = 'no-usable-lift';
    frames[0]!.layers['usable-lift-agl']!.value = 0;
    frames[0]!.layers['usable-lift-agl']!.status = 'no-usable-lift';
    frames[0]!.layers['thermal-velocity']!.value = 0;
    // Create a true morning temperature inversion (+2°C warmer at 1800m than 2m surface)
    frames[0]!.layers['sfc-temp-c']!.value = 8;
    frames[0]!.profile.levels[0]!.temperatureC = 11;

    // Peak afternoon hour (index 2): strong w* = 2.4 m/s reaching effectiveCloudLimitM (2800m) + 100% total sky cover
    frames[2]!.layers['usable-lift-msl']!.value = 2800;
    frames[2]!.layers['usable-lift-agl']!.value = 1300;
    frames[2]!.layers['thermal-top-msl']!.value = 2850;
    frames[2]!.layers['surface-lcl-msl'] = { ...frames[2]!.layers['sfc-temp-c']!, value: 2800 };
    frames[2]!.layers['thermal-velocity']!.value = 2.4;
    frames[2]!.layers['cloud-cover-total']!.value = 100;
    frames[3]!.layers['cloud-cover-total']!.value = 95;

    // Day 2: completely dead overcast day (w* = 0, no usable lift, saturated RH >= 95% cloud layer, and an elevated unstable lapse layer aloft that must NOT paint a false thermal blob!)
    for (const i of [4, 5, 6, 7]) {
      frames[i]!.layers['usable-lift-msl']!.value = null;
      frames[i]!.layers['usable-lift-msl']!.status = 'no-usable-lift';
      frames[i]!.layers['usable-lift-agl']!.value = 0;
      frames[i]!.layers['usable-lift-agl']!.status = 'no-usable-lift';
      frames[i]!.layers['thermal-velocity']!.value = 0;
      frames[i]!.layers['cloud-cover-total']!.value = 100;
      // Saturated overcast cloud layer at 2400..3000m (T === Td)
      frames[i]!.profile.levels[1]!.dewPointC = frames[i]!.profile.levels[1]!.temperatureC;
      frames[i]!.profile.levels[2]!.dewPointC = frames[i]!.profile.levels[2]!.temperatureC;
    }

    const site = forecast(frames);
    const allDays = [...new Set(site.hours.map(h => h.validAt.slice(0, 10)))];

    // 1) Stitched 2-day hybrid-climb default scene
    const stitched = buildStitchedWindgramView(site, {
      unitSystem: 'imperial',
      compact: true,
      heightRange: 'soaring',
      timeZone: site.site.timeZone,
      widthPx: 620,
      heightPx: 320,
      dateKeys: allDays,
    });
    const internal = sceneData(stitched);
    expect(internal.fieldMode).toBe('hybrid-climb');

    // Day 1 has climb dome paths & morning inversion; Day 2 (dead overcast) has ZERO climb paths inside its x-span!
    const climbFields = internal.fields.filter(f => f.className.startsWith('wg-climb-'));
    expect(climbFields.length).toBeGreaterThanOrEqual(3);
    const day2Left = internal.dayPanels![1]!.left;
    for (const cf of climbFields) {
      const xs = [...cf.path.matchAll(/[ML](-?\d+(?:\.\d+)?)/g)].map(m => Number(m[1]));
      expect(xs.every(x => x < day2Left)).toBe(true);
    }
    expect(internal.fields.some(f => f.className.startsWith('wg-inversion-'))).toBe(true);
    expect(internal.cloudDeckFields?.some(f => f.className === 'wg-cloud-deck-ovc')).toBe(true);
    expect(internal.skyCoverSpans?.some(s => s.tier === 'ovc')).toBe(true);

    const svg = renderWindgramSvg(stitched);
    // Root SVG uses aria-label + aria-describedby with NO root <title> tooltip before <desc>.
    expect(svg).toContain('aria-label="Wind, temperature and clouds by hour and altitude"');
    expect(svg).not.toMatch(/<svg[^>]*><title/);
    // High-contrast haloed TOL curve, top OVC sky-cover strip, contoured cloud deck, and active Cu only where lift reaches LCL.
    expect(svg).toContain('class="wg-tol-halo"');
    expect(svg).toContain('class="wg-tol-core"');
    expect(svg).toContain('data-sky-cover="ovc"');
    expect(svg).toContain('>OVC<');
    expect(svg).toContain('class="wg-cloud-deck-ovc"');
    expect(svg).toContain('data-cumulus="cu"');
    expect(svg).not.toContain('class="wg-cloud-potential"');

    // 2) Classic 'lapse' mode remains cleanly swappable via fieldMode: 'lapse'.
    const lapseScene = buildWindgramView(site, {
      unitSystem: 'imperial',
      fieldMode: 'lapse',
      compact: true,
      heightRange: 'soaring',
      timeZone: site.site.timeZone,
      hours: { timeZone: site.site.timeZone, dateKey: allDays[0]! },
    });
    const lapseSvg = renderWindgramSvg(lapseScene);
    expect(lapseSvg).toContain('meteo-gram-stab-');
    expect(lapseSvg).toContain('class="wg-cloud-potential"');
    expect(renderWindgramKey('imperial', true, 'hybrid-climb')).toContain('Net climb · ft/min');
    expect(renderWindgramKey('imperial', true, 'lapse')).toContain('Lapse rate · °F/1,000 ft');
  });

  it('models multi-regime soaring days faithfully: native-tail continuity past mapFrameCount, OD cumulus with zero fake lightning, Scorer-gated mountain wave w(ω), WMO 2.5+5n kt wind barbs, and -20..0°C SLW icing', () => {
    // 1) Exact hydrostatic vertical velocity conversion & WMO 2.5+5n knot wind barb speed coding
    // At 750 hPa, 0°C (273.15 K), ω = -10 Pa/s -> w = (10 * 287.05 * 273.15) / (75000 * 9.80665) ≈ +1.066 m/s (+210 fpm)
    const wWave = omegaToVerticalVelocityMps(-10, 0, 750, 2500);
    expect(wWave).toBeCloseTo(1.066, 2);
    expect(omegaToVerticalVelocityMps(8, 0, 750, 2500)).toBeLessThan(-0.8);
    expect([1.5, 8.5, 11.5, 15, 24, 26, 32, 52].map(windBarbSpeedColor)).toEqual([
      '#78ff78', '#78ff78', '#78ff78', '#ffffff', '#fde047', '#fde047', '#fca5a5', '#e879f9',
    ]);

    // 2) Multi-day forecast where mapFrameCount covers ONLY Day 1 (4 frames), Day 2 is native-tail ('unavailable' fine surface),
    // and Day 3 is a 0-fpm winter mountain-wave day with strong resolved ascent aloft in statically stable air.
    const day1 = [14, 16, 18, 20];
    const day2 = [38, 40, 42, 44];
    const day3 = [62, 64, 66, 68];
    const { build, sample, profile } = fixture([...day1, ...day2, ...day3], 4);
    const sampleMap = new Map(sample.frames.map(f => [f.id, f]));
    const frames = profile.frames.map(frame => {
      const fine = sampleMap.get(frame.id);
      return fine ? { ...frame, layers: { ...frame.layers, ...fine.layers } } : frame;
    });

    // Day 1 afternoon: Frame 2 has OD spreadout (overdeveloped = true, CAPE = 400), Frame 3 has high instability (CAPE = 1450 J/kg) + 30 kt & 52 kt upper winds (no fake lightning!)
    frames[2]!.layers['usable-lift-msl']!.value = 2500;
    frames[2]!.layers['usable-lift-agl']!.value = 1000;
    frames[2]!.layers['thermal-top-msl']!.value = 2600;
    frames[2]!.layers['surface-lcl-msl'] = { ...frames[2]!.layers['sfc-temp-c']!, value: 2450 };
    frames[2]!.layers['thermal-velocity']!.value = 2.2;
    frames[2]!.layers['cape-jkg'] = { ...frames[2]!.layers['sfc-temp-c']!, value: 400 };
    frames[2]!.derived.overdeveloped = true;
    frames[2]!.derived.cloudCapped = true;

    frames[3]!.layers['usable-lift-msl']!.value = 2550;
    frames[3]!.layers['usable-lift-agl']!.value = 1050;
    frames[3]!.layers['thermal-top-msl']!.value = 2700;
    frames[3]!.layers['surface-lcl-msl'] = { ...frames[3]!.layers['sfc-temp-c']!, value: 2500 };
    frames[3]!.layers['thermal-velocity']!.value = 2.6;
    frames[3]!.layers['cape-jkg'] = { ...frames[3]!.layers['sfc-temp-c']!, value: 1450 };
    frames[3]!.derived.overdeveloped = true;
    frames[3]!.derived.cloudCapped = true;

    // Day 2 (indices 4..7): beyond mapFrameCount -> fine usable-lift-msl is 'unavailable', but native w* = 2.3 m/s & thermal-top-msl = 2750 m!
    for (const i of [5, 6]) {
      frames[i]!.layers['thermal-velocity']!.value = 2.3;
      frames[i]!.layers['thermal-top-msl']!.value = 2750;
      frames[i]!.derived.effectiveCloudLimitM = 2900;
    }
    frames[4]!.layers['thermal-velocity']!.value = 0;
    frames[7]!.layers['thermal-velocity']!.value = 0;

    // Day 3 (indices 8..11): 0 fpm winter mountain wave day (w* = 0) with strong 29 kt..52.5 kt upper wind & resolved wave ascent (omegaPaS = -14..-16 Pa/s at 2400..3000m)
    for (const i of [8, 9, 10, 11]) {
      frames[i]!.layers['thermal-velocity']!.value = 0;
      frames[i]!.layers['thermal-top-msl']!.value = 1500;
      frames[i]!.profile.levels[1]!.omegaPaS = -14;
      frames[i]!.profile.levels[1]!.uWindMps = 15; // 29.2 kt (#fca5a5 coral)
      frames[i]!.profile.levels[1]!.vWindMps = 0;
      frames[i]!.profile.levels[2]!.omegaPaS = -16;
      frames[i]!.profile.levels[2]!.uWindMps = 27; // 52.5 kt WMO pennant (#e879f9 magenta)
      frames[i]!.profile.levels[2]!.vWindMps = 0;
    }

    const site = createPointForecast(build, point)(build.manifest.frames, new Map(frames.map(f => [f.id, f])));
    const allDays = [...new Set(site.hours.map(h => h.validAt.slice(0, 10)))];

    // Verify native-tail Day 2 keeps usableLiftTopM === null while populating nativeUsableLiftTopM, and high CAPE never synthesizes fake 'cb' lightning!
    expect(site.hours[5]!.mapLift.mslM).toBeNull();
    expect(site.hours[5]!.nativeUsableLiftTopM).toBeGreaterThan(2400);
    expect(classifyConvectiveCloudRegime(site.hours[2]!)).toBe('od');
    expect(classifyConvectiveCloudRegime(site.hours[3]!)).toBe('od');

    // Pure native-tail 1-day view on Day 2 scales to soaring ceiling (not 15 km full atmosphere!) and renders climb dome + dashed native ceiling
    const day2Scene = buildWindgramView(site, {
      unitSystem: 'metric',
      compact: true,
      heightRange: 'soaring',
      timeZone: site.site.timeZone,
      hours: { timeZone: site.site.timeZone, dateKey: allDays[1]! },
    });
    expect(day2Scene.topM).toBeLessThan(5000);
    const day2Svg = renderWindgramSvg(day2Scene);
    expect(day2Svg).toContain('class="wg-climb-');
    expect(day2Svg).toContain('data-native-lift-ceiling=""');
    const day2MidReading = readWindgram(day2Scene, 1, 2000);
    expect(day2MidReading.estimatedClimbMps).toBeGreaterThan(1.0);

    // Pure winter wave 1-day view on Day 3 scales to encompass wave lift at 3000 m and renders cyan wave contours without false thermal climb
    const day3Scene = buildWindgramView(site, {
      unitSystem: 'metric',
      compact: true,
      heightRange: 'soaring',
      timeZone: site.site.timeZone,
      hours: { timeZone: site.site.timeZone, dateKey: allDays[2]! },
    });
    expect(day3Scene.topM).toBeGreaterThanOrEqual(3000);
    const day3Svg = renderWindgramSvg(day3Scene);
    expect(day3Svg).toContain('class="wg-wave-lift"');
    expect(day3Svg).toContain('class="wg-wave-strong"');
    expect(day3Svg).not.toContain('class="wg-climb-');
    const waveReading = readWindgram(day3Scene, 1, 2400);
    // The native column is known and has no thermal: 0, which the tile shows as model ascent instead.
    expect(waveReading.estimatedClimbMps).toBe(0);
    expect(waveReading.waveVelocityMps).toBeGreaterThan(1.2);
    expect(waveReading.lapseCPer1000Ft).toBeGreaterThan(-2.45);

    // Adversarial Scorer check: a dry-adiabatic convective chimney (-3.05 °C/1kft) must NOT emit laminar wave contours!
    const adiabaticFrames = frames.slice(8, 12).map(frame => ({
      ...frame,
      profile: {
        ...frame.profile,
        levels: [
          { ...frame.profile.levels[0]!, heightM: 1800, temperatureC: 18, dewPointC: -4, uWindMps: 14, vWindMps: 0, omegaPaS: -15 },
          { ...frame.profile.levels[1]!, heightM: 2400, temperatureC: 12, dewPointC: -6, uWindMps: 15, vWindMps: 0, omegaPaS: -16 },
          { ...frame.profile.levels[2]!, heightM: 3000, temperatureC: 6, dewPointC: -8, uWindMps: 15, vWindMps: 0, omegaPaS: -16 },
          { ...frame.profile.levels[3]!, heightM: 3600, temperatureC: 0, dewPointC: -10, uWindMps: 15, vWindMps: 0, omegaPaS: -14 },
        ],
      },
    }));
    const adiabaticSite = createPointForecast(build, point)(build.manifest.frames.slice(8, 12), new Map(adiabaticFrames.map(f => [f.id, f])));
    const adiabaticScene = buildWindgramView(adiabaticSite, {
      unitSystem: 'metric',
      compact: true,
      heightRange: 'soaring',
      timeZone: adiabaticSite.site.timeZone,
      hours: adiabaticSite.hours,
    });
    expect(renderWindgramSvg(adiabaticScene)).not.toContain('class="wg-wave-lift"');

    // Stitched 3-day SVG renders OD cloud (zero fake lightning bolts), coral 30kt & magenta 50kt+ wind barbs, dashed native Day 2 ceiling, and Day 3 wave band
    const stitched = buildStitchedWindgramView(site, {
      unitSystem: 'imperial',
      compact: true,
      heightRange: 'soaring',
      timeZone: site.site.timeZone,
      widthPx: 640,
      heightPx: 340,
      dateKeys: allDays.slice(0, 3),
    });
    const stitchedSvg = renderWindgramSvg(stitched);
    expect(stitchedSvg).toContain('data-cumulus="od"');
    expect(stitchedSvg).not.toContain('data-cumulus="cb"');
    expect(stitchedSvg).not.toContain('wg-cloud-cb-bolt');
    expect(stitchedSvg).toContain('wg-barb-danger');
    expect(stitchedSvg).toContain('wg-barb-pennant');
    expect(stitchedSvg).toContain('--wg-wind-danger: #fca5a5');
    expect(stitchedSvg).toContain('--wg-wind-pennant: #e879f9');
    expect(stitchedSvg).not.toContain('style="color:');
    expect(stitchedSvg).toContain('data-native-lift-ceiling=""');
    expect(stitchedSvg).toContain('class="wg-wave-lift"');

    // Verify tile-2x2 hover callout across Cu-base TOL, Wave vs Ascent, -20..0°C SLW icing vs -35°C cirrus, plain CAPE, Inversion, and unit-aware shear
    const climbVal = new FakeElement('text');
    const climbSub = new FakeElement('text');
    const climbFill = new FakeElement('rect');
    const tempEl = new FakeElement('text');
    const hazardEl = new FakeElement('text');
    const tileMap = new Map<string, FakeElement>([
      ['[data-tile-climb-val]', climbVal],
      ['[data-tile-climb-sub]', climbSub],
      ['[data-tile-climb-fill]', climbFill],
      ['[data-tile-temp]', tempEl],
      ['[data-tile-hazard]', hazardEl],
    ]);
    const bound = getWindgramCalloutRenderer('tile-2x2').bind({
      querySelector: (sel: string) => tileMap.get(sel) ?? null,
    } as unknown as ParentNode);
    const dummyTelemetry = {
      timeChip: '2:00 PM', altChip: '', snappedToTol: false, canSnapToTol: false,
      calloutBadge: 'ALT', calloutMeteo: '', calloutSoar: '', hasPositiveClimb: false,
    };

    // a) Cu-capped TOL + OD spreadout
    const odTolReading = readWindgram(stitched, 2, 2500);
    bound.paint({ aglText: '3,280 ft AGL', mslText: '8,200 ft MSL', useTol: true, telemetry: dummyTelemetry, reading: odTolReading, unitSystem: 'imperial' });
    expect(climbSub.textContent).toBe('▲ Cu base');
    expect(hazardEl.textContent).toBe('OD spreadout');

    // b) High CAPE instability (plain CAPE text, zero fake lightning bolt!)
    const capeReading = readWindgram(stitched, 3, 2200);
    bound.paint({ aglText: '2,300 ft AGL', mslText: '7,200 ft MSL', useTol: false, telemetry: dummyTelemetry, reading: capeReading, unitSystem: 'imperial' });
    expect(hazardEl.textContent).toBe('CAPE 1450');
    expect(hazardEl.textContent).not.toContain('⚡');

    // c) Neutral model vertical motion ('▲ Model ascent' / '▼ Model descent')
    bound.paint({ aglText: '2,950 ft AGL', mslText: '7,870 ft MSL', useTol: false, telemetry: dummyTelemetry, reading: waveReading, unitSystem: 'imperial' });
    expect(climbSub.textContent).toBe('▲ Model ascent');
    expect(climbFill.getAttribute('class')).toContain('is-wave');
    bound.paint({
      aglText: '2,950 ft AGL', mslText: '7,870 ft MSL', useTol: false, telemetry: dummyTelemetry,
      reading: { ...waveReading, lapseCPer1000Ft: -2.9 },
      unitSystem: 'imperial',
    });
    expect(climbSub.textContent).toBe('▲ Model ascent');
    bound.paint({
      aglText: '2,950 ft AGL', mslText: '7,870 ft MSL', useTol: false, telemetry: dummyTelemetry,
      reading: { ...waveReading, waveVelocityMps: -1.4 },
      unitSystem: 'imperial',
    });
    expect(climbVal.textContent).toMatch(/^-\d+ fpm$/);
    expect(climbSub.textContent).toBe('▼ Model descent');

    // d) Supercooled liquid water icing (-4°C with liquid RH >= 94% -> '❄ Icing risk') vs -35°C glaciated cirrus (no icing risk)
    bound.paint({
      aglText: '4,000 ft AGL', mslText: '8,900 ft MSL', useTol: false, telemetry: dummyTelemetry,
      reading: { ...waveReading, waveVelocityMps: 0, temperatureF: 24.8, relativeHumidityPercent: 96, cloud: 'humidity', precipitationMmHr: 0 },
      unitSystem: 'metric',
    });
    expect(tempEl.textContent).toBe('❄ -4°C');
    expect(hazardEl.textContent).toBe('❄ Icing risk');
    expect(climbSub.textContent).toBe('No thermal');

    bound.paint({
      aglText: '28,000 ft AGL', mslText: '33,000 ft MSL', useTol: false, telemetry: dummyTelemetry,
      reading: { ...waveReading, temperatureF: -31, cloud: 'humidity', precipitationMmHr: 0, capeJkg: 0, windShear: null, overdeveloped: false },
      unitSystem: 'metric',
    });
    expect(tempEl.textContent).toBe('❄ -35°C');
    expect(hazardEl.textContent).toBe('Dry');

    // e) Temperature inversion lid & unit-aware vertical wind shear
    bound.paint({
      aglText: '1,200 ft AGL', mslText: '6,100 ft MSL', useTol: false, telemetry: dummyTelemetry,
      reading: { ...waveReading, waveVelocityMps: 0, lapseCPer1000Ft: 1.2, cloud: null, relativeHumidityPercent: 42, windShear: null, capeJkg: 0, overdeveloped: false },
      unitSystem: 'imperial',
    });
    expect(climbSub.textContent).toBe('Inversion lid');
    expect(hazardEl.textContent).toBe('Inversion');

    bound.paint({
      aglText: '2,000 ft AGL', mslText: '6,900 ft MSL', useTol: false, telemetry: dummyTelemetry,
      reading: { ...waveReading, waveVelocityMps: 0, lapseCPer1000Ft: -1.5, cloud: null, relativeHumidityPercent: 45, windShear: { lowerM: 1800, upperM: 2400, vectorChangeMps: 4.5, perKmMps: 7.5 }, capeJkg: 0, overdeveloped: false },
      unitSystem: 'imperial',
    });
    expect(hazardEl.textContent).toBe('Shear 5.1 mph/kft');
  });

  it('preserves native-column convective depth under a high ridge and distinguishes unpublished model omega', async () => {
    const { resolveConvectiveEnvelope, estimateThermalClimbAtHeight } = await import('./windgram-climb.ts');
    // Ridge DEM 1,450 m over 1,000 m model ground with 1,521.35 m native usable ceiling (thermal top 2,000 m, w* = 0.639445 m/s)
    const column = { groundM: 1000, thermalTopM: 2000, thermalVelocityMps: 0.639445, usableTopM: 1521.35, cloudCapM: 4000 };
    const env = resolveConvectiveEnvelope(column, 1450);
    expect(env).not.toBeNull();
    expect(env!.groundM).toBe(1000);
    expect(env!.floorM).toBe(1450);
    expect(env!.convectiveDepthM).toBeCloseTo(1000, 0);
    // Below the 1,450 m ridge is underground (0 climb); at 1,480 m MSL inside [1450, 1521.35] it follows the true 1,000 m native profile
    expect(estimateThermalClimbAtHeight(1400, column, 1450).estimatedClimbMps).toBe(0);
    const aloftClimb = estimateThermalClimbAtHeight(1480, column, 1450).estimatedClimbMps!;
    expect(aloftClimb).toBeGreaterThan(0);
    expect(aloftClimb).toBeLessThan(0.12);

    // Unpublished model omega (e.g. GFS / ICON-EU) vs missing single-level omega (e.g. RRFS / WRF)
    const { build, profile } = fixture([1, 2], 2);
    const noOmegaFrames = profile.frames.map(f => ({
      ...f,
      profile: f.profile ? { ...f.profile, levels: f.profile.levels.map(l => ({ ...l, omegaPaS: null })) } : f.profile,
    }));
    const noOmegaSite = createPointForecast(build, { lat: 38.85, lon: -78.41 })(
      build.manifest.frames.slice(0, 2),
      new Map(noOmegaFrames.slice(0, 2).map(f => [f.id, f])),
    );
    const noOmegaView = buildWindgramView(noOmegaSite, { unitSystem: 'metric', compact: true, timeZone: noOmegaSite.site.timeZone, hours: noOmegaSite.hours });
    expect(readWindgram(noOmegaView, 0, 1800).verticalVelocityUnavailableReason).toBe(
      'Vertical motion unavailable (not published for this model).',
    );

    const partialOmegaFrames = noOmegaFrames.map((f, idx) => idx === 1 && f.profile
      ? { ...f, profile: { ...f.profile, levels: f.profile.levels.map((l, j) => (j === 1 ? { ...l, omegaPaS: -0.9 } : l)) } }
      : f);
    const partialSite = createPointForecast(build, { lat: 38.85, lon: -78.41 })(
      build.manifest.frames.slice(0, 2),
      new Map(partialOmegaFrames.slice(0, 2).map(f => [f.id, f])),
    );
    const partialView = buildWindgramView(partialSite, { unitSystem: 'metric', compact: true, timeZone: partialSite.site.timeZone, hours: partialSite.hours });
    expect(readWindgram(partialView, 0, 1800).verticalVelocityUnavailableReason).toBe(
      'Vertical motion unavailable for the selected frame and height.',
    );
    expect(readWindgram(partialView, 1, 1800).verticalVelocityUnavailableReason).toBe(
      'Vertical motion unavailable at this height.',
    );
  });
});
