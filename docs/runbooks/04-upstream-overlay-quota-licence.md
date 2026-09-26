# 04 — Upstream overlay, quota or licence failure

> **PRE-SEASON DRAFT (2026-09-23).** Not yet exercised. EFFIS has been fetched only
> against fixtures and development runs; the ArcGIS toggle (G6) is still being built;
> no CDSE or GIBS server integration exists. Revise after season 1 and at every
> pre-season drill (see [README](README.md)).

**Class.** A free, no-SLA upstream that is *not* on the detection path fails or
changes terms. Four shapes:
- **Outage.** EFFIS or GIBS is down mid-season.
- **Content failure.** An HTTP 200 carries an error document, a blank image or the
  wrong size.
- **Quota cliff.** The ArcGIS free tier (2M tiles/month) or CDSE (10k PU/month) runs
  out during a viral event.
- **Licence or attribution change.** A provider changes its terms or its required
  credit line.

The map stays usable; a layer degrades. The risk is serving something silently wrong
or unlicensed, not going dark.

Detection-path feeds (FIRMS, LSA SAF, EUMETSAT) going stale are
[01](01-pipeline-stale.md), not this runbook.

**Sources.**
- RISKS watchlist rows: "GIBS / EFFIS have no SLA", "CDSE quota exhaustion", "ArcGIS
  free-tier cliff", "NC-licence traps".
- RISKS R5 (free-data dependency).
- Review 14 minors: EFFIS 200-with-error/blank image, and the Esri quota degrading to
  a toggle disabled via client-config.
- ADR-001 A1.2 (proxy, serve-stale-on-error) and A1.3 (Esri toggle, never proxied).
- OPERATIONS §1.1(6) (mutes) and §11.
- RISKS §3 (licence review before code).

## 1. Detection signal

| Signal | Where | Meaning |
|---|---|---|
| `effis:layers` row `warn` (26 h) / `critical` (50 h, `pages: true`) | `/api/health/freshness` | No EFFIS layer has landed a good copy within budget. Critical 500s the endpoint. |
| `effis-refresh` row (26 h / 50 h, `pages: false`) and the `effis-refresh` heartbeat check | freshness body; healthchecks.io | The refresh job itself is not completing. It runs every 6 h (`EFFIS_REFRESH_INTERVAL_MS`). |
| `{"effis_refresh": {...}, "degraded": true}` | worker stdout | Not one layer reached `stored`, or a status row could not be written. Per layer: `outcome` (`stored`, `fetch_failed`, `rejected`, `suspect`, `write_failed`), `sanity`, `sanityRule`, `staleAvailable`, `error`. |
| `outcome: "rejected"` / `"suspect"` with a `sanityRule` | same line | **Content failure** caught by `core/effis/content-sanity.ts`: `http_status_not_ok`, `content_type_mismatch`, `error_document_body`, `png_signature_missing`, `png_structure_invalid`, `png_dimensions_mismatch` (reject); `png_fully_transparent`, `png_uniform_pixels`, `png_mostly_transparent`, `body_below_byte_floor` (suspect). The last good `current` is never replaced. |
| `{"effis_refresh_failed": ...}` | worker stdout | The refresh threw. |
| `{"refresh_disabled": ...}` at start-up | worker stdout | `FIRE_WATCH_STATE_DIR` is unset, so neither the refresh nor the overlay route runs. |
| `weather:context` row (6 h / 24 h, `pages: false`), `{"weather_refresh": ..., "degraded": true}`, `weather_refresh_failed` | freshness body; worker stdout | ECMWF Open Data context is stale (`FIRE_WATCH_ECMWF_BASE_URL`). Context only; it never pages. |
| A provider notice, a changed terms page, or a CI-13 failure | email, provider site, `pnpm run test` | **Licence or attribution change.** CI-13 fails when a credit line from `packages/contracts/src/credits.ts` goes missing from a surface. It cannot detect that the provider changed the required wording. |

Gaps:
- `NOT YET BUILT (G6)`: ArcGIS usage metering and its 80% alarm. G6 is being built
  concurrently; update this row when it lands.
- `NOT YET BUILT (no task yet)`: a CDSE quota dashboard alarm and any server-side GIBS
  signal. GIBS and CDSE layers are not integrated server-side today, so there is
  nothing to monitor.
- `NOT YET BUILT (G4 open point)`: a reject metric. Rejections show only in the
  refresh log line and in the evidence under `rejected/` in the state dir.
- Known blind spot (G4): an error message drawn *into* an image of the requested size
  cannot be detected until the `EXCEPTIONS=XML` config change lands.
  `png_mostly_transparent` is unarmed (`NEAR_BLANK_TRANSPARENT_FRACTION` is `null`).

## 2. Triage

1. **Which upstream, and which shape?** Read the freshness body (see
   [01](01-pipeline-stale.md) §2 step 1) and the refresh lines:
   ```sh
   cd /srv/fire-watch && docker compose logs --since 30m | grep -E 'effis_refresh|weather_refresh|refresh_disabled'
   ```
2. **Outage or content?** `fetch_failed` means the upstream is unreachable or
   returning non-2xx. `rejected`/`suspect` means it answers with garbage. Check the
   EFFIS/JRC service status before assuming it is our fault. `write_failed` is ours:
   check disk space on the state dir.
3. **Are users still being served?** `staleAvailable: true` means the proxy
   (`/overlays/effis/:file`) is still serving the last good copy. It sets
   `Last-Modified` to the copy's `available_at`, so clients can label its age.
4. **Quota.** For ArcGIS, check the Esri developer dashboard. `NOT YET BUILT (G6)`:
   in-app metering. For CDSE, check the quota dashboard, which only matters once
   imagery is integrated.
5. **Licence.** Is the change to *wording* (update the credit), to *terms* (possible
   loss of rights), or a new non-commercial clause (NC trap, RISKS watchlist)? Terms
   changes are founder decisions, not operator actions.

## 3. Mitigation

- **M1 — EFFIS outage.** There is nothing to do on the box. The proxy serves the last
  good copy (ADR-001 A1.2; `max-age=600`) and the refresh retries every 6 h by
  itself. Do not mute: a mute is a code change to `MUTES` in
  `server/src/core/config/freshness-budgets.ts` (at most 24 h, with a reason, per
  §1.1(6)) and deploys are `NOT YET BUILT (J4)`. `effis:layers` critical is 50 h, so
  a short outage never reaches it. To point at a mirror or stub for a drill, set
  `FIRE_WATCH_EFFIS_BASE_URL` (an env change, see the
  [README](README.md#shared-facts-every-runbook-assumes)).
- **M2 — EFFIS content failure.** Also nothing to do urgently: rejected and suspect
  bodies never move `current`. Keep the evidence files under `rejected/` and `suspect/`
  in the state dir for the post-incident note. If a new failure pattern gets
  through (a bad image served as good), that is a G4 follow-up: add a rule to
  `core/effis/content-sanity.ts` and a fixture.
- **M3 — The upstream is permanently gone or changed its API.** This is a config and
  code change, never a mute (review 14 H1 reasoning applies). Retire the row as in
  [01](01-pipeline-stale.md) M4, or re-point the base URL. `NOT YET BUILT (J4)`: the
  deploy.
- **M4 — ArcGIS quota cliff.** `NOT YET BUILT (G6)`: the planned lever is to hide the
  imagery toggle through `/api/v1/client-config` without a deploy. Today the document
  carries only `transport`, `poll_interval_ms` and `static_snapshot_url`
  (`packages/contracts/src/client-config.ts`), so there is no Esri field to flip. The
  imagery must never be proxied or pre-cached server-side as a workaround; that is a
  licence term (RISKS watchlist). Until G6 lands, the only fallback is a web release
  without the toggle.
- **M5 — CDSE quota exhaustion.** `NOT YET BUILT (no task yet)`: no CDSE pipeline
  exists. The planned responses are pre-rendered GIBS layers and AWS `sentinel-cogs`
  as the second access path (RISKS watchlist).
- **M6 — Attribution wording change.** Update `packages/contracts/src/credits.ts` and
  the surfaces CI-13 checks, then ship. `NOT YET BUILT (G5)`: G5 has open founder
  decisions on the existing wording. `NOT YET BUILT (J4)`: the deploy.
- **M7 — Terms change or a new NC clause.** Stop using the source. For an overlay,
  remove the layer; for context data, point to the licensed alternative. For example,
  weather is ECMWF Open Data because Open-Meteo's free tier is non-commercial
  (DATA-SOURCES §D3/§D6). Run the 09 licence review before any replacement goes in
  (RISKS §3). This is a founder decision; record it.

## 4. Communication

- **Operator.** `effis:layers` critical pages through the freshness probe into
  fw-alerts. `NOT YET BUILT (C5)`: the Grafana probe leg that turns the 500 into a
  page. The other rows in this runbook do not page by design.
- **Public.**
  - The product surface is the single degraded banner for an overlay (08 §5.6) plus
    the proxy's honest `Last-Modified`.
  - `NOT YET BUILT (J5)`: a status-page note, e.g. "EFFIS fire-danger layer shows data
    from DD.MM; the upstream service is unavailable". An outage announced at least
    24 h ahead does not consume error budget (§4.1 rule 6).
  - `NOT YET BUILT (founder decision, OPERATIONS §10 rule 2)`: the second announcement
    channel.
- **Licence changes** are communicated by the credit line itself and, if a layer is
  removed, by a changelog note. Never silently.

## 5. Recovery verification

1. `effis:layers` is back to `ok`, and the next `effis_refresh` line has
   `degraded: false` with `outcome: "stored"` for every layer.
2. The proxy serves the new copy: `Last-Modified` on `/overlays/effis/<file>` moves to
   the new `available_at`.
3. For content failures, a fixture for the new pattern is in the G4 suite and fails
   without the rule.
4. For a licence change, CI-13 is green and the new credit wording matches the
   provider's requirement word for word.
5. `NOT YET BUILT (G6)`: for the quota cliff, the toggle is re-enabled only when the
   meter is below its alarm threshold.

## 6. Post-incident note

Record in `WORKLOG.md`:
- the upstream
- the shape (outage, content, quota or licence)
- the window during which a stale or held copy was served
- any sanity rule that was missed (a bad image served as good is the serious one)
- the quota numbers at the cliff

Update the RISKS watchlist row for the upstream (RISKS §3); a new failure mode gets
its own row. A licence change also updates the DATA-SOURCES licence table. Error
budget: the EFFIS proxy is on the 99.9% map read path (OPERATIONS §4), so an outage
where the proxy served nothing (no `current`) uses budget. Serving stale with an honest
label does not.
