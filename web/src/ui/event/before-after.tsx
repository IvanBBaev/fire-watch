/**
 * The V2-E2 before/after comparison on an event page: two NASA GIBS true-colour daily
 * mosaics around the event's centre, one over the other, with a divider the reader drags
 * — or moves with the arrow keys, since the divider is a native range input. The left of
 * the divider shows the day before the first detection, the right the day after the last
 * one (or the newest day available, said so, while the event is still being detected).
 *
 * Honesty: the labels name the days and what the imagery is, never that it is clear. A
 * daily mosaic is often under cloud or smoke, so either date can be stepped a day at a
 * time (`core/before-after.ts`), and the note says nothing checks for cloud.
 *
 * The tiles come straight from NASA (keyless, no referrer), so opening the panel is what
 * makes the reader's browser contact GIBS — never the page load. The credit line is drawn
 * from the registry for the `imagery-compare` surface and exists only while the panel does
 * (CI-13).
 *
 * Loaded lazily by `BeforeAfterHost` (`event-details.tsx`), off the critical path (CI-12).
 */

import { useEffect, useMemo, useState } from 'preact/hooks';

import { creditsFor, renderCredit } from '@fire-watch/contracts';

import {
  canShift,
  comparisonDates,
  comparisonTiles,
  gibsTileUrl,
  latestAvailableDay,
  shiftDate,
  type ComparisonDates,
  type ComparisonTile,
  type UtcDay,
} from '../../core/before-after.js';
import { formatDateSofia } from '../../core/i18n/format.js';
import type { FireEvent } from '../../core/types.js';
import { useApp } from '../context.js';
import { activeCreditConditions, creditRenderContext } from '../logic/credits.js';

/** CSS px either side of the view's centre the tiles must cover (the view is at most 800 × 300). */
const HALF_WIDTH_PX = 400;
const HALF_HEIGHT_PX = 150;

export interface BeforeAfterProps {
  readonly event: Pick<FireEvent, 'id' | 'lon' | 'lat' | 'firstObservedAt' | 'lastObservedAt'>;
  readonly nowMs: number;
  readonly onClose: () => void;
}

/** A UTC day as the reader's numeric date; noon UTC keeps the same date in Sofia. */
function dayText(day: UtcDay, locale: Parameters<typeof formatDateSofia>[1]): string {
  return formatDateSofia(`${day}T12:00:00Z`, locale);
}

function TileLayer({
  day,
  tiles,
  onError,
}: {
  readonly day: UtcDay;
  readonly tiles: readonly ComparisonTile[];
  readonly onError: () => void;
}) {
  return (
    <>
      {tiles.map((tile) => {
        const src = gibsTileUrl(day, tile);
        return (
          <img
            key={src}
            class="before-after-tile"
            src={src}
            alt=""
            decoding="async"
            referrerpolicy="no-referrer"
            draggable={false}
            onError={onError}
            style={{
              left: `calc(50% + ${String(tile.leftPx)}px)`,
              top: `calc(50% + ${String(tile.topPx)}px)`,
            }}
          />
        );
      })}
    </>
  );
}

export function BeforeAfter({ event, nowMs, onClose }: BeforeAfterProps) {
  const { messages, locale, config, clock } = useApp();
  const t = messages.beforeAfter;
  // Keyed on the newest available day, not the instant: a ticking clock must not undo the
  // reader's stepped dates, only a new day (or another event) may.
  const latestDay = Number.isFinite(nowMs) ? latestAvailableDay(nowMs) : null;
  const initial = useMemo(
    () => comparisonDates(event.firstObservedAt, event.lastObservedAt, nowMs),
    [event.firstObservedAt, event.lastObservedAt, latestDay],
  );
  const [dates, setDates] = useState<ComparisonDates | null>(initial);
  const [divider, setDivider] = useState(50);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setDates(initial);
    setFailed(false);
  }, [initial]);

  const tiles = useMemo(
    () => comparisonTiles(event.lon, event.lat, HALF_WIDTH_PX, HALF_HEIGHT_PX),
    [event.lon, event.lat],
  );
  const context = creditRenderContext(clock, messages);
  const credits = creditsFor('imagery-compare', activeCreditConditions(config, { gibsOn: true }));

  const shift = (which: 'before' | 'after', delta: number): void => {
    if (dates === null) return;
    setFailed(false);
    setDates(shiftDate(dates, which, delta));
  };
  const stepButton = (which: 'before' | 'after', delta: number, label: string, glyph: string) => (
    <button
      type="button"
      class="button-secondary before-after-step"
      aria-label={label}
      title={label}
      disabled={dates === null || !canShift(dates, which, delta)}
      onClick={() => {
        shift(which, delta);
      }}
    >
      {glyph}
    </button>
  );

  const beforeText = dates === null ? '' : dayText(dates.before, locale);
  const afterText = dates === null ? '' : dayText(dates.after, locale);

  return (
    <section class="event-section before-after" aria-labelledby="before-after-title">
      <h2 id="before-after-title">{t.title}</h2>
      {dates === null ? (
        <p class="event-note">{t.unavailable}</p>
      ) : (
        <>
          <div class="before-after-dates">
            <p class="before-after-date">
              <span>{t.beforeLabel(beforeText)}</span>{' '}
              {stepButton('before', -1, t.beforeEarlier, '‹')}
              {stepButton('before', 1, t.beforeLater, '›')}
            </p>
            <p class="before-after-date">
              <span>
                {dates.afterKind === 'latest'
                  ? t.afterLatestLabel(afterText)
                  : t.afterLabel(afterText)}
              </span>{' '}
              {stepButton('after', -1, t.afterEarlier, '‹')}
              {stepButton('after', 1, t.afterLater, '›')}
            </p>
          </div>
          <div
            class="before-after-view"
            role="img"
            aria-label={t.imageLabel(beforeText, afterText)}
          >
            <div class="before-after-layer">
              <TileLayer day={dates.before} tiles={tiles} onError={() => setFailed(true)} />
            </div>
            <div
              class="before-after-layer before-after-after"
              style={{ clipPath: `inset(0 0 0 ${String(divider)}%)` }}
            >
              <TileLayer day={dates.after} tiles={tiles} onError={() => setFailed(true)} />
            </div>
            <div
              class="before-after-divider"
              style={{ left: `${String(divider)}%` }}
              aria-hidden="true"
            />
            <div class="before-after-marker" aria-hidden="true" />
          </div>
          <input
            class="before-after-slider"
            type="range"
            min={0}
            max={100}
            step={1}
            value={divider}
            aria-label={t.sliderLabel}
            aria-valuetext={t.sliderValue(divider)}
            onInput={(e) => {
              setDivider(Number(e.currentTarget.value));
            }}
          />
          {failed && (
            <p class="event-note" role="status">
              {t.tilesFailed}
            </p>
          )}
          <p class="event-note">{t.note}</p>
        </>
      )}
      {credits.map((credit) => (
        <p class="event-note before-after-credit" key={credit.id}>
          {credit.href === undefined ? (
            renderCredit(credit, context)
          ) : (
            <a class="external-link" href={credit.href} target="_blank" rel="noopener noreferrer">
              {renderCredit(credit, context)}
            </a>
          )}
        </p>
      ))}
      <p>
        <button type="button" class="button-secondary" onClick={onClose}>
          {t.close}
        </button>
      </p>
    </section>
  );
}
