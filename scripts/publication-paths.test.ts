import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { PRODUCER_SOURCE_PATHS } from '../apps/batch/src/identity.js';
import { FORECAST_WORKFLOW_PATHS, PUBLICATION_PATHS, PUBLISHER_SCRIPTS } from './publication-workflow.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
/** Static and dynamic imports, plus files located with `new URL('./x', import.meta.url)` (workers, data). */
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bnew URL\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
const SOURCE = /\.(?:[cm]?[jt]s)$/;

function resolveImport(from: string, specifier: string): string {
  const path = normalize(join(dirname(from), specifier));
  const ts = path.replace(/\.js$/, '.ts');
  return path.endsWith('.js') && existsSync(join(ROOT, ts)) ? ts : path;
}
function imports(path: string): string[] {
  return [...readFileSync(join(ROOT, path), 'utf8').matchAll(IMPORT)].map(match => resolveImport(path, match[1]!));
}
function files(directory: string): string[] {
  return readdirSync(join(ROOT, directory), { withFileTypes: true }).flatMap(entry => entry.name === 'node_modules' || entry.name === 'dist' ? []
    : entry.isDirectory() ? files(join(directory, entry.name)) : SOURCE.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [join(directory, entry.name)] : []);
}
/** `scripts/` files the forecast workflows name directly, or start through a package.json script they call. */
function entryScripts(): string[] {
  const workflows = ['.github/workflows/forecast.yml', '.github/workflows/forecast-model.yml', '.github/actions/setup/action.yml'];
  const text = workflows.map(path => readFileSync(join(ROOT, path), 'utf8')).join('\n');
  const { scripts } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  const operations = readFileSync(join(ROOT, 'scripts/operations.ts'), 'utf8');
  const called = new Set([...text.matchAll(/\bpnpm (?:run )?([\w:-]+)/g), ...operations.matchAll(/\bpnpm\(\[\s*'([\w:-]+)'/g)].map(match => match[1]!));
  const commands = [text, ...[...called].flatMap(name => scripts[name] ?? [])].join('\n');
  return [...new Set([...commands.matchAll(/\bscripts\/[\w./-]+\.(?:[cm]?[jt]s)\b/g)].map(match => match[0]))];
}

it('lists exactly the scripts that forecast workflows run and import', () => {
  const closure = new Set<string>(), pending = entryScripts();
  expect(pending).toEqual(expect.arrayContaining(['scripts/operations.ts', 'scripts/forecast-dispatch.ts', 'scripts/workflow-models.ts', 'scripts/setup-pmtiles.mjs']));
  // Producer code outside scripts/ may import a script too (the terrain CLI imports operations.ts).
  const producerRoots = PRODUCER_SOURCE_PATHS.filter(path => path !== 'scripts' && existsSync(join(ROOT, path)) && !SOURCE.test(path) && !path.endsWith('.json') && !path.endsWith('.yaml'));
  for (const path of [...producerRoots, 'packages/client'].flatMap(files)) pending.push(...imports(path).filter(target => target.startsWith('scripts/')));
  while (pending.length) {
    const path = pending.pop()!;
    if (closure.has(path)) continue;
    expect(existsSync(join(ROOT, path)), path).toBe(true);
    closure.add(path);
    pending.push(...imports(path).filter(target => target.startsWith('scripts/')));
  }
  expect([...PUBLISHER_SCRIPTS].sort()).toEqual([...closure].sort());
});

it('ignores bench, smoke, test and Markdown changes but not producer, client or forecast workflow changes', () => {
  const relevant = ['apps/api/wrangler.json', '.npmrc', 'scripts/publication-workflow.ts', 'scripts/setup-pmtiles.mjs', 'apps/batch/src/render.ts', 'apps/batch/pmtiles.json',
    'packages/contracts/config/models.json', 'packages/client/src/client-api.ts', 'package.json', 'pnpm-lock.yaml',
    '.github/workflows/forecast.yml', '.github/workflows/forecast-model.yml', '.github/actions/setup/action.yml'];
  const ignored = ['scripts/preview-layer-bench.ts', 'scripts/wind-feature-smoke.ts', 'scripts/publication-workflow.test.ts', 'apps/batch/src/render.test.ts',
    'apps/batch/src/split-grib/README.md', '.github/workflows/ci.yml', '.github/workflows/deploy.yml', 'docs/science.md'];
  for (const path of [...relevant, ...ignored]) expect(existsSync(join(ROOT, path)), path).toBe(true);
  // The same pathspecs assertPublishableRevision hands to `git diff`, evaluated against the tracked tree.
  const selected = new Set(execFileSync('git', ['ls-files', '--', ...PUBLICATION_PATHS], { cwd: ROOT, encoding: 'utf8' }).split('\n'));
  expect(relevant.filter(path => !selected.has(path))).toEqual([]);
  expect(ignored.filter(path => selected.has(path))).toEqual([]);
  expect(FORECAST_WORKFLOW_PATHS.every(path => existsSync(join(ROOT, path)))).toBe(true);
});
