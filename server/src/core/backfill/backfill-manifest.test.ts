import { describe, expect, it } from 'vitest';

import { defineConfig } from '../config/versioned-config.js';
import {
  MANIFEST_VERSION,
  completedEntry,
  emptyManifest,
  parseManifest,
  renderManifest,
  withEntry,
  type ManifestEntry,
} from './backfill-manifest.js';
import { backfillJob, planChunks, type BackfillSourceSpec } from './backfill-plan.js';

const SPEC: BackfillSourceSpec = {
  source: 'firms:viirs:snpp',
  product: 'VIIRS_SNPP_SP',
  firstDay: '2024-01-01',
  lastDay: '2024-01-12',
};

const JOB = backfillJob(
  defineConfig('firms_sp_backfill', 'firms_sp_backfill_test_v1', { sources: [SPEC] }),
);

/** A fake but shape-correct hash — 64 hex characters, obviously not a real digest. */
const FAKE_SHA = 'ab'.repeat(32);

const COMPLETE: ManifestEntry = {
  source: 'firms:viirs:snpp',
  product: 'VIIRS_SNPP_SP',
  start_date: '2024-01-01',
  day_range: 10,
  path: 'firms/VIIRS_SNPP_SP/2024/VIIRS_SNPP_SP_2024-01-01_10d.csv',
  status: 'complete',
  fetched_at: '2026-08-12T09:00:00Z',
  bytes: 1234,
  sha256: FAKE_SHA,
};

describe('renderManifest / parseManifest', () => {
  it('round-trips a manifest through its on-disk text', () => {
    const manifest = withEntry(emptyManifest(JOB), 'VIIRS_SNPP_SP/2024-01-01/10d', COMPLETE);

    const parsed = parseManifest(renderManifest(manifest), JOB);

    expect(parsed).toEqual(manifest);
  });

  it('renders human-readable text: pretty-printed, keys sorted, trailing newline', () => {
    const text = renderManifest(withEntry(emptyManifest(JOB), 'a-chunk', COMPLETE));

    expect(text.endsWith('}\n')).toBe(true);
    expect(text.split('\n').length).toBeGreaterThan(5);
    // Top-level keys appear in sorted order, so two manifests diff cleanly.
    const keys = ['"area"', '"chunks"', '"manifest_version"', '"plan"', '"plan_digest"'];
    const positions = keys.map((key) => text.indexOf(key));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(positions.every((at) => at >= 0)).toBe(true);
  });

  it('keeps entries this plan does not know, so a widened plan is append-safe', () => {
    const foreign: ManifestEntry = { ...COMPLETE, product: 'MODIS_SP' };
    const manifest = withEntry(emptyManifest(JOB), 'MODIS_SP/2023-06-01/10d', foreign);

    const parsed = parseManifest(renderManifest(manifest), JOB);
    const updated = withEntry(parsed, 'VIIRS_SNPP_SP/2024-01-01/10d', COMPLETE);

    expect(updated.chunks['MODIS_SP/2023-06-01/10d']).toEqual(foreign);
  });

  it('refuses text that is not JSON, without suggesting deletion works', () => {
    expect(() => parseManifest('not json', JOB)).toThrow(/not valid JSON/);
    expect(() => parseManifest('[]', JOB)).toThrow(/JSON object/);
  });

  it('refuses a manifest written under a different plan, digest or area — by name', () => {
    const text = renderManifest(emptyManifest(JOB));

    expect(() => parseManifest(text, { ...JOB, plan: 'firms_sp_backfill_test_v2' })).toThrow(
      /plan is "firms_sp_backfill_test_v1"/,
    );
    expect(() => parseManifest(text, { ...JOB, planDigest: 'deadbeef' })).toThrow(/plan_digest/);
    expect(() => parseManifest(text, { ...JOB, area: '19,39,31,46' })).toThrow(/area/);
    expect(() => parseManifest(text, { ...JOB, pollingBboxVersion: 'polling_bbox_v2' })).toThrow(
      /polling_bbox_version/,
    );
  });

  it('refuses a manifest version this build does not write', () => {
    const text = renderManifest(emptyManifest(JOB)).replace(
      `"manifest_version": ${String(MANIFEST_VERSION)}`,
      '"manifest_version": 99',
    );

    expect(() => parseManifest(text, JOB)).toThrow(/manifest_version/);
  });

  it('refuses a complete entry that lost its hash — --check would have nothing to verify', () => {
    const { sha256: _dropped, ...withoutHash } = COMPLETE;
    const manifest = withEntry(emptyManifest(JOB), 'a-chunk', withoutHash);

    expect(() => parseManifest(renderManifest(manifest), JOB)).toThrow(/sha256/);
  });

  it('refuses an entry with a status it does not have words for', () => {
    const text = renderManifest(
      withEntry(emptyManifest(JOB), 'a-chunk', {
        ...COMPLETE,
        status: 'in_progress' as ManifestEntry['status'],
      }),
    );

    expect(() => parseManifest(text, JOB)).toThrow(/status/);
  });
});

describe('completedEntry', () => {
  const chunk = planChunks(SPEC)[0];

  it('returns the entry only when it is complete', () => {
    if (chunk === undefined) throw new Error('plan produced no chunks');
    const complete = withEntry(emptyManifest(JOB), chunk.chunkId, COMPLETE);
    const { bytes: _bytes, sha256: _sha256, ...withoutHash } = COMPLETE;
    const failed = withEntry(emptyManifest(JOB), chunk.chunkId, {
      ...withoutHash,
      status: 'failed',
      error: 'FIRMS returned 503',
    });

    expect(completedEntry(complete, chunk)).toEqual(COMPLETE);
    expect(completedEntry(failed, chunk)).toBeNull();
    expect(completedEntry(emptyManifest(JOB), chunk)).toBeNull();
  });
});
