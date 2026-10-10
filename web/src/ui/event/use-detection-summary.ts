/**
 * Loads the event's detections file once per event id and reduces it to a
 * {@link DetectionSummary}. A missing template, a 404, a transport failure and an
 * empty file all answer `unavailable` — the page then says so instead of inventing
 * sensors or FRP.
 */

import { useEffect, useState } from 'preact/hooks';

import { parseDetectionDetail, summariseDetections } from './detection-detail.js';
import type { DetectionSummary } from './detection-detail.js';

export type DetailState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly summary: DetectionSummary }
  | { readonly kind: 'unavailable' };

const UNAVAILABLE: DetailState = { kind: 'unavailable' };
const LOADING: DetailState = { kind: 'loading' };

/** The detections URL for one event, or `null` when detail is switched off. */
export function detectionsUrl(template: string | null, eventId: string): string | null {
  return template === null ? null : template.replace('{id}', encodeURIComponent(eventId));
}

/** A fetched body (or `null` for a non-OK answer) → the state the panel renders. */
export function detailStateOf(body: unknown): DetailState {
  const summary = summariseDetections(parseDetectionDetail(body));
  return summary === null ? UNAVAILABLE : { kind: 'ready', summary };
}

export function useDetectionSummary(template: string | null, eventId: string): DetailState {
  const url = detectionsUrl(template, eventId);
  const [state, setState] = useState<{ url: string | null; detail: DetailState }>({
    url,
    detail: url === null ? UNAVAILABLE : LOADING,
  });

  useEffect(() => {
    if (url === null) {
      setState({ url, detail: UNAVAILABLE });
      return undefined;
    }
    let cancelled = false;
    setState({ url, detail: LOADING });
    fetch(url)
      .then(async (response) => (response.ok ? ((await response.json()) as unknown) : null))
      .then((body) => {
        if (!cancelled) setState({ url, detail: detailStateOf(body) });
      })
      .catch(() => {
        if (!cancelled) setState({ url, detail: UNAVAILABLE });
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  // A navigation to another event must never show the previous event's detail for a frame.
  return state.url === url ? state.detail : url === null ? UNAVAILABLE : LOADING;
}
