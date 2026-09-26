# Spike B7 — Surviving `setStyle`: idempotent layer registry + `transformStyle`

**Question.** `map.setStyle()` (theme swap) rebuilds the style tree and drops every
runtime source and layer. How do our fire layers survive a theme change without a
flash of fire-less basemap, and without duplicate-layer errors?

**Decision.** Use both defenses from review 08 §5.3.5 together:

1. **`transformStyle` merge** — `setStyle(url, { transformStyle: preserveFireStyle })`
   copies our sources and layers from the previous style into the incoming one
   atomically, so there is never a rendered frame without fire data during the swap.
2. **Idempotent re-apply on every `style.load`** — `applyFireLayers(map)` uses
   existence-checked adds (`getSource`/`getLayer` before `addSource`/`addLayer`) and
   runs on every `style.load` event, not just the first. After a normal theme swap it
   finds everything already present (carried by defense 1) and adds nothing; after any
   style rebuild that did *not* go through our `setTheme` path it restores the full
   set.

Neither defense is sufficient alone: `transformStyle` only runs for `setStyle` calls
that pass the option, and re-apply alone leaves a visible gap between the new style
rendering and the `style.load` handler running.

## What `style.load` must restore besides layers

- **Source data** — carried sources keep their data under defense 1, but after a
  rebuild without it the fresh sources are empty; the handler re-pushes the current
  store state directly (bypassing the 1/s throttle — style swaps are rare user
  gestures, not data churn).
- **Feature-state** — a style rebuild clears feature-state, so the handler re-applies
  `{selected: true}` for the currently selected public id.

## Registry design that makes this testable

The registry is plain data plus pure functions against a structural `LayerHost` seam
(`getSource` / `addSource` / `getLayer` / `addLayer`); `maplibre-gl` appears only as
types. Source and layer specs are built fresh per apply, so no shared mutable `data`
object leaks between applications.

## What the fake-host tests prove (`web/src/map/layer-registry.test.ts`)

The fake host is stricter than MapLibre: it **throws** on a duplicate `addSource` /
`addLayer`, and its `reset()` simulates the `setStyle` wipe.

- Double apply performs zero additional adds (idempotence, no reliance on MapLibre's
  own duplicate errors).
- Apply after `reset()` re-adds both sources and all four layers (the `style.load`
  recovery path).
- Apply after a partial wipe fills in only the missing pieces.
- `preserveFireStyle`: returns the next style unchanged when previous is `undefined`;
  carries our sources/layers over; appends our layers after the incoming basemap
  layers in registry paint order; never duplicates entries the next style already
  contains; leaves basemap sources and other style members untouched.

Not covered here (by design): a real browser swap between two style URLs — that is a
shell-level smoke test. This spike de-risks the merge/re-apply logic itself.
