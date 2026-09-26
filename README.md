# Fire Watch

Near-real-time (15 min–3 h) wildfire **situational-awareness** map and alerts for
Bulgaria and the Balkans — "Watch Duty for the Balkans" — fused from every usable
free satellite source plus curated official information, in local languages.

> Fire Watch is a **situational-awareness and tracking service for developing and
> ongoing fires**, built on satellite data that is minutes-to-hours behind reality. It
> will usually not be the first to know a fire has started — people on the ground and
> 112 are. It exists to answer: *"the fire I heard about — where is it, how big, which
> way has it grown, is it still being detected, and what is the danger level around me
> today?"* It is not a life-safety alarm, it never declares a fire out, and in an
> emergency 112 and official evacuation orders always come first.

This statement is normative (from the fire-domain review, restated in
[`docs/ANALYSIS.md`](docs/ANALYSIS.md) §4): every product, copy, and scope decision
must stay consistent with it.

## Status

**In implementation** (since August 2026). The design phase closed in July 2026:
founding analysis, twelve role reviews, five accepted ADRs, a verified data-source
catalog, and the consolidated gates/risks/plan documents below. A third review round
(August 2026) filled four senior seats the first two rounds never staffed. A fourth
(September 2026) reviewed the implementation itself and filled the three seats it opened:
platform/release, engineering practice, and data stewardship.

Current focus is WP0–WP1 (task-level breakdown in [`docs/TASKS.md`](docs/TASKS.md)):
the monorepo, CI and supply-chain hardening are in place, and the shadow ingestion
pipeline — the single highest priority — is under way: CSV validation and quarantine,
freshness budgets and the health/status API are implemented; live shadow recording
starts once the VM and the FIRMS credentials are provisioned. Public launch target:
**May 2027**, pre-season. **Season 1 (2027) is fully free.**

## Core invariants

Rules that outrank any feature. Enforcement details in
[`docs/GATES.md`](docs/GATES.md) and [`docs/GLOSSARY.md`](docs/GLOSSARY.md).

1. **The map fails open; alerts fail closed.** A stale-but-visible map beats a blank
   page; a paused alert pipeline beats a wrong push.
2. **We never assert a fire is out** in our own voice — no "out", "all clear",
   "safe", "extinguished" in schema, API, or UI; the exact §3 negation strings
   of the GLOSSARY wording contract are the sole exception. False reassurance is
   the #1 harm, and the never-send list is enforced as code.
3. **Honest clock everywhere:** every surface shows how old the data actually is
   (last satellite detection, server timestamps) and never implies "live".
4. **Zero alerts from a single low-confidence detection** — a CI-tested invariant.
5. **Permalinks are forever:** every event `public_id` ever issued resolves for the
   lifetime of the archive (directly or via `mergedInto`) — never 404, never re-used.
6. **Season 1 is fully free.** Paid tiers are a CP3 decision (October 2027), never a
   mid-season switch.

## Documentation map

| Document | What it is |
|---|---|
| [`docs/ANALYSIS.md`](docs/ANALYSIS.md) | Founding analysis: market, product definition, architecture, costs |
| [`docs/DATA-SOURCES.md`](docs/DATA-SOURCES.md) | Satellite & environmental data-source catalog (verified July 2026): licences, quotas, integration waves |
| [`docs/DATA-SOURCES-EXTENDED.md`](docs/DATA-SOURCES-EXTENDED.md) | Maximum-coverage survey (August 2026), Parts H–N: the complete satellite inventory over Bulgaria (incl. the Chinese Fengyun fleet), reception hardware and latency, ground truth, proxy signals, sense-side devices |
| [`docs/decisions/`](docs/decisions/README.md) | Architecture Decision Records 001–005 (index in its README) |
| [`docs/reviews/`](docs/reviews/00-summary.md) | Nineteen role reviews across four rounds (01–12, 16–19, 21–23) + two audits (13–14), two role-gap analyses (15, 20) and `00-summary.md` — the design corpus the ADRs distill, and since round 4 the build's reviewers too |
| [`docs/data/`](docs/data/DATASETS.md) | Dataset register: one dated entry per corpus a fit, calibration, replay or checkpoint report cites (DS-1…DS-4) |
| [`docs/GLOSSARY.md`](docs/GLOSSARY.md) | Canonical vocabulary: entities, lifecycle wording ladder (EN/BG), never-send list |
| [`docs/GATES.md`](docs/GATES.md) | Every gate in one place: CI invariants, launch/season gates, business checkpoints CP1–CP3 |
| [`docs/RISKS.md`](docs/RISKS.md) | Consolidated risk register: business R1–R10 + engineering/data watchlist |
| [`docs/IMPLEMENTATION-PLAN.md`](docs/IMPLEMENTATION-PLAN.md) | Work packages WP0–WP9, calendar, definitions of done |
| [`docs/TASKS.md`](docs/TASKS.md) | The plan broken into dispatchable tasks: dispatch waves, per-task specs, done-when criteria |
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | Operations contract (ops ADR-006): freshness budgets, monitoring legs, backups, provisioning |
| [`docs/EXTERNAL-ACCOUNTS.md`](docs/EXTERNAL-ACCOUNTS.md) | Every external registration/key needed, with lead times and costs |

Suggested reading order for a newcomer: this file → `ANALYSIS.md` →
`reviews/00-summary.md` → the five ADRs → `GLOSSARY.md` → `IMPLEMENTATION-PLAN.md`.

## Stack (decided pre-code — rationale in the ADRs)

TypeScript/Node monolith in the ports & adapters style. Server: Fastify v5 +
TypeBox + Kysely + PostGIS on a single Hetzner VM, Cloudflare (free tier) + R2 in
front. Client: Preact + signals with a framework-free core, MapLibre GL, self-hosted
vector tiles and glyphs on R2, PWA with web push / Telegram / email alerts.
Workspace: pnpm — `packages/contracts` (TypeBox schemas shared verbatim) +
`server/` + `web/`.

## Running the ingest worker

Two entrypoints share one wiring (`server/src/app/ingest-wiring.ts`): `pnpm -F
@fire-watch/server worker` polls on a cadence and is what the VM runs, and `pnpm -F
@fire-watch/server ingest` runs a single cycle for a smoke test or a manual catch-up.
Both write one canonical-JSON line per cycle to stdout.

Configuration is environment-only — there is no config file, and no default for a
secret. Values reach the process from the VM env file (`OPERATIONS.md` §8).

| Variable | Required | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | yes | — | The same variable dbmate reads, on purpose |
| `FIRMS_MAP_KEY` | yes | — | Never logged; only its length is |
| `FIRMS_BASE_URL` | no | the NASA Area API | Point a drill or smoke test at a stub |
| `FIRE_WATCH_DB_ROLE` | no | `fire_watch_app` | Assumed in the connection startup packet |
| `FIRE_WATCH_POLL_INTERVAL_MS` | no | `600000` | Bounded to 1 min … 1 h |
| `FIRE_WATCH_HEARTBEAT_URL` | no | — | healthchecks.io ping base for the dead-man's switch. The whole value is a secret and is never logged or echoed; absent on a developer box, where no check should page |

Exit codes: `0` clean, `1` nothing recorded (CLI) or the wiring itself failed, `2`
misconfiguration — every missing variable is named at once.

## Running the health API

`pnpm -F @fire-watch/server api` serves the probe surface — `/healthz`, `/readyz` and
`/api/health/freshness` (`docs/OPERATIONS.md` §2) — from its own entrypoint and its own
two-connection pool, so a wedged ingest cycle and a wedged probe cannot take each other
down. It binds to loopback by default: the only intended path to it in production is
Cloudflare → local proxy → this process.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | yes | — | Same variable as the worker and dbmate |
| `FIRE_WATCH_API_PORT` | no | `8080` | 1024–65535 — a privileged port would mean running as root for the sake of a number |
| `FIRE_WATCH_API_HOST` | no | `127.0.0.1` | Loopback unless the deployment model says otherwise |
| `FIRE_WATCH_CLIENT_IP_HEADER` | no | unset | Name of the header the edge **overwrites** with the real client IP (for Cloudflare: `cf-connecting-ip`); the rate limiter keys on it, falling back to the socket address. `x-forwarded-for` is refused by name — proxies append to it rather than overwrite it, so keying on it would hand the rate-limit key to the caller |
| `FIRE_WATCH_DB_ROLE` | no | `fire_watch_app` | As for the worker |
| `FIRE_WATCH_SSE_ENABLED` | no | `true` | Exactly `true` or `false`. `false` is the operator kill: the fleet is told `poll`, the stream answers `503`, and nothing re-offers it until the variable changes and the process restarts |
| `FIRE_WATCH_CLIENT_POLL_INTERVAL_MS` | no | `45000` | What a polling client is told to wait between snapshot reads; bounded to 5 s … 30 min, the same bounds the web client enforces |
| `FIRE_WATCH_STATIC_SNAPSHOT_URL` | no | unset | Absolute `http(s)` URL of the CDN copy of `/snapshot.json` (ADR-003 A1.2), handed to clients verbatim. Unset means `null`: the client reads the origin |
| `FIRE_WATCH_ARCGIS_API_KEY` | no | unset | ArcGIS Location Platform client key for the optional imagery toggle (TASKS G6). Secret: never logged (`describeConfig` says only `<configured>`), though it is handed to browsers offered imagery. Set together with `FIRE_WATCH_ARCGIS_IMAGERY_TILE_URL` or not at all, and needs `FIRE_WATCH_STATE_DIR` (kill switch, override, trip latch, `usage.json`) |
| `FIRE_WATCH_ARCGIS_IMAGERY_TILE_URL` | no | unset | `https` raster tile template with `{z}`, `{x}` and `{y}` and no token; no default, because the endpoint is part of provisioning the key |
| `FIRE_WATCH_ARCGIS_TILE_CEILING` | no | unset | Tiles per quota period at which imagery turns off; an integer in 1 … 1,999,999 (below the 2M free tier). Unset means unarmed: imagery stays off even with a key |
| `FIRE_WATCH_AUTH_ENABLED` | no | `false` | Exactly `true` or `false`. Sign-in (TASKS I1, `POST /api/v1/auth/{link,continue,logout}`) and the signed-in account routes (`/api/v1/account`, `/api/v1/account/export`, `/api/v1/zones`, `/api/v1/channels/*` — I2, I3, I4, I6) are registered only when `true`; off, all of those paths are a `404`. With `true`, the process refuses to start unless every `FIRE_WATCH_AUTH_*` variable below and the four `FIRE_WATCH_SES_*` credentials are set |
| `FIRE_WATCH_AUTH_MAIL_FROM` | with auth | — | Verified SES sender for sign-in mail, a bare address on `FIRE_WATCH_AUTH_MAIL_DOMAIN`. No default: chosen when the auth-mail subdomain is provisioned |
| `FIRE_WATCH_AUTH_MAIL_DOMAIN` | with auth | — | The auth-mail subdomain; the sender must be on it. Which subdomain, and whether it is separate from the alerts one, is a founder decision |
| `FIRE_WATCH_AUTH_LANDING_URL` | with auth | — | `https` URL of the page that receives the link; no fragment and no credentials. Set it to the web app's canonical landing page, `https://<host>/sign-in/continue`. The token is appended as `#token=…`, which browsers never send to a server. The path is not validated: the web app moves a token found on any of its paths to `/sign-in/continue` before its first request, so a link to another path of the same app still works |
| `FIRE_WATCH_AUTH_ALLOWED_ORIGINS` | with auth | — | Comma-separated exact `https` origins (no path, no trailing slash) the auth POSTs must come from; must include the landing URL's origin |
| `FIRE_WATCH_SES_REGION`, `…_ACCESS_KEY_ID`, `…_SECRET_ACCESS_KEY`, `…_FROM_ADDRESS` | with auth | — | Shared with the email alert channel. For sign-in the region must be an EU region (`eu-*`). The IAM principal needs `ses:SendEmail` only, scoped to the verified auth-mail identity. Both key halves are redacted from every log line |
| `FIRE_WATCH_ZONE_KEY_ID`, `FIRE_WATCH_ZONE_KEY` | no | unset | The active zone-centre key (TASKS I2): an id (`[A-Za-z0-9_.-]{1,64}`, stored in each zone row) and standard base64 of exactly 32 bytes, set together or not at all. Unset, the API does not register the zone and export routes (`404`) — zones are never stored in clear. Read by the API only; the key is never logged, the id is |
| `FIRE_WATCH_ZONE_KEYS_RETIRED` | no | unset | `id:base64,id:base64` — decrypt-only keys kept until `zone-key-rotation-cli.ts` has moved every row off them. Refused without an active key |

The same process serves the two read routes of ADR-003, each on its own pool so a burst
on either cannot starve `/readyz`: `/snapshot.json` (T1 — the active set as GeoJSON,
ETag from the global `seq` mark, `?updated_after_seq=` cursor) and `/api/v1/stream` (T0 —
Server-Sent Events: `retry:` on connect, replay from `Last-Event-ID` or
`?last_event_id=` out of a 1,000-frame ring, a `reset` frame when the ring cannot serve
the cursor, `freshness` at least every 30 s, a keepalive every 25 s; 5,000 connections
hard cap → `503` + `Retry-After`). Neither pays the probe rate limiter; both answer
refusals as `application/problem+json`.

It also serves `GET /api/v1/client-config` (ADR-003 D1, A1.1, A1.2), the document the
fleet reads before it chooses a transport: exactly `transport` (`"sse"` or `"poll"`),
`poll_interval_ms` and `static_snapshot_url`, as `application/json` with
`Cache-Control: public, max-age=30` and CORS `*` — a flip reaches every client within one
edge TTL. The `transport` field is the demotion controller's answer: it becomes `poll`
the instant the stream is at its cap, or after five minutes of event-loop lag p99 over
200 ms or host CPU over 80 %, and becomes `sse` again only after thirty minutes below all
three. On the flip to `poll` every open stream is sent one `degrade` frame (`reason`
`capacity` or `load`) and closed, and `/api/v1/stream` answers `503` + `Retry-After: 60`
until the stream is offered again; clients are never told any of this in words.

## Running the integration suite

`pnpm run test:integration` runs every `*.integration.test.ts` against a real PostgreSQL
16 + PostGIS 3.4 started by Testcontainers — the only place the migrations and the SQL
adapters are executed. Without a reachable Docker daemon each suite skips itself, so a
laptop without Docker stays green; `FIRE_WATCH_REQUIRE_DOCKER=1` turns that skip into a
failure. CI's `integration` job sets it and additionally fails on any skipped test.

The suites pin `postgis/postgis:16-3.4`, which is published for amd64 only. On Apple
Silicon it runs under emulation and its health check times out, so point
`FIRE_WATCH_PG_IMAGE` at an arm64 build of the same versions; the override is applied in
one place, `vitest.config.ts`, and leaves CI's image unchanged when unset. With
[colima](https://github.com/abiosoft/colima) (a dedicated profile keeps the test VM away
from any other Docker work):

```
colima start fwtest --arch aarch64 --cpus 4 --memory 4
DOCKER_HOST=unix://$HOME/.colima/fwtest/docker.sock \
TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock \
FIRE_WATCH_REQUIRE_DOCKER=1 \
FIRE_WATCH_PG_IMAGE=imresamu/postgis:16-3.4 \
  pnpm run test:integration
```

`DOCKER_HOST` points the Docker CLI and Testcontainers at the colima socket on the host;
`TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE` is the socket path *inside* the VM, which the
Ryuk reaper container mounts — the host path does not exist there.

## Running the end-to-end suite

`pnpm run test:e2e` builds the web app and drives the built bundle in a real headless
Chrome against a scripted fixture origin, with the transport forced to `poll` — gate
CI-7: every feature must be complete on the T1 tier alone, so the suite asserts that
`/api/v1/stream` is never requested and that no `EventSource` is ever constructed.
Six scenarios cover the boot handshake, the polling cadence and its cursor reads, a
status flip and an arrival and a removal reaching the list, opening a detection from a
row and resolving a merged permalink to its survivor, the staleness banner and the
instant it is stamped with, and the silent flip to the static T2 copy after a streak of
origin failures. Nothing leaves loopback: every off-origin request — the basemap
included — is aborted and recorded, so a run is the same on a plane as in CI.

The same project carries gate **CI-18**, the layout accessibility floors
(`web/e2e/a11y.e2e.ts`): at 320 × 512, at 360 × 640, at 360 × 640 with a 32 px root font
— a doubled browser default, which is WCAG 1.4.4's 200 % — and at 1280 × 800, where the
panel stops being a sheet over the map and becomes a column beside it, every in-scope
surface must reflow without horizontal scrolling, keep every interactive target at
44 × 44 CSS px and uncovered, keep body text at or above the 16 px floor, and clip no
text. Each number is read back from the rendered layout rather than from the stylesheet,
because a floor written in CSS and lost to a cascade is a floor the reader never gets. A
fifth scenario reaches the list by `Tab` alone in a browser with no WebGL. What a headless browser cannot assert —
Android's OS font scale, screen readers, whether the focus order agrees with the visual one
— is the manual protocol in `docs/GATES.md` §1.2.

The browser is not a dependency: `puppeteer-core` ships no binary, and the install is
`--ignore-scripts`. The suite uses the first of an explicit
`FIRE_WATCH_E2E_BROWSER=/path/to/chrome`, the pinned build in the puppeteer cache, any
Chrome or headless shell already in that cache, or a system Chrome. If it finds none it
prints the install command it wants:

```
pnpm --filter @fire-watch/web exec browsers install \
  chrome-headless-shell@<pinned build> --path "$HOME/.cache/puppeteer"
```

`npx vitest run --project e2e` reruns the suite against the existing `web/dist` without
rebuilding — the fast loop while working on a scenario.
