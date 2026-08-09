/**
 * Config-as-data (ADR-002 D5).
 *
 * Clustering parameters, the source registry, alert thresholds and the polling bbox are
 * not constants in code and not rows someone edits in production — they are versioned
 * data loaded at startup. Two properties matter:
 *
 *   1. A replay of last September must use *last September's* parameters, so every
 *      artifact that depends on them records the version it ran under.
 *   2. Two runs that claim the same version must be byte-identical, so the version
 *      carries a digest of the values rather than a number someone remembers to bump.
 */

import { canonicalJson } from '../determinism/canonical-json.js';

export interface VersionedConfig<T> {
  readonly name: string;
  readonly version: string;
  /** Digest over the canonical serialization — the thing a report actually cites. */
  readonly digest: string;
  readonly values: Readonly<T>;
}

/**
 * FNV-1a over the canonical serialization. Not a security primitive — it identifies a
 * parameter set in a report and catches an accidental edit, nothing more — and it is
 * deliberately dependency-free so the core stays free of platform crypto.
 */
export function configDigest(value: unknown): string {
  const text = canonicalJson(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * The shape of a config version string. Exported because the replay fixtures pin the
 * versions they were recorded under and must validate them the same way — a second
 * regex would be a second definition of what a version is.
 */
export const CONFIG_VERSION_RE = /^[a-z0-9_]+_v\d+$/;

export function defineConfig<T>(
  name: string,
  version: string,
  values: Readonly<T>,
): VersionedConfig<T> {
  if (!CONFIG_VERSION_RE.test(version)) {
    throw new RangeError(
      `config version must look like clustering_params_v1, got ${JSON.stringify(version)}`,
    );
  }
  return Object.freeze({
    name,
    version,
    digest: configDigest(values),
    values: Object.freeze(values),
  });
}
