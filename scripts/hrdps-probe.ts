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
const probeCache = await mkdtemp(join(tmpdir(), 'probe-'));
const session = await createSplitGribAcquisitionSession(source, { cycle, activeIndices: active, cacheDir: probeCache });
const timer = setInterval(() => console.log(JSON.stringify({ variant, elapsedS: Math.round((Date.now() - t0) / 1000), ...session.stats })), 20_000);
try {
  const big = await session.acquire(hour);
  console.log('DONE', JSON.stringify({ variant, hour, elapsedS: (Date.now() - t0) / 1000, ...session.stats }));
  if (process.env.COMPARE === '1') {
    const picks = Uint32Array.from({ length: 2000 }, (_, j) => j * 800);
    const small = await createSplitGribAcquisitionSession(source, { cycle, activeIndices: Uint32Array.from(picks, k => active[k]!), cacheDir: probeCache });
    const t1 = Date.now();
    const frame = await small.acquire(hour);
    console.log('SMALL', (Date.now() - t1) / 1000, JSON.stringify(small.stats));
    let arrays = 0, mismatches = 0;
    const walk = (a: unknown, b: unknown, path: string) => {
      if (a instanceof Float32Array || a instanceof Uint8Array) {
        if (!(b instanceof a.constructor) || a.length !== active.length) return;
        arrays++;
        const bb = b as Float32Array;
        for (let j = 0; j < picks.length; j++) {
          const x = a[picks[j]!]!, y = bb[j]!;
          if (!(x === y || (Number.isNaN(x) && Number.isNaN(y)))) { if (mismatches++ < 5) console.log('MISMATCH', path, j, x, y); }
        }
        return;
      }
      if (Array.isArray(a)) { a.forEach((v, i) => walk(v, (b as unknown[])[i], `${path}[${i}]`)); return; }
      if (a && typeof a === 'object' && !ArrayBuffer.isView(a)) for (const [k, v] of Object.entries(a)) walk(v, (b as Record<string, unknown>)[k], `${path}.${k}`);
    };
    walk(big, frame, 'frame');
    console.log('COMPARE', JSON.stringify({ arrays, mismatches }));
    await small.close();
  }
} catch (error) {
  console.log('FAILED', variant, (Date.now() - t0) / 1000, error);
} finally { clearInterval(timer); await session.close(); }
