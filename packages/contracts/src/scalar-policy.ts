import type { LayerId } from './layers.js';

/** Absolute tolerance at a physical bound. The original finite value is stored. */
export const DIRECT_SCALAR_BOUNDARY = 1e-4;

export function acceptDirectScalar(layer: LayerId, value: number | null): { value: number | null; invalid: boolean } {
  if (value === null || !Number.isFinite(value)) return { value: null, invalid: false };
  if (layer === 'cloud-cover-total' || layer === 'cloud-cover-low') {
    if (value < -DIRECT_SCALAR_BOUNDARY || value > 100 + DIRECT_SCALAR_BOUNDARY) return { value: null, invalid: true };
    return { value, invalid: false };
  }
  if (layer === 'cape-jkg') {
    if (value < -DIRECT_SCALAR_BOUNDARY) return { value: null, invalid: true };
    return { value, invalid: false };
  }
  return { value, invalid: false };
}
