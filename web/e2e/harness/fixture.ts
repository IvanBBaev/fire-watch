/**
 * The scripted snapshot behind the fake origin: the shipped `public/fixtures/snapshot.json`
 * loaded once, then bent to what a scenario needs.
 *
 * Two things make a fixture written in August usable by a suite that runs whenever:
 *
 *   * **Time shift.** Every ISO-8601 stamp in the document moves by the same delta, so
 *     `generated_at` lands on "now" (or on a deliberately old instant for the stale
 *     scenario) while every observation keeps its distance from it. The app judges
 *     staleness against server time and scopes its list by observation age, so the
 *     *relative* layout of the fixture is what the assertions rest on — and it is why the
 *     expected row count is computed from the shifted document rather than typed in.
 *   * **Mutations.** A polling client proves itself by noticing a change. The three
 *     verbs a real origin performs — a status flip, a new event, a removal — are scripted
 *     here as edits to the base document, each moving the global `max_seq` forward the
 *     way the server's global `seq` mark would (ADR-003: one mark for the whole set).
 *     Removals bump the mark too, so the next full snapshot's `max_seq` exceeds the seq
 *     of the vanished event and the reconciler's set authority applies.
 *
 * The base document stays in *fixture time*; the shift is applied when a request is
 * answered. A feature handed to `add` is therefore also in fixture time — clone one
 * that is already in the document rather than minting stamps from the wall clock.
 */

import { readFile } from 'node:fs/promises';

export interface WireSourceRow {
  readonly source_id: string;
  readonly last_observed_at: string | null;
}

export interface WireFeatureProperties {
  readonly id: string;
  readonly seq: number;
  readonly status: string;
  readonly score_bucket: string;
  readonly merged_into: string | null;
  readonly first_observed_at: string;
  readonly last_observed_at: string;
  readonly detection_count: number;
  readonly place_name_bg: string;
  readonly place_name_en: string;
  readonly area_ha: number | null;
  readonly next_pass_window: { readonly start: string; readonly end: string } | null;
}

export interface WireFeature {
  readonly type: 'Feature';
  readonly id: string;
  readonly geometry: { readonly type: 'Point'; readonly coordinates: readonly [number, number] };
  readonly properties: WireFeatureProperties;
}

/** The wire shape of `/snapshot.json`, as the web client's `parseSnapshot` reads it. */
export interface WireSnapshot {
  readonly type: 'FeatureCollection';
  readonly schema_version: number;
  readonly generated_at: string;
  readonly max_seq: number;
  readonly partial: boolean;
  readonly sources: readonly WireSourceRow[];
  readonly features: readonly WireFeature[];
}

/** The shipped fixture — the same file the dev server and the built app serve. */
const FIXTURE_URL = new URL('../../public/fixtures/snapshot.json', import.meta.url);

export async function loadFixtureSnapshot(): Promise<WireSnapshot> {
  const raw: unknown = JSON.parse(await readFile(FIXTURE_URL, 'utf8'));
  if (!isRecord(raw) || raw['type'] !== 'FeatureCollection' || !Array.isArray(raw['features'])) {
    throw new Error(`${FIXTURE_URL.pathname}: not a FeatureCollection`);
  }
  // The shape is the app's wire contract and the app's guard rejects any defect at boot,
  // so a structural mismatch here surfaces as a failed boot, not as a silent pass.
  return raw as unknown as WireSnapshot;
}

/** ISO-8601 UTC with a `Z` suffix — the only stamp form the snapshot carries. */
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/**
 * Move every stamp in the document by `deltaMs`. Generic over the JSON tree on purpose:
 * a new dated property in the wire format then shifts with the rest instead of being
 * left behind in August.
 */
export function shiftTimestamps<T>(value: T, deltaMs: number): T {
  if (typeof value === 'string') {
    if (!ISO_UTC.test(value)) return value;
    return new Date(Date.parse(value) + deltaMs).toISOString() as T;
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => shiftTimestamps(item, deltaMs)) as T;
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = shiftTimestamps(item, deltaMs);
    return out as T;
  }
  return value;
}

/** The document re-anchored so that `generated_at` is exactly `generatedAtMs`. */
export function anchoredAt(snapshot: WireSnapshot, generatedAtMs: number): WireSnapshot {
  return shiftTimestamps(snapshot, generatedAtMs - Date.parse(snapshot.generated_at));
}

/**
 * Ids of the features observed within `windowMs` before `nowMs` — what the default age
 * window of the home list shows once the map has not narrowed it (and in the harness the
 * basemap is blocked, so it never does).
 */
export function observedWithin(snapshot: WireSnapshot, nowMs: number, windowMs: number): string[] {
  const cutoff = nowMs - windowMs;
  return snapshot.features
    .filter((feature) => Date.parse(feature.properties.last_observed_at) >= cutoff)
    .map((feature) => feature.id);
}

export interface ScriptedSnapshot {
  /** The current base document, in fixture time. */
  current(): WireSnapshot;
  /** Only the features changed after `afterSeq`, flagged `partial` — a cursor answer. */
  changesAfter(afterSeq: number): WireSnapshot;
  /** Flip a feature's status; the feature takes the next global seq. */
  bump(id: string, patch: { readonly status: string }): number;
  /** Add a feature (in fixture time); its seq is overwritten with the next global seq. */
  add(feature: WireFeature): number;
  /** Drop a feature and move the mark past it, so a full answer proves its absence. */
  remove(id: string): number;
}

export function scriptSnapshot(base: WireSnapshot): ScriptedSnapshot {
  let doc: WireSnapshot = base;

  const nextSeq = (): number => doc.max_seq + 1;

  const replaceFeature = (
    id: string,
    make: (feature: WireFeature, seq: number) => WireFeature,
  ): number => {
    if (!doc.features.some((feature) => feature.id === id)) {
      throw new Error(`fixture: no feature ${id}`);
    }
    const seq = nextSeq();
    const features = doc.features.map((feature) =>
      feature.id === id ? make(feature, seq) : feature,
    );
    doc = { ...doc, max_seq: seq, features };
    return seq;
  };

  return {
    current: () => doc,
    changesAfter: (afterSeq) => ({
      ...doc,
      partial: true,
      features: doc.features.filter((feature) => feature.properties.seq > afterSeq),
    }),
    bump: (id, patch) =>
      replaceFeature(id, (feature, seq) => ({
        ...feature,
        properties: { ...feature.properties, status: patch.status, seq },
      })),
    add: (feature) => {
      if (doc.features.some((existing) => existing.id === feature.id)) {
        throw new Error(`fixture: feature ${feature.id} already present`);
      }
      const seq = nextSeq();
      const added: WireFeature = { ...feature, properties: { ...feature.properties, seq } };
      doc = { ...doc, max_seq: seq, features: [...doc.features, added] };
      return seq;
    },
    remove: (id) => {
      if (!doc.features.some((feature) => feature.id === id)) {
        throw new Error(`fixture: no feature ${id}`);
      }
      const seq = nextSeq();
      doc = { ...doc, max_seq: seq, features: doc.features.filter((feature) => feature.id !== id) };
      return seq;
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
