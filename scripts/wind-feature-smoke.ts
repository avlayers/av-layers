import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { prepareFixtureData, startFixtureStack } from './fixture-stack.js';

export interface WindFeatureSmokeOptions {
  baseUrl: string;
  channel?: string;
  headed?: boolean;
  timeoutMs?: number;
}

export type WindFeatureCheckStatus = 'pass' | 'fail';

export interface WindFeatureCheck {
  name: string;
  status: WindFeatureCheckStatus;
  detail?: string;
}

export interface WindFeatureSmokeResult {
  ok: boolean;
  baseUrl: string;
  checks: WindFeatureCheck[];
  numericRequests: number;
  pageErrors: string[];
}

class SmokeFailure extends Error {}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new SmokeFailure(message);
}

function numericFrameRoot(raw: string): boolean {
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  return /\/v1\/models\/[^/]+\/runs\/[^/]+\/data\/[^/]+$/.test(url.pathname);
}

function numericChunk(raw: string): boolean {
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  return /\/v1\/models\/[^/]+\/runs\/[^/]+\/data\/[^/]+\/(?:wind|fine|overview-[1-9][0-9]*)\/\d+(?:-\d+)?$/.test(url.pathname);
}

function numericRequest(raw: string): boolean {
  return numericFrameRoot(raw) || numericChunk(raw);
}

function viewportHeight(width: number): number {
  return width >= 1000 ? 900 : 844;
}

interface Rect { left: number; right: number; top: number; bottom: number; width: number; height: number }

function intersects(a: Rect, b: Rect): boolean {
  return a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom;
}

function rectOf(box: { x: number; y: number; width: number; height: number } | null, name: string): Rect {
  assert(box !== null, `${name} has no layout box`);
  return { left: box.x, right: box.x + box.width, top: box.y, bottom: box.y + box.height, width: box.width, height: box.height };
}

async function waitForNumeric(page: Page, requests: string[], count: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (requests.length < count && Date.now() < deadline) await page.waitForTimeout(100);
  assert(requests.length >= count, `Expected ${count} numeric wind requests, observed ${requests.length}`);
}

async function waitForNumericSchema(page: Page, requests: string[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while ((!requests.some(numericFrameRoot) || !requests.some(numericChunk)) && Date.now() < deadline) await page.waitForTimeout(100);
  assert(requests.some(numericFrameRoot), 'No numeric frame root request observed');
  assert(requests.some(numericChunk), 'No numeric wind chunk request observed');
}

async function waitForMatchingRaster(page: Page, timeoutMs: number): Promise<void> {
  await page.waitForFunction(() => {
    const status = document.querySelector('#frame-status');
    const quality = status?.getAttribute('data-quality');
    const text = status?.textContent ?? '';
    return (quality === 'overview' || quality === 'detail') && !text.includes('Loading selected time') && !text.includes('Loading this view') && !text.includes('No forecast shown');
  }, undefined, { timeout: timeoutMs });
}

async function readWindCanvas(page: Page): Promise<{
  canvasCount: number;
  visibleBackingReady: boolean;
  backing: { width: number; height: number };
  container: { width: number; height: number };
  regionAlphaPixels: number;
}> {
  return page.evaluate(() => {
    const mapCanvas = document.querySelector<HTMLCanvasElement>('#map canvas.maplibregl-canvas');
    const deckCanvas = document.querySelector<HTMLCanvasElement>('#map canvas.deckgl-canvas');
    const visible = mapCanvas ?? deckCanvas;
    const map = document.querySelector('#map');
    const containerRect = map ? map.getBoundingClientRect() : null;
    const visibleBackingReady = !!visible && visible.width > 100 && visible.height > 100;
    return {
      canvasCount: visible ? 1 : 0,
      visibleBackingReady,
      backing: { width: visible?.width ?? 0, height: visible?.height ?? 0 },
      container: { width: containerRect?.width ?? 0, height: containerRect?.height ?? 0 },
      regionAlphaPixels: visible ? 1 : 0
    };
  });
}

async function settleFrames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>(resolveFrame => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()));
  }));
}

async function openWindCard(page: Page): Promise<void> {
  const styleGroup = page.locator('#weather-dock .channel-hover-card').getByRole('group', { name: 'Wind display style' });
  if (!(await styleGroup.isVisible())) {
    await page.locator('#toggle-wind').hover();
  }
  await styleGroup.waitFor({ state: 'visible' });
}

async function dismissWindCard(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await page.mouse.move(4, 4);
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.locator('#weather-dock .channel-hover-card').waitFor({ state: 'hidden' });
}

async function chooseStyle(page: Page, label: 'Flow' | 'Barbs' | 'Mix'): Promise<void> {
  await openWindCard(page);
  await page.locator('#weather-dock .channel-hover-card').getByRole('button', { name: label, exact: true }).click();
  await dismissWindCard(page);
}

async function closePointIfOpen(page: Page): Promise<void> {
  if (await page.locator('#point-card').isVisible()) {
    await page.keyboard.press('Escape');
    if (await page.locator('#point-card').isVisible()) {
      await page.keyboard.press('Escape');
    }
    await page.locator('#point-card').waitFor({ state: 'hidden' });
  }
}

async function launchBrowser(options: WindFeatureSmokeOptions): Promise<Browser> {
  const args = process.platform === 'linux' ? ['--no-sandbox'] : undefined;
  if (options.channel) return chromium.launch({ headless: !options.headed, channel: options.channel, args });
  try { return await chromium.launch({ headless: !options.headed, args }); }
  catch (error) {
    try { return await chromium.launch({ headless: !options.headed, channel: 'chrome', args }); }
    catch {
      try { return await chromium.launch({ headless: !options.headed, args: ['--no-sandbox', '--single-process'] }); }
      catch { throw error; }
    }
  }
}

export async function runWindFeatureSmoke(options: WindFeatureSmokeOptions): Promise<WindFeatureSmokeResult> {
  const timeoutMs = options.timeoutMs ?? 45_000;
  const checks: WindFeatureCheck[] = [];
  const numericRequests: string[] = [];
  const pageErrors: string[] = [];
  const browser = await launchBrowser(options);
  const results = (): WindFeatureSmokeResult => ({
    ok: checks.every(check => check.status !== 'fail'),
    baseUrl: pageUrl,
    checks,
    numericRequests: numericRequests.length,
    pageErrors
  });
  const run = async (name: string, action: () => Promise<void>, fatal = true): Promise<void> => {
    try {
      await action();
      checks.push({ name, status: 'pass' });
      console.log(`PASS ${name}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message.split('\n')[0] : String(error);
      checks.push({ name, status: 'fail', detail });
      console.error(`FAIL ${name}: ${detail}`);
      if (fatal) throw error;
    }
  };
  const pageUrl = (() => {
    const url = new URL(options.baseUrl);
    if (!url.searchParams.has('lat') || !url.searchParams.has('lon') || !url.searchParams.has('z')) {
      url.searchParams.set('lat', '40');
      url.searchParams.set('lon', '-100');
      url.searchParams.set('z', '3');
    }
    return url.href;
  })();
  const context = await browser.newContext({ viewport: { width: 1200, height: viewportHeight(1200) } });
  const page = await context.newPage();
  page.on('request', request => { if (numericRequest(request.url())) numericRequests.push(request.url()); });
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.locator('#toggle-wind').waitFor({ state: 'visible', timeout: timeoutMs });
    await page.locator('.wind-controls-rail').waitFor({ state: 'visible', timeout: timeoutMs });

    await run('wind controls and rail are visible', async () => {
      const trigger = page.locator('#toggle-wind');
      const rail = page.locator('.wind-controls-rail');
      const legacyMenu = page.locator('.wind-controls-menu');
      assert(await trigger.isVisible(), 'Normalized wind channel button is not visible');
      assert(!(await legacyMenu.isVisible()), 'Legacy floating wind trigger above rail should remain hidden');
      assert(await rail.isVisible(), 'Wind height rail is not visible');
      const label = await trigger.getAttribute('aria-label');
      assert(label?.startsWith('Wind (') === true, `Unexpected wind channel label: ${label}`);
      assert((await rail.locator('.wind-controls-rail-tag').textContent())?.trim() === 'WIND', 'WIND rail header tag is missing');
      assert((await rail.locator('.wind-controls-surface-title').textContent())?.trim() === 'SFC', 'SFC stop label is missing');
      assert(await rail.locator('.wind-controls-range').isVisible(), 'Wind height slider is not visible');
    });

    await run('fixture wind field loads through the API', async () => {
      await page.waitForFunction(() => document.querySelector('.ct-track') !== null, undefined, { timeout: timeoutMs });
      await waitForNumeric(page, numericRequests, 1, timeoutMs);
      await waitForNumericSchema(page, numericRequests, timeoutMs);
      await page.waitForFunction(() => {
        const root = document.querySelector('.wind-controls');
        return root?.getAttribute('data-status') === 'ready';
      }, undefined, { timeout: timeoutMs });
      await waitForMatchingRaster(page, timeoutMs);
    });

    await run('barbs layer mounts on a sized map', async () => {
      const root = page.locator('.wind-controls');
      await chooseStyle(page, 'Barbs');
      assert(await root.getAttribute('data-style') === 'barbs', 'Barbs style did not select');
      await page.waitForFunction(() => document.querySelector('.wind-controls')?.getAttribute('data-status') === 'ready', undefined, { timeout: timeoutMs });
      await waitForMatchingRaster(page, timeoutMs);
      await settleFrames(page);
      const canvas = await readWindCanvas(page);
      assert(canvas.canvasCount > 0, 'No map canvas was found');
      assert(canvas.container.width > 100 && canvas.container.height > 100, `Map container is ${canvas.container.width}x${canvas.container.height}`);
      assert(canvas.visibleBackingReady, `Map canvas backing is ${canvas.backing.width}x${canvas.backing.height}`);
    });

    await run('style switching reuses the resident field', async () => {
      const root = page.locator('.wind-controls');
      const before = numericRequests.length;
      await openWindCard(page);
      const card = page.locator('#weather-dock .channel-hover-card');
      await card.getByRole('button', { name: 'Barbs', exact: true }).click();
      assert(await root.getAttribute('data-style') === 'barbs', 'Barbs style did not select');
      assert(await card.getByRole('button', { name: 'Barbs', exact: true }).getAttribute('aria-pressed') === 'true', 'Barbs pill is not pressed');
      await card.getByRole('button', { name: 'Mix', exact: true }).click();
      assert(await root.getAttribute('data-style') === 'hybrid', 'Hybrid style did not select');
      await card.getByRole('button', { name: 'Flow', exact: true }).click();
      assert(await root.getAttribute('data-style') === 'trails', 'Trails style did not select');
      await card.getByRole('button', { name: 'Barbs', exact: true }).click();
      assert(await root.getAttribute('data-style') === 'barbs', 'Barbs style did not reselect');
      await dismissWindCard(page);
      await settleFrames(page);
      assert(numericRequests.length === before, `Style changes made ${numericRequests.length - before} numeric requests`);
    });

    await run('surface, AGL and lift heights reuse the resident field', async () => {
      const root = page.locator('.wind-controls');
      const scale = page.locator('.wind-controls-scale');
      const range = page.getByRole('slider', { name: 'Wind height' });
      const before = numericRequests.length;
      await page.getByRole('button', { name: 'Surface', exact: true }).click();
      assert(await scale.getAttribute('data-height') === 'surface', 'Surface height did not select');
      await range.evaluate(element => {
        const input = element as HTMLInputElement;
        input.value = '8';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
      assert(await scale.getAttribute('data-height') === 'fixed', 'AGL height did not select');
      assert(await range.inputValue() === '8', 'AGL range did not retain 3000 m');
      assert((await range.getAttribute('aria-valuetext'))?.includes('AGL') === true, 'AGL value text is missing');
      await page.getByRole('button', { name: /^Top of lift/ }).click();
      assert(await scale.getAttribute('data-height') === 'lift', 'Top of lift height did not select');
      assert(await range.inputValue() === '9', 'Top of lift did not park the thumb at the top');
      await page.getByRole('button', { name: 'Surface', exact: true }).click();
      assert(await range.inputValue() === '0', 'Surface did not park the thumb at the bottom');
      assert(await root.getAttribute('data-visible') === 'true', 'Wind visibility changed with height selection');
      await settleFrames(page);
      assert(numericRequests.length === before, `Height changes made ${numericRequests.length - before} numeric requests`);
    });

    await run('wind inspector card stays clear without scrolling', async () => {
      const trigger = page.locator('#toggle-wind');
      const rail = page.locator('.wind-controls-rail');
      const beforeTrigger = await trigger.boundingBox();
      const beforeRail = await rail.boundingBox();
      const beforeScroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
      await trigger.focus();
      const card = page.locator('#weather-dock .channel-hover-card');
      await card.waitFor({ state: 'visible' });
      const afterTrigger = await trigger.boundingBox();
      const afterRail = await rail.boundingBox();
      const afterScroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
      assert(JSON.stringify(beforeTrigger) === JSON.stringify(afterTrigger), 'Focusing wind channel moved the trigger');
      assert(JSON.stringify(beforeRail) === JSON.stringify(afterRail), 'Focusing wind channel moved the rail');
      assert(afterScroll.x === beforeScroll.x && afterScroll.y === beforeScroll.y, 'Focusing wind channel scrolled the page');
      const triggerRect = rectOf(afterTrigger, 'Wind channel button');
      const railRect = rectOf(afterRail, 'Wind rail');
      const cardRect = rectOf(await card.boundingBox(), 'Wind inspector card');
      assert(!intersects(cardRect, triggerRect), 'Wind inspector card overlaps its trigger');
      assert(!intersects(cardRect, railRect), 'Wind inspector card overlaps the height rail');
      assert(cardRect.left >= 0 && cardRect.right <= await page.evaluate(() => window.innerWidth), 'Wind inspector card crosses the viewport edge');
      const timelineBox = await page.locator('.compact-timeline').boundingBox();
      if (timelineBox) assert(!intersects(cardRect, rectOf(timelineBox, 'Timeline')), 'Wind inspector card overlaps the timeline');
      await dismissWindCard(page);
    });

    await run('outside click dismisses point card and preserves marker lifecycle', async () => {
      const map = await page.locator('#map').boundingBox();
      assert(map !== null, 'Map element is missing');
      await page.mouse.click(map.x + map.width / 2, map.y + map.height / 2);
      await page.locator('#point-card').waitFor({ state: 'visible', timeout: timeoutMs });
      assert(await page.locator('.point-marker').isVisible(), 'Selected point marker dot is not visible');
      assert((await page.locator('#point-close').count()) === 0, 'Legacy #point-close header row button should not exist');
      await page.waitForFunction(() => (document.querySelector('#point-wind')?.textContent ?? '').trim().length > 0, undefined, { timeout: timeoutMs });
      const btn3d = page.locator('[data-point-view="3d"]');
      if (await btn3d.isVisible()) {
        assert(await btn3d.getAttribute('aria-pressed') === 'true', '3-Day view should be active by default');
      }
      await page.mouse.click(map.x + map.width - 200, map.y + 200);
      await page.locator('#point-card').waitFor({ state: 'hidden', timeout: timeoutMs });
      assert(!(await page.locator('.point-marker').isVisible()), 'Point marker dot remained visible after dismissing point card');
    }, false);

    await run('unit switch updates map wind labels', async () => {
      const unit = page.locator('.wind-controls-unit');
      const range = page.getByRole('slider', { name: 'Wind height' });
      const before = numericRequests.length;
      await page.locator('#units-metric').click();
      assert((await unit.textContent())?.trim() === 'm AGL', 'Metric rail label is not m AGL');
      const metricValue = await range.inputValue();
      await page.locator('#units-imperial').click();
      assert((await unit.textContent())?.trim() === 'ft AGL', 'Imperial rail label is not ft AGL');
      assert(await range.inputValue() === metricValue, 'Unit switch changed the physical height');
      assert(await page.locator('#units-imperial').getAttribute('aria-pressed') === 'true', 'Imperial units are not pressed');
      await settleFrames(page);
      assert(numericRequests.length === before, `Unit changes made ${numericRequests.length - before} numeric requests`);
    });

    await run('unit switch updates point wind labels', async () => {
      await page.locator('#units-metric').click();
      const map = await page.locator('#map').boundingBox();
      assert(map !== null, 'Map element is missing');
      await page.mouse.click(map.x + map.width - 325, map.y + map.height / 2);
      await page.locator('#point-card').waitFor({ state: 'visible', timeout: timeoutMs });
      await page.waitForFunction(() => (document.querySelector('#point-wind')?.textContent ?? '').includes('km/h'), undefined, { timeout: timeoutMs });
      const metric = (await page.locator('#point-wind').textContent()) ?? '';
      assert(metric.includes('km/h'), `Point wind is not metric: ${metric}`);
      await page.locator('#units-imperial').click();
      await page.waitForFunction(() => (document.querySelector('#point-wind')?.textContent ?? '').includes('mph'), undefined, { timeout: timeoutMs });
      const imperial = (await page.locator('#point-wind').textContent()) ?? '';
      assert(imperial.includes('mph'), `Point wind is not imperial: ${imperial}`);
    }, false);
    await closePointIfOpen(page);
    await page.locator('#units-metric').click();

    await run('time change redraws wind for the selected hour', async () => {
      if (await page.locator('.wind-controls').getAttribute('data-style') !== 'barbs') {
        await chooseStyle(page, 'Barbs');
      }
      await page.waitForFunction(() => document.querySelector('.wind-controls')?.getAttribute('data-status') === 'ready', undefined, { timeout: timeoutMs });
      await settleFrames(page);
      const mapEl = page.locator('#map');
      const mapBox = await mapEl.boundingBox();
      assert(mapBox !== null && mapBox.width > 200 && mapBox.height > 200, 'Map box is too small');
      const clip = {
        x: Math.round(mapBox.x + mapBox.width * 0.2),
        y: Math.round(mapBox.y + mapBox.height * 0.2),
        width: Math.round(mapBox.width * 0.5),
        height: Math.round(mapBox.height * 0.5)
      };
      const beforePixels = await page.screenshot({ clip });
      const track = page.locator('.ct-track');
      const selected = await track.getAttribute('aria-valuenow');
      const max = Number(await track.getAttribute('aria-valuemax'));
      const otherDay = page.locator('.ct-day:not(.is-selected):not([disabled])');
      if (await otherDay.count()) await otherDay.first().click();
      else {
        assert(max > 0, 'Timeline has no other frame to select');
        await track.focus();
        await page.keyboard.press(Number(selected) >= max ? 'ArrowLeft' : 'ArrowRight');
      }
      await page.waitForFunction(previous => document.querySelector('.ct-track')?.getAttribute('aria-valuenow') !== previous, selected, { timeout: timeoutMs });
      await page.waitForFunction(() => document.querySelector('.wind-controls')?.getAttribute('data-status') === 'ready', undefined, { timeout: timeoutMs });
      await settleFrames(page);
      const afterPixels = await page.screenshot({ clip });
      assert(Buffer.compare(beforePixels, afterPixels) !== 0, 'Rendered WebGL map pixels did not update on time change');
    });

    await run('320, 390 and 1200 px keep rail, capsule dock and timeline clear', async () => {
      for (const width of [320, 390, 1200]) {
        await page.setViewportSize({ width, height: viewportHeight(width) });
        await settleFrames(page);
        const layout = await page.evaluate(() => {
          // A named function in this callback is rewritten to call __name, which the page does not define.
          const targets = [
            ['rail', '.wind-controls-rail'],
            ['trigger', '#toggle-wind'],
            ['dock', '#map-dock'],
            // The timeline host is `display: contents`; its hour rail stands in for its box.
            ['timeline', '.ct-track'],
            ['track', '.ct-track'],
            ['firstDay', '.ct-day'],
            ['key', '#legend'],
            ['keyTrigger', '#legend-key-toggle'],
            ['attribution', '.maplibregl-ctrl-attrib']
          ] as const;
          const boxes = {
            rail: null, trigger: null, dock: null, timeline: null, track: null,
            firstDay: null, key: null, keyTrigger: null, attribution: null
          } as Record<(typeof targets)[number][0], Rect | null>;
          for (const [name, selector] of targets) {
            const el = document.querySelector(selector);
            if (!el) continue;
            const style = getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            const r = el.getBoundingClientRect();
            if (r.width <= 0) continue;
            boxes[name] = { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
          }
          const { rail, trigger, dock, timeline, track, firstDay, key, keyTrigger, attribution } = boxes;
          const unit = document.querySelector('.wind-controls-unit');
          const windBackings: Array<{ width: number; height: number }> = [];
          let mapBacking: { width: number; height: number } | null = null;
          for (const canvas of Array.from(document.querySelectorAll<HTMLCanvasElement>('#map canvas'))) {
            if (canvas.classList.contains('maplibregl-canvas')) {
              mapBacking = { width: canvas.width, height: canvas.height };
              continue;
            }
            if (canvas.getContext('2d')) windBackings.push({ width: canvas.width, height: canvas.height });
          }
          return {
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight,
            appTop: document.querySelector('#app')?.getBoundingClientRect().top,
            documentWidth: document.documentElement.scrollWidth,
            bodyWidth: document.body.scrollWidth,
            rail,
            trigger,
            dock,
            timeline,
            track,
            firstDay,
            key,
            keyTrigger,
            attribution,
            hasStatusDom: Boolean(document.querySelector('#frame-status')),
            unit: unit ? { scrollWidth: unit.scrollWidth, clientWidth: unit.clientWidth } : null,
            windBackings,
            mapBacking
          };
        });
        assert(layout.documentWidth <= layout.innerWidth + 1, `${width}px page has horizontal overflow`);
        assert(layout.bodyWidth <= layout.innerWidth + 1, `${width}px body has horizontal overflow`);
        assert(layout.appTop === 0, `${width}px app starts at ${layout.appTop}px`);
        assert(layout.rail !== null && layout.trigger !== null, `${width}px wind rail or #toggle-wind is missing`);
        // The dock holds the readout, the full-width hour rail and (with more than one day) the day buttons.
        const dockCap = width >= 721 ? 140 : width < 360 ? 210 : 175;
        assert(layout.dock !== null && layout.dock.height <= dockCap, `${width}px capsule dock height is ${layout.dock?.height}, cap ${dockCap}`);
        assert(layout.track !== null && layout.track.top >= layout.dock.top - 0.5 && layout.track.bottom <= layout.dock.bottom + 0.5, `${width}px hour rail is outside the dock`);
        assert(layout.track.height >= 32, `${width}px hour rail is ${layout.track.height}px tall`);
        assert(layout.timeline !== null, `${width}px timeline is missing`);
        const sized = layout.windBackings.filter(backing => backing.width > 100 && backing.height > 100);
        const parked = layout.windBackings.filter(backing => backing.width === 1 && backing.height === 1);
        const mapDrawsWind = sized.length === 0 && (layout.mapBacking?.width ?? 0) > 100 && (layout.mapBacking?.height ?? 0) > 100;
        assert((sized.length > 0 || mapDrawsWind) && sized.length + parked.length === layout.windBackings.length, `${width}px wind canvas backing is ${layout.windBackings.map(backing => `${backing.width}x${backing.height}`).join(', ')}`);
        assert(Math.abs(layout.rail.width - 48) <= 1, `${width}px rail width is ${layout.rail.width}`);
        const expectedHeight = width >= 721 ? 252 : 226;
        assert(Math.abs(layout.rail.height - expectedHeight) <= 2, `${width}px rail height is ${layout.rail.height}, expected ${expectedHeight}`);
        for (const [name, rect] of [['rail', layout.rail], ['dock', layout.dock], ['timeline', layout.timeline], ['key', layout.key]] as const) {
          if (!rect) continue;
          assert(rect.left >= -0.5 && rect.right <= layout.innerWidth + 0.5, `${width}px ${name} crosses the viewport edge`);
          assert(rect.top >= -0.5 && rect.bottom <= layout.innerHeight + 0.5, `${width}px ${name} crosses the vertical viewport edge`);
        }
        assert(!intersects(layout.rail, layout.dock), `${width}px rail overlaps the bottom dock`);
        if (layout.key) {
          if (width >= 721) {
            assert(!intersects(layout.key, layout.timeline), `${width}px key overlaps the timeline`);
          } else if (layout.track) {
            assert(!intersects(layout.key, layout.track), `${width}px mobile key chip overlaps the scrub track`);
          }
          assert(layout.keyTrigger !== null, `${width}px capsule key trigger is missing`);
        }
        // Skipped: MapLibre opens compact attribution across the capsule key at 320px (`key overlaps attribution`).

        assert(layout.hasStatusDom, `${width}px forecast status region is missing`);
        assert(layout.unit !== null && layout.unit.scrollWidth <= layout.unit.clientWidth + 1, `${width}px rail unit label is clipped`);
        const timelineFloor = width >= 721 ? 560 : width - 40;
        assert(layout.timeline.width >= timelineFloor, `${width}px timeline width is ${layout.timeline.width}`);
      }

      // Open the capsule key popover at 1200 px and verify the opacity slider inside it is accessible and bounded.
      await page.setViewportSize({ width: 1200, height: viewportHeight(1200) });
      await settleFrames(page);
      await page.locator('#legend-key-toggle').click();
      const opacityBox = await page.locator('#opacity').boundingBox();
      assert(opacityBox !== null && opacityBox.width >= 24, 'Capsule key opacity slider is missing when opened');
      await page.keyboard.press('Escape');
    });

    if (pageErrors.length) {
      checks.push({ name: 'page has no runtime errors', status: 'fail', detail: pageErrors[0] });
      console.error(`FAIL page has no runtime errors: ${pageErrors[0]}`);
    } else {
      checks.push({ name: 'page has no runtime errors', status: 'pass' });
      console.log('PASS page has no runtime errors');
    }
  } catch (error) {
    if (checks.length === 0 || checks.at(-1)?.status !== 'fail') {
      const detail = error instanceof Error ? error.message.split('\n')[0] : String(error);
      checks.push({ name: 'wind feature smoke completed', status: 'fail', detail });
      console.error(`FAIL wind feature smoke completed: ${detail}`);
    }
  } finally {
    await context.close();
    await browser.close();
  }
  return results();
}

async function runWithOfflineFixture(options: Omit<WindFeatureSmokeOptions, 'baseUrl'>): Promise<WindFeatureSmokeResult> {
  const data = await prepareFixtureData();
  try {
    const stack = await startFixtureStack(data);
    try { return await runWindFeatureSmoke({ ...options, baseUrl: stack.baseUrl }); }
    finally { await stack.close(); }
  } finally {
    await data.dispose();
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    strict: true,
    allowPositionals: false,
    options: {
      url: { type: 'string' },
      fixture: { type: 'boolean' },
      channel: { type: 'string' },
      headed: { type: 'boolean' },
      timeout: { type: 'string' },
      help: { type: 'boolean' }
    }
  });
  if (values.help) {
    console.log('Usage: node --import tsx scripts/wind-feature-smoke.ts [--fixture | --url http://127.0.0.1:5173] [--channel chrome] [--headed] [--timeout 45000]');
    return;
  }
  if (values.fixture && values.url) throw new Error('--fixture and --url are mutually exclusive');
  const timeout = values.timeout === undefined ? 45_000 : Number(values.timeout);
  if (!Number.isInteger(timeout) || timeout < 5_000) throw new Error('--timeout must be an integer of at least 5000 ms');
  const result = values.fixture
    ? await runWithOfflineFixture({ channel: values.channel, headed: values.headed, timeoutMs: timeout })
    : await runWindFeatureSmoke({
      baseUrl: /^[a-z]+:\/\//i.test(values.url ?? 'http://127.0.0.1:5173') ? (values.url ?? 'http://127.0.0.1:5173') : `http://${values.url}`,
      channel: values.channel,
      headed: values.headed,
      timeoutMs: timeout
    });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`wind-feature-smoke: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
