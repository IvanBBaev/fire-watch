/**
 * Slot 600: the V2-E3 Copernicus EMS badge, loaded on first use: its parser and matching
 * stay off the critical path (CI-12). Renders nothing when no activation list is configured.
 */

import type { FunctionComponent } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import { useApp } from '../../context.js';
import type { CemsBadgeProps } from '../cems-badge.js';
import type { EventSectionProps } from './registry.js';

export default function CemsSection({ event }: EventSectionProps) {
  const { config } = useApp();
  const url = config.cemsActivationsUrl;
  const [Badge, setBadge] = useState<FunctionComponent<CemsBadgeProps> | null>(null);
  useEffect(() => {
    if (url === undefined || Badge !== null) return undefined;
    let live = true;
    import('../cems-badge.js').then(
      (module) => {
        if (live) setBadge(() => module.CemsBadge);
      },
      () => {
        // A failed chunk load leaves the page without the badge; nothing else depends on it.
      },
    );
    return () => {
      live = false;
    };
  }, [url, Badge]);
  if (url === undefined || Badge === null) return null;
  return <Badge url={url} event={event} />;
}
