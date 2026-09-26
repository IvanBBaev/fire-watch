# Spike B6 — Feature-state on public ids via `promoteId`

**Question.** Can MapLibre feature-state (the selection ring) key on our public event
ids (`fw-YYYY-…` strings) instead of numeric feature ids, and what does that mean for
merges and tombstones?

**Decision.** Yes. The `fire-events` GeoJSON source is declared with
`promoteId: 'id'`, which lifts `properties.id` — the public id — into the feature id
that `setFeatureState` / `removeFeatureState` key on. The UUID stays an internal store
key and never appears in the GeoJSON payload, the feature id, or the feature-state key
space.

## Why the public id

- **One id across the whole UI surface.** Permalinks (`/event/fw-…`), the route
  parameter, `onSelectEvent(publicId)`, `flyToEvent(publicId)`, and now feature-state
  all speak the same identifier (ADR-002: uuid = internal, public id = external). The
  map controller never translates ids; a click handler reads `feature.id` and hands it
  straight to the shell.
- **String ids are first-class with `promoteId`.** MapLibre GL JS 6.1.0 documents
  string-valued promoted ids for feature-state on GeoJSON sources; no numeric aliasing
  layer is needed.
- **No re-upload on selection.** Selection toggles `{selected: true}` feature-state on
  one id; the 1,000-event collection is never re-sent for a selection change
  (review 08 §5.3.2).

## Merge / tombstone implications

- A merged event becomes a tombstone: `status: 'archived'` with `mergedInto` set. The
  GeoJSON builder excludes every archived event, so the tombstone's feature disappears
  from the source on the next `setData`. Any feature-state still recorded under the
  tombstone's id is harmless — feature-state without a matching feature renders
  nothing, and MapLibre drops it when the source data no longer carries the id.
- The survivor keeps its own public id; selection state on the survivor is untouched
  by the merge. If the shell re-routes a tombstone permalink to the survivor, it calls
  `setSelected(survivorPublicId)` and the ring lands correctly, because the key space
  is exactly the permalink id space.

## What was validated, and how

- **Node-level tests** (`web/src/map/layer-registry.test.ts`,
  `web/src/map/geojson.test.ts`): the source spec carries
  `{ type: 'geojson', promoteId: 'id' }`; built features set both `feature.id` and
  `properties.id` to the public id; the serialized collection contains no UUID;
  archived events (plain and merge tombstones) are excluded from the collection.
- **Documented library behavior**: string `promoteId` feature-state is per MapLibre
  GL JS 6.1.0 documentation. No browser was driven in this spike — a real-map smoke
  test (click → ring on `fw-…` id) belongs to the shell integration pass.
- **Plan B** if string-keyed feature-state regresses in a future MapLibre release:
  keep a `publicId → numeric index` alias map inside the map module and translate at
  the `setFeatureState` boundary only. Nothing outside `web/src/map/**` would change.
