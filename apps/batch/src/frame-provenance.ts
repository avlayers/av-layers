import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { encodeBoundedJson, MAX_PROVENANCE_BYTES, MAX_PROVENANCE_JSON_TOKENS, parseBoundedJson, parseFrameProvenance,
  getProvenanceReference, parseProvenance, provenanceFrameReferenceSchema, type ManifestV5, type ProvenanceFrameReference } from '@av/contracts';
import { localPath, readLocalFile } from './local-file.js';
import type { ObjectStorage } from './storage.js';

type Identity = Pick<ManifestV5, 'model' | 'buildId' | 'cycle'>;
type Frame = ManifestV5['frames'][number];
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const frameKey = (identity: Identity, frame: Frame): string => `builds/${identity.model}/${identity.buildId}/provenance/${frame.id}.json`;

export async function readLocalProvenance(root: string, manifest: Identity & Pick<ManifestV5, 'source' | 'frames'>) {
  const reference = getProvenanceReference(manifest);
  const bytes = await readLocalFile(localPath(root, reference.key), MAX_PROVENANCE_BYTES);
  if (digest(bytes) !== reference.sha256) throw new Error(`Invalid provenance hash ${reference.key}`);
  return { reference, bytes, value: parseProvenance(parseBoundedJson(bytes, MAX_PROVENANCE_JSON_TOKENS), manifest) };
}

/** Commit one bounded source receipt; the run index retains its verified reference. */
export async function writeFrameProvenance(root: string, identity: Identity, frame: Frame, receipt: { hour: number; intervals: unknown; receipt: unknown }): Promise<ProvenanceFrameReference> {
  const value = parseFrameProvenance({ version: 1, ...identity, frame, ...receipt }, identity, frame);
  const bytes = encodeBoundedJson(value, MAX_PROVENANCE_BYTES, MAX_PROVENANCE_JSON_TOKENS), key = frameKey(identity, frame);
  const reference = provenanceFrameReferenceSchema.parse({ hour: receipt.hour, frame: frame.id, key, bytes: bytes.byteLength, sha256: digest(bytes) });
  const file = localPath(root, key);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, bytes, { flag: 'wx' });
  return reference;
}

/** `local` with each `capturedAt` timestamp taken from the same place in `stored`; everything else stays local. */
const withStoredCaptureTimes = (local: unknown, stored: unknown): unknown => {
  if (Array.isArray(local)) return local.map((item, index) => withStoredCaptureTimes(item, Array.isArray(stored) ? stored[index] : undefined));
  if (!local || typeof local !== 'object') return local;
  const other = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored as Record<string, unknown> : {};
  return Object.fromEntries(Object.entries(local).map(([key, item]) => [key,
    key === 'capturedAt' && typeof item === 'string' && typeof other[key] === 'string' && Number.isFinite(Date.parse(other[key] as string))
      ? other[key] : withStoredCaptureTimes(item, other[key])]));
};

/**
 * A retried shard reacquires the same upstream objects with a new `capturedAt`. When an interrupted attempt
 * already stored this frame's immutable provenance, and its bytes are exactly the local bytes with the
 * stored capture timestamps in place of the local ones, the stored bytes replace the local ones so the
 * retry finishes the same build. Any other difference (changed upstream objects, extra keys, other
 * encodings) keeps the new bytes, and the immutable write still refuses them.
 */
export async function adoptStoredFrameProvenance(root: string, store: Pick<ObjectStorage, 'get'>, reference: ProvenanceFrameReference, signal?: AbortSignal): Promise<ProvenanceFrameReference> {
  const stored = await store.get(reference.key, undefined, MAX_PROVENANCE_BYTES, signal);
  if (!stored) return reference;
  const sha256 = digest(stored.bytes);
  if (sha256 === reference.sha256) return reference;
  const file = localPath(root, reference.key), local = await readLocalFile(file, MAX_PROVENANCE_BYTES, reference.bytes);
  const parse = (bytes: Uint8Array) => parseBoundedJson(bytes, MAX_PROVENANCE_JSON_TOKENS);
  const expected = encodeBoundedJson(withStoredCaptureTimes(parse(local), parse(stored.bytes)), MAX_PROVENANCE_BYTES, MAX_PROVENANCE_JSON_TOKENS);
  if (Buffer.compare(expected, stored.bytes) !== 0) return reference;
  await writeFile(file, stored.bytes);
  return provenanceFrameReferenceSchema.parse({ ...reference, bytes: stored.bytes.byteLength, sha256 });
}

export async function readFrameProvenance(source: string | { store: ObjectStorage; signal?: AbortSignal }, identity: Identity, frame: Frame, reference: ProvenanceFrameReference) {
  provenanceFrameReferenceSchema.parse(reference);
  if (reference.frame !== frame.id || reference.key !== frameKey(identity, frame)) throw new Error('Invalid provenance frame reference');
  let bytes: Uint8Array;
  if (typeof source === 'string') bytes = await readLocalFile(localPath(source, reference.key), MAX_PROVENANCE_BYTES, reference.bytes);
  else {
    source.signal?.throwIfAborted();
    const object = await source.store.get(reference.key, undefined, reference.bytes, source.signal);
    if (!object || object.bytes.byteLength !== reference.bytes) throw new Error('Provenance frame missing or wrong length');
    bytes = object.bytes;
  }
  if (digest(bytes) !== reference.sha256) throw new Error('Provenance frame hash mismatch');
  const value = parseFrameProvenance(parseBoundedJson(bytes, MAX_PROVENANCE_JSON_TOKENS), identity, frame);
  if (value.hour !== reference.hour) throw new Error('Provenance frame hour mismatch');
  return value;
}
