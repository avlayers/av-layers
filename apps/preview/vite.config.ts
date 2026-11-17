import preact from '@preact/preset-vite';
import { browserBundleBudget } from '../../scripts/browser-bundle.js';
import { defineConfig } from 'vite';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const shim = (name: string) => new URL(`./src/shims/${name}.ts`, import.meta.url).pathname;

export default defineConfig({
  envPrefix: ['VITE_', 'AV_API_BASE'],
  resolve: { alias: { path: shim('node-path'), 'node:path': shim('node-path'), fs: shim('node-path'), 'node:fs': shim('node-path'), 'fs/promises': shim('node-path'), 'node:fs/promises': shim('node-path'), url: shim('node-path'), 'node:url': shim('node-path'), os: shim('node-path'), 'node:os': shim('node-path'), http: shim('node-path'), 'node:http': shim('node-path'), https: shim('node-path'), 'node:https': shim('node-path'), zlib: shim('node-path'), 'node:zlib': shim('node-path'), stream: shim('node-path'), 'node:stream': shim('node-path'), util: shim('node-path'), 'node:util': shim('node-path'), buffer: shim('node-path'), 'node:buffer': shim('node-path'), crypto: shim('node-path'), 'node:crypto': shim('node-path'), worker_threads: shim('node-path'), 'node:worker_threads': shim('node-path') } },
  // CI measured 414067 B gzip startup after globe Auto selection; streaming and wind-render instrumentation adds about 300 B.
  plugins: [preact(), browserBundleBudget(1_200_000, 300_000), {
    name: 'windy-plugin-assets',
    apply: 'build',
    async generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'MapLibre-LICENSE.txt', source: await readFile(join(require.resolve('maplibre-gl/package.json'), '..', 'LICENSE.txt')) });
      this.emitFile({ type: 'asset', fileName: 'THIRD_PARTY_NOTICES.txt', source: await readFile(new URL('../../THIRD_PARTY_NOTICES.txt', import.meta.url)) });
      const directory = fileURLToPath(new URL('../windy-plugin/dist/', import.meta.url));
      for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const path = join(entry.parentPath, entry.name);
        this.emitFile({ type: 'asset', fileName: `windy-plugin/${relative(directory, path).replaceAll('\\', '/')}`, source: await readFile(path) });
      }
    }
  }],
  build: {
    minify: 'terser',
    target: 'es2022',
    sourcemap: true,
    outDir: 'dist'
  }
});
