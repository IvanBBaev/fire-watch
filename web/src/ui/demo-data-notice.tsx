/**
 * FD-5: the permanent "demo data" notice (data policy, "Fixtures out of prod").
 *
 * Any build that serves the committed fixtures says so on every page, for as long as the
 * page is open: not dismissible, and outside the degraded-state `BannerSlot`, whose one
 * banner at a time would otherwise hide it the moment the data also went stale. A
 * production build cannot reach this — `web/vite.config.ts` refuses to build one on
 * fixtures — so a live deploy never shows it.
 */

import { servesFixtures, type ClientConfig } from '../core/config.js';
import type { Messages } from '../core/i18n/messages.js';
import './status/status.css';

export interface DemoDataNoticeProps {
  readonly config: Pick<ClientConfig, 'dataSource'>;
  readonly messages: Pick<Messages, 'demoDataNotice'>;
}

export function DemoDataNotice({ config, messages }: DemoDataNoticeProps) {
  if (!servesFixtures(config)) return null;
  // `note`, not `status`: it never changes, so it has nothing to announce, and the banner
  // slot keeps sole use of `.fw-banner[role="status"]`.
  return (
    <p class="fw-demo-notice" role="note">
      {messages.demoDataNotice}
    </p>
  );
}
