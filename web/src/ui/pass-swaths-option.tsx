/**
 * The F15 swath overlay's legend in the Layers panel: the two swatches (next passes
 * outlined in blue, recent passes shaded violet — the map's own colours) and, under each,
 * the passes the map is drawing right now in words. The map labels the same passes only
 * where the basemap can render text; this list always can, so a reader on the fallback
 * basemap or a screen reader loses nothing.
 *
 * Both read `useSwathDisplay()`, so the list and the map agree on which passes are recent
 * or next at this minute. A document whose window is over says so instead of listing
 * nothing silently; stale orbital elements are named the same way the pass section names
 * them.
 */

import { formatTimeSofia } from '../core/i18n/format.js';
import {
  PASS_NEXT_COLOR,
  PASS_RECENT_COLOR,
  type SwathKind,
  type SwathPassSummary,
} from '../core/pass-swaths.js';
import { PASS_PLATFORM_LABELS } from '../core/passes.js';
import { useApp } from './context.js';
import { passSwathsPayload } from './layers.js';
import { useSwathDisplay } from './pass-swaths.js';

/** Under the panel's id (`fw-layers-panel`), without importing the panel (no cycle). */
const ID_PREFIX = 'fw-layers-panel-swaths';

/** How many passes each list names: the nearest ones; the map shows the rest. */
const LIST_LIMIT = { next: 5, recent: 3 } as const;

const SWATCH_STYLE: Record<SwathKind, Record<string, string>> = {
  next: { backgroundColor: 'transparent', borderColor: PASS_NEXT_COLOR, borderWidth: '2px' },
  recent: { backgroundColor: `${PASS_RECENT_COLOR}26`, borderColor: PASS_RECENT_COLOR },
};

/** The passes of one kind, nearest to now first. */
export function nearestPasses(
  passes: readonly SwathPassSummary[],
  kind: SwathKind,
): readonly SwathPassSummary[] {
  const ofKind = passes.filter((pass) => pass.kind === kind);
  ofKind.sort((a, b) =>
    kind === 'next' ? Date.parse(a.mid) - Date.parse(b.mid) : Date.parse(b.mid) - Date.parse(a.mid),
  );
  return ofKind.slice(0, LIST_LIMIT[kind]);
}

export function SwathLegend() {
  const { messages, locale } = useApp();
  const display = useSwathDisplay();
  const doc = passSwathsPayload.value;
  if (display === null || doc === null) return null;
  const stale = doc.platforms.some((platform) => platform.elements === 'stale');
  const groups: readonly { kind: SwathKind; title: string }[] = [
    { kind: 'next', title: messages.layers.swathsNext },
    { kind: 'recent', title: messages.layers.swathsRecent },
  ];
  return (
    <div class="layers-legend">
      {groups.map(({ kind, title }) => {
        const titleId = `${ID_PREFIX}-${kind}`;
        const passes = nearestPasses(display.passes, kind);
        return (
          <div key={kind}>
            <p id={titleId} class="layers-legend-title layers-legend-item">
              <span class="layers-swatch" style={SWATCH_STYLE[kind]} aria-hidden="true" />
              {title}
            </p>
            {passes.length === 0 ? (
              <p class="layers-note">{messages.passes.none}</p>
            ) : (
              <ul aria-labelledby={titleId} class="layers-pass-list">
                {passes.map((pass) => (
                  <li key={`${pass.platform}-${pass.mid}`}>
                    {messages.layers.swathsPassAt(
                      PASS_PLATFORM_LABELS[pass.platform],
                      formatTimeSofia(pass.mid, locale),
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
      {display.ended ? <p class="layers-note">{messages.passes.expired}</p> : null}
      {stale ? <p class="layers-note">{messages.passes.elementsStale}</p> : null}
    </div>
  );
}
