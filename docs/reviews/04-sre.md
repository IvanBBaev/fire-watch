# Review 04 — SRE / Operations & Reliability

*Reviewer role: senior SRE/DevOps. Date: 2026-07-21. Status: complete.*
*Inputs reviewed: `docs/ANALYSIS.md`, `docs/decisions/001-map-stack.md`. Project is pre-code.*

---

## 1. Summary verdict

**Conditional GO from the operations side.** The proposal is unusually honest for a pre-code
project — "freshness as first-class data", "poll don't stream", flat-cost tiles, and the outbox
pattern are all operationally correct instincts. But the design has a structural inversion and
three real gaps:

1. **The real-time transport is inverted.** The data cadence is 5–10 minutes at best (FIRMS
   poll + FCI full disk), yet the architecture makes live SSE the primary delivery path — the
   single most fragile component on a small VM during exactly the spike the product exists for.
   Edge-cached polling should be the *default* transport; SSE is an enhancement tier.
2. **The managed-Postgres budget assumption is wrong.** Neon's free tier (100 CU-hours/month)
   cannot survive a 24/7 5-minute poller (~180+ CU-hours/month at minimum compute size), and
   Supabase free pauses after 7 days of low activity and caps at 500 MB — one fire season of
   append-only detections blows through that. The €10–30 budget still works, but with
   VM-local PostGIS + disciplined backups, not with the free tiers as written.
3. **Observability and meta-alerting are absent.** The analysis declares freshness a core
   product value but contains no mechanism for *us* to learn the pipeline is dead at 3 AM in
   fire season. For this product, a silently stale map is worse than a down map.
4. **Backup/DR, secrets, and deploy story are unspecified** — expected pre-code, but the watch
   zones and the VAPID push key are irreplaceable the day v1 ships, so the plan must exist
   before v1, not after.

All four are fixable at design time with zero or near-zero budget impact. Concrete designs for
each are in §5. The spike-survival property the ADR correctly demands for tiles must be extended
to *every* read path (style JSON, EFFIS overlays, event data) — the good news is that with a
5–10-minute data cadence, the entire hot read path is cacheable and the product can be made
"spike-proof by construction" on a €7/month footprint.

---

## 2. Strengths (operationally sound as proposed)

- **Honest-freshness UX as a product principle.** `last_observed_at` / "last satellite pass
  HH:MM" rendered explicitly is not just ethics — it is what makes graceful degradation
  *possible*: a stale-but-labeled map is an acceptable degraded state. Keep this non-negotiable.
- **"Poll, don't stream" for ingestion.** Correct. FIRMS for a Balkan bbox at 5-minute cadence
  is 4 requests/5 min against a quota of 5,000/10 min — three orders of magnitude of headroom.
  Etag/dedup polling is trivially restartable and crash-safe; EUMETCast push would add a
  hardware/ops dependency (dish + DVB receiver) for marginal latency gain. Defer it, as planned.
- **Append-only raw detections with reprocessable clustering.** This is the DR posture for the
  domain core: clustering bugs become re-runs, not data loss. Validated.
- **Notification outbox in the domain design.** The single most important reliability pattern
  for the alert engine is already in the diagram. It needs the delivery-side design (§5.7), but
  the foundation is right.
- **PostGIS from day one.** Correct call — `ST_DWithin` geofencing and clustering in SQL beats
  bespoke geo code, and Postgres is the one component with a mature backup ecosystem.
- **ADR-001 tile economics.** Flat-cost/self-hosted tiles is exactly the right spike posture;
  MapLibre + PMTiles-on-R2 is the correct end state. Two amendments below (§3 R-5, §5.2): the
  Phase-2 migration must happen *at* MVP, and the PMTiles serving path has a free-tier trap.
- **Explicit non-goals** (no prediction, no dispatch tooling, no own sensors) keep the
  operational surface small. A solo-operated service survives on a small surface.
- **Realistic latency expectations** (NRT ≈ 3 h, no URT for Europe) prevent the classic failure
  of building infra for a latency the data can't deliver.

---

## 3. Risks & gaps (severity-ranked)

| # | Severity | Risk | Where |
|---|---|---|---|
| R-1 | **High** | SSE-first live updates on a small VM: file-descriptor/proxy/conntrack limits make the live map the first casualty of the spike; no degradation ladder exists in the analysis | ANALYSIS §5 API layer |
| R-2 | **High** | No observability/meta-alerting design: nothing detects a dead poller, a stale FCI feed, or a silently failing alert engine; freshness is a UX field, not a monitored SLI | ANALYSIS §5 |
| R-3 | **High** | Budget math relies on managed-Postgres free tiers that don't fit the workload (Neon compute-hours; Supabase pause + 500 MB cap vs append-only detections) | ANALYSIS §5 decision 3, 5 |
| R-4 | **Medium-High** | No backup/DR plan; irreplaceable data (watch zones, curated incident log, VAPID private key) undefined; no RPO/RTO | absent |
| R-5 | **Medium** | OpenFreeMap public instance (explicitly no SLA) as MVP basemap contradicts the spike thesis: launch traffic *is* spike traffic for this product category; also, PMTiles-via-Worker serving hits Cloudflare Workers free tier's 100k req/day cap mid-spike | ADR-001 Phase 1/2 |
| R-6 | **Medium** | EFFIS WMS consumed directly by browsers (ADR: "plain raster source via bbox template") — client-direct load on a JRC expert service will be rate-limited or break under our spike, and we can't cache or degrade it | ADR-001 |
| R-7 | **Medium** | Mass-alert fan-out vs channel rate limits: Telegram hard-caps at ~30 msg/s (1/s per chat); a 50k-recipient event = ~28 minutes of send time with no prioritization or digesting design | ANALYSIS v1 alerts |
| R-8 | **Medium** | Zero-downtime deploy vs long-lived SSE connections unaddressed; naive restarts during a fire event disconnect every viewer simultaneously (thundering-herd reconnect) | absent |
| R-9 | **Low-Med** | Secrets management unspecified (FIRMS MAP_KEY, EUMETSAT consumer key/secret, VAPID keypair, bot tokens); VAPID key loss = silent loss of the push audience | absent |
| R-10 | **Low** | No abuse/rate-limit posture on the public API; a fire map gets scraped and hotlinked during events | absent |
| R-11 | **Low** | No error-tracking or log-retention plan; no load-test or pre-season readiness ritual | absent |

---

## 4. Detailed recommendations

Each maps to a risk above; full designs in §5.

1. **(R-1) Invert the transport.** Make 30–60 s polling of an edge-cached snapshot the default
   map transport at MVP; ship SSE later as a capped enhancement tier with automatic fallback.
   Rationale: the freshest data changes every 5–10 minutes; a 30 s poll of a CDN-cached JSON is
   *indistinguishable to the user* from SSE and reduces origin load from O(users) to O(1).
   Build the degradation ladder as first-class design (§5.2), not as an incident improvisation.
2. **(R-3) Change the DB plan:** PostGIS in Docker on the VM at MVP, with encrypted nightly
   dumps (plus WAL archiving from v1) to Cloudflare R2. Revisit managed Postgres as the *first
   paid upgrade* when real users store watch zones (§5.4, §5.5). If managed-from-day-one is
   preferred for ops comfort, budget Neon Launch (paid) honestly — not the free tier.
3. **(R-2) Build observability before features:** the metric set, three dashboards, and the
   three-legged meta-alerting design in §5.3 (Grafana Cloud free + healthchecks.io free +
   UptimeRobot free — three *independent* failure-detection paths). The
   `/api/health/freshness` endpoint that returns 5xx when any source exceeds its staleness
   budget is the single highest-leverage 20 lines of code in the project: it turns a dumb
   external uptime probe into a data-freshness pager.
4. **(R-4) Adopt the backup/DR plan in §5.5:** RPO 24 h at MVP (no user data exists yet),
   tightening to ≤ 15 min at v1; RTO 2–4 h via scripted VM rebuild; quarterly restore drill.
5. **(R-5) Pull ADR-001 Phase 2 forward to MVP.** Self-hosting a Balkans PMTiles extract on R2
   is a weekend of work and removes the only unbounded third-party availability risk before the
   first user arrives. Serve it via exploded static `z/x/y` tiles on R2 (pure CDN-cacheable
   objects, no Worker in the request path) *or* accept Workers Paid ($5/mo) during fire season —
   the Workers **free** tier's 100,000 req/day cap is ~1,000 map sessions/day and will be
   exhausted in the first hour of a real spike.
6. **(R-6) Proxy and cache EFFIS WMS at our edge.** Browsers request
   `/overlays/effis/{layer}/{z}/{x}/{y}` from us; a Cloudflare cache rule holds tiles for
   10–15 min (danger forecast changes daily; burnt areas ~daily). This cuts JRC-bound traffic
   by ~99%, survives EFFIS downtime with stale tiles, and keeps attribution/ToS under our
   control. Never let a third-party expert service see our consumer traffic curve.
7. **(R-7) Design notification delivery as a queue with per-channel token buckets, priority,
   and digesting** (§5.7). Key rule: at most one notification per user per fire event per
   cooldown window; push first, Telegram second, email last; TTL on everything.
8. **(R-8) Deploy = drain, not drop** (§5.6): SIGTERM handler closes SSE with `retry:` hints,
   clients resume via `Last-Event-ID`; polling-tier users never notice deploys at all (another
   argument for recommendation 1).
9. **(R-9) Secrets inventory + handling in §5.6.** Treat the VAPID private key as tier-0
   (offline backup); everything else is rotatable and lives in GitHub Environments → root-owned
   env file on the VM.
10. **(R-10)** One Cloudflare rate-limiting rule (free tier includes one) on `/api/*`; strict
    CORS; cache headers that make hotlinking the snapshot harmless (it's cached anyway — decide
    deliberately that the embed/hotlink is *free marketing* and version its URL).
11. **(R-11)** Sentry free tier (or GlitchTip later) for error tracking from the first commit;
    Docker log rotation caps; the pre-season "fire drill" checklist (§5.4) as a calendar ritual
    every April.

---

## 5. SRE deep dive

### 5.1 Deployment topology

#### Options considered

| Option | Est. cost/mo | Spike behavior | Ops burden | Verdict |
|---|---|---|---|---|
| **Hetzner VM (CX22/CAX11 class, 2 vCPU / 4 GB) + VM-local PostGIS, Cloudflare in front** | ~€5–8 (post-June-2026 price adjustment; verify current) + €0.60 IPv4; 20 TB traffic incl. | Flat cost; origin shielded by CDN; vertical resize in minutes | Moderate (you own the box) but small surface | **Recommended** |
| Hetzner VM + Neon (managed PG) | VM + €0 free tier — **but free tier doesn't fit**: 5-min poller keeps compute awake 24/7 → ~180 CU-h/mo at the 0.25 CU minimum vs 100 CU-h free; 0.5 GB storage vs seasons of append-only detections; realistic = Launch paid plan | Good | Lower DB ops | Right shape, wrong tier; **revisit as first paid upgrade** (§5.4) |
| Hetzner VM + Supabase free | €5–8 | 500 MB cap; free projects pause after 7 days of low activity (won't trigger with a poller, but the cap + shared infra will) | Low | No — cap kills it within one season |
| Fly.io (2 machines + Fly Postgres) | ~$10–25 realistic (no free tier since 2024; egress billed) | Fine; anycast is nice | Low-moderate; Fly Postgres is *unmanaged* (you still own backups/failover) | Workable but 2–3× the cost for less headroom; no ops win on the DB side |
| Serverless (Workers/Lambda + managed PG) | Unpredictable | Cost scales with the spike — violates the project's own requirement 1; long-lived SSE and cron-heavy ingestion fight the model; PostGIS unavailable in serverless DBs' cheapest tiers | Low | No — the spike-cost profile is exactly what ADR-001 rejects for maps |

#### Recommended topology

```
                     users (spike: 10^5)
                          │
              ┌───────────▼────────────┐
              │  Cloudflare (free)     │  DNS, TLS, CDN cache, WAF, 1 rate-limit rule
              │  cache rules:          │
              │   tiles/style  1y      │
              │   /snapshot    30s     │
              │   /overlays    10min   │
              └─────┬────────────┬─────┘
                    │            │ (origin pull, cache miss only)
        ┌───────────▼──┐   ┌─────▼──────────────────────────────┐
        │ Cloudflare R2│   │ Hetzner VM  (CX22/CAX11, Falkenst.)│
        │  - PMTiles / │   │  Docker Compose:                   │
        │    tile tree │   │   caddy/nginx ── api  (Fastify,    │
        │  - snapshot  │◄──┼─────────────┐       SSE+REST)      │
        │    .json     │ every 60s push  │       worker (pollers,│
        │  - style,    │   │             │       clustering,     │
        │    glyphs    │   │             │       alert dispatch, │
        │  - backups   │   │             │       snapshot push)  │
        └──────────────┘   │   postgres:16-postgis (local vol)  │
                           │   alloy (→ Grafana Cloud free)     │
                           └────────────────────────────────────┘
External SaaS (all free tier): Grafana Cloud, healthchecks.io, UptimeRobot, Sentry, GitHub Actions/GHCR
```

**Decisions and reasoning:**

- **Docker Compose over bare systemd.** One `compose.yaml` is the deployable artifact: the same
  images CI built and tested are what runs in prod; Postgres+PostGIS, Caddy, and Grafana Alloy
  arrive as pinned images instead of apt archaeology; rollback is `docker compose up` with the
  previous tag. Bare systemd saves ~100 MB RAM and one layer — not worth losing image-identical
  deploys. (Do use systemd for exactly one thing: a unit that runs `docker compose up -d` on
  boot, plus host-level `LimitNOFILE` — §5.2.)
- **Jobs run in a separate `worker` process, same image, different entrypoint** — *not* inside
  the API process and *not* in system cron:
  - The event loop serving thousands of SSE/HTTP responses must never share a process with
    netCDF decoding (FCI), DBSCAN clustering, or a burst of notification sends.
  - Scheduling lives *in* the worker (e.g. `croner`), so every job success can ping
    healthchecks.io from job code and export metrics — system cron is invisible to the app.
  - Worker → API signaling via Postgres `LISTEN/NOTIFY` (new event ⇒ API fans out to SSE
    clients); worker holds a Postgres advisory lock so a second worker instance is safe-by-
    accident during deploys.
  - Failure isolation both ways: API redeploy doesn't stop ingestion; a poisoned granule
    crash-looping the worker doesn't take the map down.
- **Region:** Hetzner Falkenstein/Nuremberg. ~25–35 ms RTT to Sofia, and (relevant later) close
  to a Neon/managed-PG region (Frankfurt) if the DB moves out.
- **Keep the IPv4 address** (~€0.60/mo): GitHub-hosted Actions runners have no IPv6, so an
  IPv6-only origin breaks the SSH deploy path (workaround is a tunnel/Tailscale — not worth it
  at MVP).
- **What this costs:** see Appendix A — ~€7–9/mo baseline, ~€15–20 in-season with every
  optional paid knob turned on. Comfortably inside €10–30.

### 5.2 Spike survival plan

Design premise: **Watch Duty added 600k users overnight.** Assume a 500× traffic multiple can
arrive in hours, during the worst fire of the year, while you are asleep. The plan is: make the
read path origin-independent, cap the stateful path, and pre-build the ladder down.

#### 5.2.1 What is static-cacheable (answer: almost everything)

| Asset | Origin | Edge TTL | Notes |
|---|---|---|---|
| Basemap tiles | R2 (Balkans extract) | 1 y, immutable, content-hashed path | See PMTiles serving note below |
| Style JSON, sprites, glyphs | R2 | 1 y, hashed | Style swap = new hash |
| Terrain/hillshade tiles | AWS Terrarium (open data) → proxy+cache at our edge | 30 d | Don't send users direct in volume; be a good citizen |
| EFFIS overlays (danger, burnt area) | our `/overlays/effis/…` WMS proxy | 10–15 min | R-6; serve stale on upstream error |
| **Live fire events snapshot** `/snapshot.json` | worker pushes to R2 every 60 s; also served by API | 30 s edge TTL | The heart of the ladder; carries `generated_at` |
| Event detail `/api/events/:id` | API | 30–60 s | Cacheable — details change on the same 5-min cadence |
| App shell (PWA) | Cloudflare Pages or R2 | standard | Free, effectively infinite scale |
| SSE `/api/stream` | API only | bypass | The only truly dynamic endpoint — and it's optional |

With those rules, a 100k-concurrent spike polling every 30–60 s produces **~1–3 requests/s at
origin** (cache-miss refills only). That is the whole trick: origin load is a function of the
TTL, not of the audience.

**PMTiles serving trap (amends ADR-001):** the elegant single-file PMTiles on R2 needs range
requests resolved by the Protomaps Cloudflare Worker. Workers **free** tier = 100k requests/day
— roughly 1,000 map sessions (a session easily pulls 50–150 tiles). A spike day is 10⁶–10⁷ tile
requests. Either (a) enable Workers Paid — $5/mo flat + $0.30/million past 10M, still flat-ish
and fine — or (b) explode the extract into a static `z/x/y` tile tree on R2 (tippecanoe/pmtiles
extract; a Bulgaria+buffer pyramid to z14 is a few GB, inside R2's 10 GB free), which makes every
tile a plain cacheable object with **no compute in the path**. Option (b) is the most
spike-proof and is the recommended MVP configuration; keep the `.pmtiles` file as the build
artifact either way.

#### 5.2.2 The SSE connection-count problem — real numbers

What actually breaks, in order, on a default Ubuntu box at ~1–50k concurrent SSE connections:

1. **Process file descriptors.** Default soft limit **1024** → Node starts failing `accept()` at
   ~1,000 viewers. Fix: `LimitNOFILE=131072` in the systemd unit / `ulimits` in compose
   (`nofile: 131072`). Kernel `fs.nr_open` default 1,048,576 — fine.
2. **Reverse-proxy limits.** nginx on Debian/Ubuntu defaults to `worker_connections 768`, and a
   proxied connection consumes **2** FDs (client + upstream) → hard cap ≈ 380 concurrent
   streams. Fix: `worker_rlimit_nofile 131072; events { worker_connections 32768; }` and for
   the SSE location: `proxy_buffering off; proxy_read_timeout 1h; gzip off;` (or send
   `X-Accel-Buffering: no` from the app). Caddy needs no FD config beyond the process limit but
   the same buffering awareness.
3. **Connection tracking.** With Cloudflare proxying, every viewer is a distinct long-lived
   origin connection; netfilter conntrack default `nf_conntrack_max` (commonly 65,536, RAM-
   scaled) fills up and the kernel **silently drops new SYNs** (`table full, dropping packet` in
   dmesg — a classic 3 AM mystery). Fix: `net.netfilter.nf_conntrack_max = 262144` (~80 MB) —
   or skip nftables state for the web ports entirely.
4. **Memory.** Idle SSE ≈ 8–16 KB kernel buffers + ~10–20 KB Node userspace ⇒ 10k conns ≈
   ~300 MB, 50k ≈ 1.5+ GB — colliding with Postgres on a 4 GB box.
5. **Cloudflare idle timeout.** CF terminates a proxied response with **error 524 after 100 s
   without bytes** (configurable only on Enterprise). SSE must send a comment frame (`:ka\n\n`)
   every **25–30 s** — which doubles as dead-connection detection.

**Conclusion:** a tuned 4 GB VM can *hold* ~10–20k SSE connections, but it shouldn't have to.
Enforce an application-level cap: an atomic counter, **max 5,000 concurrent SSE at MVP**
(revisit after a load test); above the cap, `/api/stream` returns `503 + Retry-After: 60` and
the client falls back to polling — which, per §5.2.1, costs the origin nothing.

#### 5.2.3 Graceful degradation ladder

| Tier | Transport | Freshness | Who gets it | Origin cost |
|---|---|---|---|---|
| **T0** | SSE push | seconds after processing | Opt-in / capped at 5k conns (post-MVP feature) | O(connections) |
| **T1 (default)** | Poll `/snapshot.json`, 30–60 s, edge-cached | ≤ TTL + processing | Everyone, by default, at MVP | **O(1)** — cache refills only |
| **T2** | Static snapshot from **R2** (last file the worker pushed) | last successful push, honestly timestamped | Everyone, automatically, when origin is down | **Zero** — origin not involved |

- **T1→T0 upgrade** is a client feature, not a default: the client asks `/api/client-config`
  (edge-cached 30 s) whether SSE is currently offered.
- **T0→T1 demotion (automatic):** server flips `client-config` to `transport: "poll"` when any
  of: SSE count > cap; event-loop lag p99 > 200 ms for 5 min; CPU > 80% for 5 min. Existing
  streams get an `event: degrade` frame and close; `EventSource`'s native auto-reconnect hits
  the 503 and the client's error handler switches to polling. Hysteresis: only re-offer SSE
  after 30 min below thresholds.
- **T1→T2 (automatic, client-side):** if `/snapshot.json` fails or is stale (client compares
  `generated_at` against wall clock), the frontend fetches the R2-hosted copy directly (a
  second hostname baked into the app shell) and renders the staleness banner. **Total origin
  loss degrades the product to "map with last-known data, honestly labeled" — which is exactly
  the honest-freshness promise.** This tier costs nothing and must be built at MVP.
- The UI staleness banner is driven by `generated_at` in the payload at every tier — one
  mechanism, three tiers.

#### 5.2.4 Spike checklist (condensed runbook RB-4)

1. Confirm auto-demotion to T1 happened (Grafana: SSE count, `client-config` state).
2. Cloudflare analytics: cache hit ratio on `/snapshot.json` and tiles ≥ 95% — if not, a cache
   rule regressed; fix that before touching the VM.
3. `conntrack -C` vs max; dmesg for drops; `ss -s` for socket totals.
4. Freeze deploys. Resize VM one step (CX22→CX32) **only** if CPU-bound after demotion —
   resize is a ~1–2 min reboot; T2 covers the gap.
5. Notification queue age p95 < 10 min? If not: push only, defer email (§5.7).
6. Post a status-page note; verify upstream (FIRMS/EFFIS get slow during megafires too — our
   caches and staleness UX are the shield).

### 5.3 Observability

Principle: **the #1 SLI is data freshness per source.** The map being up while showing 9-hour-old
hotspots without saying so is the worst failure mode this product has — it is the one that costs
trust, and trust is the stated moat.

#### 5.3.1 Metric set (Prometheus naming; Grafana Cloud free = 10k series budget — this is <500)

**Pipeline / freshness (the ones that page):**

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `fw_source_last_success_timestamp_seconds` | gauge | `source` (firms_viirs_snpp, firms_viirs_n20/n21, firms_modis, fci_fir, effis_wms, open_meteo) | Unix time of last successful fetch — **the** freshness SLI; alert on `time() - x` |
| `fw_source_fetch_total` | counter | `source, outcome` (ok/http_4xx/http_5xx/timeout/parse_error) | Poll outcomes |
| `fw_source_records_fetched_total` | counter | `source` | Zero-records-for-N-polls during fire season is its own smell |
| `fw_ingest_to_visible_seconds` | histogram | `source` | Our pipeline latency: fetch → row visible in snapshot (SLO ≤ 10 min) |
| `fw_e2e_detection_latency_seconds` | histogram | `source` | acq_time → visible; includes NASA's ~3 h NRT lag — feeds the honesty UX and validates the FCI business case with real numbers |
| `fw_cluster_run_seconds` / `fw_cluster_events_active` | histogram / gauge | — | Clustering health; active-event count is also a great public stat |
| `fw_job_last_success_timestamp_seconds` | gauge | `job` (snapshot_push, backup, tile_refresh…) | Every scheduled job, one gauge |

**Serving:**

- `http_request_duration_seconds` (histogram; `route`, `code` — keep `route` templated, never raw paths: cardinality)
- `fw_sse_connections` (gauge), `fw_sse_rejected_total` (counter) — the cap in action
- `fw_degradation_tier` (gauge: 0/1/2) — current offered tier
- `nodejs_eventloop_lag_seconds`, heap, GC (default `prom-client` set), per process (`api`/`worker`)
- `pg_pool_*` (in-use/waiting), plus node_exporter/Alloy host metrics (CPU, mem, **disk %**, conntrack usage)

**Notifications (§5.7):**

- `fw_notification_enqueued_total` / `fw_notification_sent_total` / `fw_notification_failed_total` — labels `channel` (webpush/telegram/email), `reason` (410_gone, 429, timeout…)
- `fw_notification_queue_depth` (gauge), `fw_notification_queue_oldest_seconds` (gauge — pages)
- `fw_notification_dispatch_latency_seconds` (histogram: event visible → handed to provider)

Ship via Grafana **Alloy** on the VM scraping both processes → Grafana Cloud free (10k series,
50 GB logs, 14-day retention, 3 users). Send *logs* too (compose json-file → Alloy → Loki):
50 GB/month is ample at this scale if logs are structured and boring.

#### 5.3.2 Dashboards (three, no more)

1. **Data pipeline:** per-source freshness (stat tiles: "FIRMS VIIRS: 4m ago"), fetch outcome
   rates, e2e latency histogram, active events, job table. This is the dashboard that's open on
   a second monitor all July.
2. **Serving:** RED per route, SSE gauge vs cap, degradation tier, event-loop lag, host CPU/mem/
   disk/conntrack, CF cache-hit ratio (via Cloudflare's free Grafana data source or GraphQL API).
3. **Notifications:** queue depth/age, per-channel send & failure rates, dispatch latency,
   subscription churn (410-prune rate).

#### 5.3.3 Alerting — and meta-alerting ("who tells US it's dead at 3 AM")

Three **independent legs**, all free tier, so no single vendor (including ourselves) is a single
point of failure for knowing:

| Leg | Watches | Mechanism | Detects even if… |
|---|---|---|---|
| **Grafana Cloud alerting** | metric rules below | Alloy pushes metrics out; rules evaluate in *their* cloud; notify → Telegram + email | our VM is up but the app is sick |
| **healthchecks.io** (free: 20 checks) | every scheduled job: `firms_poll` (period 5 m, grace 10 m), `fci_fetch` (10 m/30 m), `effis_refresh` (daily), `snapshot_push` (1 m/5 m), `backup` (daily/6 h), `worklog… no — deploy smoke` | jobs ping **after success** from job code; missing ping ⇒ email+Telegram | our VM/worker is entirely dead, Alloy included; also catches "cron ran but failed" |
| **UptimeRobot** (free: 50 monitors, 5-min) | `/healthz`; **`/api/health/freshness`** (returns **500 when any source exceeds its staleness budget** — external probe becomes a freshness pager); homepage; the R2 snapshot URL; TLS expiry | external HTTP probes from their infra | Cloudflare/DNS/origin problems invisible from inside |

Freshness budgets for `/api/health/freshness` (also the Grafana rules):

| Source | Warn | Critical (page) |
|---|---|---|
| FIRMS (any VIIRS/MODIS combined) | > 20 min since successful poll | > 45 min |
| FCI FIR (once live) | > 30 min since last granule | > 60 min |
| EFFIS layers | > 26 h | > 50 h |
| Snapshot push to R2 | > 5 min | > 15 min |
| Backup | > 26 h | > 50 h |

Additional Grafana rules: disk > 80%; `fw_notification_queue_oldest_seconds` > 600;
`fw_degradation_tier` == 2 for > 5 min; SSE rejects sustained; cert/domain via UptimeRobot.

**The 3 AM path (solo operator):** all critical alerts land in a dedicated Telegram
"fw-alerts" chat; on the phone, that chat gets a custom loud notification sound and an OS-level
Do-Not-Disturb exception. That is genuinely enough for one person at MVP. **Season mode
(June–September):** add a voice-call escalation — a tiny Cloudflare Worker webhook target that
triggers a Twilio voice call (~€1.2/mo number + ~€0.014/min) when a *critical* Grafana alert
fires and stays unacked 10 min. Budget: €2/mo, only 4 months a year. Write the alert→ack flow
down; "I saw it and went back to sleep" must be a deliberate act, not a default.

**Status page:** UptimeRobot's free public status page at MVP (zero work); upgrade to a static
self-hosted page on R2 when branding matters. Link it from the app's error states.

### 5.4 Availability targets & the upgrade path

Honesty first: **a €30/mo single-VM system cannot promise fire-season heroics on the write
path — so architect the read path to not need the VM.** That's the actual SLO strategy.

| SLO | Target | Error budget/month | How it's achievable |
|---|---|---|---|
| **Map read path** (tiles, style, snapshot, overlays — via CDN/R2) | **99.9%** | 43 min | Origin-independent by construction (T2); measured by UptimeRobot on the R2 snapshot URL |
| **API** (interactive: detail panels, auth, zones) | **99.5%** | 3 h 39 m | Single VM + CF; deploys drain, not drop |
| **Freshness** (FIRMS data visible ≤ 10 min after we could have fetched it) | 99% of intervals | ~7 h | Poller redundancy is upstream's job; ours is restart-fast + alert-fast |
| **Alert dispatch** (event visible → handed to push/TG provider) | p95 ≤ 60 s; p99 ≤ 5 min | — | Outbox + dedicated worker; §5.7 |

- Declare these **internal SLOs**, not customer SLAs, until the B2B tier (v2) — then sell SLAs
  only on the API/webhook surface, backed by real history from Grafana.
- **Error-budget policy (solo-dev version):** burning > 50% of any budget in one incident ⇒
  written post-mortem and a one-week feature freeze spent on the reliability item it exposed.
  Cheap, and it prevents trust-rot.
- **What fire season demands vs what €30 buys:** fire season demands that *reading the map and
  receiving alerts* never depend on one VM being healthy. T2 + outbox give exactly that. It
  does *not* demand five-nines on the login page. Resist upgrading the wrong thing.

**First paid upgrades, with triggers (in order):**

| Trigger | Upgrade | Cost |
|---|---|---|
| v1 ships (real users store watch zones) | WAL archiving (wal-g → R2, RPO ≤ 15 min) — free — **or** move DB to managed Postgres (Neon Launch tier) if ops time is the scarcer resource | €0 / ~€18 |
| Fire-season entry (every June) | Workers Paid for tile margin (if PMTiles-Worker path chosen) + Twilio voice escalation | ~€7/mo, seasonal |
| Sustained CPU > 70% for 1 h at T1, or event-loop lag p99 > 200 ms weekly | VM resize CX22→CX32 class (2→4 vCPU, 8 GB) | +€5–8 |
| > 5k concurrent SSE demanded as a *product* need | Split: `api` VM + `worker+db` VM (compose already separates them; move one service) | +€5–8 |
| First paying B2B customer with SLA | Managed PG (if not already) + staging VM + on-call formalization | +€25–40 |

Note the deliberate absence of Kubernetes, load balancers, and multi-region from this table.

### 5.5 Backup & DR

#### Data criticality tiers

| Tier | Data | Replaceable? | Protection |
|---|---|---|---|
| **0 — irreplaceable** | users, watch zones, push subscriptions, notification audit log, **curated incident log** (human editorial work), VAPID private key | No | From v1: WAL archiving or managed-PG PITR; plus hourly logical dump of just these tables (they're tiny — KBs to MBs); VAPID key in password manager + offline copy |
| **1 — expensive to lose** | fire events + event↔detection links (recomputable from detections, but event IDs churn — breaking alert history and shared URLs) | Partly | Nightly dump; treat event IDs as durable once alerts reference them |
| **2 — re-fetchable** | raw detections (FIRMS archive API backfills), EFFIS layers, weather cache | Yes (FIRMS `_SP` standard products cover history) | Nightly dump is a convenience, not a requirement; document the backfill script |

#### Cadence & mechanics

- **MVP (no users yet):** nightly `pg_dump -Fc`, encrypted with `age`, pushed to **R2** via
  rclone (bucket versioning on; retain 14 daily + 8 weekly). RPO 24 h — acceptable because
  tier-0 data doesn't exist yet and tier-2 is re-fetchable. The backup job pings
  healthchecks.io *after* upload; the check's grace makes silence an alert.
- **v1 (users exist):** add continuous WAL archiving (wal-g: weekly full base backup + WAL to
  R2) → **RPO ≤ 15 min, PITR** — still ~€0 at this size. This is the moment to re-evaluate
  managed PG (Neon paid: PITR built-in, restores are branch-clones — genuinely good DR UX).
- **Restore drill quarterly** (and in the April fire drill): restore latest backup into a
  scratch container, run a row-count/consistency script, time it, write the number down. An
  untested backup is a rumor.
- **GDPR note:** backups contain home locations (watch zones) — hence `age` encryption at rest
  in R2, EU jurisdiction bucket, retention limited to the schedule above, and the deletion
  policy documented ("erasure requests are effective immediately in the live DB and age out of
  backups within 60 days").

#### Runbook sketches (to live in `docs/runbooks/`)

- **RB-1 Pipeline stale** (freshness alert): check `/api/health/freshness` → which source;
  healthchecks.io — did the job run at all?; `docker compose logs worker --since 30m`;
  distinguish upstream outage (FIRMS/EUMETSAT status pages, their 5xx in our metrics) from our
  bug. Upstream ⇒ verify the staleness banner is showing, note on status page, stop (the UX is
  the mitigation). Ours ⇒ restart worker; crash-loop ⇒ roll back image tag (§5.6); file
  incident note.
- **RB-2 VM loss** (RTO target **2–4 h**): create VM from `infra/cloud-init.yaml` (kept in
  repo: docker, sysctl, limits, alloy — the *entire* host config must be code from day one);
  restore secrets env from password manager; `docker compose up -d` (images pull from GHCR);
  RB-3 for data; flip the origin IP in Cloudflare (proxied = instant); verify all three
  monitoring legs green. **Meanwhile users still see the T2 snapshot + tiles from R2 — the
  outage is a read-only, honestly-labeled map, not a dead site.**
- **RB-3 DB restore:** wal-g restore to point-in-time (or `age -d dump | pg_restore` at MVP);
  sanity script (row counts vs last metrics); if compromise suspected, rotate DB password +
  all tier-1 secrets.
- **RB-4 Spike:** §5.2.4.

### 5.6 Secrets, CI/CD, zero-downtime deploys

#### Secrets inventory

| Secret | Blast radius | Rotatable? | Notes |
|---|---|---|---|
| **VAPID private key** | lose it ⇒ every push subscription dies silently (re-subscribe only on next site visit) | **Effectively no** | Tier-0: password manager + offline copy; never in repo/image |
| EUMETSAT consumer key/secret | FCI feed stops | Yes (portal) | Exchange for short-lived (~1 h) tokens at runtime; store only key/secret |
| FIRMS MAP_KEY | polling stops (also: abuse could get it throttled) | Yes | Low sensitivity but treat as secret anyway |
| Telegram bot token | attacker can impersonate the bot to users | Yes (BotFather) | Higher sensitivity than it looks — it can *send* |
| SES/SMTP credentials | spam from our domain ⇒ reputation loss | Yes | Scope IAM to ses:SendEmail only |
| R2 access keys (backups, snapshot push) | backups/snapshot tampering | Yes | Two tokens: write-only for backup path, RW for snapshot |
| Deploy SSH key / GHCR token | code exec on VM | Yes | Deploy-only user; GH environment-scoped |
| DB password | local-only exposure | Yes | Not reachable off-VM (no public PG port) |

**Handling (right-sized — no Vault):** canonical store = GitHub **Environments** (`production`)
secrets; deploy renders them to `/etc/fire-watch/secrets.env`, `root:root`, `0600`, referenced
by compose `env_file`. Local human copy lives in the password manager. Optional upgrade:
SOPS+age-encrypted env file *in* the repo (auditable changes) with the age key as the only GH
secret. Never bake secrets into images; never log them (Fastify redaction list from day one).
Write a one-line rotation procedure per row above in the runbook.

#### CI/CD (GitHub Actions; private repo free tier = 2,000 min/mo — ample)

```
ci.yml   (every push/PR): typecheck → lint → unit tests → build → docker build (no push)
deploy.yml (push to main, or tag):
  1. reuse CI, then docker build+push → ghcr.io/…/fire-watch:{git-sha} (+ :latest)
  2. environment: production (secrets gated here)
  3. ssh deploy@vm "cd /srv/fire-watch && ./deploy.sh {git-sha}"
     deploy.sh: write .env image tag → docker compose pull
                → compose up -d worker   (workers drain via advisory lock)
                → compose up -d api      (see drain story below)
                → smoke: curl /healthz + /api/health/freshness (loop 30s)
                → on failure: redeploy previous tag (kept in /srv/fire-watch/last_good)
  4. post-deploy: ping healthchecks.io "deploy" check; annotate Grafana
```

Rollback = `./deploy.sh <previous-sha>` — image-tag deploys make this one command. DB
migrations: forward-only, expand/contract pattern (never a migration the previous image can't
run against), applied by the worker on boot behind the advisory lock.

#### Zero-downtime and the SSE problem

- **Polling-tier users (the default, per §5.2) never notice a deploy at all** — `/snapshot.json`
  is served from the edge cache and R2 during the restart window. This is the main reason the
  transport inversion (rec. 1) also solves the deploy problem.
- **SSE drain:** on SIGTERM the API (a) stops accepting new streams (503 → clients fall to
  polling), (b) sends each open stream `retry: 15000` + a final `event: reconnect`, (c) closes
  and exits within a 10 s grace (compose `stop_grace_period: 15s`). Clients resume via
  `EventSource` auto-reconnect with `Last-Event-ID`; the API replays events since that ID from
  the DB (IDs are monotonic event timestamps). Result: a deploy is a ≤ 15 s gap on the luxury
  tier and invisible on the default tier — true blue-green (two API containers + proxy flip) is
  not warranted at this scale; document it as the future path if SSE ever becomes contractual.
- **Deploy freeze rule:** no deploys while `fw_degradation_tier > 0` or during an active
  major-fire event, except hotfixes for the incident itself.

### 5.7 Notification delivery reliability (the mass-alert event)

Scenario to design for: a fast-moving fire (or a nationwide smoke day) triggers thousands of
watch zones within one clustering cycle. Everyone must be told once, quickly, in priority
order — without tripping provider limits or spamming anyone.

#### Channel realities (verified July 2026)

| Channel | Limit | Failure modes | Cost |
|---|---|---|---|
| **Web Push** (FCM endpoints for Chrome, Mozilla autopush, Apple) | No practical sender-side cap at our volumes; a single Node sender over HTTP/2 sustains ~200–500 push/s | `404/410 Gone` ⇒ prune subscription immediately; `429` per push-service host ⇒ backoff that host, not the queue | Free |
| **Telegram bot** | **~30 msg/s** overall; 1 msg/s per chat; 20 msg/min per group; `429` returns `retry_after` — honor it exactly | Flood-wait if ignored; (paid 1000/s tier requires 100k Stars balance + 100k MAU — not our reality) | Free |
| **Email (Amazon SES eu-central-1)** | default production quota historically ~14 msg/s / 50k day — **request an increase before June**, it takes days not minutes | Bounces/complaints tank domain reputation | ~$0.10/1k |

#### Design

- **Outbox → dispatcher with per-channel token buckets** (webpush 300/s, telegram 25/s —
  under the 30 to leave interactive-bot headroom — email 12/s). The outbox row is written in
  the same transaction as the alert decision (already in the architecture — good); the
  dispatcher is at-least-once with idempotency keys (`user, event, escalation_level`), so
  retries never double-send.
- **Priority queue, not FIFO:** order by (zone distance to fire asc, zone sensitivity, channel
  speed). The person 2 km from the flame front gets slot #1; the smoke-advisory recipient 200 km
  away can wait 20 minutes without harm.
- **Digest & cooldown:** at most **one notification per user per fire event per 30 min**
  (first detection immediate; subsequent detections update a digest: "Fire near Karlovo — 6 new
  detections, moving NE"). This collapses the worst-case volume by an order of magnitude and is
  also the anti-panic UX the analysis's legal section wants.
- **TTL everywhere:** web push `TTL: 1800, Urgency: high` (a fire alert delivered 4 h late is
  noise); Telegram/email entries expire from the queue after 6 h and are dropped with a metric,
  not sent stale.
- **Worked example:** 20k users, megafire triggers 3k users (push 3k ≈ 10–15 s; Telegram-linked
  40% = 1.2k ≈ 50 s; email 3k ≈ 3.5 min at default SES quota). Nationwide smoke day, 30k
  digest recipients: push ≈ 2 min, Telegram 12k ≈ 8 min, email 30k ≈ 36 min at default quota
  (≈ 5 min after a quota raise to 100/s) — all acceptable *given priority ordering*, which is
  the piece that must exist in the schema from day one.
- **Failure handling:** per-channel circuit breaker (Telegram down ⇒ push/email continue);
  `fw_notification_queue_oldest_seconds` pages at 10 min; prune `410` push subscriptions on
  sight and surface "your alerts stopped working" in-app on next visit.
- **Deliverability hygiene (email):** send from a dedicated subdomain (`alerts.firewatch.…`)
  with SPF/DKIM/DMARC from the first message; alerts only — never marketing — on that domain.
- **Never promise delivery in marketing copy.** The analysis's liability section already says
  "not a life-safety system"; the notification SLO is *dispatch* p95 ≤ 60 s (§5.4) — delivery
  beyond the provider handoff is explicitly best-effort, and the docs/ToS must say so.

---

## 6. Open questions for the team

1. **FCI delivery path:** Data Store REST polling (simple, minutes-scale lag, quota-bound) vs
   EUMETCast (satellite dish + DVB hardware — a physical ops dependency at someone's house?).
   The review assumes Data Store polling; confirm before v1 planning, and confirm LSA SAF
   redistribution/caching terms for our derived layer.
2. **Who is on call?** Solo founder = single human point of failure exactly when fires peak
   (August vacation…). Is there a second person who can at least execute RB-1/RB-4 from the
   runbook? If not, does "season mode" include a no-solo-travel rule?
3. **SSE as a product requirement:** given the 5–10 min data cadence, does anyone actually need
   sub-30 s push on the *map* (as opposed to notifications)? If not, T0 can be deferred
   indefinitely and the architecture simplifies further. Recommend deciding this explicitly in
   an ADR-002 (transport), referencing §5.2.
4. **EFFIS/JRC terms for proxy-caching** their WMS output and re-serving it (attribution is
   clearly fine; systematic caching should be verified against their ToS, same as the noted
   EUMETSAT re-verification).
5. **Cloudflare dependency concentration:** DNS + CDN + R2 + (maybe) Workers in one vendor. At
   this budget it's the right trade, but decide the stance now: acceptable until B2B SLAs, then
   revisit (R2 → B2/S3 mirror is a day of work).
6. **Detection retention policy:** append-only forever, or archive raw detections older than
   N seasons to R2 parquet? (Affects the VM-disk trajectory and the GDPR-adjacent story is
   clean — detections aren't personal data.) Propose: keep 2 seasons hot, archive the rest.
7. **Staging:** none is proposed (correct at this budget). Confirm the team accepts
   "compose profile on the laptop + smoke tests on prod deploy" until the first paying customer.
8. **BG-ALERT / ГДПБЗН interplay:** is there any official-notification scenario in which our
   alerts must be suppressed or reworded (e.g., during an active evacuation)? Legal said
   "panic-minimization review" — operations needs the *mechanism* (a manual per-event
   "official-guidance override" flag in the curated incident log).

---

## Appendix A — Monthly cost model (EUR, July 2026 prices)

| Item | Baseline | Fire season |
|---|---|---|
| Hetzner CX22/CAX11-class VM (2 vCPU/4 GB) | 4.50–7.00 | same (resize burst: +5–8 prorated) |
| IPv4 address | 0.60 | 0.60 |
| Cloudflare free (DNS/CDN/WAF/1 rate rule) | 0 | 0 |
| R2 (tiles, snapshot, backups — within 10 GB/1M A/10M B free ops) | 0 | 0–2 |
| Workers Paid (only if PMTiles-Worker serving path chosen) | 0 | 5 |
| Grafana Cloud / healthchecks.io / UptimeRobot / Sentry (free tiers) | 0 | 0 |
| Amazon SES (alert email) | 0–1 | 1–3 |
| Twilio voice escalation (number + calls, June–Sept) | 0 | ~2 |
| Domain (amortized) | 1 | 1 |
| **Total** | **≈ 6–10** | **≈ 9–21** |

Within the €10–30 envelope with headroom; the first item that *should* break the envelope is
managed Postgres at v1 (~€18), and that is a deliberate, trigger-based decision (§5.4), not drift.

## Appendix B — Pre-season "fire drill" checklist (every April/May)

1. Restore latest DB backup to scratch; verify; record restore time.
2. k6 load test (Grafana Cloud free 500 VUh): 5k VUs polling `/snapshot.json` + 1k SSE; confirm
   T0→T1 auto-demotion fires and edge hit-ratio ≥ 95%.
3. Chaos: `docker kill` the worker mid-cycle → confirm healthchecks pages within grace; kill the
   API → confirm T2 (R2 snapshot) serves and UptimeRobot pages.
4. Quotas & keys: SES sending quota raised; FIRMS MAP_KEY valid; EUMETSAT key/secret exchange
   works; Telegram bot token alive; VAPID offline backup verified present.
5. Refresh basemap extract (new OSM cut) and EFFIS layer list.
6. Test the 3 AM path literally: fire a synthetic critical alert at night; confirm the phone
   wakes you; season-mode Twilio call path returns 200.
7. Re-read RB-1…RB-4; update anything the last season falsified.
