/**
 * Reading back the elements `tle-refresh.ts` stored, verified (TASKS F15).
 *
 * Each platform's payload is hashed by the reader and compared with the sha256 its sidecar
 * recorded, then re-parsed through the same OMM gate the refresh used. The refresh writes
 * the payload and then the sidecar, so a reader can catch the pair mid-flip: one retry,
 * then the platform reads as unverifiable — reported as missing elements, never computed
 * from bytes nobody vouched for.
 */

import type { PayloadReader } from '../ports/payload-reader.js';
import { parseOmmBody } from './omm.js';
import { PASS_PLATFORMS, type PassPlatform } from './pass-platforms.js';
import type { PlatformElements } from './passes-document.js';
import { tleElementsPath, tleMetaPath } from './tle-refresh.js';

export interface StoredElements {
  readonly elements: readonly PlatformElements[];
  /**
   * The verified payload hashes in platform order (`-` for none): a cache key that changes
   * exactly when a document computed from these elements would.
   */
  readonly digest: string;
  /** Per-platform reasons a stored copy was refused, for the operator's log. */
  readonly problems: readonly string[];
}

type ReadOutcome =
  | { readonly kind: 'ok'; readonly elements: PlatformElements; readonly sha256: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'refused'; readonly reason: string };

export async function loadStoredElements(
  reader: PayloadReader,
  platforms: readonly PassPlatform[] = PASS_PLATFORMS,
): Promise<StoredElements> {
  const elements: PlatformElements[] = [];
  const hashes: string[] = [];
  const problems: string[] = [];
  for (const platform of platforms) {
    let outcome = await readOnce(reader, platform);
    if (outcome.kind === 'refused') outcome = await readOnce(reader, platform);
    if (outcome.kind === 'ok') {
      elements.push(outcome.elements);
      hashes.push(outcome.sha256);
      continue;
    }
    if (outcome.kind === 'refused') problems.push(`${platform.id}: ${outcome.reason}`);
    elements.push({ platform, record: null });
    hashes.push('-');
  }
  return { elements, digest: hashes.join(','), problems };
}

async function readOnce(reader: PayloadReader, platform: PassPlatform): Promise<ReadOutcome> {
  const meta = await reader.readText(tleMetaPath(platform.noradId));
  const payload = await reader.readPayload(tleElementsPath(platform.noradId));
  if (meta === null && payload === null) return { kind: 'absent' };
  if (meta === null || payload === null) {
    return { kind: 'refused', reason: 'payload and sidecar not both present' };
  }
  const sidecarSha = sidecarSha256(meta, platform.noradId);
  if (sidecarSha === null) return { kind: 'refused', reason: 'sidecar is malformed' };
  if (sidecarSha !== payload.sha256) {
    return { kind: 'refused', reason: 'payload does not match its sidecar sha256' };
  }
  const parsed = parseOmmBody(new TextDecoder().decode(payload.bytes), platform.noradId);
  if (!parsed.ok) return { kind: 'refused', reason: parsed.reason };
  return { kind: 'ok', elements: { platform, record: parsed.record }, sha256: payload.sha256 };
}

function sidecarSha256(text: string, noradId: number): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record['norad_id'] !== noradId) return null;
  const sha = record['sha256'];
  return typeof sha === 'string' && /^[0-9a-f]{64}$/.test(sha) ? sha : null;
}
