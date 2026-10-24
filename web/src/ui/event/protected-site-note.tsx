/**
 * V2-F1 on an event: "inside the Natura 2000 protected site <name> (<code>)", "N of M
 * detections are inside …", or "about X km from …" when the nearest site's edge is within
 * `PROTECTED_SITE_NEAR_M` (5 km). `core/geo/protected-sites.ts` has the rule.
 *
 * Per detection whenever the detections file gave positions, the event's centre otherwise
 * (while the file loads, and when there is none). Context, never a claim about the fire:
 * nothing renders until the sites have loaded (fetched from our own origin the first time
 * an event is opened), nothing renders if they fail to load, and nothing renders beyond
 * 5 km — and the absence of a sentence is not a claim that no site is affected, because
 * the network covers Bulgaria, Greece and Romania only.
 */

import { STATIC_SOURCE_METRIC } from '@fire-watch/contracts';
import { useEffect } from 'preact/hooks';

import type { ProtectedSiteRelation } from '../../core/geo/protected-sites.js';
import type { FireEvent } from '../../core/types.js';
import type { Messages } from '../../core/i18n/messages.js';
import { useApp } from '../context.js';
import { loadProtectedSites, protectedSites, protectedSitesGeo } from '../protected-sites.js';
import type { DetectionPosition } from './detection-detail.js';

export interface ProtectedSiteNoteProps {
  readonly event: Pick<FireEvent, 'lon' | 'lat'>;
  /** The detections' positions; `null` (or empty) falls back to the event's centre. */
  readonly positions?: readonly DetectionPosition[] | null;
}

/** The sentence for a relation; the distance is shown in km to one decimal. */
export function protectedSiteText(
  relation: ProtectedSiteRelation,
  t: Messages['eventDetail'],
): string {
  const { name, code } = relation.site;
  if (relation.relation === 'near') {
    return t.protectedSiteNear(
      Math.max(0.1, Math.round(relation.distanceM / 100) / 10),
      name,
      code,
    );
  }
  return relation.inside === relation.total
    ? t.protectedSiteInside(name, code)
    : t.protectedSiteInsideSome(relation.inside, relation.total, name, code);
}

export function ProtectedSiteNote({ event, positions = null }: ProtectedSiteNoteProps) {
  const { messages } = useApp();
  useEffect(() => {
    void loadProtectedSites();
  }, []);
  const geo = protectedSitesGeo.value;
  if (geo === null) return null;
  const points = positions !== null && positions.length > 0 ? positions : [event];
  const relation = geo.protectedSiteRelation(protectedSites.value, points, STATIC_SOURCE_METRIC);
  if (relation === null) return null;
  return (
    <p class="event-note protected-site-note">
      {protectedSiteText(relation, messages.eventDetail)}
    </p>
  );
}
