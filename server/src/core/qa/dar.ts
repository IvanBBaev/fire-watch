/**
 * DAR — Duplicate Alert Rate (GLOSSARY §8; 06 §5.1.2; ADR-004 D9).
 *
 * "alerts repeating the same `(zone, event, alert_type)` semantic content within the
 * suppression window ÷ total alerts dispatched. Merge/split re-notifications count as
 * duplicates **unless** they carry an escalation." Targets: ≤ 5 % shadow → ≤ 1 % steady.
 *
 * Three things the formula's words decide, spelled out because each is a place an
 * implementation could quietly make the number look better:
 *
 *   - **The window is `alert_gating_v1`'s.** The suppression window is not a QA parameter;
 *     it is the rule the dispatcher actually applied. Reading it from the gating config
 *     means a config change moves both the behaviour and the metric that judges it, and a
 *     copy here could silently start grading last year's rule.
 *   - **`event` means the merge-resolved key, not the row id.** A1.6 folds alert state
 *     across the parent chain, so a merge mints a new event id for a fire the zone has
 *     been following. Keying on the raw id would make every merge re-notification a
 *     *different* pair and hide exactly the duplicates the formula names. `eventKey` is
 *     therefore an input the caller must resolve, and its meaning is a precondition of
 *     this function, not an implementation detail.
 *   - **"unless they carry an escalation" means a strictly higher rung.** A repeat at the
 *     same ladder step is a repeat, whatever else changed about the event. A step above the
 *     previous notification's is news, which is what the ladder is for (A1.11).
 */

import { ALERT_GATING, type AlertGatingParams, type AlertType } from '../config/alert-gating.js';
import type { EpochMs } from '../ports/clock.js';
import { QA_METRICS, type QaMetricsParams } from './qa-metrics-params.js';
import { meetsAtMost, rateOf, type Rate } from './rate.js';

export interface DispatchedAlert {
  readonly alertId: string;
  readonly zoneId: string;
  /**
   * The **merge/alias-resolved** event key — the identity a reader would recognise as
   * "the same fire", not the `fire_events` row id. See the header.
   */
  readonly eventKey: string;
  readonly alertType: AlertType;
  readonly dispatchedAtMs: EpochMs;
  /**
   * The escalation rung this alert announced; `0` when it announced none (`new_fire`,
   * `digest`). Taken from the decision's `ladderStep`.
   */
  readonly ladderStep: number;
}

export interface DarInput {
  /** Every alert actually dispatched in the reporting window — DAR's denominator. */
  readonly alerts: readonly DispatchedAlert[];
}

export interface DuplicateAlert {
  readonly alertId: string;
  /** The earlier alert it repeats. */
  readonly repeatsAlertId: string;
  readonly gapMs: number;
}

export interface DarReport {
  readonly configVersion: string;
  readonly configDigest: string;
  /** The gating config whose suppression window this rate was measured against. */
  readonly alertGatingVersion: string;
  readonly suppressionWindowMs: number;
  readonly rate: Rate;
  readonly shadowMaxRate: number;
  readonly steadyMaxRate: number;
  readonly meetsShadowTarget: boolean | null;
  readonly meetsSteadyTarget: boolean | null;
  readonly duplicates: readonly DuplicateAlert[];
}

export function dar(
  input: DarInput,
  params: QaMetricsParams = QA_METRICS.values,
  gating: AlertGatingParams = ALERT_GATING.values,
): DarReport {
  const seen = new Set<string>();
  for (const alert of input.alerts) {
    if (seen.has(alert.alertId)) {
      throw new RangeError(`duplicate alert id ${JSON.stringify(alert.alertId)}`);
    }
    seen.add(alert.alertId);
    if (!Number.isFinite(alert.dispatchedAtMs)) {
      throw new RangeError(`alert ${JSON.stringify(alert.alertId)} has a non-finite dispatch time`);
    }
    if (!Number.isInteger(alert.ladderStep) || alert.ladderStep < 0) {
      throw new RangeError(
        `alert ${JSON.stringify(alert.alertId)} has ladder step ${String(alert.ladderStep)}; ` +
          'a rung is a non-negative integer, 0 meaning "not an escalation"',
      );
    }
  }

  // Chronological, with the id as the tie-break so two alerts dispatched in the same
  // millisecond are ordered the same way on every machine and in every replay.
  const ordered = input.alerts
    .slice()
    .sort((a, b) => a.dispatchedAtMs - b.dispatchedAtMs || compareIds(a.alertId, b.alertId));

  const lastByKey = new Map<string, DispatchedAlert>();
  const duplicates: DuplicateAlert[] = [];

  for (const alert of ordered) {
    const key = semanticKey(alert);
    const previous = lastByKey.get(key);
    if (previous !== undefined) {
      const gapMs = alert.dispatchedAtMs - previous.dispatchedAtMs;
      if (gapMs <= gating.suppressionWindowMs && alert.ladderStep <= previous.ladderStep) {
        duplicates.push(
          Object.freeze({ alertId: alert.alertId, repeatsAlertId: previous.alertId, gapMs }),
        );
      }
    }
    lastByKey.set(key, alert);
  }

  const rate = rateOf(duplicates.length, ordered.length);
  return Object.freeze({
    configVersion: QA_METRICS.version,
    configDigest: QA_METRICS.digest,
    alertGatingVersion: ALERT_GATING.version,
    suppressionWindowMs: gating.suppressionWindowMs,
    rate,
    shadowMaxRate: params.dar.shadowMaxRate,
    steadyMaxRate: params.dar.steadyMaxRate,
    meetsShadowTarget: meetsAtMost(rate, params.dar.shadowMaxRate, params),
    meetsSteadyTarget: meetsAtMost(rate, params.dar.steadyMaxRate, params),
    duplicates: Object.freeze(duplicates),
  });
}

/**
 * `(zone, event, alert_type)`, joined by a separator no id may contain. The parts are
 * length-prefixed rather than trusted, so `("a-b", "c")` and `("a", "b-c")` cannot collide
 * into one key and cancel a duplicate.
 */
function semanticKey(alert: DispatchedAlert): string {
  return [alert.zoneId, alert.eventKey, alert.alertType]
    .map((part) => `${String(part.length)}:${part}`)
    .join('|');
}

/** UTF-16 code-unit order. Never `localeCompare`: CI-2 runs under `LC_ALL=tr_TR.UTF-8`. */
function compareIds(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
