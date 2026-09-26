/**
 * The nightly shadow diff (TASKS H8; IP WP6; 06 §5.7; GATES L-1).
 *
 * 06 §5.7: the candidate "runs in parallel on the same detection stream and writes to the
 * shadow tables; it never dispatches", and the nightly report covers "events
 * created/merged/split, alerts that *would* have fired, per-zone deltas, projected
 * PCR/CER/DAR movement". L-1 promotes on "every diff explained". This function is that
 * report as a pure value: given what live and the candidate each concluded over one
 * window, and the reviewer's explanations so far, it returns every difference, classified,
 * each either explained or listed as unexplained.
 *
 * ## Determinism
 *
 * The report is an artifact a reviewer signs, so re-running it must produce the same bytes
 * — the same property CI-2 asks of a replay. Nothing here reads a clock, iterates a `Map`
 * into the output unsorted, or orders by float: every list is sorted by a string key in
 * code-unit order, event pairing is exact rational arithmetic (`event-matching.ts`), and
 * the report carries no "generated at" (the CLI logs that on its own line). The input
 * order of every array is irrelevant, which the tests assert by shuffling it.
 *
 * ## Classification
 *
 * Events are paired by detection-set Jaccard (ADR-002 D7 step 5). Merge tombstones — an
 * event with `mergedInto` set — are not paired: a tombstone is the *trace* of a merge,
 * and the merge itself shows up as the survivor's overlap. What is left classifies as:
 *
 *   | kind                          | meaning                                                   |
 *   |-------------------------------|-----------------------------------------------------------|
 *   | `event_created`               | shadow event overlapping no live event — a new fire       |
 *   | `event_dropped`               | live event overlapping no shadow event — a lost fire      |
 *   | `event_split`                 | unpaired shadow event overlapping live ones — candidate split |
 *   | `event_merged`                | unpaired live event overlapping shadow ones — candidate merged |
 *   | `event_status_differs`        | paired, different lifecycle state                         |
 *   | `event_score_bucket_differs`  | paired, different public bucket (a raw score wobble is not news; a bucket is what a user sees) |
 *   | `event_detections_differ`     | paired, but not the same detection set                    |
 *   | `event_invalidated_differs`   | paired, one side's hard override fired                    |
 *
 * Alerts are keyed by A1.11's idempotency key `(zone, event, type, subkey)` with the
 * shadow event translated to its paired live public id — so the same alert on a renumbered
 * event is the same key, which is the whole reason D7's matching exists. A shadow alert on
 * an unpaired event keeps `shadow:<key>` as its event and can only ever be shadow-only.
 *
 *   | kind                        | meaning                                                    |
 *   |-----------------------------|------------------------------------------------------------|
 *   | `alert_only_shadow`         | the candidate would have sent it; live did not — "would have fired" |
 *   | `alert_only_live`           | live decided it; the candidate would not have              |
 *   | `alert_template_differs`    | same key, different reviewed template                      |
 *   | `alert_decided_at_differs`  | same key, decided at a different instant (see `shadow_diff_v1`) |
 *
 * Live `manual` rows are the reader's to exclude: a human-initiated alert is not a rule
 * outcome and no candidate rule set could reproduce it.
 *
 * ## What the report does not project
 *
 * 06 §5.7 also asks for projected PCR and CER movement. Both need EFFIS perimeters and
 * the synthetic-zone decision harness (`core/qa/shadow-pcr.ts`), which are the weekly D8
 * job's inputs, not a nightly window's; the report projects DAR only — `core/qa/dar.ts`
 * run on each side's decisions, with `decided_at` standing in for a dispatch time nothing
 * in a shadow ever has.
 */

import { isLifecycleState, scoreBucket, type LifecycleState } from '@fire-watch/contracts';

import { ALERT_TYPES, type AlertType } from '../config/alert-gating.js';
import { canonicalJson } from '../determinism/canonical-json.js';
import { isoFromEpochMs, type EpochMs } from '../ports/clock.js';
import { dar, type DarReport, type DispatchedAlert } from '../qa/dar.js';
import { compareIds, matchEvents } from './event-matching.js';
import type { DiffDisposition, DiffExplanation } from './explanations.js';
import { SHADOW_DIFF, type ShadowDiffParams } from './shadow-diff-params.js';

/** One event as either side concluded it. Live `key` is the public id; shadow's is the candidate's own. */
export interface ShadowSideEvent {
  readonly key: string;
  readonly status: LifecycleState;
  readonly score: number;
  readonly startedAtMs: EpochMs;
  readonly lastDetectionAtMs: EpochMs;
  readonly invalidated: boolean;
  /** The survivor's key when this event is a merge tombstone, else `null`. */
  readonly mergedInto: string | null;
  readonly detectionUids: readonly string[];
}

/** One alert decision — a would-be outbox row — as either side concluded it. */
export interface ShadowSideAlert {
  readonly zoneId: string;
  /** The side's own event key, as in {@link ShadowSideEvent.key}. */
  readonly eventKey: string;
  readonly alertType: AlertType;
  /** `once`, `step-N`, or a digest window start (A1.11). */
  readonly alertSubkey: string;
  readonly templateId: string;
  readonly decidedAtMs: EpochMs;
}

export interface ShadowSide {
  readonly events: readonly ShadowSideEvent[];
  readonly alerts: readonly ShadowSideAlert[];
}

/** `[fromMs, toMs)` — half-open, so consecutive nightly windows neither overlap nor gap. */
export interface ShadowWindow {
  readonly fromMs: EpochMs;
  readonly toMs: EpochMs;
}

export interface ShadowDiffInput {
  /** The candidate's `config_version`, as it stamps `events_shadow`/`alerts_shadow`. */
  readonly candidateVersion: string;
  readonly window: ShadowWindow;
  readonly live: ShadowSide;
  readonly shadow: ShadowSide;
  readonly explanations: readonly DiffExplanation[];
}

export const SHADOW_DIFF_KINDS = [
  'event_created',
  'event_dropped',
  'event_split',
  'event_merged',
  'event_status_differs',
  'event_score_bucket_differs',
  'event_detections_differ',
  'event_invalidated_differs',
  'alert_only_shadow',
  'alert_only_live',
  'alert_template_differs',
  'alert_decided_at_differs',
] as const;
export type ShadowDiffKind = (typeof SHADOW_DIFF_KINDS)[number];

export type DiffDetailValue = string | number | boolean | null | readonly string[];

export interface ShadowDiffLine {
  /** Stable across re-runs; what an explanation names. See {@link diffKey}. */
  readonly key: string;
  readonly kind: ShadowDiffKind;
  readonly liveEventKey: string | null;
  readonly shadowEventKey: string | null;
  /** Set on alert lines only. */
  readonly zoneId: string | null;
  readonly detail: Readonly<Record<string, DiffDetailValue>>;
  readonly explanation: {
    readonly disposition: DiffDisposition;
    readonly fixtureId: string | null;
    readonly reason: string;
  } | null;
}

export interface ZoneDelta {
  readonly zoneId: string;
  readonly liveAlerts: number;
  readonly shadowAlerts: number;
  readonly onlyLive: number;
  readonly onlyShadow: number;
  /** Present on both sides with a template or timing diff. */
  readonly differing: number;
}

export const SHADOW_DIFF_VERDICTS = ['all_explained', 'unexplained_diffs'] as const;
export type ShadowDiffVerdict = (typeof SHADOW_DIFF_VERDICTS)[number];

export interface ShadowDiffReport {
  readonly configVersion: string;
  readonly configDigest: string;
  readonly candidateVersion: string;
  readonly window: { readonly from: string; readonly to: string };
  readonly events: {
    /** Standing events — tombstones excluded — on each side. */
    readonly live: number;
    readonly shadow: number;
    readonly liveTombstones: number;
    readonly shadowTombstones: number;
    readonly paired: number;
  };
  readonly alerts: {
    readonly live: number;
    readonly shadow: number;
    readonly common: number;
    readonly onlyLive: number;
    readonly onlyShadow: number;
  };
  readonly countsByKind: Readonly<Record<ShadowDiffKind, number>>;
  readonly zones: readonly ZoneDelta[];
  readonly projectedDar: { readonly live: DarReport; readonly shadow: DarReport };
  readonly diffs: readonly ShadowDiffLine[];
  /** Keys of the diffs with no explanation. Empty is what L-1 promotes on. */
  readonly unexplained: readonly string[];
  /** Explanations naming no diff in this report — the diff went away, or the key is misspelt. */
  readonly staleExplanations: readonly string[];
  readonly verdict: ShadowDiffVerdict;
}

type DraftLine = Omit<ShadowDiffLine, 'explanation'>;

export function shadowDiff(
  input: ShadowDiffInput,
  params: ShadowDiffParams = SHADOW_DIFF.values,
): ShadowDiffReport {
  const { window } = input;
  if (!Number.isFinite(window.fromMs) || !Number.isFinite(window.toMs)) {
    throw new RangeError('shadow window bounds must be finite');
  }
  if (window.fromMs >= window.toMs) {
    throw new RangeError('shadow window must end after it starts');
  }
  const tolerance = params.alerts.decidedAtToleranceMs;
  if (tolerance !== null && (!Number.isFinite(tolerance) || tolerance < 0)) {
    throw new RangeError(`decidedAtToleranceMs must be null or >= 0, got ${String(tolerance)}`);
  }
  input.live.events.forEach(assertEvent);
  input.shadow.events.forEach(assertEvent);
  input.live.alerts.forEach(assertAlert);
  input.shadow.alerts.forEach(assertAlert);

  const liveStanding = input.live.events.filter((event) => event.mergedInto === null);
  const shadowStanding = input.shadow.events.filter((event) => event.mergedInto === null);
  const matching = matchEvents(liveStanding, shadowStanding, params.matching.minJaccard);

  const lines: DraftLine[] = [];
  lines.push(...eventLines(liveStanding, shadowStanding, matching));

  const liveKeyForShadow = new Map(matching.matches.map((m) => [m.shadowKey, m.liveKey]));
  const alertOutcome = alertLines(
    input.live.alerts,
    input.shadow.alerts,
    liveKeyForShadow,
    tolerance,
  );
  lines.push(...alertOutcome.lines);

  const explanationByKey = new Map(input.explanations.map((e) => [e.key, e]));
  if (explanationByKey.size !== input.explanations.length) {
    throw new RangeError('two explanations name the same diff');
  }

  lines.sort((a, b) => compareIds(a.key, b.key));
  const seenKeys = new Set<string>();
  const diffs = lines.map((line): ShadowDiffLine => {
    if (seenKeys.has(line.key)) {
      // Unreachable while every kind keys on a distinct identity; a guard, because two
      // lines sharing a key would share an explanation and one of them would be hidden.
      throw new Error(`two diff lines share the key ${line.key}`);
    }
    seenKeys.add(line.key);
    const found = explanationByKey.get(line.key);
    return Object.freeze({
      ...line,
      explanation:
        found === undefined
          ? null
          : Object.freeze({
              disposition: found.disposition,
              fixtureId: found.fixtureId,
              reason: found.reason,
            }),
    });
  });

  const unexplained = diffs.filter((d) => d.explanation === null).map((d) => d.key);
  const staleExplanations = input.explanations
    .map((e) => e.key)
    .filter((key) => !seenKeys.has(key))
    .sort(compareIds);

  const countsByKind = Object.fromEntries(SHADOW_DIFF_KINDS.map((kind) => [kind, 0])) as Record<
    ShadowDiffKind,
    number
  >;
  for (const d of diffs) countsByKind[d.kind] += 1;

  return Object.freeze({
    configVersion: SHADOW_DIFF.version,
    configDigest: SHADOW_DIFF.digest,
    candidateVersion: input.candidateVersion,
    window: Object.freeze({ from: isoFromEpochMs(window.fromMs), to: isoFromEpochMs(window.toMs) }),
    events: Object.freeze({
      live: liveStanding.length,
      shadow: shadowStanding.length,
      liveTombstones: input.live.events.length - liveStanding.length,
      shadowTombstones: input.shadow.events.length - shadowStanding.length,
      paired: matching.matches.length,
    }),
    alerts: alertOutcome.totals,
    countsByKind: Object.freeze(countsByKind),
    zones: alertOutcome.zones,
    projectedDar: Object.freeze({
      live: dar({ alerts: dispatchedFrom(input.live) }),
      shadow: dar({ alerts: dispatchedFrom(input.shadow) }),
    }),
    diffs: Object.freeze(diffs),
    unexplained: Object.freeze(unexplained),
    staleExplanations: Object.freeze(staleExplanations),
    verdict: unexplained.length === 0 ? 'all_explained' : 'unexplained_diffs',
  });
}

/** The report as the bytes a reviewer signs and a double run compares. */
export function renderShadowDiffReport(report: ShadowDiffReport): string {
  return canonicalJson(report);
}

/**
 * `<kind>:<JSON array of identity parts>`. JSON rather than a separator, because a digest
 * subkey is an ISO instant full of colons and a candidate's event key is free text: an
 * encoding that cannot collide is cheaper than proving a separator never appears.
 */
export function diffKey(kind: ShadowDiffKind, parts: readonly string[]): string {
  return `${kind}:${JSON.stringify(parts)}`;
}

function eventLines(
  live: readonly ShadowSideEvent[],
  shadow: readonly ShadowSideEvent[],
  matching: ReturnType<typeof matchEvents>,
): DraftLine[] {
  const liveByKey = new Map(live.map((e) => [e.key, e]));
  const shadowByKey = new Map(shadow.map((e) => [e.key, e]));
  const lines: DraftLine[] = [];

  for (const match of matching.matches) {
    const l = mustGet(liveByKey, match.liveKey);
    const s = mustGet(shadowByKey, match.shadowKey);
    const pair = { liveEventKey: l.key, shadowEventKey: s.key, zoneId: null };
    if (l.status !== s.status) {
      lines.push({
        key: diffKey('event_status_differs', [l.key]),
        kind: 'event_status_differs',
        ...pair,
        detail: { live: l.status, shadow: s.status },
      });
    }
    const liveBucket = scoreBucket(l.score);
    const shadowBucket = scoreBucket(s.score);
    if (liveBucket !== shadowBucket) {
      lines.push({
        key: diffKey('event_score_bucket_differs', [l.key]),
        kind: 'event_score_bucket_differs',
        ...pair,
        detail: {
          live: liveBucket,
          shadow: shadowBucket,
          liveScore: l.score,
          shadowScore: s.score,
        },
      });
    }
    if (match.intersection !== match.union) {
      lines.push({
        key: diffKey('event_detections_differ', [l.key]),
        kind: 'event_detections_differ',
        ...pair,
        detail: {
          common: match.intersection,
          onlyLive: l.detectionUids.length - match.intersection,
          onlyShadow: s.detectionUids.length - match.intersection,
        },
      });
    }
    if (l.invalidated !== s.invalidated) {
      lines.push({
        key: diffKey('event_invalidated_differs', [l.key]),
        kind: 'event_invalidated_differs',
        ...pair,
        detail: { live: l.invalidated, shadow: s.invalidated },
      });
    }
  }

  const liveHolders = holdersByUid(live);
  const shadowHolders = holdersByUid(shadow);

  for (const key of matching.unmatchedShadow) {
    const s = mustGet(shadowByKey, key);
    const overlaps = overlapping(s, liveHolders);
    lines.push(
      overlaps.length === 0
        ? {
            key: diffKey('event_created', [key]),
            kind: 'event_created',
            liveEventKey: null,
            shadowEventKey: key,
            zoneId: null,
            detail: { detections: s.detectionUids.length, status: s.status },
          }
        : {
            key: diffKey('event_split', [key]),
            kind: 'event_split',
            liveEventKey: null,
            shadowEventKey: key,
            zoneId: null,
            detail: { detections: s.detectionUids.length, overlapsLive: overlaps },
          },
    );
  }

  for (const key of matching.unmatchedLive) {
    const l = mustGet(liveByKey, key);
    const overlaps = overlapping(l, shadowHolders);
    lines.push(
      overlaps.length === 0
        ? {
            key: diffKey('event_dropped', [key]),
            kind: 'event_dropped',
            liveEventKey: key,
            shadowEventKey: null,
            zoneId: null,
            detail: { detections: l.detectionUids.length, status: l.status },
          }
        : {
            key: diffKey('event_merged', [key]),
            kind: 'event_merged',
            liveEventKey: key,
            shadowEventKey: null,
            zoneId: null,
            detail: { detections: l.detectionUids.length, overlapsShadow: overlaps },
          },
    );
  }

  return lines;
}

interface KeyedAlert {
  readonly parts: readonly string[];
  readonly alert: ShadowSideAlert;
  readonly eventRef: string;
}

function alertLines(
  live: readonly ShadowSideAlert[],
  shadow: readonly ShadowSideAlert[],
  liveKeyForShadow: ReadonlyMap<string, string>,
  toleranceMs: number | null,
): {
  lines: DraftLine[];
  totals: ShadowDiffReport['alerts'];
  zones: readonly ZoneDelta[];
} {
  const liveKeyed = keyAlerts(live, (eventKey) => eventKey, 'live');
  const shadowKeyed = keyAlerts(
    shadow,
    (eventKey) => liveKeyForShadow.get(eventKey) ?? `shadow:${eventKey}`,
    'shadow',
  );

  const zones = new Map<
    string,
    { live: number; shadow: number; onlyLive: number; onlyShadow: number; differing: number }
  >();
  const zone = (zoneId: string) => {
    let entry = zones.get(zoneId);
    if (entry === undefined) {
      entry = { live: 0, shadow: 0, onlyLive: 0, onlyShadow: 0, differing: 0 };
      zones.set(zoneId, entry);
    }
    return entry;
  };

  const lines: DraftLine[] = [];
  let common = 0;
  for (const [identity, l] of liveKeyed) {
    zone(l.alert.zoneId).live += 1;
    const s = shadowKeyed.get(identity);
    if (s === undefined) {
      zone(l.alert.zoneId).onlyLive += 1;
      lines.push({
        key: diffKey('alert_only_live', l.parts),
        kind: 'alert_only_live',
        liveEventKey: l.alert.eventKey,
        shadowEventKey: null,
        zoneId: l.alert.zoneId,
        detail: alertDetail(l.alert),
      });
      continue;
    }
    common += 1;
    let differs = false;
    const shared = {
      liveEventKey: l.alert.eventKey,
      shadowEventKey: s.alert.eventKey,
      zoneId: l.alert.zoneId,
    };
    if (l.alert.templateId !== s.alert.templateId) {
      differs = true;
      lines.push({
        key: diffKey('alert_template_differs', l.parts),
        kind: 'alert_template_differs',
        ...shared,
        detail: { live: l.alert.templateId, shadow: s.alert.templateId },
      });
    }
    const deltaMs = s.alert.decidedAtMs - l.alert.decidedAtMs;
    if (deltaMs !== 0 && (toleranceMs === null || Math.abs(deltaMs) > toleranceMs)) {
      differs = true;
      lines.push({
        key: diffKey('alert_decided_at_differs', l.parts),
        kind: 'alert_decided_at_differs',
        ...shared,
        detail: {
          live: isoFromEpochMs(l.alert.decidedAtMs),
          shadow: isoFromEpochMs(s.alert.decidedAtMs),
          deltaMs,
        },
      });
    }
    if (differs) zone(l.alert.zoneId).differing += 1;
  }

  for (const [identity, s] of shadowKeyed) {
    zone(s.alert.zoneId).shadow += 1;
    if (liveKeyed.has(identity)) continue;
    zone(s.alert.zoneId).onlyShadow += 1;
    lines.push({
      key: diffKey('alert_only_shadow', s.parts),
      kind: 'alert_only_shadow',
      liveEventKey: s.eventRef.startsWith('shadow:') ? null : s.eventRef,
      shadowEventKey: s.alert.eventKey,
      zoneId: s.alert.zoneId,
      detail: alertDetail(s.alert),
    });
  }

  return {
    lines,
    totals: Object.freeze({
      live: liveKeyed.size,
      shadow: shadowKeyed.size,
      common,
      onlyLive: liveKeyed.size - common,
      onlyShadow: shadowKeyed.size - common,
    }),
    zones: Object.freeze(
      [...zones.entries()]
        .sort(([a], [b]) => compareIds(a, b))
        .map(([zoneId, z]) =>
          Object.freeze({
            zoneId,
            liveAlerts: z.live,
            shadowAlerts: z.shadow,
            onlyLive: z.onlyLive,
            onlyShadow: z.onlyShadow,
            differing: z.differing,
          }),
        ),
    ),
  };
}

function keyAlerts(
  alerts: readonly ShadowSideAlert[],
  eventRefOf: (eventKey: string) => string,
  side: string,
): Map<string, KeyedAlert> {
  const keyed = new Map<string, KeyedAlert>();
  for (const alert of alerts) {
    const eventRef = eventRefOf(alert.eventKey);
    const parts = [alert.zoneId, eventRef, alert.alertType, alert.alertSubkey];
    const identity = JSON.stringify(parts);
    if (keyed.has(identity)) {
      // A1.11's key is unique in `alert_outbox` and in `alerts_shadow`; two rows under one
      // key after translation means two shadow events were paired to one live event,
      // which the matching forbids. Either way it is a reader bug, not a diff.
      throw new RangeError(`${side} has two alerts under one idempotency key ${identity}`);
    }
    keyed.set(identity, { parts, alert, eventRef });
  }
  return keyed;
}

function alertDetail(alert: ShadowSideAlert): Record<string, DiffDetailValue> {
  return { decidedAt: isoFromEpochMs(alert.decidedAtMs), templateId: alert.templateId };
}

/**
 * DAR's input from one side. `alertId` is the idempotency key, which is unique per side;
 * `eventKey` follows the side's merge chain to its survivor, because DAR's header makes a
 * merge-resolved key a precondition; `ladderStep` is read back from the `step-N` subkey
 * the decision wrote (`escalationSubkey`), and is 0 for everything that is not an
 * escalation — exactly what `DispatchedAlert` asks for.
 */
function dispatchedFrom(side: ShadowSide): DispatchedAlert[] {
  const mergedInto = new Map(side.events.map((e) => [e.key, e.mergedInto]));
  return side.alerts.map((alert) => ({
    alertId: JSON.stringify([alert.zoneId, alert.eventKey, alert.alertType, alert.alertSubkey]),
    zoneId: alert.zoneId,
    eventKey: survivorOf(alert.eventKey, mergedInto),
    alertType: alert.alertType,
    dispatchedAtMs: alert.decidedAtMs,
    ladderStep: alert.alertType === 'escalation' ? ladderStepOf(alert.alertSubkey) : 0,
  }));
}

function survivorOf(key: string, mergedInto: ReadonlyMap<string, string | null>): string {
  const visited = new Set<string>();
  let current = key;
  for (;;) {
    const next = mergedInto.get(current) ?? null;
    if (next === null || visited.has(next)) return current;
    visited.add(current);
    current = next;
  }
}

function ladderStepOf(subkey: string): number {
  const match = /^step-([1-9]\d*)$/.exec(subkey);
  if (match === null) {
    throw new RangeError(`escalation subkey ${JSON.stringify(subkey)} is not step-N`);
  }
  return Number(match[1]);
}

function holdersByUid(events: readonly ShadowSideEvent[]): Map<string, string[]> {
  const holders = new Map<string, string[]>();
  for (const event of events) {
    for (const uid of event.detectionUids) {
      const list = holders.get(uid);
      if (list === undefined) holders.set(uid, [event.key]);
      else list.push(event.key);
    }
  }
  return holders;
}

function overlapping(
  event: ShadowSideEvent,
  holders: ReadonlyMap<string, readonly string[]>,
): string[] {
  const found = new Set<string>();
  for (const uid of event.detectionUids) {
    for (const key of holders.get(uid) ?? []) found.add(key);
  }
  return [...found].sort(compareIds);
}

function assertEvent(event: ShadowSideEvent): void {
  if (!isLifecycleState(event.status)) {
    throw new RangeError(`event ${JSON.stringify(event.key)} has an unknown status`);
  }
  if (!Number.isFinite(event.startedAtMs) || !Number.isFinite(event.lastDetectionAtMs)) {
    throw new RangeError(`event ${JSON.stringify(event.key)} has a non-finite instant`);
  }
  // Range-checks the score as a side effect; a score outside [0, 1] is not a bucket.
  scoreBucket(event.score);
}

function assertAlert(alert: ShadowSideAlert): void {
  if (!(ALERT_TYPES as readonly string[]).includes(alert.alertType)) {
    throw new RangeError(`alert type ${JSON.stringify(alert.alertType)} is not in the vocabulary`);
  }
  if (!Number.isFinite(alert.decidedAtMs)) {
    throw new RangeError('alert has a non-finite decision instant');
  }
}

function mustGet<V>(map: ReadonlyMap<string, V>, key: string): V {
  const value = map.get(key);
  if (value === undefined) throw new Error(`matching returned an unknown key ${key}`);
  return value;
}
