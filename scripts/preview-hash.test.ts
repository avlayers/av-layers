import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { previewSourceHash } from './preview-hash';

it('fingerprints model JSON and excludes node_modules and tests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'preview-hash-test-'));
  try {
    const dir = join(root, 'packages/contracts');
    await mkdir(join(dir, 'config'), { recursive: true });
    await mkdir(join(dir, 'node_modules'), { recursive: true });
    await writeFile(join(dir, 'config/models.json'), '{"version":1}');
    await writeFile(join(dir, 'index.ts'), 'export {};');
    const first = await previewSourceHash(root, ['packages/contracts'], false);
    await writeFile(join(dir, 'node_modules/ignored.json'), '{}');
    await writeFile(join(dir, 'ignored.test.ts'), 'export {};');
    expect(await previewSourceHash(root, ['packages/contracts'], false)).toBe(first);
    await writeFile(join(dir, 'config/models.json'), '{"version":2}');
    expect(await previewSourceHash(root, ['packages/contracts'], false)).not.toBe(first);
  } finally { await rm(root, { recursive: true, force: true }); }
});
