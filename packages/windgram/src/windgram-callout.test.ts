import { describe, expect, it } from 'vitest';
import { dewpointFromGfsV16RhC, dewpointFromTempAndRhC } from '@av/thermodynamics';
import { mountWindgram } from './dom.ts';
import { buildWindgramView, createPointForecast, readWindgram } from './model.ts';
import { renderWindgramSvg } from './svg.ts';
import { analyzeHourCloudLayers, skyCoverageCode } from './windgram-clouds.ts';
import { getWindgramCalloutRenderer } from './windgram-callout.ts';
import { cloudOktasSegments } from './windgram-callout-tile-cells.ts';
import { classifyParagliderWind } from './windgram-wind-tiers.ts';
import { mpsToKnots } from './windgram-format.ts';
import { hourSampling } from './windgram-sampling.ts';
import { FakeElement, fixture, point } from './windgram-test-fixture.ts';

describe('Windgram callout', () => {
  it('renders Option B 2x2 Instrument Tile by default with WMO 2.5+5n kt wind tiers, surface-only gusts, METAR sky code + Clear vs Whiteout disambiguation, dewpoint, dual-halo crosshairs, and pluggable variant swapping', () => {
    expect(classifyParagliderWind(null)).toBe('missing');
    expect(classifyParagliderWind(1.0)).toBe('calm');      // 1.9 kt (<2.5 kt WMO calm circle)
    expect(classifyParagliderWind(5.5)).toBe('ok');        // 10.7 kt (2.5–12.5 kt: 5 & 10 kt barbs green)
    expect(classifyParagliderWind(7.5)).toBe('moderate');  // 14.6 kt (12.5–17.5 kt: 15 kt barb white)
    expect(classifyParagliderWind(13.0)).toBe('caution');  // 25.3 kt (17.5–27.5 kt: 20 & 25 kt barbs yellow)
    expect(classifyParagliderWind(16.0)).toBe('danger');   // 31.1 kt (27.5–47.5 kt: 30–45 kt barbs coral)
    expect(classifyParagliderWind(26.0)).toBe('pennant');  // 50.5 kt (>=47.5 kt: 50+ kt WMO pennant magenta)
    expect([0, 4, 15, 35, 75, 95].map(cloudOktasSegments)).toEqual([0, 0, 1, 2, 4, 5]);
    expect([0, 5, 18, 40, 72, 95].map(skyCoverageCode)).toEqual(['CLR', 'CLR', 'FEW', 'SCT', 'BKN', 'OVC']);

    const { sample, profile, forecast } = fixture([20, 21]);
    const frames = profile.frames.map((frame, i) => ({ ...frame, layers: { ...frame.layers, ...sample.frames[i].layers } }));
    frames[0].layers['cloud-cover-total'] = { ...frames[0].layers['sfc-temp-c']!, value: 35 };
    const site = forecast(frames);
    const scene = buildWindgramView(site, { unitSystem: 'metric', compact: false, timeZone: site.site.timeZone, hours: site.hours });

    const defaultSvg = renderWindgramSvg(scene);
    expect(defaultSvg).toContain('windgram-hybrid');
    expect(defaultSvg).toContain('data-callout-variant="tile-2x2"');
    expect(defaultSvg).toContain('data-cursor-vertical-halo=""');
    expect(defaultSvg).toContain('data-cursor-horizontal-halo=""');
    expect(defaultSvg).toContain('data-cursor-point-halo=""');
    expect(defaultSvg).toContain('data-tile-wind-arrow=""');
    expect(defaultSvg).toContain('data-tile-climb-fill=""');
    expect(defaultSvg).toContain('data-tile-okta="4"');
    expect(defaultSvg).toContain('data-tile-sky-code=""');
    expect(defaultSvg).toContain('data-tile-dewpoint=""');
    expect(defaultSvg).toContain('data-tile-rain-icon=""');

    const classicSvg = renderWindgramSvg(scene, { calloutVariant: 'classic' });
    expect(classicSvg).toContain('data-callout-variant="classic"');
    expect(classicSvg).toContain('data-cursor-soar=""');
    expect(classicSvg).not.toContain('data-tile-wind-arrow=""');

    // Bind Option B 2x2 DOM nodes directly and verify live painting across dry, surface-gust, caution-wind/rain, and in-cloud states.
    const back = new FakeElement('rect');
    const badgePill = new FakeElement('rect');
    const badge = new FakeElement('text');
    const agl = new FakeElement('text');
    const msl = new FakeElement('text');
    const windBg = new FakeElement('rect');
    const dial = new FakeElement('circle');
    const windArrow = new FakeElement('path');
    const windCalm = new FakeElement('circle');
    const windSpeed = new FakeElement('text');
    const windDir = new FakeElement('text');
    const climbFill = new FakeElement('rect');
    const climbVal = new FakeElement('text');
    const climbSub = new FakeElement('text');
    const cloudBg = new FakeElement('rect');
    const oktas = [0, 1, 2, 3, 4].map(() => new FakeElement('rect'));
    const skyCodeEl = new FakeElement('text');
    const cloudText = new FakeElement('text');
    const rainBg = new FakeElement('rect');
    const tempEl = new FakeElement('text');
    const dewpointEl = new FakeElement('text');
    const rainIcon = new FakeElement('path');
    const hazardEl = new FakeElement('text');
    const tileNodes = new Map<string, FakeElement>([
      ['[data-cursor-back]', back],
      ['[data-tile-badge-pill]', badgePill],
      ['[data-cursor-badge]', badge],
      ['[data-cursor-agl]', agl],
      ['[data-cursor-msl]', msl],
      ['[data-tile-wind-bg]', windBg],
      ['[data-tile-dial]', dial],
      ['[data-tile-wind-arrow]', windArrow],
      ['[data-tile-wind-calm]', windCalm],
      ['[data-tile-wind-speed]', windSpeed],
      ['[data-tile-wind-dir]', windDir],
      ['[data-tile-climb-fill]', climbFill],
      ['[data-tile-climb-val]', climbVal],
      ['[data-tile-climb-sub]', climbSub],
      ['[data-tile-cloud-bg]', cloudBg],
      ...oktas.map((el, i) => [`[data-tile-okta="${i}"]`, el] as const),
      ['[data-tile-sky-code]', skyCodeEl],
      ['[data-tile-cloud-text]', cloudText],
      ['[data-tile-rain-bg]', rainBg],
      ['[data-tile-temp]', tempEl],
      ['[data-tile-dewpoint]', dewpointEl],
      ['[data-tile-rain-icon]', rainIcon],
      ['[data-tile-hazard]', hazardEl],
    ]);
    const bound = getWindgramCalloutRenderer('tile-2x2').bind({
      querySelector: (sel: string) => tileNodes.get(sel) ?? null,
    } as unknown as ParentNode);

    const baseReading = readWindgram(scene, 0, 1800);
    const dummyTelemetry = {
      timeChip: '3:00 PM', altChip: '★ TOL 500 m AGL', snappedToTol: true, canSnapToTol: false,
      calloutBadge: '★ TOP OF LIFT', calloutMeteo: '', calloutSoar: '', hasPositiveClimb: true,
    };

    // 1) Flyable wind (270° W blowing East -> downwind arrow rotated 90°), clear air under SCT 35% sky, dewpoint Td 2°, no surface gust aloft at 300 m AGL.
    const size = bound.paint({
      aglText: '500 m AGL',
      mslText: '2,000 m MSL',
      useTol: true,
      telemetry: dummyTelemetry,
      reading: { ...baseReading, heightAglM: 300, speedKt: mpsToKnots(4.5), gustKt: 22, directionDeg: 270, precipitationMmHr: 0, windShear: null },
      unitSystem: 'metric',
    });
    expect(size).toEqual({ width: 204, height: 74 });
    expect(badge.textContent).toBe('★ TOL');
    expect(windArrow.getAttribute('transform')).toBe('translate(16.5 33) rotate(90)');
    expect(windSpeed.textContent).toBe('16 km/h');
    expect(windSpeed.getAttribute('class')).toContain('is-ok');
    expect(windDir.textContent).toBe('W · Sfc G41');
    expect(Number(climbFill.getAttribute('height'))).toBeGreaterThan(0);
    expect(oktas.map(el => el.getAttribute('class')?.includes('is-lit') ?? false)).toEqual([true, true, false, false, false]);
    expect(skyCodeEl.textContent).toBe('SCT 35%');
    expect(cloudText.textContent).toBe('Clear · RH 50%');
    expect(dewpointEl.textContent).toBe('Td 2°');
    expect(rainIcon.getAttribute('visibility')).toBe('hidden');
    expect(hazardEl.textContent).toBe('Dry');

    // 1b) Near-surface launch hover (<=150 m AGL) surfaces 10m gusts (W · G41) and promotes caution border without inventing upper-air gusts.
    bound.paint({
      aglText: '80 m AGL',
      mslText: '1,580 m MSL',
      useTol: false,
      telemetry: dummyTelemetry,
      reading: { ...baseReading, heightAglM: 80, speedKt: 10, gustKt: 22, directionDeg: 270, precipitationMmHr: 0, windShear: null },
      unitSystem: 'metric',
    });
    expect(windDir.textContent).toBe('W · G41');
    expect(back.getAttribute('class')).toContain('is-caution');

    // 2) Yellow-tier wind (20.4 kt / 38 km/h WNW — zero adjectives!), active precipitation (0.8 mm/h), freezing air (-2°C), and saturated IMC whiteout (RH >=94%).
    bound.paint({
      aglText: '900 m AGL',
      mslText: '2,400 m MSL',
      useTol: false,
      telemetry: dummyTelemetry,
      reading: {
        ...baseReading,
        heightAglM: 900,
        speedKt: mpsToKnots(10.5),
        gustKt: 24,
        directionDeg: 292.5,
        temperatureF: 28.4,
        dewPointC: -2.4,
        relativeHumidityPercent: 96,
        cloudHumidityPercent: 96,
        cloud: 'humidity',
        cloudCoverTotalPercent: 85,
        precipitationMmHr: 0.8,
      },
      unitSystem: 'metric',
    });
    expect(badge.textContent).toBe('ALT');
    expect(back.getAttribute('class')).toContain('is-caution');
    expect(windBg.getAttribute('class')).toContain('is-caution');
    expect(windDir.textContent).toBe('WNW · Sfc G44');
    expect(windDir.textContent).not.toMatch(/Caution|Strong/i);
    expect(cloudBg.getAttribute('class')).toContain('is-cloud');
    expect(skyCodeEl.textContent).toBe('OVC');
    expect(cloudText.textContent).toBe('☁ In cloud · RH 96%');
    expect(tempEl.textContent).toBe('❄ -2°C');
    expect(dewpointEl.textContent).toBe('Td -2°');
    expect(tempEl.getAttribute('class')).toContain('is-freeze');
    expect(rainIcon.getAttribute('visibility')).toBe('visible');
    expect(hazardEl.textContent).toBe('0.8 mm/h · ❄ Icing risk');

    // 3) Live runtime variant swap via setCalloutVariant.
    const swapHost = new FakeElement('div');
    const mounted = mountWindgram(swapHost as unknown as HTMLElement, {
      view: scene,
      idPrefix: 'swap-callout',
      selectedValidAt: scene.hours[0].validAt,
      inspectionMode: 'magnetic',
    });
    expect(swapHost.innerHTML).toContain('data-callout-variant="tile-2x2"');
    mounted.setCalloutVariant('classic');
    expect(swapHost.innerHTML).toContain('data-callout-variant="classic"');
    mounted.setCalloutVariant('tile-2x2');
    expect(swapHost.innerHTML).toContain('data-callout-variant="tile-2x2"');
    mounted.dispose();
  });

  it('models cloud depth, FEW/SCT/BKN/OVC scatteredness, multi-layer cloud decks, high cirrus vs low OVC, and Clear vs Whiteout/Cu-tower hover states', () => {
    const { build, sample, profile } = fixture([15, 17, 19], 3);
    const frames = profile.frames.map((frame, i) => ({ ...frame, layers: { ...frame.layers, ...sample.frames[i]!.layers } }));

    // Hour 0 (15Z): Two distinct stratiform layers inside soaring domain (low OVC valley stratus 1700..1950m, clear slot at 2250m, mid SCT/BKN altocumulus 2650..3050m), w* = 0
    frames[0]!.layers['usable-lift-msl']!.value = null;
    frames[0]!.layers['usable-lift-msl']!.status = 'no-usable-lift';
    frames[0]!.layers['usable-lift-agl']!.value = 0;
    frames[0]!.layers['usable-lift-agl']!.status = 'no-usable-lift';
    frames[0]!.layers['thermal-velocity']!.value = 0;
    frames[0]!.layers['cloud-cover-low']!.value = 90;
    frames[0]!.layers['cloud-cover-total']!.value = 92;
    frames[0]!.profile.levels = [
      { pressureHpa: 900, heightM: 1700, temperatureC: 10, dewPointC: 9.8, uWindMps: 3, vWindMps: 2, omegaPaS: 0 },   // ~99% RH (OVC stratus)
      { pressureHpa: 875, heightM: 1950, temperatureC: 8.5, dewPointC: 8.0, uWindMps: 4, vWindMps: 2, omegaPaS: 0 },  // ~97% RH
      { pressureHpa: 845, heightM: 2250, temperatureC: 7.0, dewPointC: -4.0, uWindMps: 5, vWindMps: 3, omegaPaS: 0 }, // ~45% RH (clear VMC window!)
      { pressureHpa: 805, heightM: 2650, temperatureC: 2.0, dewPointC: -0.2, uWindMps: 7, vWindMps: 4, omegaPaS: 0 }, // ~85% RH (SCT/BKN alto deck)
      { pressureHpa: 765, heightM: 3050, temperatureC: -1.0, dewPointC: -3.0, uWindMps: 8, vWindMps: 5, omegaPaS: 0 }, // ~86% RH
    ];

    // Hour 1 (17Z): Towering SCT Cumulus (base = 2200 m, parcel top = 3450 m -> 1,250 m deep, w* = 2.8 m/s, cloud-cover-low = 38%) + Cloud suck!
    frames[1]!.layers['usable-lift-msl']!.value = 2200;
    frames[1]!.layers['usable-lift-agl']!.value = 700;
    frames[1]!.layers['surface-lcl-msl'] = { ...frames[1]!.layers['sfc-temp-c']!, value: 2200 };
    frames[1]!.layers['thermal-top-msl']!.value = 3450;
    frames[1]!.layers['thermal-velocity']!.value = 2.8;
    frames[1]!.layers['cloud-cover-low']!.value = 38;
    frames[1]!.layers['cloud-cover-total']!.value = 38;
    frames[1]!.derived.effectiveCloudLimitM = 2200;
    frames[1]!.derived.cuPotentialM = 1250;
    frames[1]!.derived.cloudCapped = true;
    frames[1]!.derived.overdeveloped = false;

    // Hour 2 (19Z): Sunny blue thermals with strong BL shear (buoyancyShearRatio = 0.28 -> B/S 3) under 95% High Cirrus ONLY (cloud-cover-low = 0%, dry column)
    frames[2]!.layers['usable-lift-msl']!.value = 2400;
    frames[2]!.layers['usable-lift-agl']!.value = 900;
    frames[2]!.layers['thermal-top-msl']!.value = 2550;
    frames[2]!.layers['surface-lcl-msl'] = { ...frames[2]!.layers['sfc-temp-c']!, value: 3500 };
    frames[2]!.layers['thermal-velocity']!.value = 2.0;
    frames[2]!.layers['cloud-cover-low']!.value = 0;
    frames[2]!.layers['cloud-cover-total']!.value = 95;
    frames[2]!.derived.effectiveCloudLimitM = 3500;
    frames[2]!.derived.cloudCapped = false;
    frames[2]!.derived.overdeveloped = false;
    frames[2]!.derived.buoyancyShearRatio = 0.28;

    const site = createPointForecast(build, point)(build.manifest.frames, new Map(frames.map(f => [f.id, f])));
    const scene = buildWindgramView(site, {
      unitSystem: 'metric',
      compact: false,
      heightRange: 'soaring',
      timeZone: site.site.timeZone,
      hours: site.hours,
    });
    const svg = renderWindgramSvg(scene);

    // Chart SVG renders patterned SCT/BKN & solid OVC stratiform decks, Cu base glyph (no vertical tower boxes), and HI OVC cirrus badge!
    expect(svg).toContain('class="wg-cloud-deck-sct"');
    expect(svg).toContain('class="wg-cloud-deck-ovc"');
    expect(svg).toContain('data-cumulus="cu"');
    expect(svg).not.toContain('data-cu-tower=');
    expect(svg).toContain('data-sky-high="true"');
    expect(svg).toContain('>HI OVC<');

    // Direct multi-layer analysis verification on Hour 0
    const h0Analysis = analyzeHourCloudLayers(site.hours[0], hourSampling(site.hours[0]!), scene.topM);
    expect(h0Analysis.layers).toHaveLength(2);
    expect(h0Analysis.layers[0]!.saturated).toBe(true);
    expect(h0Analysis.layers[1]!.saturated).toBe(false);

    // Bind tile-2x2 and verify hover states across all 3 hours
    const climbSub = new FakeElement('text');
    const skyCodeEl = new FakeElement('text');
    const cloudText = new FakeElement('text');
    const cloudBg = new FakeElement('rect');
    const hazardEl = new FakeElement('text');
    const oktas = [0, 1, 2, 3, 4].map(() => new FakeElement('rect'));
    const tileMap = new Map<string, FakeElement>([
      ['[data-tile-climb-sub]', climbSub],
      ['[data-tile-sky-code]', skyCodeEl],
      ['[data-tile-cloud-text]', cloudText],
      ['[data-tile-cloud-bg]', cloudBg],
      ['[data-tile-hazard]', hazardEl],
      ...oktas.map((el, i) => [`[data-tile-okta="${i}"]`, el] as const),
    ]);
    const bound = getWindgramCalloutRenderer('tile-2x2').bind({
      querySelector: (sel: string) => tileMap.get(sel) ?? null,
    } as unknown as ParentNode);
    const dummyTel = {
      timeChip: '12:00 PM', altChip: '', snappedToTol: false, canSnapToTol: false,
      calloutBadge: 'ALT', calloutMeteo: '', calloutSoar: '', hasPositiveClimb: false,
    };

    // a) Hour 0 at 1,820 m (inside lower saturated OVC stratus): 'OVC 100%' + '☁ In cloud · ... m'
    const inLowOvc = readWindgram(scene, 0, 1820);
    bound.paint({ aglText: '320 m AGL', mslText: '1,820 m MSL', useTol: false, telemetry: dummyTel, reading: inLowOvc, unitSystem: 'metric' });
    expect(skyCodeEl.textContent).toBe('OVC 100%');
    expect(cloudText.textContent).toMatch(/^☁ In cloud · \d+ m$/);
    expect(cloudBg.getAttribute('class')).toContain('is-cloud');

    // b) Hour 0 at 2,250 m (clear VMC slot between low OVC deck and mid SCT/BKN deck): '2 LYR' + 'Clear · Base +...' + 'Dry · 2 layers' when precip is 0
    const betweenLayers = readWindgram(scene, 0, 2250);
    bound.paint({ aglText: '750 m AGL', mslText: '2,250 m MSL', useTol: false, telemetry: dummyTel, reading: { ...betweenLayers, precipitationMmHr: 0 }, unitSystem: 'metric' });
    expect(skyCodeEl.textContent).toBe('2 LYR');
    expect(cloudText.textContent).toMatch(/^Clear · Base \+\d+ m$/);
    expect(cloudBg.getAttribute('class')).not.toContain('is-cloud');
    expect(hazardEl.textContent).toBe('Dry · 2 layers');

    // c) Hour 0 at 2,850 m (inside upper non-saturated altocumulus band): '☁ SCT/BKN deck · ... m'
    const inMidDeck = readWindgram(scene, 0, 2850);
    bound.paint({ aglText: '1,350 m AGL', mslText: '2,850 m MSL', useTol: false, telemetry: dummyTel, reading: inMidDeck, unitSystem: 'metric' });
    expect(cloudText.textContent).toMatch(/^☁ (SCT|BKN) deck · \d+ m$/);
    expect(cloudBg.getAttribute('class')).toContain('is-cloud');

    // d) Hour 1 below Cu base (1,850 m), at ★ TOL Cu base (2,200 m), and inside towering Cu (2,650 m)
    const belowCu = readWindgram(scene, 1, 1850);
    bound.paint({ aglText: '350 m AGL', mslText: '1,850 m MSL', useTol: false, telemetry: dummyTel, reading: belowCu, unitSystem: 'metric' });
    expect(skyCodeEl.textContent).toBe('SCT 38%');
    expect(cloudText.textContent).toBe('Clear · Base +350 m');

    const atCuTol = readWindgram(scene, 1, 2200);
    bound.paint({ aglText: '700 m AGL', mslText: '2,200 m MSL', useTol: true, telemetry: dummyTel, reading: atCuTol, unitSystem: 'metric' });
    expect(climbSub.textContent).toBe('▲ Cu base');
    expect(cloudText.textContent).toBe('Cu base · 1,250 m deep');
    expect(hazardEl.textContent).toBe('⚠ Cloud suck');

    const inCuTower = readWindgram(scene, 1, 2650);
    bound.paint({ aglText: '1,150 m AGL', mslText: '2,650 m MSL', useTol: false, telemetry: dummyTel, reading: inCuTower, unitSystem: 'metric' });
    expect(climbSub.textContent).toBe('☁ In Cu tower');
    expect(skyCodeEl.textContent).toBe('SCT Cu');
    expect(cloudText.textContent).toBe('☁ In Cu · 1,250 m deep');
    expect(hazardEl.textContent).toBe('⚠ Cloud suck');

    // e) Hour 2 at 1,900 m (sheared thermal under 95% high cirrus only): 'HI 95%' + 'Clear · High cirrus' + '▲ Sheared lift' + 'B/S 3 · Sheared'
    const underHighCirrus = readWindgram(scene, 2, 1900);
    bound.paint({ aglText: '400 m AGL', mslText: '1,900 m MSL', useTol: false, telemetry: dummyTel, reading: underHighCirrus, unitSystem: 'metric' });
    expect(skyCodeEl.textContent).toBe('HI 95%');
    expect(cloudText.textContent).toBe('Clear · High cirrus');
    expect(oktas[0]!.getAttribute('class')).toContain('is-high');
    expect(climbSub.textContent).toBe('▲ Sheared lift');
    expect(hazardEl.textContent).toBe('B/S 3 · Sheared');
  });

  it('recovers physical liquid RH and dewpoint on GFS cold clouds without false Icing risk', () => {
    const cascades = { lat: 47.25, lon: -121.75 };
    const { build: retainedBuild, profile: retainedProfile } = fixture([18, 21], 2);

    // Frame 0: Nov 22 18Z GFS f018 at 600 hPa (4,159 m): liquid-vapor-pressure dewpoint from 99.58% GFS RH (~85.41% liquid RH)
    retainedProfile.frames[0]!.profile.modelTerrainM = 1200;
    retainedProfile.frames[0]!.layers['sfc-temp-c']!.value = 2;
    retainedProfile.frames[0]!.layers['sfc-dewpoint-c'] = { ...retainedProfile.frames[0]!.layers['sfc-temp-c']!, value: -2 };
    retainedProfile.frames[0]!.profile.levels = [
      { pressureHpa: 850, heightM: 1500, temperatureC: -2, dewPointC: dewpointFromTempAndRhC(-2, 70), uWindMps: 6, vWindMps: 0, omegaPaS: 0 },
      { pressureHpa: 600, heightM: 4159, temperatureC: -17.72, dewPointC: dewpointFromGfsV16RhC(-17.72, 99.58), uWindMps: 14, vWindMps: 0, omegaPaS: 0 },
    ];
    // Frame 1: Cascades -19.82 °C with 95.12% GFS RH -> 78.29% liquid RH
    retainedProfile.frames[1]!.profile.modelTerrainM = 1200;
    retainedProfile.frames[1]!.profile.levels = [
      { pressureHpa: 850, heightM: 1500, temperatureC: -3, dewPointC: dewpointFromTempAndRhC(-3, 70), uWindMps: 6, vWindMps: 0, omegaPaS: 0 },
      { pressureHpa: 600, heightM: 4170, temperatureC: -19.82, dewPointC: dewpointFromGfsV16RhC(-19.82, 95.12), uWindMps: 15, vWindMps: 0, omegaPaS: 0 },
    ];

    const retainedSite = createPointForecast(retainedBuild, cascades)(
      retainedBuild.manifest.frames,
      new Map(retainedProfile.frames.map(f => [f.id, f])),
    );
    const retainedView = buildWindgramView(retainedSite, {
      unitSystem: 'metric', compact: false, heightRange: 'full', timeZone: retainedSite.site.timeZone, hours: retainedSite.hours,
    });

    const f018 = readWindgram(retainedView, 0, 4159);
    expect(f018.relativeHumidityPercent!).toBeCloseTo(85.41, 1);
    expect(f018.cloudHumidityPercent!).toBeGreaterThanOrEqual(94);
    expect(f018.dewPointC!).toBeLessThan(-19.5);

    const archived600 = readWindgram(retainedView, 1, 4170);
    expect(archived600.relativeHumidityPercent!).toBeCloseTo(78.4, 0);
    expect(archived600.cloudHumidityPercent!).toBeGreaterThanOrEqual(94);

    // Tile callout shows cold-cloud evidence without Icing risk at both heights
    const cloudText = new FakeElement('text');
    const hazardEl = new FakeElement('text');
    const bound = getWindgramCalloutRenderer('tile-2x2').bind({
      querySelector: (sel: string) => (sel === '[data-tile-cloud-text]' ? cloudText : sel === '[data-tile-hazard]' ? hazardEl : null),
    } as unknown as ParentNode);
    const dummyTel = { timeChip: '07:00', altChip: '', snappedToTol: false, canSnapToTol: false, calloutBadge: 'ALT', calloutMeteo: '', calloutSoar: '', hasPositiveClimb: false };
    for (const r of [f018, archived600]) {
      bound.paint({ aglText: '2,960 m AGL', mslText: '4,160 m MSL', useTol: false, telemetry: dummyTel, reading: { ...r, precipitationMmHr: 0 }, unitSystem: 'metric' });
      expect(cloudText.textContent).toContain('☁ Cold cloud');
      expect(hazardEl.textContent).not.toContain('Icing');
    }
  });
});
