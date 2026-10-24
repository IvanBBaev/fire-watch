/**
 * The lazy half of V2-A1 playback: everything only a reader who opened the scrubber needs —
 * checking the history body, turning it into the map's GeoJSON, the cursor's actions and
 * the panel's body (the window choice, the slider with step / play / speed, the age legend,
 * the FIRMS credit and the way back to live).
 *
 * `playback-loader.ts` imports this module with `import()` the first time the panel opens
 * or a window is chosen (a `pb=` link), so none of it is on the first-render or map path
 * (CI-12, `LAZY_ROLES`). It builds on the shell's signals (`playback.ts`) and never imports
 * the loader, which keeps the import one-way.
 *
 * Every control is a native element: the window choice is a radio group, the slider is an
 * `<input type="range">` (arrow keys, Home/End and Page keys for free) whose
 * `aria-valuetext` is the Sofia time rather than a minute count, and play/pause is one
 * button with `aria-pressed`. The status line is a polite live region; the moving cursor
 * time is not, so a playing replay does not talk over everything else.
 */

import { batch } from '@preact/signals';
import { useEffect } from 'preact/hooks';

import { CREDITS, renderCredit } from '@fire-watch/contracts';

import {
  PLAYBACK_AGE_CLASSES,
  PLAYBACK_STEP_MINUTES,
  nextSpeed,
  parseHistoryBody,
  playbackCollection,
  playbackTickMs,
  shownCount,
  stepCursor,
} from '../core/history-body.js';
import { formatShortDateTimeSofia } from '../core/i18n/format.js';
import type { Messages } from '../core/i18n/messages.js';
import {
  HISTORY_RANGES,
  HISTORY_RANGE_MINUTES,
  clampCursor,
  cursorForInstant,
  cursorInstantMs,
  type HistoryBody,
  type HistoryRange,
  type PlaybackCollection,
  type PlaybackSpeed,
} from '../core/playback.js';
import type { Clock } from '../core/ports.js';
import { useApp } from './context.js';
import { creditRenderContext } from './logic/credits.js';
import {
  pendingAtMs,
  playbackBody,
  playbackCursor,
  playbackPlaying,
  playbackRange,
  playbackSpeed,
  playbackStatus,
  startPlayback,
  stopPlayback,
  type PlaybackStatus,
} from './playback.js';

/** The registry id the replayed detections owe (NASA FIRMS / LANCE). */
export const PLAYBACK_CREDIT_ID = 'firms-acknowledgement';

/** The FIRMS credit, rendered from the contracts registry exactly as `/credits` renders it. */
export function firmsCreditText(
  clock: Pick<Clock, 'epochNow'>,
  messages: Pick<Messages, 'appTitle'>,
): string {
  const credit = CREDITS.find((entry) => entry.id === PLAYBACK_CREDIT_ID);
  return credit === undefined ? '' : renderCredit(credit, creditRenderContext(clock, messages));
}

/** A window ready to replay: the checked body and the map's collection, built once. */
export interface LoadedReplay {
  readonly body: HistoryBody;
  readonly collection: PlaybackCollection;
}

/**
 * Fetch and check one window. Every failure — the network, a status, a body that is not a
 * history document or is for another window — is `null`, never a throw.
 */
export async function fetchReplay(
  range: HistoryRange,
  fetchUrl: (url: string) => Promise<Response>,
  urlTemplate: string,
): Promise<LoadedReplay | null> {
  try {
    const response = await fetchUrl(urlTemplate.replace('{range}', range));
    if (!response.ok) return null;
    const body = parseHistoryBody(await response.json());
    if (body === null || body.range !== range) return null;
    return { body, collection: playbackCollection(body) };
  } catch {
    return null;
  }
}

/**
 * Land a window the loader fetched: the cursor opens at a link's pinned instant, or at the
 * window's end. An answer for a window no longer chosen is dropped.
 */
export function landReplay(range: HistoryRange, { body, collection }: LoadedReplay): void {
  if (playbackRange.peek() !== range) return;
  const atMs = pendingAtMs.peek();
  batch(() => {
    pendingAtMs.value = null;
    playbackCursor.value =
      atMs === null ? HISTORY_RANGE_MINUTES[range] : cursorForInstant(body, atMs);
    playbackStatus.value = { kind: 'ready', body, collection };
  });
}

/* ----------------------------------------------------------------------------------- */
/* The cursor's actions                                                                 */
/* ----------------------------------------------------------------------------------- */

export function setPlaybackCursor(cursor: number): void {
  const range = playbackRange.peek();
  if (range !== null) playbackCursor.value = clampCursor(cursor, range);
}

/** One step back or forward; stepping pauses. */
export function stepPlayback(direction: -1 | 1): void {
  const range = playbackRange.peek();
  if (range === null) return;
  playbackPlaying.value = false;
  playbackCursor.value = stepCursor(playbackCursor.peek(), direction, range);
}

/**
 * Play or pause. Playing from the window's end starts over from its beginning, so the
 * button always does something visible.
 */
export function togglePlaying(): void {
  const range = playbackRange.peek();
  if (range === null || playbackBody.peek() === null) return;
  if (!playbackPlaying.peek() && playbackCursor.peek() >= HISTORY_RANGE_MINUTES[range]) {
    playbackCursor.value = 0;
  }
  playbackPlaying.value = !playbackPlaying.peek();
}

/** One tick of the play loop: a step forward, pausing at the window's end. */
export function tickPlayback(): void {
  const range = playbackRange.peek();
  if (range === null) return;
  const next = stepCursor(playbackCursor.peek(), 1, range);
  playbackCursor.value = next;
  if (next >= HISTORY_RANGE_MINUTES[range]) playbackPlaying.value = false;
}

/* ----------------------------------------------------------------------------------- */
/* The panel's body                                                                     */
/* ----------------------------------------------------------------------------------- */

function statusLine(status: PlaybackStatus, messages: Messages): string | null {
  switch (status.kind) {
    case 'idle':
      return null;
    case 'loading':
      return messages.playback.loading;
    case 'unavailable':
      return messages.playback.unavailable;
    case 'ready':
      if (status.body.count === 0) return messages.playback.empty;
      return status.body.truncated ? messages.playback.truncated : null;
  }
}

/** The play loop: one step per tick while playing, faster at a higher speed. */
function usePlayLoop(playing: boolean, speed: PlaybackSpeed): void {
  useEffect(() => {
    if (!playing) return undefined;
    const timer = setInterval(tickPlayback, playbackTickMs(speed));
    return () => {
      clearInterval(timer);
    };
  }, [playing, speed]);
}

function Scrubber({ range, body }: { readonly range: HistoryRange; readonly body: HistoryBody }) {
  const { messages, locale, clock } = useApp();
  const cursor = playbackCursor.value;
  const playing = playbackPlaying.value;
  const speed = playbackSpeed.value;
  usePlayLoop(playing, speed);
  const cursorTime = formatShortDateTimeSofia(
    new Date(cursorInstantMs(body, cursor)).toISOString(),
    locale,
  );

  return (
    <div class="playback-scrubber">
      <input
        type="range"
        class="playback-slider"
        min={0}
        max={HISTORY_RANGE_MINUTES[range]}
        step={PLAYBACK_STEP_MINUTES[range]}
        value={cursor}
        aria-label={messages.playback.scrubberLabel}
        aria-valuetext={cursorTime}
        onInput={(event) => {
          // Dragging pauses, so the hand and the play loop never fight over the cursor.
          playbackPlaying.value = false;
          setPlaybackCursor(Number(event.currentTarget.value));
        }}
      />
      <div class="playback-buttons">
        <button
          type="button"
          class="map-control"
          onClick={() => {
            stepPlayback(-1);
          }}
        >
          {messages.playback.stepBack}
        </button>
        <button type="button" class="map-control" aria-pressed={playing} onClick={togglePlaying}>
          {playing ? messages.playback.pause : messages.playback.play}
        </button>
        <button
          type="button"
          class="map-control"
          onClick={() => {
            stepPlayback(1);
          }}
        >
          {messages.playback.stepForward}
        </button>
        <button
          type="button"
          class="map-control"
          onClick={() => {
            playbackSpeed.value = nextSpeed(speed);
          }}
        >
          {messages.playback.speed(speed)}
        </button>
      </div>
      <p class="playback-cursor">
        <span>{messages.playback.cursorAt(cursorTime)}</span>
        <span>{messages.playback.shownCount(shownCount(body, cursor))}</span>
      </p>
      <div class="layers-legend">
        <p class="layers-legend-title">{messages.playback.legendTitle}</p>
        <ul>
          {PLAYBACK_AGE_CLASSES.map((entry, index) => (
            <li key={entry.color}>
              <span
                class="layers-swatch"
                aria-hidden="true"
                style={{ background: entry.color, opacity: entry.opacity }}
              />
              {messages.playback.ageClasses[index] ?? ''}
            </li>
          ))}
        </ul>
      </div>
      <p class="layers-note">{messages.playback.sizeNote}</p>
      <p class="layers-credit">{firmsCreditText(clock, messages)}</p>
    </div>
  );
}

/** Everything under the panel's title and honesty note. */
export function PlaybackReplayPanel() {
  const { messages } = useApp();
  const range = playbackRange.value;
  const body = playbackBody.value;
  const line = statusLine(playbackStatus.value, messages);

  return (
    <>
      <fieldset class="layers-group">
        <legend class="layers-group-title">{messages.playback.rangeLabel}</legend>
        {HISTORY_RANGES.map((option, index) => (
          <label class="layers-option" key={option}>
            <input
              type="radio"
              name="fw-playback-range"
              value={option}
              checked={range === option}
              onChange={() => {
                startPlayback(option);
              }}
            />
            <span>{messages.playback.ranges[index] ?? option}</span>
          </label>
        ))}
      </fieldset>
      <p class="layers-status" aria-live="polite">
        {line}
      </p>
      {range !== null && body !== null ? <Scrubber range={range} body={body} /> : null}
      {range !== null ? (
        <button type="button" class="map-control playback-live" onClick={stopPlayback}>
          {messages.playback.backToLive}
        </button>
      ) : null}
    </>
  );
}
