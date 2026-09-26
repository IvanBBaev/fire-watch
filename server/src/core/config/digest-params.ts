/**
 * `digest_params_v1` — when the daily digest window opens (ADR-004 D3/D4 as amended by
 * A1.7, A1.8 and A1.11; ADR-002 D5 config-as-data).
 *
 * This is a small config, and deliberately a separate one rather than two more fields on
 * `alert_gating`. Two reasons, both structural:
 *
 *   - The gating config's version is stamped on every `alert_outbox` row as `rule_version`
 *     and pinned by every alert fixture's manifest. Moving the digest hour would then bump
 *     a version that says "the thresholds changed" about a change that touched no
 *     threshold, and every archived decision would have to be re-read under a version it
 *     was not decided under.
 *   - The repo already answers this question the same way everywhere else — one small
 *     versioned set per decision (`clustering_params`, `lifecycle_params`, `pass_table`,
 *     `polling_bbox`, `weather_context`, `effis_layers`, `ingest_anomaly`,
 *     `freshness_budgets`, `sp_swap_sanity`, `qa_metrics`, `score_params`).
 *
 * Why a version at all, for what is one hour: a replay of last September must produce last
 * September's digests. The window start is the digest's idempotency subkey (A1.11), so an
 * hour edited in place would silently re-key every digest ever sent — the same fire could
 * be summarised twice under two different windows, which is the one failure a digest
 * exists to prevent.
 */

import { defineConfig, type VersionedConfig } from './versioned-config.js';

export interface DigestParams {
  /**
   * Local hour the daily digest window opens (D4: "the 09:00 daily summary"). Local, not
   * UTC, and resolved through the tz database per account — a digest that arrived at
   * 09:00 UTC would land at 11:00 or 12:00 in Sofia depending on the season, which is
   * exactly the class of bug fixture S14 exists to catch.
   *
   * The value is also load-bearing in a way an hour usually is not: A1.7's quiet hours
   * (22:00–07:00 by default) do not cover it, so the digest sits outside the quiet window
   * *by construction* rather than by an exception. An hour inside a user's quiet hours is
   * expressible — accounts own their window — and the producer holds the digest rather
   * than piercing them, because a digest is the lowest-urgency thing the product sends
   * and it never overrides anything (07 §5.5.3).
   */
  readonly windowHour: number;
  readonly windowMinute: number;
}

export const DIGEST_PARAMS: VersionedConfig<DigestParams> = defineConfig(
  'digest_params',
  'digest_params_v1',
  {
    windowHour: 9,
    windowMinute: 0,
  },
);
