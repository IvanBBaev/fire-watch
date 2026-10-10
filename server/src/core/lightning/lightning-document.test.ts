import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { POLLING_BBOX } from '../config/polling-bbox.js';
import {
  LIGHTNING_DOCUMENT_RETENTION_MS,
  LIGHTNING_MAX_STALENESS_MS,
  LIGHTNING_RETENTION_MS,
  buildRecord,
  documentFlashes,
  emptyDocument,
  encodeProductId,
  mergeRecords,
  parseLightningDocument,
  parseLightningRecord,
  recordMetaPath,
  recordPath,
  selectLightning,
  type LightningRecord,
} from './lightning-document.js';
import { LIGHTNING_FILTER } from '../config/lightning-filter.js';
import { defineConfig } from '../config/versioned-config.js';
import type { Flash } from './lightning-payload.js';

const NOW = Date.UTC(2026, 8, 30, 12, 40);
const MIN = 60_000;
const BOX = POLLING_BBOX.values;

function flash(at: number, lat = 42.5, lon = 23.5, falseLikelihood: number | null = 0.1): Flash {
  return { at, lat, lon, radiance: 10, durationMs: 100, footprint: 2, falseLikelihood };
}

/** A 10-minute product ending `endMinutesAgo` before NOW, with the given flashes. */
function record(
  id: string,
  endMinutesAgo: number,
  flashes: readonly Flash[] = [],
  publishedAtIso: string | null = null,
): LightningRecord {
  const end = NOW - endMinutesAgo * MIN + 9_000;
  return buildRecord({
    productId: id,
    window: { start: end - 10 * MIN, end },
    publishedAtIso,
    availableAt: end + 40_000,
    flashes: flashes.length > 0 ? flashes : [flash(end - 5 * MIN)],
  });
}

describe('record paths', () => {
  it('shard by day and name the file by the product id', () => {
    const end = Date.UTC(2026, 8, 30, 12, 30, 9);
    expect(recordPath(end, 'LFL_0001.nc')).toBe('lightning/mtg-li/lfl/20260930/LFL_0001.nc.json');
    expect(recordMetaPath(end, 'LFL_0001.nc')).toBe(
      'lightning/mtg-li/lfl/20260930/LFL_0001.nc.meta.json',
    );
  });

  it('encode an id so it can never leave its directory or collide', () => {
    expect(encodeProductId('../x/y')).toBe('~2e.~2fx~2fy');
    expect(encodeProductId('a~2fb')).not.toBe(encodeProductId('a/b'));
    expect(encodeProductId('a b')).not.toBe(encodeProductId('a_b'));
    expect(encodeProductId('.hidden').startsWith('.')).toBe(false);
    expect(encodeProductId('a/b')).not.toContain('/');
  });
});

describe('buildRecord', () => {
  it('sorts flashes and renders times with milliseconds', () => {
    const r = buildRecord({
      productId: 'p',
      window: { start: NOW - 10 * MIN, end: NOW },
      availableAt: NOW,
      flashes: [flash(NOW - MIN), flash(NOW - 2 * MIN + 250)],
    });
    expect(r.flashes.map((f) => f.t)).toEqual([
      '2026-09-30T12:38:00.250Z',
      '2026-09-30T12:39:00.000Z',
    ]);
    expect(parseLightningRecord(JSON.stringify(r))).toEqual(r);
  });
});

describe('mergeRecords', () => {
  it('adds products, reports coverage, and ignores a product merged before', () => {
    const a = record('a', 20);
    const b = record('b', 10);
    const once = mergeRecords(emptyDocument(NOW), [a, b], NOW);
    expect(once.products.map((p) => p.id)).toEqual(['a', 'b']);
    expect(once.covered_through).toBe(b.end);
    expect(once.covered_from).toBe(a.start);
    expect(once.available_at).toBe(b.available_at);
    expect(documentFlashes(once)).toHaveLength(2);
    const twice = mergeRecords(once, [b], NOW);
    expect(twice).toEqual(once);
  });

  it('drops products and flashes older than the retention window', () => {
    const old = record('old', LIGHTNING_DOCUMENT_RETENTION_MS / MIN + 5);
    const kept = record('kept', LIGHTNING_RETENTION_MS / MIN + 30);
    const fresh = record('fresh', 10);
    const merged = mergeRecords(emptyDocument(NOW), [old, kept, fresh], NOW);
    expect(merged.products.map((p) => p.id)).toEqual(['kept', 'fresh']);
    expect(documentFlashes(merged)).toHaveLength(2);
  });

  it('empties to null coverage once everything has aged out', () => {
    const merged = mergeRecords(emptyDocument(NOW), [record('a', 10)], NOW);
    const later = mergeRecords(merged, [], NOW + LIGHTNING_DOCUMENT_RETENTION_MS + 20 * MIN);
    expect(later.covered_through).toBeNull();
    expect(documentFlashes(later)).toEqual([]);
  });

  it('gives the same document for the same records merged in any order or in any split', () => {
    const records = Array.from({ length: 6 }, (_, i) =>
      record(`p${String(i)}`, 10 + i * 10, [
        flash(NOW - (15 + i * 10) * MIN, 40 + i * 0.5, 21 + i),
        flash(NOW - (12 + i * 10) * MIN, 44 - i * 0.25, 29 - i),
      ]),
    );
    fc.assert(
      fc.property(
        fc.shuffledSubarray(records, { minLength: records.length }),
        fc.integer({ min: 0, max: records.length }),
        (shuffled, split) => {
          const reference = mergeRecords(emptyDocument(NOW), records, NOW);
          const first = mergeRecords(emptyDocument(NOW), shuffled.slice(0, split), NOW);
          const both = mergeRecords(first, shuffled.slice(split), NOW);
          expect(both).toEqual(reference);
        },
      ),
    );
  });
});

describe('reprocessed products', () => {
  const late = '2026-09-30T12:45:00Z';
  const early = '2026-09-30T12:31:00Z';

  it('replace exactly their own window, whichever arrives first', () => {
    const neighbour = record('n', 20);
    const original = record('orig', 10, [flash(NOW - 12 * MIN), flash(NOW - 11 * MIN)], early);
    const reprocess = record('rep', 10, [flash(NOW - 12 * MIN)], late);
    const forward = mergeRecords(
      mergeRecords(emptyDocument(NOW), [neighbour, original], NOW),
      [reprocess],
      NOW,
    );
    const backward = mergeRecords(
      mergeRecords(emptyDocument(NOW), [neighbour, reprocess], NOW),
      [original],
      NOW,
    );
    expect(forward.products.map((p) => p.id)).toEqual(['n', 'rep']);
    expect(backward).toEqual(forward);
    expect(documentFlashes(forward)).toHaveLength(2);
  });

  it('order a publication tie by id, deterministically', () => {
    const a = record('a', 10, [], late);
    const b = record('b', 10, [], late);
    const ab = mergeRecords(emptyDocument(NOW), [a, b], NOW);
    expect(ab.products.map((p) => p.id)).toEqual(['b']);
    expect(mergeRecords(emptyDocument(NOW), [b, a], NOW)).toEqual(ab);
  });
});

describe('the confidence filter', () => {
  it('drops flashes the product rates likelier false, keeps and counts unrated ones', () => {
    const r = record('p', 10, [
      flash(NOW - 15 * MIN, 42.5, 23.5, 0),
      flash(NOW - 14 * MIN, 42.5, 23.5, 0.5),
      flash(NOW - 13 * MIN, 42.5, 23.5, 0.504),
      flash(NOW - 12 * MIN, 42.5, 23.5, null),
    ]);
    const doc = mergeRecords(emptyDocument(NOW), [r], NOW);
    expect(doc.filter_version).toBe(LIGHTNING_FILTER.version);
    expect(doc.products[0]).toMatchObject({ kept: 3, filtered_out: 1, unrated: 1 });
    expect(documentFlashes(doc)).toHaveLength(3);
  });

  it('makes a document from another filter version unreadable, so it is rebuilt', () => {
    const strict = defineConfig('lightning_filter', 'lightning_filter_v99', {
      maxFalseLikelihood: 0.1,
      keepUnrated: false,
    });
    const doc = mergeRecords(emptyDocument(NOW, strict), [record('p', 10)], NOW, strict);
    expect(parseLightningDocument(JSON.stringify(doc), strict)).toEqual(doc);
    expect(parseLightningDocument(JSON.stringify(doc))).toBeNull();
  });
});

describe('parseLightningDocument', () => {
  it('round-trips a merged document and refuses anything else', () => {
    const merged = mergeRecords(emptyDocument(NOW), [record('a', 10)], NOW);
    expect(parseLightningDocument(JSON.stringify(merged))).toEqual(merged);
    expect(parseLightningDocument(JSON.stringify({ ...merged, schema_version: 1 }))).toBeNull();
    expect(parseLightningDocument(JSON.stringify({ ...merged, source: 'x' }))).toBeNull();
    expect(
      parseLightningDocument(
        JSON.stringify({
          ...merged,
          products: [{ ...merged.products[0], flashes: [{ t: 'x', lat: 0, lon: 0 }] }],
        }),
      ),
    ).toBeNull();
    expect(parseLightningDocument('nope')).toBeNull();
  });
});

describe('selectLightning', () => {
  const inside = flash(NOW - 30 * MIN, 42.5, 23.5);
  const outside = flash(NOW - 30 * MIN, 50, 10);
  const future = flash(NOW + 2 * MIN, 42.5, 23.5);

  it('serves the flashes inside the box up to now, with coverage and product count', () => {
    const doc = mergeRecords(
      emptyDocument(NOW),
      [record('a', 25, [inside, outside]), record('b', 0, [future])],
      NOW,
    );
    const selected = selectLightning(doc, NOW, BOX);
    expect(selected.ok && selected.body).toMatchObject({
      covered_through: doc.covered_through,
      products: 2,
      retention_hours: 6,
      flashes: [{ t: new Date(inside.at).toISOString(), lat: 42.5, lon: 23.5 }],
    });
  });

  it('serves an empty sky only while coverage is recent', () => {
    const doc = mergeRecords(emptyDocument(NOW), [record('a', 10, [outside])], NOW);
    const selected = selectLightning(doc, NOW, BOX);
    expect(selected.ok && selected.body.flashes).toEqual([]);
    const stale = selectLightning(doc, NOW + LIGHTNING_MAX_STALENESS_MS, BOX);
    expect(stale).toEqual({ ok: false, reason: 'stale' });
  });

  it('refuses a document with no coverage at all', () => {
    expect(selectLightning(emptyDocument(NOW), NOW, BOX)).toEqual({ ok: false, reason: 'empty' });
  });
});
