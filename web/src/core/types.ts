/**
 * The seams of the web client — every module-boundary shape in one place.
 *
 * `core/store`, `core/feed`, `map/` and `ui/` are separately owned layers (ADR-005 D1)
 * and meet only through what is declared here. The wire format is *not* here on purpose:
 * the snapshot travels as a GeoJSON FeatureCollection with snake_case foreign members
 * (mirroring the future `/snapshot.json`, ADR-003 D1), and the feed adapter is the single
 * place that guards and maps it into these flat shapes. Nothing past the transport
 * boundary ever sees wire JSON.
 */

import type { FreshnessReport, LifecycleState, ScoreBucket } from '@fire-watch/contracts';

import type { MapCamera, MapViewport } from './geo/viewport.js';

export type Locale = 'bg' | 'en';

export type ThemeName = 'light' | 'dark';

/**
 * One fire event as the client holds it.
 *
 * One identifier (ADR-002, review 13): `id` is the public `fw-<year>-<base32>` id — the
 * store key, and what permalinks and MapLibre feature-state (`promoteId: 'id'`) key on. The
 * internal UUID never crosses the wire (snapshot schema v2 dropped the duplicate `uuid`).
 *
 * All timestamps are ISO-8601 UTC strings from the server — satellite observation time,
 * never poll time (07-product-ux P1). The client never computes lifecycle or confidence
 * locally; `status` and `scoreBucket` arrive decided (ADR-002 D6).
 */
export interface FireEvent {
  readonly id: string;
  /** Global seq at this event's last change — the per-event version (ADR-003 D3). */
  readonly seq: number;
  readonly status: LifecycleState;
  readonly scoreBucket: ScoreBucket;
  /** Survivor's public id when this event was merged away — a tombstone, never a 404. */
  readonly mergedInto: string | null;
  readonly lon: number;
  readonly lat: number;
  readonly firstObservedAt: string;
  readonly lastObservedAt: string;
  readonly detectionCount: number;
  readonly placeNameBg: string;
  readonly placeNameEn: string;
  /** Attributed burned-area estimate; `null` when no source has published one. */
  readonly areaHa: number | null;
  /** Next expected observation window; `null` renders `freshness_chip_unknown` (§3b). */
  readonly nextPassWindow: { readonly start: string; readonly end: string } | null;
}

/**
 * One detection at slope zoom — rendered true-size, tapped for pass details.
 *
 * `lon`/`lat` are the pixel *centre*; `scanKm`/`trackKm` are the extent of the cell the
 * instrument integrated over (across-track and along-track). The pair is what lets the map
 * draw the footprint GLOSSARY §5.2 requires instead of a point that reads as "go here" —
 * see `core/geo/footprint.ts`. Either may be `null`: older rows and some sources publish no
 * usable extent, and the nadir substitution then applies to the pair as a whole.
 */
export interface Detection {
  readonly uid: string;
  readonly lon: number;
  readonly lat: number;
  readonly observedAt: string;
  readonly sourceId: string;
  readonly scanKm: number | null;
  readonly trackKm: number | null;
}

/** Per-source observation recency as carried inside the snapshot itself. */
export interface SnapshotSourceRow {
  readonly sourceId: string;
  readonly lastObservedAt: string | null;
}

/**
 * A parsed snapshot. A full snapshot is the authority on the event *set*; a cursor
 * (`partial: true`) response is an upsert batch and never authoritative for removals
 * (ADR-003 D3, fixture S15).
 */
export interface Snapshot {
  readonly schemaVersion: number;
  readonly generatedAt: string;
  readonly maxSeq: number;
  readonly partial: boolean;
  readonly events: readonly FireEvent[];
  readonly sources: readonly SnapshotSourceRow[];
}

/**
 * Everything a transport can hand the store (review 08 §5.2.2). Both transports speak
 * this one vocabulary — the store never learns which of them a message came from.
 *
 * - `snapshot` — a parsed `/snapshot.json` body, full or cursor-partial (ADR-003 D3 rule 1).
 * - `delta` — an event upsert batch (rule 2); SSE hands over one event per frame.
 *   `generatedAt` is the server instant the carrying frame was stamped with; it is what
 *   dates an `event.merged` tombstone for the 24 h age-out, so the store never has to
 *   consult a clock of its own to know when a merge happened.
 * - `reset` — the stream declared this client's cursor void (rule 3).
 * - `freshness` — the probe API's per-source report (the side-poll, T1 and T0 alike).
 * - `stream-freshness` — the stream's periodic `freshness` frame: the registry's high-water
 *   mark, which is how a client learns of a change that emitted no frame (an event leaving
 *   the map bumps `seq` silently, E2), plus the same per-source rows a snapshot carries.
 * - `snapshot-confirmed` — a full-snapshot request **to the origin** answered
 *   `304 Not Modified`: the origin confirmed the stored set as of `generatedAt` (its
 *   `Date`), and the staleness anchor may advance although no body was transferred. Only
 *   the origin may send this. A `304` from the static copy proves a CDN still holds the
 *   object, not that anything upstream is still publishing, and advancing the anchor on it
 *   would hide a frozen pipeline behind a healthy cache (GLOSSARY §3b trigger 1).
 */
export type FeedMessage =
  | { readonly kind: 'snapshot'; readonly snapshot: Snapshot }
  | { readonly kind: 'delta'; readonly events: readonly FireEvent[]; readonly generatedAt?: string }
  | { readonly kind: 'reset' }
  | { readonly kind: 'freshness'; readonly report: FreshnessReport }
  | {
      readonly kind: 'stream-freshness';
      readonly generatedAt: string;
      readonly maxSeq: number;
      readonly sources: readonly SnapshotSourceRow[];
    }
  | { readonly kind: 'snapshot-confirmed'; readonly generatedAt: string };

export type FeedStatus = 'connecting' | 'live' | 'degraded' | 'dead';

/**
 * The transport port (review 08 §5.2.2). T1 polling is the default and every feature must
 * be fully functional on it alone (ADR-003 D1); the SSE transport speaks the same port.
 */
export interface DataFeedPort {
  start(cursor: { readonly lastSeq: number | null }): void;
  stop(): void;
  onMessage(callback: (message: FeedMessage) => void): void;
  onStatus(callback: (status: FeedStatus) => void): void;
}

/** Which origin a poll went to: the API's `/snapshot.json` (T1) or the static copy (T2). */
export type PollingTier = 'T1' | 'T2';

/**
 * How a polling run paces itself: `'poll'` is the ordinary T1 loop; `'safety'` is the
 * 10-minute full-snapshot rhythm that runs *underneath* a live stream (ADR-003 D3, A1.5) —
 * no cursor requests, no freshness side-poll of its own cadence changes, just the proof
 * that the set is still what the stream says it is.
 */
export type PollCadence = 'poll' | 'safety';

/**
 * What one poll attempt came to, as the supervisor needs it (ADR-003 A1.2/A1.3): the
 * status code decides, never the problem body. `ok` is a parsed `200` or a `304`
 * (`generatedAt` is `null` for the latter — a 304 carries no body); `unusable` is a network
 * error, a timeout, a `5xx`, a `429`, or a body the guard rejected. `retryAfterMs` is the
 * server's hold, already resolved against server time.
 */
export type PollOutcome =
  | {
      readonly kind: 'ok';
      readonly tier: PollingTier;
      readonly full: boolean;
      readonly generatedAt: string | null;
    }
  | {
      readonly kind: 'unusable';
      readonly tier: PollingTier;
      readonly status: number | null;
      readonly retryAfterMs: number | null;
    };

/**
 * What the stream transport tells the supervisor, beside the messages it hands the store:
 * the connection opened, it failed (the browser will not retry — the supervisor decides),
 * or the server asked every stream to step down (`degrade`, ADR-003 A1.1).
 */
export type SseSignal =
  | { readonly kind: 'open' }
  | { readonly kind: 'error' }
  | { readonly kind: 'degrade'; readonly reason: string };

/** Transport-supervisor states (review 08 §5.2.3, ADR-003 D3). */
export type SupervisorState =
  'BOOT' | 'POLLING' | 'SSE_CONNECTING' | 'SSE_LIVE' | 'STATIC_FALLBACK';

export interface StoreState {
  /** Keyed by the public `id` (review 08 §5.2.4). Tombstones stay resident so permalinks resolve. */
  readonly events: ReadonlyMap<string, FireEvent>;
  readonly maxSeq: number;
  /** `generated_at` of the last applied full snapshot; staleness anchors here. */
  readonly lastSnapshotAt: string | null;
  readonly freshness: FreshnessReport | null;
  readonly feedStatus: FeedStatus;
  /** Raised on a detected seq gap — the feed layer must force a full snapshot (rule 3). */
  readonly needsSnapshot: boolean;
  /**
   * Per-source observation recency carried by snapshots and stream `freshness` frames,
   * merged newer-wins per source (TASKS F4). Input to `staleSources`; nothing renders it yet.
   */
  readonly sources: readonly SnapshotSourceRow[];
}

/**
 * The client store. Framework-free by boundary rule (`web-core-is-framework-free`):
 * subscription is a plain listener set; the UI bridges to signals on its own side, and
 * the map subscribes directly, never through the VDOM (ADR-005 D4).
 */
export interface FireEventStore {
  state(): StoreState;
  subscribe(listener: () => void): () => void;
  dispatch(message: FeedMessage): void;
  setFeedStatus(status: FeedStatus): void;
  /** Called by the feed layer once a forced full-snapshot refetch is in flight. */
  acknowledgeSnapshotNeed(): void;
}

/**
 * The self-hosted outdoor basemap (TASKS G1–G3, ADR-001 A1.1 / A2.1): URL templates for
 * the exploded vector-tile tree, the glyph PBFs and — optionally — a Terrarium DEM mirror.
 * `infra/tiles` prints these values after an upload. While `tilesUrl` or `glyphsUrl` is
 * `null` the map keeps the external `styleUrls`, so nothing depends on R2 existing yet.
 */
export interface OutdoorBasemapConfig {
  /** `…/tiles/<version>/{z}/{x}/{y}.mvt` */
  readonly tilesUrl: string | null;
  /** `…/fonts/<version>/{fontstack}/{range}.pbf` */
  readonly glyphsUrl: string | null;
  /** `…/dem/terrarium/{z}/{x}/{y}.png`; `null` renders the style without hillshade. */
  readonly demTilesUrl: string | null;
  /** Deepest zoom in the tile tree; MapLibre overzooms past it (ADR-001 A1.1: 14). */
  readonly maxzoom: number;
}

/** What `map/` needs to come alive; `ui/` supplies it when the map chunk loads. */
export interface MapControllerDeps {
  readonly container: HTMLElement;
  readonly store: FireEventStore;
  readonly theme: ThemeName;
  /** Passed in (from ClientConfig) so `map/` never imports config — one seam, WP5-ready. */
  readonly styleUrls: Readonly<Record<ThemeName, string>>;
  /**
   * The self-hosted outdoor style's inputs. When complete, the map builds its own light/dark
   * style from them (`map/outdoor-style.ts`) instead of loading `styleUrls`; absent, `null`
   * or incomplete, `styleUrls` is what loads.
   */
  readonly outdoorBasemap?: OutdoorBasemapConfig | null;
  /** `{id}` → public id; `null` disables the detection-detail fetch. */
  readonly detectionsUrlTemplate: string | null;
  /**
   * Fully rendered map-corner attribution (contracts `renderMapCornerLine`) —
   * placeholders already resolved; the map renders it verbatim (ADR-001 A1.4).
   */
  readonly attributionLine: string;
  /**
   * Where to open when the URL fragment does not say — a remembered camera, a geolocation
   * fix, or the default view. A `#map=` fragment always wins: a shared link must land
   * everyone on the same frame regardless of what each of their browsers remembers.
   */
  readonly initialView: MapCamera;
  /** Tapping a fire feature — the shell routes to `/event/:id`. */
  readonly onSelectEvent: (publicId: string) => void;
  /**
   * The frame changed (load and every `moveend`). This is what makes the list follow the
   * map; it fires on settled movement only, not on every animation frame of a pan.
   */
  readonly onViewportChange: (viewport: MapViewport) => void;
}

export interface MapController {
  setTheme(theme: ThemeName): void;
  setSelected(publicId: string | null): void;
  flyToEvent(publicId: string): void;
  /** Move the camera outright — the "Balkans" and "my location" controls. */
  flyTo(camera: MapCamera): void;
  /**
   * Hide events last observed before `cutoffMs`; `null` shows everything. The same number
   * the list is scoped by, so the two surfaces cannot disagree about what "recent" means.
   * A display filter only — it never touches lifecycle state (ADR-003 A1.4/R1).
   */
  setAgeCutoff(cutoffMs: number | null): void;
  /**
   * Show the Esri World Imagery raster from this tile URL (key included), or none for
   * `null` (ADR-001 A1.3/A2.3). Removing it is the whole fallback: the basemap underneath
   * shows again, with no error tile and no message.
   */
  setImagery(tilesUrl: string | null): void;
  destroy(): void;
}
