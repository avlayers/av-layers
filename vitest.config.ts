import { availableParallelism } from 'node:os';
import { configDefaults, defineConfig } from 'vitest/config';

const include = ['{packages,apps,scripts,tests}/**/*.test.{ts,tsx}'];
const integration = [
  '{packages,apps,scripts,tests}/**/*.integration.test.ts',
  'apps/api/test/{runtime,wind-data}.test.ts',
  'apps/batch/src/{archive,raster-pool,render,whole-domain-v5}.test.ts',
  'scripts/sample-preview.test.ts'
];

export default defineConfig({
  test: {
    css: { include: [/\?inline$/] },
    testTimeout: 30_000,
    fileParallelism: true,
    maxWorkers: Math.min(8, availableParallelism()),
    projects: [
      { extends: true, test: { name: 'unit', include, exclude: [...configDefaults.exclude, ...integration] } },
      { extends: true, test: { name: 'integration', include: integration } }
    ]
  }
});
