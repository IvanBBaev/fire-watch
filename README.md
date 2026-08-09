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
catalog, and the consolidated gates/risks/plan documents below.

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
| [`docs/decisions/`](docs/decisions/README.md) | Architecture Decision Records 001–005 (index in its README) |
| [`docs/reviews/`](docs/reviews/00-summary.md) | Twelve role reviews (01–12) + `00-summary.md` — the design corpus the ADRs distill |
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
