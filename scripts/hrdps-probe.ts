// TEMPORARY diagnostic: times one HRDPS frame acquisition on a GitHub-hosted runner. Not for merge.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getProduct } from '@av/contracts/models';
import { splitSource } from '../apps/batch/src/split-grib/source.js';
import { createSplitGribAcquisitionSession } from '../apps/batch/src/split-grib/acquire.js';

const variant = process.env.VARIANT ?? 'configured';
const model = structuredClone(getProduct('hrdps')!);
const upstream = model.upstream as Record<string, unknown>;
if (variant === 'datamart-8') { delete upstream.mirrorUrlTemplates; upstream.fetchConcurrency = 8; }
if (variant === 'hpfx-primary-12') { upstream.urlTemplate = (upstream.mirrorUrlTemplates as string[])[0]; delete upstream.mirrorUrlTemplates; upstream.fetchConcurrency = 12; }
if (variant === 'hpfx-primary-24') { upstream.urlTemplate = (upstream.mirrorUrlTemplates as string[])[0]; delete upstream.mirrorUrlTemplates; upstream.fetchConcurrency = 24; }
const source = splitSource(model);
const cells = source.grid.width * source.grid.height;
const active = Uint32Array.from({ length: Math.floor(cells / 2) }, (_, i) => i * 2);
const cycle = process.env.CYCLE!;
const hour = Number(process.env.HOUR ?? 12);
const t0 = Date.now();
const session = await createSplitGribAcquisitionSession(source, { cycle, activeIndices: active, cacheDir: await mkdtemp(join(tmpdir(), 'probe-')) });
const timer = setInterval(() => console.log(JSON.stringify({ variant, elapsedS: Math.round((Date.now() - t0) / 1000), ...session.stats })), 20_000);
try {
  await session.acquire(hour);
  console.log('DONE', JSON.stringify({ variant, hour, elapsedS: (Date.now() - t0) / 1000, ...session.stats }));
} catch (error) {
  console.log('FAILED', variant, (Date.now() - t0) / 1000, error);
} finally { clearInterval(timer); await session.close(); }
