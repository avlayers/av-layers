import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountWindgram } from './dom.ts';
import { buildWindgramView, createPointForecast, readWindgram } from './model.ts';
import { placeWindgramCallout } from './windgram-callout-placement.ts';
import { FakeElement, fixture, point } from './windgram-test-fixture.ts';

afterEach(() => vi.unstubAllGlobals());

describe('Windgram interaction', () => {
  it('snaps magnetically within 16px of Top of Lift, glides freely beyond 16px, and re-snaps via snapToTol', () => {
    const { build, sample, profile } = fixture([20, 21]);
    const frames = profile.frames.map((frame, i) => ({ ...frame, layers: { ...frame.layers, ...sample.frames[i].layers } }));
    frames[0].layers['usable-lift-msl']!.value = 2100;
    frames[0].layers['usable-lift-agl']!.value = 600;
    frames[0].layers['cloud-cover-total'] = { ...frames[0].layers['sfc-temp-c']!, value: 35 };
    const site = createPointForecast(build, point, {
      siteTerrain: {
        elevationM: 1500,
        status: 'valid',
        interpolated: true,
        surfaceId: 'gfs-fine',
        surface: 'DSM',
        verticalDatum: 'EGM2008',
      },
    })(build.manifest.frames, new Map(frames.map(f => [f.id, f])));
    const scene = buildWindgramView(site, { unitSystem: 'metric', compact: false, timeZone: site.site.timeZone, hours: site.hours });
    const cursor = new FakeElement('g');
    const tolRing = new FakeElement('circle');
    const badge = new FakeElement('text');
    const agl = new FakeElement('text');
    const msl = new FakeElement('text');
    const meteo = new FakeElement('text');
    const soar = new FakeElement('text');
    const markers = new Map([
      ['[data-windgram-cursor]', cursor],
      ['[data-cursor-tol-ring]', tolRing],
      ['[data-cursor-badge]', badge],
      ['[data-cursor-agl]', agl],
      ['[data-cursor-msl]', msl],
      ['[data-cursor-meteo]', meteo],
      ['[data-cursor-soar]', soar],
    ]);
    const svg = {
      querySelector: (selector: string) => markers.get(selector) ?? null,
      getScreenCTM: () => ({ inverse: () => ({}) }),
    };
    const host = Object.assign(new FakeElement('div'), {
      ownerDocument: {},
      querySelector: (selector: string) => (selector === 'svg.windgram' ? svg : null),
      getBoundingClientRect: () => ({ left: 0, top: 0, right: scene.width, bottom: scene.height }),
    });
    vi.stubGlobal('DOMPoint', class {
      constructor(readonly x: number, readonly y: number) {}
      matrixTransform() { return this; }
    });
    const telemetries: import('./windgram-readout.ts').WindgramTelemetryStrip[] = [];
    const chart = mountWindgram(host as unknown as HTMLElement, {
      view: scene,
      idPrefix: 'magnetic-card',
      selectedValidAt: scene.hours[0].validAt,
      inspectionMode: 'magnetic',
      onTelemetry: item => { if (item) telemetries.push(item); },
    });

    // Initial selection defaults onto cloud-capped Top of Lift (2100 m < 2500 m thermal top) with concise badge, cardinal wind, TOL climb, and cloud %.
    expect(badge.textContent).toBe('★ TOP OF LIFT');
    expect(badge.textContent).not.toContain('drag');
    expect(agl.textContent).toBe('600 m AGL');
    expect(agl.textContent).not.toContain('model AGL');
    expect(meteo.textContent).not.toMatch(/\(\d+°\)/);
    expect(soar.textContent).toMatch(/Climb \+\d+\.\d m\/s · Cloud 35%/);
    expect(tolRing.getAttribute('visibility')).toBe('hidden');
    expect(telemetries.at(-1)?.snappedToTol).toBe(true);

    const tolRatio = (2100 - scene.floorM) / (scene.topM - scene.floorM);
    const tolY = scene.bottom - tolRatio * scene.plotHeight;

    // Hovering within 16px vertically of TOL snaps onto TOL.
    host.dispatchEvent(Object.assign(new Event('pointermove'), {
      pointerType: 'mouse', pointerId: 1, clientX: scene.hours[0].x, clientY: tolY - 11,
    }));
    expect(badge.textContent).toBe('★ TOP OF LIFT');
    expect(agl.textContent).toBe('600 m AGL');
    expect(tolRing.getAttribute('visibility')).toBe('hidden');

    // Dragging within the convective layer (>16px below TOL) shows stronger mid-layer climb rate and cloud %.
    const midThermalRatio = (1800 - scene.floorM) / (scene.topM - scene.floorM);
    const midThermalY = scene.bottom - midThermalRatio * scene.plotHeight;
    host.dispatchEvent(Object.assign(new Event('pointerdown'), {
      pointerType: 'touch', pointerId: 2, isPrimary: true, clientX: scene.hours[0].x, clientY: tolY,
    }));
    host.dispatchEvent(Object.assign(new Event('pointermove'), {
      pointerType: 'touch', pointerId: 2, isPrimary: true, clientX: scene.hours[0].x, clientY: midThermalY,
    }));
    host.dispatchEvent(Object.assign(new Event('pointerup'), {
      pointerType: 'touch', pointerId: 2, isPrimary: true, clientX: scene.hours[0].x, clientY: midThermalY,
    }));
    expect(badge.textContent).toBe('ALTITUDE');
    expect(badge.textContent).not.toContain('drag');
    expect(agl.textContent).toMatch(/^\d+ m AGL$/);
    expect(agl.textContent).not.toContain('model AGL');
    expect(tolRing.getAttribute('visibility')).toBe('visible');
    expect(meteo.textContent).not.toMatch(/\(\d+°\)/);
    expect(soar.textContent).toMatch(/Climb \+\d+\.\d m\/s · Cloud 35%/);
    expect(telemetries.at(-1)?.canSnapToTol).toBe(true);
    expect(telemetries.at(-1)?.altChip).toContain('↺ TOL');

    // Uncapped dry TOL hour (frame 1) in imperial formats Peak +XXX fpm.
    const imperialScene = buildWindgramView(site, { unitSystem: 'imperial', compact: false, timeZone: site.site.timeZone, hours: site.hours });
    const imperialReading = readWindgram(imperialScene, 1, imperialScene.hours[1].usableLiftTopM!);
    expect(imperialReading.peakClimbMps).toBeGreaterThan(0);

    // Tapping the ↺ TOL chip action snaps right back onto Top of Lift.
    chart.snapToTol();
    expect(badge.textContent).toBe('★ TOP OF LIFT');
    expect(agl.textContent).toBe('600 m AGL');
    expect(tolRing.getAttribute('visibility')).toBe('hidden');
    expect(telemetries.at(-1)?.snappedToTol).toBe(true);

    // Hovering at the very bottom line of the Windgram jumps to 10 m AGL (where 10 m wind & temp start) instead of 0 m AGL.
    const unpinnedChart = mountWindgram(host as unknown as HTMLElement, {
      view: scene,
      idPrefix: 'magnetic-bottom',
      selectedValidAt: scene.hours[0].validAt,
      inspectionMode: 'magnetic',
    });
    host.dispatchEvent(Object.assign(new Event('pointermove'), {
      pointerType: 'mouse', pointerId: 3, clientX: scene.hours[0].x, clientY: scene.bottom,
    }));
    expect(badge.textContent).toBe('ALTITUDE');
    expect(agl.textContent).toBe('10 m AGL');
    expect(meteo.textContent.length).toBeGreaterThan(0);
    unpinnedChart.dispose();
    chart.dispose();
  });

  it('restores the selected map lift card after hover and blur, and clears it on Escape', () => {
    const { sample, view } = fixture([20, 21]);
    sample.frames[1].layers['usable-lift-msl']!.value = 2200;
    sample.frames[1].layers['usable-lift-agl']!.value = 700;
    const scene = view(sample.frames);
    const cursor = new FakeElement('g');
    const agl = new FakeElement('text');
    const msl = new FakeElement('text');
    const markers = new Map([['[data-windgram-cursor]', cursor], ['[data-cursor-agl]', agl], ['[data-cursor-msl]', msl]]);
    const svg = {
      querySelector: (selector: string) => markers.get(selector) ?? null,
      getScreenCTM: () => ({ inverse: () => ({}) })
    };
    const host = Object.assign(new FakeElement('div'), {
      ownerDocument: {},
      querySelector: (selector: string) => selector === 'svg.windgram' ? svg : null,
      getBoundingClientRect: () => ({ left: 0, top: 0, right: scene.width, bottom: scene.height })
    });
    vi.stubGlobal('DOMPoint', class {
      constructor(readonly x: number, readonly y: number) {}
      matrixTransform() { return this; }
    });
    const chart = mountWindgram(host as unknown as HTMLElement, { view: scene, idPrefix: 'lift-card', selectedValidAt: scene.hours[0].validAt });
    const point = (type: string, y = scene.top + 10) => host.dispatchEvent(Object.assign(new Event(type), {
      pointerType: 'mouse', pointerId: 1, clientX: scene.hours[1].x, clientY: y
    }));
    const expectLift = (aglText: string, mslText: string) => {
      expect(cursor.getAttribute('visibility')).toBe('visible');
      expect([agl.textContent, msl.textContent]).toEqual([aglText, mslText]);
    };

    point('pointermove');
    expectLift('700 m AGL', '2200 m MSL');
    point('pointermove', 0);
    expectLift('500 m AGL', '2000 m MSL');
    point('pointermove');
    point('pointerleave');
    expectLift('500 m AGL', '2000 m MSL');
    point('pointerdown');
    point('pointerup');
    host.dispatchEvent(new Event('blur'));
    expectLift('700 m AGL', '2200 m MSL');
    host.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' }));
    point('pointerleave');
    expect(cursor.getAttribute('visibility')).toBe('hidden');
    chart.dispose();
  });

  it('places the floating callout in calm sky pockets away from cursor bullseye and convective dome with hysteresis', () => {
    const bounds = { left: 46, top: 46, right: 616, bottom: 296 };
    const ceilingSamples = [
      { x: 100, ceilingY: 220 },
      { x: 260, ceilingY: 85 },
      { x: 300, ceilingY: 72 },
      { x: 340, ceilingY: 80 },
      { x: 520, ceilingY: 230 },
    ];
    // Cursor at high convective peak (x=300, y=72): callout avoids covering (300, 72) and avoids sitting inside the high dome.
    const peakPlaced = placeWindgramCallout({
      cursorX: 300,
      cursorY: 72,
      width: 178,
      height: 74,
      bounds,
      ceilingSamples,
      preferredSide: 'right',
    });
    const overlapsCursor =
      300 >= peakPlaced.x - 8 && 300 <= peakPlaced.x + 178 + 8 &&
      72 >= peakPlaced.y - 8 && 72 <= peakPlaced.y + 74 + 8;
    expect(overlapsCursor).toBe(false);
    expect(peakPlaced.x).toBeGreaterThanOrEqual(bounds.left + 4);
    expect(peakPlaced.x + 178).toBeLessThanOrEqual(bounds.right - 4);

    // Hysteresis keeps preferredSide steady across symmetric sky pockets.
    const flatSamples = [{ x: 150, ceilingY: 230 }, { x: 450, ceilingY: 230 }];
    const rightPref = placeWindgramCallout({ cursorX: 330, cursorY: 210, width: 178, height: 74, bounds, ceilingSamples: flatSamples, preferredSide: 'right' });
    const leftPref = placeWindgramCallout({ cursorX: 330, cursorY: 210, width: 178, height: 74, bounds, ceilingSamples: flatSamples, preferredSide: 'left' });
    expect(rightPref.side).toBe('right');
    expect(leftPref.side).toBe('left');
  });

  it('keeps visual and accessible altitudes in agreement across same-hour vertical pointer motion and parent container scroll', async () => {
    vi.useFakeTimers();
    try {
      const { build, sample, profile } = fixture([18], 1);
      const frame = { ...profile.frames[0]!, layers: { ...profile.frames[0]!.layers, ...sample.frames[0]!.layers } };
      frame.profile.modelTerrainM = 500;
      frame.layers['usable-lift-msl']!.value = 2400;
      frame.layers['usable-lift-agl']!.value = 1900;
      const site = createPointForecast(build, point, {
        siteTerrain: { elevationM: 500, status: 'valid', interpolated: true, surfaceId: 'gfs-fine', surface: 'DSM', verticalDatum: 'EGM2008' },
      })(build.manifest.frames, new Map([[frame.id, frame]]));
      const scene = buildWindgramView(site, { unitSystem: 'metric', compact: false, timeZone: site.site.timeZone, hours: site.hours });

      let containerOffsetY = 0;
      const agl = new FakeElement('text');
      const readout = new FakeElement('p');
      readout.id = 'scroll-readout';
      const svg = {
        querySelector: (sel: string) => (sel === '[data-cursor-agl]' ? agl : null),
        getScreenCTM: () => ({
          inverse: () => ({ offsetY: containerOffsetY }),
        }),
      };
      const host = Object.assign(new FakeElement('div'), {
        ownerDocument: {},
        querySelector: (sel: string) => (sel === 'svg.windgram' ? svg : null),
        getBoundingClientRect: () => ({
          left: 0,
          top: containerOffsetY,
          right: scene.width,
          bottom: scene.height + containerOffsetY,
        }),
      });
      vi.stubGlobal('DOMPoint', class {
        constructor(readonly x: number, readonly y: number) {}
        matrixTransform(inv: { offsetY?: number }) {
          return new DOMPoint(this.x, this.y - (inv.offsetY ?? 0));
        }
      });

      const telemetries: import('./windgram-readout.ts').WindgramTelemetryStrip[] = [];
      const chart = mountWindgram(host as unknown as HTMLElement, {
        view: scene,
        idPrefix: 'ptr-reg',
        readout: readout as unknown as HTMLElement,
        inspectionMode: 'magnetic',
        onTelemetry: t => { if (t) telemetries.push(t); },
      });

      const yForAgl = (targetAglM: number) => {
        const msl = 500 + targetAglM;
        return scene.bottom - ((msl - scene.floorM) / (scene.topM - scene.floorM)) * scene.plotHeight;
      };

      // Move vertically within the same hour from 1,528 m AGL to 982 m AGL
      host.dispatchEvent(Object.assign(new Event('pointermove'), {
        pointerType: 'mouse', pointerId: 1, clientX: scene.hours[0]!.x, clientY: yForAgl(1528),
      }));
      expect(telemetries.at(-1)!.altChip).toContain('1,528 m AGL');
      expect(readout.textContent).toContain('1,528 m AGL');

      host.dispatchEvent(Object.assign(new Event('pointermove'), {
        pointerType: 'mouse', pointerId: 1, clientX: scene.hours[0]!.x, clientY: yForAgl(982),
      }));
      expect(telemetries.at(-1)!.altChip).toContain('982 m AGL');
      vi.advanceTimersByTime(80);
      expect(readout.textContent).toContain('982 m AGL');

      // Shift enclosing container by 70 CSS pixels and point at the exact same chart-relative position
      containerOffsetY = 70;
      host.dispatchEvent(Object.assign(new Event('pointermove'), {
        pointerType: 'mouse', pointerId: 1, clientX: scene.hours[0]!.x, clientY: yForAgl(982) + 70,
      }));
      vi.advanceTimersByTime(80);
      expect(telemetries.at(-1)!.altChip).toContain('982 m AGL');
      expect(readout.textContent).toContain('982 m AGL');

      chart.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
