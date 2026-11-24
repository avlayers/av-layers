/**
 * Screenshot parity between two checkouts on the synthetic offline fixture.
 *
 *   node --import tsx scripts/visual-check.ts --baseline ../avl-baseline --out output/visual
 *
 * Generates the fixture once, serves it from the baseline checkout and from this
 * checkout in turn, captures every theme × layer × viewport case with motion reduced,
 * and compares each pair with pixelmatch. Exits non-zero when any case differs by
 * more than `--max-diff` (fraction of pixels, default 0.002).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { chromium, type Browser } from 'playwright';
import { prepareFixtureData, startFixtureStack } from './fixture-stack.js';

const LAYER_SETS: Readonly<Record<string, string>> = {
  lift: 'lift=1&clouds=0&rain=0&isobars=0&wind=0',
  clouds: 'lift=0&clouds=1&rain=0&isobars=0&wind=0',
  rain: 'lift=0&clouds=0&rain=1&isobars=0&wind=0',
  isobars: 'lift=0&clouds=0&rain=0&isobars=1&wind=0',
  barbs: 'lift=0&clouds=0&rain=0&isobars=0&wind=1&wstyle=barbs',
  all: 'lift=1&clouds=1&rain=1&isobars=1&wind=1&wstyle=barbs'
};
const VIEWPORTS = { desktop: { width: 1280, height: 800 }, phone: { width: 390, height: 844 } } as const;
const CAMERA = 'lat=40&lon=-100&z=4.5';

export interface VisualCase { theme: string; layers: keyof typeof LAYER_SETS; viewport: keyof typeof VIEWPORTS }

export function visualCases(themes: readonly string[]): VisualCase[] {
  return themes.flatMap(theme => (Object.keys(LAYER_SETS) as (keyof typeof LAYER_SETS)[]).flatMap(layers =>
    (Object.keys(VIEWPORTS) as (keyof typeof VIEWPORTS)[]).map(viewport => ({ theme, layers, viewport }))));
}

const caseName = (c: VisualCase) => `${c.theme}-${c.layers}-${c.viewport}`;

async function capture(browser: Browser, baseUrl: string, cases: readonly VisualCase[], themeParam: (theme: string) => string): Promise<Map<string, Buffer>> {
  const shots = new Map<string, Buffer>();
  for (const c of cases) {
    const context = await browser.newContext({ viewport: VIEWPORTS[c.viewport], deviceScaleFactor: 1, reducedMotion: 'reduce', timezoneId: 'UTC', locale: 'en-US' });
    const page = await context.newPage();
    await page.goto(`${baseUrl}/?${CAMERA}&theme=${themeParam(c.theme)}&${LAYER_SETS[c.layers]}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2_500);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1_000);
    shots.set(caseName(c), await page.screenshot({ animations: 'disabled', caret: 'hide' }));
    await context.close();
  }
  return shots;
}

export function diffFraction(a: Buffer, b: Buffer): { fraction: number; diff: PNG } {
  const left = PNG.sync.read(a), right = PNG.sync.read(b);
  if (left.width !== right.width || left.height !== right.height) return { fraction: 1, diff: new PNG({ width: 1, height: 1 }) };
  const diff = new PNG({ width: left.width, height: left.height });
  const changed = pixelmatch(left.data, right.data, diff.data, left.width, left.height, { threshold: 0.1 });
  return { fraction: changed / (left.width * left.height), diff };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ strict: true, allowPositionals: false, options: {
    baseline: { type: 'string' }, out: { type: 'string' }, themes: { type: 'string' },
    alias: { type: 'string', multiple: true }, 'max-diff': { type: 'string' }, keep: { type: 'boolean' }
  } });
  if (!values.baseline) throw new Error('--baseline <checkout> is required');
  const themes = (values.themes ?? 'stone,slate,chart,classic').split(',');
  // --alias old=new captures the baseline with `old` and the candidate with `new`.
  const aliases = new Map((values.alias ?? []).map(pair => pair.split('=') as [string, string]));
  const maxDiff = Number(values['max-diff'] ?? '0.002');
  const out = resolve(values.out ?? 'output/visual');
  await mkdir(out, { recursive: true });
  const cases = visualCases(themes);
  const data = await prepareFixtureData();
  const args = process.platform === 'linux' ? ['--no-sandbox'] : undefined;
  const browser = await chromium.launch({ args }).catch(() => chromium.launch({ args, channel: 'chrome' }));
  try {
    const run = async (root: string | undefined, param: (theme: string) => string) => {
      const stack = await startFixtureStack(data, root);
      try { return await capture(browser, stack.baseUrl, cases, param); }
      finally { await stack.close(); }
    };
    const baseline = await run(resolve(values.baseline), theme => [...aliases].find(([, next]) => next === theme)?.[0] ?? theme);
    const candidate = await run(undefined, theme => theme);
    const report: { case: string; fraction: number; ok: boolean }[] = [];
    for (const c of cases) {
      const name = caseName(c), a = baseline.get(name)!, b = candidate.get(name)!;
      const { fraction, diff } = diffFraction(a, b);
      const ok = fraction <= maxDiff;
      report.push({ case: name, fraction: Number(fraction.toFixed(5)), ok });
      if (!ok || values.keep) {
        await writeFile(join(out, `${name}.baseline.png`), a);
        await writeFile(join(out, `${name}.candidate.png`), b);
        await writeFile(join(out, `${name}.diff.png`), PNG.sync.write(diff));
      }
    }
    await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
    const failed = report.filter(r => !r.ok);
    console.log(`${report.length - failed.length}/${report.length} cases within ${maxDiff}`);
    for (const r of failed) console.log(`DIFF ${r.case} ${r.fraction}`);
    process.exitCode = failed.length ? 1 : 0;
  } finally {
    await browser.close();
    await data.dispose();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(`visual-check: ${error instanceof Error ? error.stack ?? error.message : String(error)}`); process.exitCode = 1; });
}
