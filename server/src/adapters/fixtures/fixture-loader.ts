/**
 * Reads a golden-replay fixture off disk (GATES §1.1).
 *
 * The filesystem is the only reason this is an adapter: parsing and validation live in
 * `core/replay/fixture-format.ts` so they stay testable without one. The one check that
 * genuinely belongs here is the `detection_uid` verification — it needs a hash, and the
 * hash lives behind a platform API.
 *
 * That check matters more than it looks. Fixtures are hand-edited: someone nudges a
 * coordinate to move a detection across a cluster boundary and does not recompute the
 * id. The replay then runs against a detection whose id does not describe it, dedup
 * behaves differently than it would in production, and the fixture quietly asserts
 * something that can never happen. Recomputing the digest on load makes that a load
 * error instead of a wrong green.
 *
 * The observation context — cloud, source outages, official declarations — is read the
 * same way: the file is named by the manifest, parsed in the core, and cross-checked
 * against the polls before the fixture is handed back.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { detectionUid } from '@fire-watch/contracts/node';

import {
  EMPTY_OBSERVATIONS,
  assertObservationsResolve,
  parseFixtureManifest,
  parseObservationContext,
  parseReplayBatch,
  type ReplayBatchInput,
} from '../../core/replay/fixture-format.js';
import type { ReplayFixture } from '../../core/replay/runner.js';

export const MANIFEST_FILE = 'manifest.json';

export function loadFixture(directory: string): ReplayFixture {
  const manifest = parseFixtureManifest(
    readJson(join(directory, MANIFEST_FILE)),
    `${directory}/${MANIFEST_FILE}`,
  );

  const batches = manifest.inputs.map((input) => {
    const batch = parseReplayBatch(readJson(join(directory, input)), input);
    verifyDetectionUids(batch, `${directory}/${input}`);
    return batch;
  });

  // A fixture that names no observations file gets the shared empty context rather than a
  // null, so every consumer downstream reads the same three arrays (see `ReplayFixture`).
  const observations =
    manifest.observations === null
      ? EMPTY_OBSERVATIONS
      : parseObservationContext(
          readJson(join(directory, manifest.observations)),
          `${directory}/${manifest.observations}`,
        );
  assertObservationsResolve(observations, batches);

  return {
    manifest,
    batches,
    observations,
    expected: readJson(join(directory, manifest.expected)),
  };
}

/**
 * Every fixture directory under `root`, in a stable order. `readdirSync` order is
 * filesystem-dependent — ext4 and APFS disagree — so it is sorted before it can become
 * the order a test suite reports failures in.
 */
export function listFixtureDirectories(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function verifyDetectionUids(batch: ReplayBatchInput, origin: string): void {
  for (const detection of batch.detections) {
    const expected = detectionUid({
      source: detection.source,
      acqTsIso: detection.acqTsIso,
      lat: detection.latCanonical,
      lon: detection.lonCanonical,
    });
    if (expected !== detection.detectionUid) {
      throw new Error(
        `${origin}: detection_uid does not match its own fields — ` +
          `expected ${expected}, found ${detection.detectionUid}. ` +
          'Recompute the id after editing a fixture row (GLOSSARY §1b).',
      );
    }
  }
}

function readJson(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new Error(`fixture file is missing: ${path}`, { cause });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new Error(`fixture file is not valid JSON: ${path}`, { cause });
  }
}
