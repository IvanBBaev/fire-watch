/**
 * The nightly backup's paging leg over healthchecks.io (TASKS C6; OPERATIONS §1.3
 * `nightly-backup`, §3 rule 5).
 *
 * The check is the {@link HeartbeatJobId} `nightly-backup`, under the same ping key as the
 * job heartbeats:
 *
 *   * every artifact uploaded → `POST <base>/nightly-backup`       (check up)
 *   * any failure             → `POST <base>/nightly-backup/fail`  (check down now: paged)
 *
 * so a failed night pages at once, and a night that never ran (timer disabled, VM gone)
 * pages when the check's grace period runs out. The body is empty: the failure reason
 * goes to the journal, never to a third party's servers.
 *
 * Same discipline as the heartbeat adapter: the URL is a secret, redacted from every error,
 * and nothing here throws or retries — a monitor must not fail the job it monitors.
 */

import type { HeartbeatJobId } from '@fire-watch/contracts';

import type { BackupPinger } from '../../core/backup/ports.js';
import { assertPingBaseUrl, HEARTBEAT_TIMEOUT_MS } from '../monitoring/healthchecks-heartbeat.js';

export const BACKUP_CHECK_SLUG: HeartbeatJobId = 'nightly-backup';

export interface HealthchecksBackupPingerOptions {
  /** `https://hc-ping.com/<ping-key>` — the same secret the heartbeats use. */
  readonly pingBaseUrl: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
  /** Told about a ping that did not land, with the URL already redacted. */
  readonly onError?: (reason: string) => void;
}

export function createHealthchecksBackupPinger(
  options: HealthchecksBackupPingerOptions,
): BackupPinger {
  const baseUrl = assertPingBaseUrl(options.pingBaseUrl);
  const timeoutMs = options.timeoutMs ?? HEARTBEAT_TIMEOUT_MS;
  const doFetch = options.fetch ?? globalThis.fetch;
  const redact = (text: string): string => text.split(baseUrl).join('<HEARTBEAT_URL>');

  async function ping(suffix: '' | '/fail'): Promise<void> {
    try {
      const response = await doFetch(`${baseUrl}/${BACKUP_CHECK_SLUG}${suffix}`, {
        method: 'POST',
        signal: AbortSignal.timeout(timeoutMs),
        body: '',
      });
      await response.body?.cancel().catch(() => undefined);
      if (!response.ok) {
        options.onError?.(`backup ping rejected with HTTP ${String(response.status)}`);
      }
    } catch (error: unknown) {
      const text =
        error instanceof Error
          ? error.name === 'TimeoutError'
            ? 'backup ping timed out'
            : error.message
          : String(error);
      options.onError?.(redact(text));
    }
  }

  return {
    succeeded: () => ping(''),
    failed: () => ping('/fail'),
  };
}

/** A pinger for runs with no ping URL configured (a laptop, a dry run). */
export const NO_BACKUP_PINGER: BackupPinger = {
  succeeded: () => Promise.resolve(),
  failed: () => Promise.resolve(),
};
