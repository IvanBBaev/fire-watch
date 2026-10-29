/**
 * Live-constellation definitions for the constellation replay (GATES §3 L-14).
 *
 * L-14 re-runs the fit and the acceptance check on a detection stream restricted to the
 * satellites that will actually be flying in a given season. The 2027 constellation is
 * NOAA-20/21 VIIRS + Sentinel-3 SLSTR as the polar sources that create and grow events,
 * with MODIS (Terra/Aqua — Aqua shut down ~Aug 2026, Terra science ends ~Feb 2027,
 * DATA-SOURCES A2) and S-NPP (anticipated EOL late 2026, DATA-SOURCES A1) dropped, and the
 * GEO attach-only sources unchanged.
 *
 * Config-as-data (ADR-002 D5): a constellation is a versioned value whose digest the
 * replay report cites, and "after any constellation change" (L-14's second trigger) means
 * a new version here. Every live source id is classified exactly once: `membership` is
 * typed as a total record over {@link LiveSourceId}, so a source going live does not
 * compile until somebody decides which side of the constellation it is on. A reserved id
 * (V3-P4) has never produced a row and is in no constellation.
 */

import {
  LIVE_SOURCE_IDS,
  requireLiveSourceId,
  SOURCE_REGISTRY,
  type LiveSourceId,
  type SourceId,
} from '@fire-watch/contracts';

import { defineConfig, type VersionedConfig } from '../config/versioned-config.js';
import type { FitDetection } from './label-join.js';

/**
 * - `live`: a polar source in the constellation; its rows are kept and it must be
 *   measured (per-source metrics reported) for the replay to count as a full pass.
 * - `attach_only`: a GEO source, kept unchanged; it never creates or merges events.
 * - `dropped`: not flying in that season; its rows are removed from the stream.
 */
export type ConstellationRole = 'live' | 'attach_only' | 'dropped';

export interface Constellation {
  /** The season the constellation describes (UTC calendar year). */
  readonly season: number;
  readonly membership: Readonly<Record<LiveSourceId, ConstellationRole>>;
  /** Why each dropped source is dropped, quoted into the report. */
  readonly droppedBecause: Readonly<Partial<Record<SourceId, string>>>;
}

export const CONSTELLATION_2027: VersionedConfig<Constellation> = defineConfig(
  'live_constellation',
  'constellation_2027_v1',
  {
    season: 2027,
    membership: {
      'firms:viirs:snpp': 'dropped',
      'firms:viirs:noaa20': 'live',
      'firms:viirs:noaa21': 'live',
      'firms:modis': 'dropped',
      'eumetsat:slstr:frp': 'live',
      'lsasaf:seviri:frp-pixel': 'attach_only',
      'lsasaf:fci:frp-pixel': 'attach_only',
    },
    droppedBecause: {
      'firms:viirs:snpp': 'S-NPP anticipated end of life late 2026 (DATA-SOURCES A1)',
      'firms:modis':
        'Aqua shut down ~Aug 2026, Terra science ends ~Feb 2027; retired in the registry (DATA-SOURCES A2)',
    },
  } as const,
);

/** Every constellation the replay CLI can be asked for, by version. */
export const CONSTELLATIONS: readonly VersionedConfig<Constellation>[] = [CONSTELLATION_2027];

export function constellationByVersion(version: string): VersionedConfig<Constellation> | null {
  return CONSTELLATIONS.find((c) => c.version === version) ?? null;
}

/**
 * Structural problems with a constellation against the source registry. Empty means the
 * constellation is usable. Checked by the replay before any clustering and pinned by a
 * unit test for every shipped constellation.
 */
export function constellationProblems(constellation: Constellation): string[] {
  const problems: string[] = [];
  for (const id of LIVE_SOURCE_IDS) {
    const role = constellation.membership[id];
    const entry = SOURCE_REGISTRY[id];
    if (entry.attachOnly !== (role === 'attach_only')) {
      problems.push(
        `${id}: role ${role} disagrees with the registry (attachOnly ${String(entry.attachOnly)})`,
      );
    }
    if (entry.status === 'retired' && role !== 'dropped') {
      problems.push(`${id}: retired in the registry but ${role} in the constellation`);
    }
    if (role === 'dropped' && constellation.droppedBecause[id] === undefined) {
      problems.push(`${id}: dropped without a reason`);
    }
    if (role !== 'dropped' && constellation.droppedBecause[id] !== undefined) {
      problems.push(`${id}: has a drop reason but is ${role}`);
    }
  }
  if (!LIVE_SOURCE_IDS.some((id) => constellation.membership[id] === 'live')) {
    problems.push('no live source: the stream could never create an event');
  }
  return problems;
}

export function sourcesWithRole(
  constellation: Constellation,
  role: ConstellationRole,
): readonly LiveSourceId[] {
  return LIVE_SOURCE_IDS.filter((id) => constellation.membership[id] === role);
}

export interface Restriction {
  readonly kept: readonly FitDetection[];
  /** Rows removed, per dropped source (only sources that had rows). */
  readonly droppedRows: Readonly<Partial<Record<SourceId, number>>>;
}

/**
 * The detection stream as the constellation would have seen it: rows from dropped
 * sources removed, everything else untouched and in its original order.
 */
export function restrictToConstellation(
  rows: readonly FitDetection[],
  constellation: Constellation,
): Restriction {
  const kept: FitDetection[] = [];
  const droppedRows: Partial<Record<SourceId, number>> = {};
  for (const row of rows) {
    if (constellation.membership[requireLiveSourceId(row.source)] === 'dropped') {
      droppedRows[row.source] = (droppedRows[row.source] ?? 0) + 1;
    } else {
      kept.push(row);
    }
  }
  return { kept, droppedRows };
}
