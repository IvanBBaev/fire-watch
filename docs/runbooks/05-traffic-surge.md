# 05 — Traffic surge (mega-fire spike)

> **PRE-SEASON DRAFT (2026-09-23).** Not yet exercised. There has been no real spike,
> no production host, and the 50× load test (K2) has not run. The demotion
> controller is proven only on a virtual clock in `app/health-wiring.test.ts` (E4,
> unticked). Revise after season 1 and at every pre-season drill (see
> [README](README.md)).

**Class.** A viral or deadly fire brings 100–1000× normal traffic to a small VM on
the €6–21/month tier. R1 calls success and disaster the same event, on the same day.
The design answer is that spike survival is a CDN property: the snapshot, the tiles
and T2 come from the edge and R2, and the origin sheds live streaming first. The
operator's job is mostly to confirm that the automatic ladder worked and **not** to
reach for hardware.

**Sources.**
- Review 04 RB-4, which points at the §5.2.4 spike checklist this runbook expands.
- RISKS R1.
- OPERATIONS §7: the ordering rule (cache → degrade → resize → split) and U-1, U-2,
  U-5, U-6, U-7.
- OPERATIONS §9.3 rule 4 (deploy freeze).
- ADR-003 D1 as amended by A15: transport tiers and demotion triggers.

## 1. Detection signal

| Signal | Where | Meaning |
|---|---|---|
| `{"transport": {"demoted": {"trigger", "reason", "streams_closed", "connections", "lag_p99_ms", "cpu_fraction"}}}` | API stdout (`app/health-wiring.ts`) | The ladder fired. `trigger` is `connections` (the 5,000 SSE cap, instant), `event_loop_lag` (p99 > 200 ms for 5 min) or `host_cpu` (> 80% for 5 min; `core/transport/demotion.ts`). `reason` is what clients were told (`capacity` or `load`). Every open stream got one `degrade` frame and was closed. |
| `/api/v1/client-config` returns `"transport": "poll"` | public, edge-cached 30 s | The fleet is on T1. New `/api/v1/stream` requests get `503` + `Retry-After: 60`. |
| `{"transport": {"re_offered": {"connections"}}}` | API stdout | SSE was offered again after 30 min below every threshold. It is silent to clients by design. |
| `/api/health/freshness` `snapshot-push` warn/critical | health API | The T2 mirror is falling behind under load: [01](01-pipeline-stale.md) M6. |
| `outbox_queue_oldest_seconds` paging | `meta_alerts` | Alert dispatch is falling behind while users flood in: [03](03-alert-dispatch-misfire.md). |
| Cloudflare analytics: requests, cache hit ratio | Cloudflare dashboard | The first place a spike is visible, and the only place the U-1 cache-ratio condition can be read. |

Gaps:
- The API's `/metrics` exports `fw_degradation_tier` (0 = SSE, 1 = demoted to polling),
  `fw_sse_connections`, `fw_sse_rejected_total{reason}` and
  `fw_event_loop_lag_p99_seconds` (see `infra/metrics/README.md`). None of them pages:
  no paging threshold is defined for them, and tier 2 (T2) cannot be seen from the
  server. `NOT YET BUILT (C5/J1)`: the Grafana leg that would chart them (no host, no
  Grafana Cloud stack), so demotion is still read from the API log line in practice.
- `NOT YET BUILT (K2)`: the 50× load test that would tell us where the real knee is.

## 2. Triage

Work in the §7 order and do not skip ahead.

1. **Did auto-demotion happen?**
   ```sh
   curl -s https://<public host>/api/v1/client-config
   cd /srv/fire-watch && docker compose logs --since 30m | grep -E '"transport"'
   ```
   If the load is real but no `demoted` line appeared, go to M2.
2. **Is the cache holding?** In Cloudflare analytics, the cache hit ratio on
   `/snapshot.json` and tiles must be ≥ 95% (U-1). If it is lower, a cache rule has
   regressed. That is the most likely cause, and fixing it is M1, before anything
   else.
3. **Is the host saturated after demotion?** On the VM:
   ```sh
   uptime; df -h
   ss -s
   cat /proc/sys/net/netfilter/nf_conntrack_count   # vs nf_conntrack_max = 262144 (§9.2)
   dmesg | tail -50    # drops, OOM kills; may need root if dmesg_restrict is set
   ```
   The deploy user's sudo rights cover only `fire-watch.service` (`systemctl` and
   `journalctl -u`; `/etc/sudoers.d/60-deploy` in `infra/cloud-init.yaml`).
   `NOT YET BUILT (C5)`: the U-5 gauge for FD and conntrack usage, so today this is a
   manual read.
4. **Is alert dispatch keeping up?** Read the `meta_alerts` line
   (`outbox_queue_oldest_seconds`). A backlog during a mass event is not a U-7
   trigger (U-7 is steady state only); go to [03](03-alert-dispatch-misfire.md) if it
   pages.
5. **Are the upstreams slow too?** FIRMS and EFFIS slow down during mega-fires. Check
   [01](01-pipeline-stale.md) and [04](04-upstream-overlay-quota-licence.md) rows in
   the freshness body.

## 3. Mitigation

- **M1 — Fix the cache first (U-1).** Restore the Cloudflare cache rule for
  `/snapshot.json` and tiles. No other action until it is resolved. Origin load is a
  function of TTL, not of audience size.
- **M2 — Force the fleet to T1 by hand** if the ladder did not fire but the box is
  struggling. This is the operator kill (E4): set `FIRE_WATCH_SSE_ENABLED=false` (an
  env change, see the [README](README.md#shared-facts-every-runbook-assumes)) and
  restart the API. It pins `transport: "poll"` and announces nothing to clients.
  Clients move within one 30-s edge TTL of `/api/v1/client-config`.
  - `NOT YET BUILT (E4 follow-up)`: a live toggle without a restart.
- **M3 — Slow polling down** if T1 itself is heavy: raise
  `FIRE_WATCH_CLIENT_POLL_INTERVAL_MS` (default 45,000; bounded by the poll-interval
  limits in `packages/contracts/src/client-config.ts`). This is also an env change
  plus restart.
- **M4 — T2 as the floor.** `FIRE_WATCH_STATIC_SNAPSHOT_URL` is advertised in
  client-config as `static_snapshot_url`. Clients fall back to the R2 object when the
  origin fails, so the map survives even a VM that is down. Check that it is set and
  that `r2_mirror_age` is `ok`.
- **M5 — Do not deploy** (OPERATIONS §9.3 rule 4: no deploys while degraded, during a
  major-fire event, or under an error-budget freeze, except incident hotfixes).
  The deploy gate (`infra/deploy-gate/`) already demands the attested boxes
  `FREEZE-DEGRADATION`, `FREEZE-MAJOR-FIRE` and `FREEZE-ERROR-BUDGET` all year, with a
  hotfix exemption. `NOT YET BUILT (J4)`: the deploy step itself is a stub.
- **M6 — Resize only as the last lever** (U-2): only if the host is CPU-bound *after*
  demotion and the cache ratio is ≥ 95%. Resize one step (CX22 → CX32 class) in the
  Hetzner console. That is a 1–2 min reboot, and T2 covers the gap. U-2 says never
  during an active incident, so this is normally a post-spike action.
  `NOT YET BUILT (B9)`: no host exists to resize.
- **M7 — FD or conntrack near the limit (U-5).** Raise the tuned constants in
  `infra/cloud-init.yaml` and redeploy the host config. Never raise limits by hand on
  the box (§9.2).
- **Never** raise the 5,000 SSE cap as an incident action. It is ADR-003's hard cap
  and changes only by ADR amendment plus the L-2 load battery (U-6).
- **Alerts under load.** Dispatch is provider-bound, not CPU-bound. Budget G
  (2,000 per 10 min) holds the ceiling; see [03](03-alert-dispatch-misfire.md) M5.
  "Push only, defer email" (review 04 §5.2.4 step 5) is `NOT YET BUILT (H5)`: there
  are no per-channel controls yet.

## 4. Communication

- **Operator.** `NOT YET BUILT (C5/J1)`: no page fires on demotion itself. Demotion is
  designed to be a non-event. The operator learns of a spike from Cloudflare, from
  the news, or from a downstream page (freshness, queue age).
- **Public.**
  - Clients already say it: the `degrade` frame carries `capacity` or `load`, and the
    UI shows the polling state.
  - `NOT YET BUILT (J5)`: a status-page note ("very high traffic; live updates switched
    to 45-second refresh; alerts unaffected"). Review 04 §5.2.4 step 6 asks for it.
  - `NOT YET BUILT (founder decision, OPERATIONS §10 rule 2)`: the second announcement
    channel. During a mega-fire it is also where press and partners will look.
- **Abuse vs. popularity.** If the traffic looks like abuse (OPERATIONS §11), the
  response is Cloudflare rules, not this runbook.
  - `NOT YET BUILT (J5/pre-launch)`: the Project Galileo application (R1 mitigation).

## 5. Recovery verification

1. A `{"transport": {"re_offered": ...}}` line appears after traffic subsides, or, if
   M2 was used, `FIRE_WATCH_SSE_ENABLED` is back to `true` and the API restarted.
   Remember to undo M2 and M3.
2. `/api/v1/client-config` shows `"transport": "sse"` again once the edge TTL passes.
3. `/api/health/freshness` is 200: the spike did not starve ingest or the T2 push.
4. `outbox_queue_oldest_seconds` is back under 600 s.
5. The cache hit ratio is back to ≥ 95%, and any cache-rule fix is written into the
   Cloudflare configuration record.

## 6. Post-incident note

Record in `WORKLOG.md`:
- peak concurrent users and requests per second (Cloudflare)
- the demotion trigger and timestamps (`demoted` / `re_offered`)
- `connections`, `lag_p99_ms` and `cpu_fraction` at demotion
- the cache hit ratio
- whether any §7 row's condition was met and what action was taken
- the error budget spent: the map read path is 99.9% (43 min/month); SSE is
  best-effort and a T0 outage is not an incident (OPERATIONS §4)

A spike that consumed more than 50% of the map or API budget gets a published
postmortem within 72 h (§4.1 rule 2). Feed the observed knee into K2's load-test
baseline and the RISKS R1 row.
