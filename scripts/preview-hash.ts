import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, sep } from 'node:path';

export async function previewSourceHash(directory: string, directories: string[], index: boolean) {
  const hash = createHash('sha256');
  for (const sourceDirectory of directories) for (const path of (await readdir(join(directory, sourceDirectory), { recursive: true })).sort()) {
    if (path.split(sep).includes('node_modules') || !/\.(?:ts|tsx|css|json)$/.test(path) || /\.test\.tsx?$/.test(path)) continue;
    hash.update(`${sourceDirectory}/${path}`).update(await readFile(join(directory, sourceDirectory, path)));
  }
  if (index) hash.update(await readFile(join(directory, 'apps/preview/index.html')));
  return hash.digest('hex');
}
