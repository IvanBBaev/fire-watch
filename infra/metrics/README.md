# Fire Watch — metrics (Grafana Cloud leg)

The first leg of OPERATIONS §3's three-leg meta-alerting: in-process metrics, shipped
off-box and evaluated there, so a VM that is up but sick still pages. TASKS C5.

| File | What it is |
| --- | --- |
| `config.alloy` | Grafana Alloy: scrapes the `api` and `worker` metrics listeners and the host (backup textfile, filesystem), labels every series with `env`, remote-writes to Grafana Cloud. |
| `rules/freshness.yaml` | Freshness budgets (§1): the API's own verdict per row, the collector's health, the snapshot-push lifeline. |
| `rules/queue.yaml` | L-8 queue age (600 s), the A1.12 approval deadline (1800 s), any A1.12 dropped send (> 0), the monitors loop that feeds the first two. |
| `rules/backup.yaml` | The nightly backup heartbeat (26 h warn, 50 h critical), from the backup CLI's textfile. |
| `rules/shrinkage.yaml` | Backup table shrinkage and vanished tables. **Info only, never a page.** |
| `rules/targets.yaml` | Scrape targets down, worker series absent, disk over 80%. |

## Where the metrics come from

- **API** (`server/src/app/api.ts`): the freshness verdict, computed **at scrape time**
  from the same reader, expected rows and budgets as `/api/health/freshness`. The
  dashboard and the endpoint UptimeRobot reads can never disagree, and the rules restate
  no freshness threshold. Also at scrape time, fleet control (`app/health-wiring.ts`):
  `fw_degradation_tier` (0 = SSE offered, 1 = demoted to polling), `fw_sse_connections`
  (open streams) and `fw_sse_rejected_total{reason}` (`not_offered`, `not_ready`,
  `capacity`, `client_cap`; every reason from the start, at zero).
- **Worker** (`server/src/app/worker.ts`): per-job last success
  (`fw_job_last_success_timestamp_seconds{job_id}`), per-loop runs, finish time and
  duration (`ingest`, `monitors`, `identity`, `dispatch`, `r2_mirror_push`,
  `r2_mirror_age` and the other loops the worker starts), per-source ingest counters, the
  monitors loop's meta-alert readings (queue age and depth, identity backlog, canary round
  trip, approval age), and `fw_alert_sends_dropped_total{reason}` from the dispatch loop
  (`ttl_expired`: a claimed send the gateway closed as past its TTL; both reasons exist
  at zero from the first cycle).
- **Both processes**: `fw_event_loop_lag_p99_seconds`, the p99 event-loop delay since the
  previous scrape. The metrics listener owns its own sampler (started on `listen`, reset
  by every read), separate from the API's demotion sampler, which keeps its own windows.
  No listener, no sampler.
- **Backup CLI** (`server/src/app/backup-cli.ts`): after a successful run, writes
  `fire_watch_backup.prom` (success instant plus per-table rows and bytes) into
  `FIRE_WATCH_METRICS_TEXTFILE_DIR`, atomically (temporary file plus rename).

Every series is declared once, in `server/src/core/observability/metric-catalog.ts`.
`server/src/app/metrics-rules.test.ts` fails when a rule here names an `fw_*` series the
catalogue does not declare, or when a numeric threshold drifts from the code constant it
mirrors.

## The listener: internal only

`GET /metrics` is served by a **separate** Fastify instance on its own port
(`server/src/adapters/http/metrics-server.ts`). It is never a route on the public API
server; `metrics-server.test.ts` proves the public server answers `/metrics` with its
ordinary 404.

| Variable | Meaning |
| --- | --- |
| `FIRE_WATCH_METRICS_PORT` | Unset: no listener (the default). Otherwise 1024–65535, and never the API port. |
| `FIRE_WATCH_METRICS_HOST` | Bind address, default `127.0.0.1`. In compose: `0.0.0.0`, with the port **not published** (§9.2: the firewall passes 80/443/SSH only). |
| `FIRE_WATCH_METRICS_TOKEN_FILE` | Absolute path to a file holding the bearer token (at least 32 printable characters, e.g. `openssl rand -hex 32`). **Required** on any non-loopback bind. |
| `FIRE_WATCH_METRICS_TEXTFILE_DIR` | Backup CLI only: absolute directory for the `.prom` file. |

The token never appears in an environment block, a log line or a metric label (§8.2).
The same secret file is mounted into Alloy as `bearer_token_file`.

## Compose wiring (to be added with the deploy pipeline)

```yaml
alloy:
  image: grafana/alloy:<pinned>
  command: ["run", "/etc/alloy/config.alloy", "--storage.path=/var/lib/alloy"]
  environment:
    GRAFANA_CLOUD_PROM_URL: ${GRAFANA_CLOUD_PROM_URL}
    GRAFANA_CLOUD_PROM_USERNAME: ${GRAFANA_CLOUD_PROM_USERNAME}
    FIRE_WATCH_METRICS_PORT: "9464"
    FIRE_WATCH_ENVIRONMENT: production
  volumes:
    - ./infra/metrics/config.alloy:/etc/alloy/config.alloy:ro
    - /:/host/root:ro,rslave
    - /var/lib/fire-watch/metrics:/host/metrics:ro
  secrets: [fire_watch_metrics_token, grafana_cloud_token]
  # no `ports:` — nothing about Alloy is reachable from outside the VM
```

`api` and `worker` get `FIRE_WATCH_METRICS_PORT=9464`, `FIRE_WATCH_METRICS_HOST=0.0.0.0`
and `FIRE_WATCH_METRICS_TOKEN_FILE=/run/secrets/fire_watch_metrics_token`; the backup
unit gets `FIRE_WATCH_METRICS_TEXTFILE_DIR=/var/lib/fire-watch/metrics`.

## Credentials

- `grafana_cloud_token`: a Grafana Cloud access-policy token with **`metrics:write`
  only**, stored in GitHub Environments (§8.1) and delivered to the VM as a secret file
  by the deploy.
- `GRAFANA_CLOUD_PROM_URL` / `GRAFANA_CLOUD_PROM_USERNAME` are not secrets, but have no
  defaults: a missing one fails Alloy's config load instead of shipping to the wrong
  stack.

## Loading the rules

The rule files are Prometheus/Mimir rule groups. Load them into the stack's hosted
Prometheus ruler, one namespace per file:

```sh
mimirtool rules load --address="$GRAFANA_CLOUD_PROM_RULER_URL" \
  --id="$GRAFANA_CLOUD_PROM_USERNAME" --key="$GRAFANA_CLOUD_RULES_TOKEN" \
  infra/metrics/rules/*.yaml
```

Routing: `page="true"` goes to the `fw-alerts` Telegram contact point (§3.1, the
operator bot, never the user-facing one); everything else goes to the dashboard and the
daily review.

## Not exported yet, and rules deliberately not written

- **Degradation tier 2 (T2, the R2 mirror).** A client falls to T2 when the origin is
  unreachable, which the server cannot observe, so `fw_degradation_tier` is only ever 0 or
  1. §3's "`fw_degradation_tier == 2` for 5 min" page cannot fire from this series; the T2
  signal today is the `snapshot-push` freshness row and the R2 mirror age loop.
- **No rule on tier, SSE rejects or event-loop lag.** §3 lists them as signals, but no
  paging number exists in code. The deploy freeze while `fw_degradation_tier > 0` (§9.3)
  and the U-2 resize trigger (event-loop lag p99 > 200 ms sustained over a week) are
  operator judgements, not pages. The API's demotion ladder (`core/transport/demotion.ts`,
  200 ms for 5 min) acts on lag itself; it does not page.
- **`fw_alert_sends_dropped_total{reason="expired_unapproved"}`**: exported at zero, but
  nothing produces it — no sweeper closes an `awaiting_approval` row at its deadline yet.
- **`fw_alert_sends_deferred_total`**: exported by the worker's `alert_evaluation` loop
  (both reasons at zero from the first cycle), counting rows newly entering
  `awaiting_approval` (`core/alerts/outbox-enqueue.ts`). It reads 0 in practice: the
  evaluation cycle writes every row `pending` while budget B is unarmed, and the
  manual-broadcast path is not wired. No rule — A1.12 does not page on a deferral.
- **WAL archive lag**: WAL archiving is v1 (§5) and unbuilt; there is no archive to read a
  lag from, with or without a migration.
- **Dispatch and R2 mirror loop-stalled rules**: the loops are instrumented, but no
  document defines a stall threshold for them, so none is written. The R2 mirror's
  lateness is already paged through the `snapshot-push` budget row.
