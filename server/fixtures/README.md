# Golden-replay fixtures

Every directory here is one scenario from the register in `docs/GATES.md` §1.1. A fixture
is checked-in data, not code: it records what the satellites handed us and what the system
must conclude from it, so that a change in the clustering engine either reproduces those
conclusions or explains itself.

## Layout

```
<fixture-id>/
  manifest.json     what the scenario is, and everything the replay must be pinned to
  poll-01.json      one poll, in the order it arrived
  poll-02.json
  expected.json     the outcomes the scenario asserts
```

## `manifest.json`

| Field | Why it exists |
|---|---|
| `id` | `S1`…`S16` for the register; a local name for harness-only fixtures. |
| `title`, `asserts` | One line each, printed when the fixture fails. |
| `required` | `pre-merge`, `pre-season` or `suite` — the "Required" column of GATES §1.1. The gate reads this field. |
| `owner` | The work package that maintains it. |
| `clockStart` | The virtual clock's start instant. Without it the fixture means something different on the day CI runs it. |
| `mode` | `live` (forward replay) or `offline` (reprocessing/backfill). An `offline` fixture that emits an alert fails — that is gate CI-6. |
| `allowRevive` | Reviving an archived event on a replay has to be said out loud (invariant I4). |
| `configVersions` | Parameters are versioned data (ADR-002 D5). A fixture that does not pin them silently changes what it asserts the next time someone tunes `eps`. |
| `inputs` | Poll files, in arrival order. Plain file names — no paths. |
| `expected` | The expectations file. |

## Poll files

```json
{
  "availableAt": "2026-08-02T11:41:00Z",
  "detections": [
    {
      "detectionUid": "<sha256 hex>",
      "source": "firms:viirs:snpp",
      "acqTsIso": "2026-08-02T11:24:00Z",
      "latCanonical": "41.85012",
      "lonCanonical": "26.14003",
      "confidence": "nominal",
      "frpMw": 12.5,
      "dayNight": "D"
    }
  ]
}
```

`availableAt` is when **we** could first have seen the row, not when the satellite observed
it — the latency between the two is what several scenarios are about. A row may carry its
own earlier `availableAt`; it may never be later than the poll that returned it.

Coordinates are canonical 5-decimal text, never floats: they are part of the
`detection_uid` pre-image (GLOSSARY §1b) and a float would reintroduce the formatting
question the canonical form exists to close.

An empty `detections` array is legal and meaningful — a poll that succeeds and returns
nothing is a healthy poll.

### Editing a row means recomputing its id

`detection_uid` is `sha256(source | acq_ts_iso | lat_5dp | lon_5dp)`. Nudging a coordinate
without recomputing the digest produces a fixture that asserts something which cannot
happen in production, so the loader recomputes every id and refuses the fixture on a
mismatch. Use `detectionUid` from `@fire-watch/contracts/node`.

The order rows appear in the file does **not** matter: the runner sorts every batch by the
fixed key `(available_at, source, lat, lon, detection_uid)` before the engine sees it.
`harness-smoke/poll-01.json` is deliberately written out of that order to keep the point
visible.

## `expected.json`

Outcomes only — public ids, lifecycle states, score buckets, which detections ended up on
which event, which alerts fired and in what order. Never cluster internals or counters: a
fixture that asserts internals stops being a regression test and becomes a change-detector
that fails on every refactor.

## Running them

```sh
pnpm --filter @fire-watch/server run build
node server/dist/adapters/fixtures/replay-cli.js                # the whole register
node server/dist/adapters/fixtures/replay-cli.js server/fixtures/harness-smoke
```

The command prints one canonical JSON document and exits non-zero if any fixture's
outcomes differ from its expectations. CI runs it twice, in two processes under different
`TZ` and locale settings, and diffs the bytes — that is gate CI-2.

## `harness-smoke`

Not a scenario. It exercises the harness itself — virtual clock, fixed batch order,
canonical report — against a placeholder engine that groups detections by coordinate and
mints ids in the order it first sees them. It stays after WP2 lands, because it is the
fixture that fails when the *harness* breaks rather than when the clustering does.
