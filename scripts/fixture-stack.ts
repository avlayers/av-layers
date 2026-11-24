import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A local API Worker and preview dev server serving the synthetic offline fixture. */
export interface FixtureStack {
  readonly baseUrl: string;
  readonly apiUrl: string;
  close(): Promise<void>;
}

export interface FixtureData {
  readonly root: string;
  readonly persistTo: string;
  readonly model: string;
  dispose(): Promise<void>;
}

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

async function freePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      server.close(err => err ? rejectPort(err) : resolvePort(port));
    });
  });
}

async function waitForHttp(url: string, deadlineMs: number): Promise<void> {
  while (Date.now() < deadlineMs) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      await response.body?.cancel();
      if (response.ok) return;
    } catch { /* Server still booting. */ }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

/** Generate and seed the offline fixture once, so several stacks can serve identical data. */
export async function prepareFixtureData(): Promise<FixtureData> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'av-fixture-'));
  const [{ OFFLINE_PRODUCT }, { generateOfflineFixture }, { seedLocalBuild }] = await Promise.all([
    import('@av/contracts/fixture-product'),
    import('./dev-fixture.js'),
    import('./sample-preview.js')
  ]);
  const manifestPath = await generateOfflineFixture(join(tempRoot, 'output'));
  const seeded = await seedLocalBuild({ manifestPath, persistTo: join(tempRoot, 'state'), fixture: true, trustedProduct: OFFLINE_PRODUCT });
  return {
    root: tempRoot,
    persistTo: seeded.persistTo,
    model: seeded.manifest.model,
    dispose: () => rm(tempRoot, { recursive: true, force: true })
  };
}

/** Start the API and preview from `repoRoot` (default: this checkout) against seeded fixture data. */
export async function startFixtureStack(data: FixtureData, repoRoot = REPO_ROOT): Promise<FixtureStack> {
  const children: ChildProcess[] = [];
  const terminate = (signal: NodeJS.Signals) => {
    for (const child of children) {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); }
      catch { child.kill(signal); }
    }
  };
  const close = async () => {
    terminate('SIGTERM');
    const force = setTimeout(() => terminate('SIGKILL'), 3_000).unref();
    await Promise.allSettled(children.map(child => new Promise<void>(done => {
      if (child.exitCode !== null || child.signalCode !== null) { done(); return; }
      child.once('close', () => done());
    })));
    clearTimeout(force);
  };
  try {
    const [apiPort, webPort] = await Promise.all([freePort(), freePort()]);
    const apiDir = join(repoRoot, 'apps', 'api'), previewDir = join(repoRoot, 'apps', 'preview');
    const wranglerJs = join(repoRoot, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
    children.push(spawn(process.execPath, [
      wranglerJs, 'dev', join(apiDir, 'test', 'fixture-worker.ts'), '--local', '--var', 'AV_LOCAL_DEVELOPMENT:true',
      '--ip', '127.0.0.1', '--port', String(apiPort), '--persist-to', data.persistTo, '--log-level', 'error', '--show-interactive-dev-session=false'
    ], { cwd: apiDir, stdio: 'inherit', detached: process.platform !== 'win32' }));
    children.push(spawn(process.execPath, [join(previewDir, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], {
      cwd: previewDir, stdio: 'inherit', detached: process.platform !== 'win32',
      env: { ...process.env, AV_API_BASE: `http://127.0.0.1:${apiPort}`, VITE_MODEL: data.model, VITE_OFFLINE_FIXTURE: 'true', VITE_BUILD_REVISION: 'smoke' }
    }));
    const deadline = Date.now() + 30_000;
    await Promise.all([
      waitForHttp(`http://127.0.0.1:${apiPort}/healthz`, deadline),
      waitForHttp(`http://127.0.0.1:${webPort}/`, deadline)
    ]);
    return { baseUrl: `http://127.0.0.1:${webPort}`, apiUrl: `http://127.0.0.1:${apiPort}`, close };
  } catch (error) {
    await close();
    throw error;
  }
}
