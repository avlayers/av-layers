import preact from '@preact/preset-vite';
import { browserBundleBudget } from '../../scripts/browser-bundle.js';
import { defineConfig } from 'vite';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export default defineConfig({
  envPrefix: ['VITE_', 'AV_API_BASE'],
  // Startup budget includes MapLibre GL plus the pinned @deck.gl/* and @luma.gl/* wind renderer.
  plugins: [preact(), browserBundleBudget(1_200_000, 300_000), {
    name: 'emit-notices',
    apply: 'build',
    async generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'MapLibre-LICENSE.txt', source: await readFile(join(require.resolve('maplibre-gl/package.json'), '..', 'LICENSE.txt')) });
      this.emitFile({ type: 'asset', fileName: 'THIRD_PARTY_NOTICES.txt', source: await readFile(new URL('../../THIRD_PARTY_NOTICES.txt', import.meta.url)) });
    }
  }],
  build: {
    minify: 'terser',
    target: 'es2022',
    sourcemap: true,
    outDir: 'dist'
  }
});
