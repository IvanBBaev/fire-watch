/**
 * The meta-alert pager over healthchecks.io (TASKS J1; OPERATIONS §3 leg 2).
 *
 * One check, slug {@link META_ALERT_CHECK_SLUG}, under the same ping key as the job
 * heartbeats. Every successful monitor cycle pings it:
 *
 *   * nothing paging → `POST <base>/meta-alerts`       (check up)
 *   * something paging → `POST <base>/meta-alerts/fail` (check down now, operator paged)
 *
 * so the check pages on an explicit failure *and* on silence — a monitor loop that died
 * stops pinging, and the check's grace period turns that into the same page. The slug is
 * deliberately not a `HeartbeatJobId`: the monitor is not a budgeted job, and adding it to
 * that contract would change the freshness registry for a check the public page never
 * shows.
 *
 * The body names the paging monitor keys and nothing else. They are fixed identifiers
 * from `meta-alert-params.ts` — no counts, no zone or event ids — so an operator sees
 * *which* leg paged in the healthchecks.io UI without our data accumulating on a third
 * party's servers.
 *
 * Same discipline as the heartbeat adapter: the URL is a secret, redacted from every
 * error, and nothing here throws or retries.
 */

import type { MetaAlertKey } from '../../core/monitoring/meta-alert-params.js';
import type { MetaAlertPager } from '../../core/ports/meta-alert-pager.js';
import { assertPingBaseUrl, HEARTBEAT_TIMEOUT_MS } from './healthchecks-heartbeat.js';

/** The healthchecks.io check an operator must create before this pager is enabled. */
export const META_ALERT_CHECK_SLUG = 'meta-alerts';

export interface HealthchecksMetaPagerOptions {
  /** `https://hc-ping.com/<ping-key>` — the same secret the heartbeats use. */
  readonly pingBaseUrl: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
  /** Told about a ping that did not land, with the URL already redacted. */
  readonly onError?: (reason: string) => void;
}

export function createHealthchecksMetaPager(options: HealthchecksMetaPagerOptions): MetaAlertPager {
  const baseUrl = assertPingBaseUrl(options.pingBaseUrl);
  const timeoutMs = options.timeoutMs ?? HEARTBEAT_TIMEOUT_MS;
  const doFetch = options.fetch ?? globalThis.fetch;
  const redact = (text: string): string => text.split(baseUrl).join('<HEARTBEAT_URL>');

  return {
    async report(paging: readonly MetaAlertKey[]): Promise<void> {
      const suffix = paging.length === 0 ? '' : '/fail';
      try {
        const response = await doFetch(`${baseUrl}/${META_ALERT_CHECK_SLUG}${suffix}`, {
          method: 'POST',
          signal: AbortSignal.timeout(timeoutMs),
          body: paging.join(','),
        });
        await response.body?.cancel().catch(() => undefined);
        if (!response.ok) {
          options.onError?.(`meta-alert ping rejected with HTTP ${String(response.status)}`);
        }
      } catch (error: unknown) {
        const reason =
          error instanceof Error
            ? error.name === 'TimeoutError'
              ? 'meta-alert ping timed out'
              : error.message
            : String(error);
        options.onError?.(redact(reason));
      }
    },
  };
}
