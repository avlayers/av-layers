import { createSecureServer, type ServerHttp2Session } from 'node:http2';
import { createServer as createHttpsServer } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer as createVite } from 'vite';
import { chromium, type Page } from 'playwright';
import { WIND_HEIGHTS } from '@av/contracts/wind-data';
import { fixtureBuild, fixtureLatest } from '../tests/forecast-fixture.ts';
import { fixturePointFetch, fixtureProfileBuild } from '../tests/client-point-fixture.ts';
import { encodeWebp } from '../apps/batch/src/webp.ts';
import type { PreviewBench } from '../apps/preview/bench.ts';
import { DETAIL_ZOOM, TILE_SIZE, fixturePixel } from './preview-pixels';
import { configureGfsWindGrid, configureRrfsWindGrid, previewWindFixture } from './preview-wind';
import { previewSourceHash } from './preview-hash';
import { correlatePointerActions, waitForPreviewRecovery } from './preview-observe';

const root = resolve(fileURLToPath(new URL('..', import.meta.url))), args = process.argv.slice(2);
const option = (name: string, fallback: string) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; };
const output = resolve(option('--out', 'output/preview-layer-bench.json')), channel = option('--channel', ''), scenario = option('--scenario', 'all');
const baseline = option('--baseline', 'main'), repeats = Number(option('--repeats', scenario === 'interaction' ? '3' : '30')), tileDelayMs = Number(option('--delay-ms', '40'));
const model = option('--model', 'gfs'), mobile = args.includes('--mobile');
const variant = option('--variant', 'both'), frameCount = Number(option('--frames', model === 'av-wrf' ? '48' : '40'));
const focused = scenario === 'viewport-warm' || scenario === 'contention' || scenario === 'pointer-smoke' || scenario === 'device-sim' || scenario === 'interaction';
const opacity = Number(option('--opacity', '1')), transparent = args.includes('--transparent'), wind = args.includes('--wind') || focused;
const dpr = Number(option('--dpr', mobile ? '3' : '1')), deviceMemory = Number(option('--device-memory', '4'));
const viewport = focused ? { width: mobile ? 390 : 1394, height: mobile ? 844 : 1032, dpr, lat: model === 'rrfs' ? 40 : 40.4895, lon: model === 'rrfs' ? -100 : 45.1123, zoom: 8.17 } : { width: 1920, height: 1080, dpr, lat: 40, lon: -100, zoom: 7.15 };
const detailZoom = focused ? 9 : DETAIL_ZOOM;
const warmMs = Number(option('--warm-ms', '30000'));
const observerMode = option('--observer', 'instrumented');
const forecastRequests = Number(option('--forecast-requests', process.env.VITE_FORECAST_REQUESTS ?? '24'));
if (!Number.isInteger(repeats) || repeats < 1 || repeats > (scenario === 'interaction' ? 30 : 200) || !Number.isInteger(tileDelayMs) || tileDelayMs < 0 || tileDelayMs > 1000 ||
  !Number.isInteger(frameCount) || frameCount < 2 || frameCount > 48 || !['all', 'cold', 'smoke', 'viewport-warm', 'contention', 'pointer-smoke', 'device-sim', 'interaction'].includes(scenario) || (focused && frameCount !== (model === 'av-wrf' ? 48 : 40)) || !['gfs', 'rrfs', 'av-wrf'].includes(model) || ((model !== 'gfs' || mobile) && !focused) || ![1, 2, 3].includes(dpr) || ![2, 4, 8].includes(deviceMemory) || !Number.isInteger(warmMs) || warmMs < 0 || warmMs > 300000 || ![16, 24, 32].includes(forecastRequests) || !['instrumented', 'control'].includes(observerMode) || !['both', 'baseline', 'changed'].includes(variant) || ![0.7, 1].includes(opacity)) throw new Error('Invalid benchmark options');
await mkdir(dirname(output), { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), 'av-preview-bench-')), baselineRoot = join(scratch, 'baseline');
const workspacePackages = new Map<string, Record<string, string>>();
const certificate = join(scratch, 'localhost.pem'), privateKey = join(scratch, 'localhost-key.pem');
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '1', '-nodes', '-keyout', privateKey, '-out', certificate, '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
const tls = { key: await readFile(privateKey), cert: await readFile(certificate) };
const sourceDirectories = ['packages', 'apps/preview/src'];
await mkdir(baselineRoot);
const baselineRevision = execFileSync('git', ['rev-parse', baseline], { cwd: root, encoding: 'utf8' }).trim();
const archive = execFileSync('git', ['archive', baselineRevision, ...sourceDirectories, 'apps/preview/index.html'], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
execFileSync('tar', ['-xf', '-', '-C', baselineRoot], { input: archive });
await symlink(join(root, 'node_modules'), join(baselineRoot, 'node_modules'));
await symlink(join(root, 'apps/preview/node_modules'), join(baselineRoot, 'apps/preview/node_modules'));
for (const entry of await readdir(join(root, 'packages'))) {
  const modules = join(root, 'packages', entry, 'node_modules');
  try { await symlink(modules, join(baselineRoot, 'packages', entry, 'node_modules')); } catch { /* package has no local dependencies */ }
}
const maplibreDirectory = dirname(createRequire(join(root, 'apps/preview/package.json')).resolve('maplibre-gl/package.json'));
const images = new Map<string, Promise<Buffer>>();
const geometry = new Map<string, Uint8Array>();
function tileImage(layer: string, frame: string, z: number, x: number, y: number): Promise<Buffer> {
  const key = `${layer}/${frame}/${z}/${x}/${y}`, hit = images.get(key);
  if (hit) return hit;
  const index = build.manifest.frames.findIndex(value => value.id === frame), geometryKey = `${z}/${x}/${y}/${transparent ? index % 3 : 0}`;
  let template = geometry.get(geometryKey);
  if (!template) {
    template = new Uint8Array(TILE_SIZE * TILE_SIZE * 4);
    const size = TILE_SIZE * 2 ** z;
    for (let row = 0; row < TILE_SIZE; row++) for (let column = 0; column < TILE_SIZE; column++) {
      template.set(fixturePixel('agl', index, z, (x * TILE_SIZE + column + 0.5) / size, (y * TILE_SIZE + row + 0.5) / size, transparent, detailZoom), (row * TILE_SIZE + column) * 4);
    }
    geometry.set(geometryKey, template);
  }
  // Reuse spatial geometry so synthetic trigonometry cannot dominate rapid frame changes.
  const rgba = template.slice(), [red, green] = fixturePixel(layer.endsWith('-agl') ? 'agl' : 'msl', index, z, 0, 0, false, detailZoom);
  for (let offset = 0; offset < rgba.length; offset += 4) { rgba[offset] = red; rgba[offset + 1] = green; }
  const image = encodeWebp(rgba); images.set(key, image); return image;
}
type Sample = Awaited<ReturnType<PreviewBench['select']>>;
function summarize(samples: Sample[]) {
  const times = (field: 'sceneMs' | 'firstCorrectMs' | 'detailedMs' | 'combinedMs', inputs = samples) => {
    const sorted = inputs.flatMap(sample => sample[field] === null ? [] : [sample[field]!]).sort((a, b) => a - b);
    return { count: sorted.length, p50Ms: sorted[Math.floor((sorted.length - 1) * 0.5)] ?? null, p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null, maxMs: sorted.at(-1) ?? null };
  };
  const ready = samples.filter(sample => sample.targetReadyAtInput);
  return { inputs: samples.length, targetReady: ready.length, targetCold: samples.length - ready.length, timeouts: samples.filter(sample => sample.outcome === 'timeout').length, superseded: samples.filter(sample => sample.outcome === 'superseded').length,
    sceneDelivery: times('sceneMs'), firstCorrectViewport: times('firstCorrectMs'), detailedViewport: times('detailedMs'), combinedInstalled: times('combinedMs'), readyCombinedInstalled: times('combinedMs', ready), maxSources: Math.max(0, ...samples.map(sample => sample.sources)) };
}
const harnessInputs = ['scripts/preview-layer-bench.ts', 'scripts/preview-pixels.ts', 'scripts/preview-wind.ts', 'scripts/preview-hash.ts', 'scripts/preview-observe.ts', 'apps/preview/bench.ts', 'apps/preview/gpu-buffers.ts', 'apps/batch/src/webp.ts', 'tests/client-point-fixture.ts', 'tests/forecast-fixture.ts', 'scripts/fixtures/gfs-wind-layout.json', 'scripts/fixtures/rrfs-wind-layout.json', 'package.json', 'pnpm-lock.yaml'];
async function harnessHash() {
  const hash = createHash('sha256');
  for (const file of harnessInputs) hash.update(file).update(await readFile(join(root, file)));
  return hash.digest('hex');
}
const harnessBeforeSha256 = await harnessHash();
async function sourceHash(directory: string, directories = sourceDirectories, index = true) {
  return previewSourceHash(directory, directories, index);
}
const fixtureSourceDirectories = ['packages/contracts', 'packages/forecast', 'packages/soaring'];
const fixtureSourceBeforeSha256 = await sourceHash(root, fixtureSourceDirectories, false);
const baselineFixtureSourceSha256 = await sourceHash(baselineRoot, fixtureSourceDirectories, false);
if (variant !== 'changed' && fixtureSourceBeforeSha256 !== baselineFixtureSourceSha256) throw new Error('Server fixture workspace dependencies differ from baseline; cannot claim isolated baseline');
const hourlyFrames = model === 'av-wrf' ? 36 : 24;
const axis = fixtureProfileBuild({ frameHours: Array.from({ length: frameCount }, (_, index) => focused && index >= hourlyFrames ? hourlyFrames + 3 + (index - hourlyFrames) * 3 : index + 1), mapFrameCount: frameCount });
const build = model === 'rrfs' || model === 'av-wrf' ? fixtureBuild({ model, frames: axis.manifest.frames, mapFrameCount: frameCount }) : axis;
if (model === 'rrfs') configureRrfsWindGrid(build.manifest); else if (model === 'gfs' && focused) configureGfsWindGrid(build.manifest);
build.manifest.expiresAt = new Date(Date.now() + 86400000).toISOString();
build.expiresAtMs = Date.parse(build.manifest.expiresAt);
if (wind) build.manifest.mapData = { sha256: 'a'.repeat(64), bytes: 1 };
const windFixture = previewWindFixture(build.manifest, model === 'rrfs' || model === 'av-wrf' ? model : focused);
await encodeWebp(new Uint8Array(TILE_SIZE * TILE_SIZE * 4));
const browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
const results = [];
try {
  for (const [name, codeRoot] of [['baseline', baselineRoot], ['changed', root]]) {
    const codeRootReal = await realpath(codeRoot);
    if (variant !== 'both' && variant !== name) continue;
    const sourceSha256 = await sourceHash(codeRoot);
    let requests = 0, active = 0, peakActive = 0, bytes = 0, lastRequest = 0, base = '', overviewRequests = 0, overviewBytes = 0, maxImageReadyMs = 0, windRequests = 0, windBytes = 0;
    const urls = new Set<string>(), errors: string[] = [];
    const protocols = new Set<string>(), sessions = new Set<ServerHttp2Session>();
    const requestTimings: { frame: string; z: number; startedAt: number; finishedAt?: number }[] = [];
    const events: { frame: string; kind: string; startedAt: number; finishedAt?: number; queuedAt?: number; queuedBodyBytes?: number; status?: number; aborted?: boolean }[] = [];
    const count = () => ({ at: Date.now() });
    const since = (start: ReturnType<typeof count>, end = Date.now()) => {
      type Counts = { starts: number; serverFinishes: number; aborted: number; queuedBodyBytes: number; finishedBodyBytes: number };
      const groups: Record<string, Counts> = {}, byFrame: Record<string, Record<string, Counts>> = {};
      for (const event of events) {
        if (![event.startedAt, event.queuedAt, event.finishedAt].some(time => time !== undefined && time >= start.at && time <= end)) continue;
        const frame = byFrame[event.frame || '(unattributed)'] ??= {};
        for (const group of [groups[event.kind] ??= { starts: 0, serverFinishes: 0, aborted: 0, queuedBodyBytes: 0, finishedBodyBytes: 0 }, frame[event.kind] ??= { starts: 0, serverFinishes: 0, aborted: 0, queuedBodyBytes: 0, finishedBodyBytes: 0 }]) {
          if (event.startedAt >= start.at && event.startedAt <= end) group.starts++;
          if (event.queuedAt !== undefined && event.queuedAt >= start.at && event.queuedAt <= end) group.queuedBodyBytes += event.queuedBodyBytes ?? 0;
          if (event.finishedAt !== undefined && event.finishedAt >= start.at && event.finishedAt <= end) {
            if (event.aborted) group.aborted++;
            else { group.serverFinishes++; group.finishedBodyBytes += event.queuedBodyBytes ?? 0; }
          }
        }
      }
      return { intervalStartEpochMs: start.at, intervalEndEpochMs: end, routes: groups, byFrame, browserReceivedBodyBytes: null };
    };
    const attributeInputs = (inputs: Sample[]) => inputs.map(sample => Object.assign(sample, { transport: since({ at: sample.inputEpochMs }, sample.finishedEpochMs ?? Date.now()) }));
    let faultsEnabled = false, failedWind = false, delayedTile = false;
    const server = createSecureServer({ ...tls, allowHTTP1: true }, async (request, response) => {
      const url = new URL(request.url!, 'http://localhost');
      const kind = url.pathname.startsWith('/tiles/') ? 'raster' : url.pathname.startsWith(`/v1/models/${model}/`) ? url.pathname.endsWith('/latest') ? 'latest' : url.pathname.endsWith('/sample') ? 'sample' : url.pathname.endsWith('/profile') ? 'profile' : 'wind' : null;
      const event = kind ? { frame: '', kind, startedAt: Date.now() } as typeof events[number] : null;
      if (event) {
        if (events.length >= 20000) { errors.push('Benchmark request event limit exceeded'); response.writeHead(503); response.end(); return; }
        events.push(event);
        response.once('finish', () => { event.finishedAt = Date.now(); event.status = response.statusCode; event.aborted = false; });
        response.once('close', () => { if (!response.writableFinished) { event.finishedAt = Date.now(); event.aborted = true; } });
      }
      const endBody = (body: string | Uint8Array) => { if (event) { event.queuedAt = Date.now(); event.queuedBodyBytes = typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength; } response.end(body); };
      const json = (value: unknown) => { response.setHeader('content-type', 'application/json'); endBody(JSON.stringify(value)); };
      try {
        if (url.pathname === '/') {
          response.setHeader('content-type', 'text/html');
          response.end(await vite!.transformIndexHtml(request.url!, await readFile(join(codeRoot, 'apps/preview/index.html'), 'utf8'))); return;
        }
        if (url.pathname === '/bench/config.json') { json({ frames: build.manifest.frames.map(frame => frame.id), transparent, wind, detailZoom,
          expectedWind: build.manifest.frames.map(frame => windFixture.expected(frame.id, viewport.lat, viewport.lon, 1500)) }); return; }
        if (url.pathname === `/v1/models/${model}/latest`) { json(fixtureLatest(build.manifest, base)); return; }
        if (url.pathname.endsWith('/sample') || url.pathname.endsWith('/profile')) { json(fixturePointFetch(build, `${base}${request.url}`)); return; }
        const numeric = wind && new RegExp(`^/v1/models/${model}/runs/[^/]+/data/([^/]+)(?:/(wind|fine|overview-\\d+)/(\\d+)(?:-(\\d+))?)?$`).exec(url.pathname);
        if (numeric) {
          windRequests++; active++; peakActive = Math.max(peakActive, active); lastRequest = Date.now();
          event!.frame = numeric[1]; event!.kind = `wind-${numeric[2] ?? 'descriptor'}`;
          const cancellation = new AbortController(); response.once('close', () => cancellation.abort());
          try {
            const fail = faultsEnabled && numeric[1] === 'f060' && !numeric[2] && !failedWind;
            if (fail) failedWind = true;
            await delay(tileDelayMs + (fail ? 1500 : 0), undefined, { signal: cancellation.signal });
            if (fail) { response.writeHead(503); endBody(''); return; }
            const [, frame, kind, first, last] = numeric;
            const descriptor = windFixture.descriptor(frame);
            const start = Number(first), end = last === undefined ? start : Number(last);
            const chunks = kind && Number.isSafeInteger(start) && Number.isSafeInteger(end) && end >= start && end - start < 512
              ? Array.from({ length: end - start + 1 }, (_, i) => windFixture.chunk(frame, kind, start + i)) : [];
            if (!descriptor || (kind && (!chunks.length || chunks.some(chunk => !chunk)))) { response.writeHead(404); response.end(); return; }
            const body = kind ? Buffer.concat(chunks as Uint8Array[]) : Buffer.from(JSON.stringify(descriptor));
            response.writeHead(200, { 'content-type': kind ? 'application/octet-stream' : 'application/json', 'content-length': body.length, 'cache-control': 'public, max-age=3600, immutable' });
            windBytes += body.length; endBody(body);
          } catch (error) { if (!cancellation.signal.aborted) throw error; }
          finally { active--; lastRequest = Date.now(); }
          return;
        }
        if (url.pathname.startsWith('/tiles/')) {
          protocols.add(request.httpVersion); requests++; active++; peakActive = Math.max(peakActive, active); lastRequest = Date.now(); urls.add(url.pathname);
          const [, , , , layer, frame, zoom, column, filename] = url.pathname.split('/'), z = Number(zoom), x = Number(column), y = Number(filename.replace('.webp', ''));
          if (z < detailZoom) overviewRequests++;
          const timing = { frame, z, startedAt: Date.now() } as { frame: string; z: number; startedAt: number; finishedAt?: number };
          requestTimings.push(timing);
          event!.frame = frame; event!.kind = `raster-z${z}`;
          const cancellation = new AbortController();
          response.once('close', () => cancellation.abort());
          try {
            const slow = faultsEnabled && frame === 'f060' && z >= detailZoom && !delayedTile;
            if (slow) delayedTile = true;
            const ready = Date.now(), latency = delay(tileDelayMs + (slow ? 3000 : 0), undefined, { signal: cancellation.signal });
            const imageReady = Promise.resolve().then(() => tileImage(layer, frame, z, x, y)).then(image => { maxImageReadyMs = Math.max(maxImageReadyMs, Date.now() - ready); return image; });
            const [image] = await Promise.all([imageReady, latency]);
            response.writeHead(200, { 'content-type': 'image/webp', 'content-length': image.length, 'cache-control': 'public, max-age=3600, immutable' });
            bytes += image.length; if (z < detailZoom) overviewBytes += image.length; timing.finishedAt = Date.now(); endBody(image);
          } catch (error) { if (!cancellation.signal.aborted) throw error; }
          finally { active--; lastRequest = Date.now(); }
          return;
        }
        // Connect consumes the compatibility fields exposed by Node's HTTP/2 request adapter.
        vite!.middlewares(request as unknown as IncomingMessage, response as unknown as ServerResponse);
      } catch (error) { errors.push(String(error)); response.writeHead(500); response.end(); }
    });
    server.on('session', session => { sessions.add(session); session.on('close', () => sessions.delete(session)); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing listener');
    base = `https://127.0.0.1:${address.port}`;
    // Vite's development WebSocket uses a separate HTTP/1 TLS listener; tile requests negotiate HTTP/2.
    const hmr = createHttpsServer(tls);
    await new Promise<void>(resolve => hmr.listen(0, '127.0.0.1', resolve));
    const hmrAddress = hmr.address();
    if (!hmrAddress || typeof hmrAddress === 'string') throw new Error('Missing HMR listener');
    const benchEntry = join(root, 'apps/preview/bench.ts');
    const vite = await createVite({ configFile: false, root: join(codeRoot, 'apps/preview'), cacheDir: join(scratch, name, 'vite'), logLevel: 'error',
      server: { hmr: { server: hmr, protocol: 'wss', host: '127.0.0.1', clientPort: hmrAddress.port }, middlewareMode: true, fs: { allow: [root, scratch] } }, optimizeDeps: { noDiscovery: true },
      define: { 'import.meta.env.AV_API_BASE': JSON.stringify(base), 'import.meta.env.VITE_OFFLINE_FIXTURE': '"true"', ...(name === 'changed' ? { 'import.meta.env.VITE_FORECAST_REQUESTS': JSON.stringify(String(forecastRequests)) } : {}) },
      esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
      resolve: { alias: [{ find: /^maplibre-gl\//, replacement: `${maplibreDirectory}/` }] },
      plugins: [
        { name: 'bench-viewport-policy', enforce: 'pre', resolveId(id, importer) { if (id === './src/features/map/viewport-policy' && importer === benchEntry) return join(codeRoot, 'apps/preview/src/features/map/viewport-policy.ts'); } },
        { name: 'observe-wind-identity', enforce: 'pre', transform(code, id) {
          if (!wind || name !== 'baseline' || !id.endsWith('/features/wind/wind-session.ts')) return;
          const anchor = '\n  return {\n    update, reconcile, clear';
          if (code.split(anchor).length !== 2) throw new Error('Wind session observer anchor is missing or ambiguous');
          const old = code.includes('const windHeld = new Map<string, WindRequest>();') && code.includes('get installed() { return installedWind && windDisplayed');
          const current = code.includes('const jobs = new Map<string, WindJob>()') && code.includes('get installed() { return installed ?');
          if (old === current) throw new Error('Unknown or ambiguous wind session observer version');
          const view = old ? 'installedWind && windDisplayed ? { view: installedWind, height: installedHeight } : null' : 'installed ? { view: installed, height: installedHeight } : null';
          const lifecycle = old ? '!destroyed && s.visible && s.mapReady && !s.expired && !s.mapFailed && !s.aborted && !!s.build && s.build.expiresAtMs > Date.now()' : 'active()';
          const ready = old
            ? "[...windHeld.values()].filter(held => held === installedWind && windDisplayed && installedHeight === s.height && held.build === s.build && coversBounds(held.bounds, cameraBounds(map)) && (held.source.isOverview !== true || map.getZoom() <= held.zoom) && held.source.hasPrepared(s.height) && held.source.sample(LAT, LON, s.height).status === 'valid').map(held => held.frame)"
            : "[...jobs.values()].filter(job => job.build === s.build && coversBounds(job.bounds, cameraBounds(map)) && (job.source.isOverview !== true || map.getZoom() <= job.zoom) && readyAt(job, s.height) && job.source.sample(LAT, LON, s.height).status === 'valid').map(job => job.frame)";
          const expression = ready.replace('LAT', String(viewport.lat)).replace('LON', String(viewport.lon));
          return code.replace(anchor, `\n  window.__benchWindState = () => { const s = state(), usable = ${lifecycle}, observation = usable ? (${view}) : null; return { height: s.height, ready: usable ? ${expression} : [], installed: observation ? { frame: observation.view.frame, height: observation.height, sample: observation.view.source.sample(${viewport.lat}, ${viewport.lon}, observation.height) } : null }; };${anchor}`);
        } },
        { name: 'observe-raster-readiness', enforce: 'pre', transform(code, id) {
          if (!id.endsWith('/features/raster/raster-overview.ts')) return;
          const anchor = 'this.transport = this.supported ? protocol.createSource(false) : null;';
          if (code.split(anchor).length !== 2 || !code.includes('ready(build: PinnedBuild, layer: LayerId, frame: string)')) throw new Error('Raster readiness observer anchor is missing or ambiguous');
          const current = code.includes('private readonly natives = new globalThis.Map<string, Image>()');
          const old = code.includes('private readonly images = new globalThis.Map<string, ImageBitmap>()');
          if (old === current) throw new Error('Unknown or ambiguous raster readiness observer version');
          const preview = 'context.frames.filter(frame => this.ready(context.build, context.layer, frame))';
          const native = old ? 'context.geometry.zoom >= context.requiredZoom ? preview : []' : 'context.frames.filter(frame => this.natives.has(frame) && this.nativeCovers())';
          return code.replace(anchor, `${anchor} window.__benchRasterReady = () => { const context = this.context; if (!context || this.disposed || context.build.expiresAtMs <= Date.now()) return { preview: [], native: [] }; const preview = ${preview}, native = ${native}; return { preview, native }; };`);
        } },
        { name: 'observe-timeline', enforce: 'pre', transform(code, id) {
          if (!id.endsWith('/features/timeline/timeline-controller.ts')) return;
          const render = code.includes('function render(width = trackWidth()): void {') ? 'function render(width = trackWidth()): void {' : 'function render(): void {';
          const anchor = '  const stopPlayback = () => {';
          if (code.split(render).length !== 2 || code.split(anchor).length !== 2 || !code.includes('function currentScale(width: number)')) throw new Error('Timeline observer anchor is missing or ambiguous');
          return code.replace(render, `${render} window.__benchTimelineSelected?.(selectedIndex);`).replace(anchor, `  window.__benchTimelinePosition = (index: number) => { const frame = frames[index]; if (!frame) return null; const local = localTimeFromMs(Date.parse(frame.validTime), offsetMinutes); const rect = track.getBoundingClientRect(); if (!local || !rect.width) return null; return { day: local.day, x: rect.left + minuteToX(currentScale(rect.width), local.hour * 60 + local.minute), y: rect.top + rect.height / 2 }; };\n${anchor}`);
        } },
        { name: 'observe-scene-commit', enforce: 'pre', transform(code, id) {
          if (!id.endsWith('/app/create-preview-app.ts')) return;
          const anchor = 'forecastSession.commitFrame(frame.id, frame.validTime);';
          if (code.split(anchor).length !== 2 || !/function selectIndex\(index: number, history: 'none' \| 'push' \| 'replace'(?:, fromTimeline = false)?\): void \{/.test(code)) throw new Error('Scene commit observer anchor is missing or ambiguous');
          code = code.replace(anchor, `${anchor} window.__benchSceneCommit?.(index, frame.id);`);
          if (name === 'changed' && wind) {
            const begin = 'windSession = createWindSession({', end = 'replacementFailed: () => view.overlay.value.replacementFailed\n    });';
            if (code.split(begin).length !== 2 || code.split(end).length !== 2) throw new Error('Public wind session observer anchor is missing or ambiguous');
            code = code.replace(end, `${end} window.__benchWindState = () => { const session = windSession, height = intent().windHeight, installed = session?.installed; return { height, ready: session ? [...session.ready].filter(([, heights]) => heights.has(height)).map(([frame]) => frame) : [], preparation: session?.preparation, memory: session?.memory, rendered: windOverlay?.renderState ?? null, installed: installed ? { frame: installed.frame, height: installed.height, sample: installed.source.sample(${viewport.lat}, ${viewport.lon}, installed.height), isOverview: installed.isOverview } : null }; };`);
          }
          return code;
        } },
        { name: 'observe-scheduler', enforce: 'pre', transform(code, id) {
          if (!id.endsWith('/client-request-scheduler.ts')) return;
          const born = 'const signal = init?.signal === undefined && input instanceof Request ? input.signal : init?.signal;';
          const start = 'function start() {';
          const finish = 'function finish() {\n      if (finished) return;';
          const headers = 'const fetched = await fetchImpl(input, { ...init, signal: controller.signal });';
          if ([born, start, finish, headers].some(anchor => code.split(anchor).length !== 2)) throw new Error('Scheduler observer anchors are missing or ambiguous');
          return code.replace(born, `const __benchQueued = performance.now(); let __benchStarted = 0, __benchHeaders = 0; ${born}`)
            .replace(start, `${start} __benchStarted = performance.now(); window.__benchRecord?.(foreground ? 'scheduler-foreground-queue' : 'scheduler-background-queue', __benchStarted - __benchQueued);`)
            .replace(headers, `${headers} __benchHeaders = performance.now(); window.__benchRecord?.('scheduler-headers-elapsed', __benchHeaders - __benchStarted);`)
            .replace(finish, `${finish} if (__benchStarted) window.__benchRecord?.('scheduler-start-to-settlement', performance.now() - __benchStarted); if (__benchHeaders) window.__benchRecord?.('scheduler-headers-to-body-settlement', performance.now() - __benchHeaders);`);
        } },
        { name: 'observe-wind-cost', enforce: 'pre', transform(code, id) {
          if (!id.endsWith('/client-wind.ts')) return;
          if (!code.includes('export class WindDataSource') || !code.includes('  prepare(height:') || !code.includes('  field(height:')) throw new Error('Wind cost observer anchors are missing');
          if (code.includes('  async prepareAsync(')) code += `\n{ const original = WindDataSource.prototype.prepareAsync; WindDataSource.prototype.prepareAsync = async function (...args) { const start = performance.now(); try { return await original.apply(this, args); } finally { window.__benchRecord?.('wind-grid-async-elapsed', performance.now() - start); } }; }`;
          return `${code}\nfor (const name of ['prepare', 'field'] as const) { const original = WindDataSource.prototype[name] as (...args: never[]) => unknown; (WindDataSource.prototype as unknown as Record<string, unknown>)[name] = function (this: WindDataSource, ...args: never[]) { const state = () => name === 'prepare' ? this.hasPrepared(args[0], args[1]) : 'hasField' in this ? this.hasField(args[0]) : null; const cached = state(); return window.__benchWindCall ? window.__benchWindCall(name === 'prepare' ? 'grid' : 'sampler', cached, () => original.apply(this, args), state) : original.apply(this, args); }; }`;
        } },
        { name: 'observe-managed-budget', enforce: 'pre', transform(code, id) {
          if (!id.endsWith('/client-preparation-budget.ts')) return;
          const idAnchor = 'let used = 0, pending = false;', changeAnchor = 'if (bytes) categories.set(category, bytes); else categories.delete(category);';
          if (code.split(idAnchor).length !== 2 || code.split(changeAnchor).length !== 2) throw new Error('Managed budget observer anchors are missing or ambiguous');
          return code.replace(idAnchor, `${idAnchor} const __benchId = window.__benchBudgetId?.() ?? 0;`).replace(changeAnchor, `${changeAnchor} window.__benchManaged?.(__benchId, limit, used, category, bytes);`);
        } },
        { name: 'observe-wind-display', enforce: 'pre', transform(code, id) {
          if (!id.endsWith('/features/wind/wind-overlay.ts')) return;
          if (!code.includes('export class WindOverlay') || !code.includes('  install(field:')) throw new Error('Wind display observer anchors are missing');
          return `${code}\n{ const original = WindOverlay.prototype.install; WindOverlay.prototype.install = function (...args) { const start = performance.now(); try { return original.apply(this, args); } finally { window.__benchRecord?.('wind-display-install-submission', performance.now() - start); } }; }`;
        } },
        { name: 'code-root-workspace', enforce: 'pre', async resolveId(id) {
          const match = /^@av\/([^/]+)(?:\/(.+))?$/.exec(id);
          if (!match) return;
          const directory = join(codeRoot, 'packages', match[1]!);
          let exportsMap = workspacePackages.get(directory);
          if (!exportsMap) {
            const parsed = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as { exports?: Record<string, string> };
            exportsMap = parsed.exports ?? {}; workspacePackages.set(directory, exportsMap);
          }
          const target = exportsMap[match[2] ? `./${match[2]}` : '.'];
          if (typeof target !== 'string') throw new Error(`Unresolved workspace import ${id} from ${codeRoot}`);
          const resolved = join(directory, target);
          if (!resolved.startsWith(codeRoot + sep)) throw new Error(`Workspace import ${id} escaped ${codeRoot}: ${resolved}`);
          return resolved;
        } },
        { name: 'measure-real-preview', enforce: 'pre', resolveId(id, importer) {
          if (id === 'maplibre-gl' && importer !== benchEntry) return benchEntry;
        } }
      ]
    });
    const probeIds = ['@av/client', '@av/client/dom', '@av/client/wind', '@av/contracts', '@av/contracts/wind-data', '@av/forecast/wind', '@av/soaring'];
    const probes: { id: string; resolved: string; sha256: string }[] = [];
    for (const id of probeIds) {
      const hit = await vite.pluginContainer.resolveId(id);
      if (!hit) throw new Error(`Benchmark probe ${id} did not resolve`);
      const file = await realpath(hit.id.split('?')[0]!);
      if (!file.startsWith(codeRootReal + sep)) throw new Error(`Benchmark probe ${id} resolved outside ${name} source: ${file}`);
      probes.push({ id, resolved: relative(codeRootReal, file), sha256: createHash('sha256').update(await readFile(file)).digest('hex') });
    }
    async function openPage() {
      const start = count(), startedAt = Date.now();
      const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: viewport.dpr });
      const page = await context.newPage();
      await page.addInitScript(mode => { window.__benchObserver = mode; }, observerMode as 'instrumented' | 'control');
      if (scenario === 'device-sim' || scenario === 'interaction') await page.addInitScript(memory => { Object.defineProperty(navigator, 'deviceMemory', { value: memory, configurable: true }); }, deviceMemory);
      page.on('pageerror', error => { if (!errors.includes(error.message)) errors.push(error.message); });
      const navigation: string[] = [], consoleErrors: string[] = [];
      page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigation.push(frame.url()); });
      page.on('console', message => { if (message.type() === 'error' || message.text().includes('[vite]')) consoleErrors.push(message.text()); });
      if (wind) await page.addInitScript(() => localStorage.setItem('av.wind-controls.v1', JSON.stringify({ style: 'hybrid', visible: true, height: 1500, fixedHeight: 1500 })));
      await page.goto(`${base}/?model=${model}&ref=agl&opacity=${opacity}&lat=${viewport.lat}&lon=${viewport.lon}&z=${viewport.zoom}&benchObserver=${observerMode}&t=${encodeURIComponent(build.manifest.frames[0].validTime)}`);
      await page.waitForFunction(() => !!window.bench);
      try { await page.evaluate(() => Promise.race([window.bench.ready, new Promise((_, reject) => setTimeout(() => reject(new Error('Initial preview did not render')), 30000))])); }
      catch (error) { throw new Error(`Initial preview failed; navigations=${JSON.stringify(navigation)} pageErrors=${JSON.stringify(errors)} console=${JSON.stringify(consoleErrors)}`, { cause: error }); }
      return { context, page, initial: { elapsedMs: Date.now() - startedAt, ...since(start), state: await page.evaluate(() => window.bench.snapshot()) } };
    }
    async function quiet(page: Page, maxWaitMs = 60000, required = true): Promise<boolean> {
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const deadline = Date.now() + maxWaitMs;
      while (active || Date.now() - lastRequest < 180 || !await page.evaluate(() => window.bench.settled())) {
        if (Date.now() > deadline) { if (required) throw new Error('Tile transport or map did not settle'); return false; }
        await delay(25);
      }
      return true;
    }
    type Trace = Awaited<ReturnType<PreviewBench['trace']>>;
    type Action = { kind: 'day-switch' | 'scrub' | 'gesture-end'; requested: number; before: Trace; after: Trace };
    async function pointerDay(page: Page, index: number) {
      const position = await page.evaluate(index => window.__benchTimelinePosition?.(index), index);
      if (!position) throw new Error(`Timeline position unavailable for ${index}`);
      const day = page.locator(`.ct-day[data-day="${position.day}"]`);
      let action: Action | null = null;
      if (await day.getAttribute('aria-pressed') !== 'true') {
        const before = await page.evaluate(() => window.bench.trace()); await day.click();
        action = { kind: 'day-switch', requested: index, before, after: await page.evaluate(() => window.bench.trace()) };
      }
      const updated = await page.evaluate(index => window.__benchTimelinePosition?.(index), index);
      if (!updated) throw new Error(`Timeline position unavailable after day change for ${index}`);
      return { position: updated, action };
    }
    async function pointerJump(page: Page, index: number) {
      const start = await page.evaluate(() => window.bench.pointerStart()), first = await page.evaluate(() => window.bench.trace()), day = await pointerDay(page, index);
      const before = await page.evaluate(() => window.bench.trace());
      await page.mouse.click(day.position.x, day.position.y);
      const inputs = await page.evaluate(start => window.bench.pointerEnd(start), start);
      const after = await page.evaluate(() => window.bench.trace()), commits = await page.evaluate(start => window.bench.sceneEvents(start), first.sceneCount);
      const actions = correlatePointerActions([...(day.action ? [day.action] : []), { kind: 'scrub', requested: index, before, after }], inputs, commits, after.epochMs + 0.001, build.manifest.frames.map(frame => frame.id));
      return { requested: index, selected: (await page.evaluate(() => window.bench.snapshot())).selectedIndex, inputs, commits, actions };
    }
    async function pointerSweep(page: Page, indices: number[], intervalMs = 120) {
      const start = await page.evaluate(() => window.bench.pointerStart()), first = await page.evaluate(() => window.bench.trace()), actions: Action[] = [];
      let day = '';
      for (const index of indices) {
        const position = await page.evaluate(index => window.__benchTimelinePosition?.(index), index);
        if (!position) throw new Error(`Timeline position unavailable for ${index}`);
        if (position.day !== day) {
          if (day) { const before = await page.evaluate(() => window.bench.trace()); await page.mouse.up(); actions.push({ kind: 'gesture-end', requested: indices[indices.indexOf(index) - 1], before, after: await page.evaluate(() => window.bench.trace()) }); }
          const next = await pointerDay(page, index); day = next.position.day;
          if (next.action) actions.push(next.action);
          await page.mouse.move(next.position.x, next.position.y);
          const before = await page.evaluate(() => window.bench.trace()); await page.mouse.down(); await delay(intervalMs);
          actions.push({ kind: 'scrub', requested: index, before, after: await page.evaluate(() => window.bench.trace()) });
        } else {
          const next = await page.evaluate(index => window.__benchTimelinePosition?.(index), index);
          if (!next) throw new Error(`Timeline position unavailable for ${index}`);
          const before = await page.evaluate(() => window.bench.trace()); await page.mouse.move(next.x, next.y); await delay(intervalMs);
          actions.push({ kind: 'scrub', requested: index, before, after: await page.evaluate(() => window.bench.trace()) });
        }
      }
      if (day) { const before = await page.evaluate(() => window.bench.trace()); await page.mouse.up(); actions.push({ kind: 'gesture-end', requested: indices.at(-1)!, before, after: await page.evaluate(() => window.bench.trace()) }); }
      const inputs = await page.evaluate(start => window.bench.pointerEnd(start), start), end = await page.evaluate(() => window.bench.trace()), commits = await page.evaluate(start => window.bench.sceneEvents(start), first.sceneCount);
      return { inputs, commits, actions: correlatePointerActions(actions, inputs, commits, end.epochMs + 0.001, build.manifest.frames.map(frame => frame.id)) };
    }
    async function windHeight(page: Page, height: number) {
      const index = WIND_HEIGHTS.findIndex(stop => stop === height);
      if (index < 0) throw new Error(`Unsupported wind height ${height}`);
      await page.evaluate(index => {
        const input = document.querySelector<HTMLInputElement>('.wind-controls-range');
        if (!input) throw new Error('Wind height control unavailable');
        input.value = String(index);
        input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
      }, index);
      if (await page.evaluate(() => window.bench.camera().height) !== height) throw new Error(`Wind height did not commit ${height}`);
    }
    const samples: Record<string, Sample[]> = {}, summary: Record<string, unknown> = {}, memoryPlateau = [];
    let environment, finalEnvironment, initialHeap, finalHeap;
    try {
      for (const prepared of focused ? [] : scenario === 'smoke' ? [false] : [false, true]) for (const intervalMs of scenario === 'smoke' ? [120] : [120, 60]) {
        const { context, page, initial } = await openPage();
        try {
          environment ??= await page.evaluate(() => window.bench.snapshot());
          const prepStart = count(), prepareAt = Date.now(), preparationSettled = prepared ? await quiet(page, 10000, false) : false;
          const preparation = { elapsedMs: Date.now() - prepareAt, settled: preparationSettled, ...since(prepStart), state: await page.evaluate(() => window.bench.snapshot()) };
          const before = count(), timingStart = requestTimings.length;
          const result = await page.evaluate(({ interval, length }) => window.bench.drag(Array.from({ length }, (_, index) => index + 1), interval), { interval: intervalMs, length: frameCount - 1 });
          const key = `${prepared ? 'afterIdle' : 'cold'}Day${intervalMs}ms`;
          samples[key] = result.samples;
          const finalInput = result.samples.at(-1)!, targetFrame = build.manifest.frames[finalInput.index].id;
          const targetHttp = requestTimings.slice(timingStart).filter(timing => timing.frame === targetFrame).map(timing => ({ z: timing.z, startMs: timing.startedAt - finalInput.inputEpochMs,
            endMs: timing.finishedAt === undefined ? null : timing.finishedAt - finalInput.inputEpochMs }));
          summary[key] = { ...summarize(result.samples), staleFramePaints: result.staleFramePaints, lastTarget: result.lastTarget, initial, preparation, interaction: since(before), targetHttp, telemetry: await page.evaluate(() => window.bench.telemetry()) };
          finalEnvironment = await page.evaluate(() => window.bench.snapshot());
        } finally { await context.close(); }
      }
      if (scenario === 'pointer-smoke') {
        const { context, page, initial } = await openPage();
        try {
          environment = initial.state;
          const result = await pointerSweep(page, Array.from({ length: frameCount }, (_, index) => index));
          const attempts = result.actions.filter(action => action.kind === 'scrub');
          if (attempts.length !== frameCount) throw new Error('Pointer attempt count does not match the frame axis');
          samples.pointerSmoke = attributeInputs(result.inputs);
          finalEnvironment = await page.evaluate(() => window.bench.snapshot());
          summary.pointerSmoke = { initial, attempts: attempts.length, actions: result.actions, commits: result.commits, telemetry: await page.evaluate(() => window.bench.telemetry()) };
        } finally { await context.close(); }
      }
      if (scenario === 'device-sim') {
        const { context, page, initial } = await openPage();
        try {
          environment = initial.state;
          const steps: unknown[] = [];
          const record = async (label: string, action: () => Promise<unknown>, pauseMs = 600) => {
            const before = count(), started = Date.now(), previous = await page.evaluate(() => ({ camera: window.bench.camera(), telemetry: window.bench.telemetry(), state: window.bench.snapshot() }));
            await action(); const hostActionElapsedMs = Date.now() - started;
            await delay(pauseMs);
            const after = await page.evaluate(() => ({ camera: window.bench.camera(), telemetry: window.bench.telemetry(), state: window.bench.snapshot() }));
            const selected = after.state.frames[after.state.selectedIndex], raster = after.state.rasterReady;
            steps.push({ label, previous, after, hostActionElapsedMs, moveEndEvents: after.camera.moveEnds - previous.camera.moveEnds,
              selectedReady: !!selected && (raster.preview.includes(selected) || raster.native.includes(selected)) && after.state.windReady.includes(selected), transport: since(before) });
          };
          for (const height of [500, 2000, 1500]) await record(`warming-height-${height}`, () => windHeight(page, height));
          const warmStart = Date.now(); let ready = false;
          while (Date.now() - warmStart < warmMs) {
            const state = await page.evaluate(() => window.bench.snapshot());
            ready = state.frames.every(frame => (state.rasterReady.preview.includes(frame) || state.rasterReady.native.includes(frame)) && state.windReady.includes(frame));
            if (ready) break;
            await delay(250);
          }
          for (const height of [500, 2000, 1500]) await record(`${ready ? 'after-ready' : 'after-bounded-wait'}-height-${height}`, () => windHeight(page, height));
          for (const area of [80000, 110000, 140000, 110000, 80000]) await record(`area-${area}`, async () => page.evaluate(area => window.bench.area(area), area), 900);
          const original = (await page.evaluate(() => window.bench.camera())).center;
          await record('pan-away', async () => page.evaluate(([lon, lat]) => window.bench.center(lon + 0.08, lat), original), 900);
          await record('pan-back', async () => page.evaluate(([lon, lat]) => window.bench.center(lon, lat), original), 900);
          finalEnvironment = await page.evaluate(() => window.bench.snapshot());
          summary.deviceSim = { simulated: true, deviceMemoryHint: await page.evaluate(() => (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null), dpr: await page.evaluate(() => devicePixelRatio), initial, waitMs: Date.now() - warmStart, fullAxisReadyBeforeSecondHeightSequence: ready,
            boundsAreaOwner: 'viewport-policy.ts boundsAreaKm2(cameraBounds(map))', steps, telemetry: await page.evaluate(() => window.bench.telemetry()), expiryClock: 'not simulated' };
        } finally { await context.close(); }
      }
      if (scenario === 'interaction') {
        const { context, page, initial } = await openPage();
        try {
          environment = initial.state;
          const cdp = await context.newCDPSession(page), steps: unknown[] = [];
          await cdp.send('HeapProfiler.collectGarbage'); initialHeap = await cdp.send('Runtime.getHeapUsage');
          const original = (await page.evaluate(() => window.bench.camera())).center;
          const start = count(), inputStart = await page.evaluate(() => window.bench.pointerStart());
          for (let round = 0; round < repeats; round++) {
            let day: string | null = null;
            for (let step = 0; step < frameCount; step++) {
              const index = round % 2 ? frameCount - 1 - step : step;
              if (step % 6 === 0) {
                await windHeight(page, [500, 2000, 1500, 4000][(round + step / 6) % 4]);
                await page.evaluate(({ area, center }) => { window.bench.area(area); window.bench.center(center[0], center[1]); }, {
                  area: [8000, 80000, 140000, 600000][(round + step / 6) % 4],
                  center: [original[0] + (step % 12 ? 0.08 : 0), original[1]]
                });
              }
              const position = await page.evaluate(index => window.__benchTimelinePosition?.(index), index);
              if (!position) throw new Error(`Timeline position unavailable for ${index}`);
              if (position.day !== day) {
                if (day) await page.mouse.up();
                const next = await pointerDay(page, index); day = next.position.day;
                await page.mouse.move(next.position.x, next.position.y); await page.mouse.down();
              } else await page.mouse.move(position.x, position.y);
            }
            if (day) await page.mouse.up();
            steps.push({ round, camera: await page.evaluate(() => window.bench.camera()), state: await page.evaluate(() => window.bench.snapshot()), telemetry: await page.evaluate(() => window.bench.telemetry()) });
          }
          await windHeight(page, 1500);
          await page.evaluate(([lon, lat]) => { window.bench.center(lon, lat); window.bench.area(80000); }, original);
          samples.interaction = attributeInputs(await page.evaluate(start => window.bench.pointerEnd(start), inputStart));
          const settled = await quiet(page, warmMs, false);
          const finalSweep = await pointerSweep(page, Array.from({ length: frameCount }, (_, index) => index), 16);
          samples.recoverySweep = attributeInputs(finalSweep.inputs);
          const finalIndex = frameCount - 1, finalFrame = build.manifest.frames[finalIndex].id;
          const delivery = await waitForPreviewRecovery(() => page.evaluate(() => ({ state: window.bench.snapshot(), height: window.bench.camera().height })),
            { index: finalIndex, frame: finalFrame, height: 1500, wind: windFixture.expected(finalFrame, viewport.lat, viewport.lon, 1500) }, observerMode as 'instrumented' | 'control');
          await cdp.send('HeapProfiler.collectGarbage'); finalHeap = await cdp.send('Runtime.getHeapUsage');
          finalEnvironment = delivery.state;
          summary.interaction = { simulated: true, initial, steps, settled, transport: since(start), recoverySweep: finalSweep.actions,
            recovery: delivery.recovery, recovered: delivery.recovered, recoveryWaitMs: delivery.elapsedMs, final: finalEnvironment, telemetry: await page.evaluate(() => window.bench.telemetry()) };
        } finally { await context.close(); }
      }
      if (scenario === 'viewport-warm') {
        const { context, page, initial } = await openPage();
        try {
          environment = initial.state;
          const preparationStart = count(), started = Date.now();
          while (Date.now() - started < warmMs) {
            const state = await page.evaluate(() => window.bench.snapshot());
            if (state.frames.every(frame => (state.rasterReady.preview.includes(frame) || state.rasterReady.native.includes(frame)) && state.windReady.includes(frame))) break;
            await delay(250);
          }
          const preparation = { elapsedMs: Date.now() - started, ...since(preparationStart), state: await page.evaluate(() => window.bench.snapshot()) };
          const jumpSamples: Sample[] = [], jumpRequests: ReturnType<typeof since>[] = [];
          for (const index of [5, 35, 26, 13]) {
            const before = count();
            jumpSamples.push(await page.evaluate(index => window.bench.select(index, 'combined'), index));
            jumpRequests.push(since(before));
          }
          samples.jumps = jumpSamples;
          summary.syntheticRangeJumps = { ...summarize(jumpSamples), requests: jumpRequests };
          for (const [key, indices] of [['forward', Array.from({ length: frameCount }, (_, i) => i)], ['reverse', Array.from({ length: frameCount }, (_, i) => frameCount - 1 - i)]] as const) {
            const before = count(), result = await page.evaluate(indices => window.bench.drag(indices, 120), indices);
            samples[key] = result.samples;
            summary[`syntheticRange${key}`] = { ...summarize(result.samples), staleFramePaints: result.staleFramePaints, ...since(before) };
          }
          const pointerJumps = [];
          for (const index of [5, 35, 26, 13]) { const before = count(); pointerJumps.push({ ...await pointerJump(page, index), transport: since(before) }); }
          samples.pointerJumps = attributeInputs(pointerJumps.flatMap(jump => jump.inputs));
          summary.pointerJumps = { jumps: pointerJumps, ...summarize(samples.pointerJumps) };
          for (const [key, indices] of [['pointerForward', Array.from({ length: frameCount }, (_, i) => i)], ['pointerReverse', Array.from({ length: frameCount }, (_, i) => frameCount - 1 - i)]] as const) {
            const before = count(), result = await pointerSweep(page, indices);
            const attempts = result.actions.filter(action => action.kind === 'scrub');
            samples[key] = attributeInputs(result.inputs); summary[key] = { attempts: attempts.length, daySwitches: result.actions.filter(action => action.kind === 'day-switch').length, gestureEnds: result.actions.filter(action => action.kind === 'gesture-end').length,
              statuses: Object.fromEntries(['delivered', 'already-selected', 'diverged', 'superseded', 'timeout', 'not-delivered'].map(status => [status, attempts.filter(action => action.status === status).length])),
              matchedInputs: summarize(attempts.flatMap(action => action.chosen && (action.status === 'delivered' || action.status === 'already-selected') ? [action.chosen] : [])), actions: result.actions, commits: result.commits, transport: since(before) };
          }
          finalEnvironment = await page.evaluate(() => window.bench.snapshot());
          summary.viewportWarm = { initial, preparation, final: finalEnvironment, telemetry: await page.evaluate(() => window.bench.telemetry()) };
        } finally { await context.close(); }
      }
      if (scenario === 'contention') {
        const { context, page, initial } = await openPage();
        try {
          environment = initial.state;
          const deadline = Date.now() + 5000;
          while (active === 0 && Date.now() < deadline) await delay(25);
          const selectionAttemptAt = Date.now(), activeAtAttempt = active, before = count();
          faultsEnabled = true;
          const index = build.manifest.frames.findIndex(frame => frame.id === 'f060');
          if (index < 0) throw new Error('Contention target f060 is missing');
          const jump = await pointerJump(page, index), result = jump.inputs.findLast(sample => sample.index === index) ?? null;
          await delay(15000);
          finalEnvironment = await page.evaluate(() => window.bench.snapshot());
          samples.contention = attributeInputs(jump.inputs);
          const inputAt = result?.inputEpochMs ?? null;
          const activeAtInput = inputAt === null ? [] : events.filter(event => event.startedAt <= inputAt && (event.finishedAt === undefined || event.finishedAt > inputAt));
          summary.contention = { initial, activeAtAttempt, selectionAttemptAt, inputAt, targetSeen: result !== null, activeAtInput: inputAt === null ? null : activeAtInput.length, nonTargetActiveRequests: inputAt === null ? null : activeAtInput.filter(event => event.frame !== 'f060').length, jump, result, failedWind, delayedTile, ...since(before), final: finalEnvironment, telemetry: await page.evaluate(() => window.bench.telemetry()),
            events: events.filter(event => event.startedAt >= selectionAttemptAt || (event.finishedAt ?? Infinity) >= (inputAt ?? selectionAttemptAt)).map(event => ({ ...event, startedAt: event.startedAt - (inputAt ?? selectionAttemptAt), finishedAt: event.finishedAt === undefined ? null : event.finishedAt - (inputAt ?? selectionAttemptAt) })) };
        } finally { await context.close(); }
      }
      if (scenario === 'all') {
        const { context, page } = await openPage();
        try {
          const cdp = await context.newCDPSession(page);
          await quiet(page);
          await cdp.send('HeapProfiler.collectGarbage'); initialHeap = await cdp.send('Runtime.getHeapUsage');
          // Visit the full day to populate the same compressed tile cache in both variants.
          for (let index = 1; index < frameCount; index++) { await page.evaluate(index => window.bench.select(index), index); await quiet(page); }
          async function steps(key: string) {
            const rows: Sample[] = [], before = count();
            let index = await page.evaluate(() => window.bench.snapshot().selectedIndex), direction = -1;
            for (let count = 0; count < repeats; count++) {
              if (index === 0) direction = 1; else if (index === frameCount - 1) direction = -1;
              index += direction; rows.push(await page.evaluate(index => window.bench.select(index), index)); await quiet(page);
            }
            samples[key] = rows; summary[key] = { ...summarize(rows), ...since(before) };
          }
          await steps('warmSteps');
          for (const intervalMs of [120, 60]) {
            await page.evaluate(() => window.bench.select(0)); await quiet(page);
            const before = count(), result = await page.evaluate(({ interval, length }) => window.bench.drag(Array.from({ length }, (_, index) => index + 1), interval), { interval: intervalMs, length: frameCount - 1 });
            const key = `warmDay${intervalMs}ms`;
            samples[key] = result.samples; summary[key] = { ...summarize(result.samples), staleFramePaints: result.staleFramePaints, lastTarget: result.lastTarget, ...since(before) };
            await quiet(page);
          }
          await page.locator('#map').click({ position: { x: 1100, y: 500 } });
          await page.waitForFunction(() => { const card = document.querySelector<HTMLElement>('#point-card'); return card && !card.hidden && card.ariaBusy === 'false' && !!document.querySelector('#point-body')?.childElementCount; });
          await steps('warmStepsWithPoint');
          const layerStart = count(), layerSamples: Sample[] = [];
          for (const reference of ['msl', 'agl'] as const) { layerSamples.push(await page.evaluate(value => window.bench.layer(value), reference)); await quiet(page); }
          samples.layerSwitch = layerSamples; summary.layerSwitch = { ...summarize(layerSamples), ...since(layerStart) };
          for (let round = 0; round < 8; round++) {
            await page.evaluate(longitude => window.bench.pan(longitude), -100 + (round % 2 ? 0 : 5)); await quiet(page);
            for (const index of [0, Math.floor(frameCount / 2), frameCount - 1]) { await page.evaluate(index => window.bench.select(index), index); await quiet(page); }
            memoryPlateau.push({ round, ...await page.evaluate(() => window.bench.snapshot()) });
          }
          await cdp.send('HeapProfiler.collectGarbage'); finalHeap = await cdp.send('Runtime.getHeapUsage');
          finalEnvironment = await page.evaluate(() => window.bench.snapshot());
          await page.screenshot({ path: output.replace(/\.json$/, `-${name}.png`) });
        } finally { await context.close(); }
      }
      if (sourceSha256 !== await sourceHash(codeRoot)) throw new Error('Benchmark sources changed during the run; repeat with stable sources');
      const loaded = (await Promise.all([...vite.moduleGraph.idToModuleMap.keys()].map(async id => {
        const clean = id.split('?')[0]!;
        try { return await realpath(clean); } catch { return clean; }
      }))).filter(id => /[\\/]packages[\\/]|[\\/]apps[\\/]preview[\\/]src[\\/]/.test(id));
      const foreign = loaded.filter(id => !id.startsWith(codeRootReal + sep));
      if (foreign.length) throw new Error(`Benchmark loaded sources outside ${name}: ${foreign.slice(0, 5).join(', ')}`);
      const loadedHash = createHash('sha256');
      for (const file of [...new Set(loaded)].sort()) { loadedHash.update(relative(codeRootReal, file)); loadedHash.update(await readFile(file)); }
      const sourceIsolation = { codeRoot: codeRootReal, probes, loadedFiles: new Set(loaded).size, loadedSha256: loadedHash.digest('hex') };
      if (errors.length) throw new Error(errors.join('\n'));
      results.push({ name, revision: name === 'baseline' ? baselineRevision : 'working-tree', forecastRequestProfile: name === 'baseline' ? { historical: true, overrideApplied: false } : { historical: false, maxActive: forecastRequests, overrideApplied: true }, sourceSha256, sourceIsolation, environment, finalEnvironment, summary, samples, memoryPlateau,
        rasterTileStarts: requests, uniqueTileURLs: urls.size, rasterQueuedBodyBytes: bytes, rasterOverviewStarts: overviewRequests, rasterOverviewQueuedBodyBytes: overviewBytes, windRouteStarts: windRequests, windQueuedBodyBytes: windBytes, transport: since({ at: 0 }), maxImageReadyMs, httpVersions: [...protocols], peakTileAndWindHTTPRequests: peakActive, initialHeap, finalHeap });
      console.log(JSON.stringify({ name, scenario, peakTileAndWindHTTPRequests: peakActive }));
    } finally { await vite.close(); hmr.closeAllConnections(); await new Promise<void>(resolve => hmr.close(() => resolve())); for (const session of sessions) session.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }
  const harnessAfterSha256 = await harnessHash();
  if (harnessAfterSha256 !== harnessBeforeSha256) throw new Error('Benchmark harness or fixture inputs changed during capture');
  const fixtureSourceAfterSha256 = await sourceHash(root, fixtureSourceDirectories, false);
  if (fixtureSourceAfterSha256 !== fixtureSourceBeforeSha256) throw new Error('Server fixture workspace dependencies changed during capture');
  await writeFile(output, JSON.stringify({ capturedAt: new Date().toISOString(), scope: 'Instrumented mode samples nine framebuffer probes for raster identity; wind identity is installed state and a numeric sample, not blended GPU pixels. Control mode disables framebuffer probes and pixel identity, but retains readiness, scene, allocation and sampled RAF observers. Pixel-verified latency is INSTRUMENTED and no overhead is subtracted. Stale paint observations are sampled and cannot prove absence between probes. Synthetic range inputs bypass compact timeline gestures. Scene commits are correlated until the next selection; same-frame generation identity is not observable. Ready means cached viewport-covering raster preview or native plus a prepared grid and valid raw numeric wind sample at the selected height; changed also requires a cached field sampler. Historical baseline lacks reusable per-frame field samplers, so only its currently installed field qualifies. Per-input transport is attributed by frame and wall-clock interval; it does not prove causal request priority. Route starts, server finish events and queued body bytes are attributed independently; browser received bytes are unavailable.',
    fixtureLimitations: model === 'av-wrf' ? 'AV-WRF uses the shared pilot Lambert geometry (204x174 native, 407x347 fine), 41 synthetic vertical levels and all 48 frames through hour 72. Wind values, terrain and full-grid coverage are synthetic; production masks, GRIB values, network behavior and device performance are not measured.' : model === 'rrfs' ? 'Numeric values, terrain and frame axis are synthetic; RRFS 26-level grid, masks and shard layout model the published 20261116T012413Z-be57ad09-4ea7-4c22-b515-d2d72a6880bb f001 descriptor for all frames. Other published frame layouts were not verified. No real GRIB, integrity or device performance is implied.' : focused ? 'Numeric wind values and terrain are synthetic; 22-level GFS grids, tile masks, packed chunk sizes and shard counts follow the published 20261116T130646Z-59ac4a14-2907-4ce5-998a-80baf7a60c99 f004 layout. No real GRIB values, real network behavior, native feasibility, GPU execution or device performance are implied.' : 'Synthetic three-level wind validates decoding and identity only; real GFS acquisition costs and native-horizon feasibility remain unverified.',
    fixtureDigestPolicy: 'All synthetic descriptor shard SHA-256 and indexSha256 fields are stable, frame/kind/shard-specific NON-INTEGRITY placeholders, not content hashes; other synthetic manifest digests are also placeholders. Only URL-keyed client cache behavior is exercised. No content integrity or production digest semantics are tested.',
    telemetryScope: 'Scheduler queue and body settlement are timed inside scheduler; body settlement includes cancellation and is not server response completion. Decode is createImageBitmap promise elapsed time, not decoder CPU. Canvas draw, successful retained wind builds and display install are synchronous call durations; GL upload is CPU API submission time across map contexts, not GPU execution. Managed peaks are per ledger and limited to the first 16 ledgers; baseline has no ledger. Full-axis times are first observations sampled every 250ms since navigation, not guaranteed completion instants. Observer elapsed time includes synchronous GL readback stalls and readiness/snapshot loops; percentiles use the most recent 4096 samples. Animation is sampled in 500ms windows every 5s; skipped callbacks are estimates at an assumed 60Hz, not hardware dropped-frame counts. Long tasks require browser support. Control mode is not instrumentation-free.',
    observerMode, model, simulatedDevice: scenario === 'device-sim' || scenario === 'interaction' ? { dpr, deviceMemoryHint: deviceMemory, mobileViewport: mobile } : null, tileDelayMs, repeats, scenario, frameCount, frames: build.manifest.frames, opacity, transparent, wind, viewport, detailZoom, warmMs: focused ? warmMs : undefined, sourceDirectories, harnessInputs, harnessBeforeSha256, harnessAfterSha256, fixtureSourceDirectories, fixtureSourceBeforeSha256, fixtureSourceAfterSha256, baselineFixtureSourceSha256, node: process.version,
    memoryScope: 'GPU texture allocations include mip levels/pool. Weak native-pixel tracking counts unclosed/unfinished ImageBitmap decodes and canvas backing dimensions; pending Blob decode size assumes the fixture 256px tile. Driver overhead, workers and default framebuffer remain outside these logical byte counts. CDP heap follows forced GC.',
    channel: channel || 'headless-shell', browser: browser.version(), results }, null, 2) + '\n');
  console.log(`Report: ${output}`);
} finally { await browser.close(); await rm(scratch, { recursive: true, force: true }); }
