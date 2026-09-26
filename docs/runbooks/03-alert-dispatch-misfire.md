# 03 — Alert dispatch misfire (storm, wrong sends, stalled outbox)

> **PRE-SEASON DRAFT (2026-09-23).** Not yet exercised: dispatch has never sent a real
> alert. `FIRE_WATCH_ALERT_DISPATCH_ENABLED` defaults to `false` and must stay off.
> `REVIEWED_TEMPLATES` is empty (H6), and the channel adapters are unbuilt (H5). The
> kill switch has not been rehearsed on a staging host (H4). Revise after season 1
> and at every pre-season drill (see [README](README.md)).

**Class.** The alert path misbehaves. There are three shapes:
- **Storm.** Too many sends, from a runaway rule, a duplicated event or a replay
  gone live.
- **Wrong sends.** Wrong zone, wrong wording, wrong people.
- **Stall.** Decided alerts sit in `alert_outbox` and nobody is notified.

A storm or a wrong send spends user trust directly. A stall is R4, the kill scenario,
in its quietest form.

**Sources.**
- RISKS R4: "alerts fail closed".
- ADR-004 D5 (kill switch, breaker, global budget G) and D6 (dispatch SLO) as amended
  by A16.
- GATES L-8: queue age pages at 600 s.
- OPERATIONS §3 (meta-alerting) and §7 U-7.
- TASKS H4 and J1 notes.

## 1. Detection signal

| Signal | Where | Meaning |
|---|---|---|
| `outbox_queue_oldest_seconds` > 600 s for 2 consecutive 60-s cycles | `{"meta_alerts": {...}, "pages": [...]}` from the `monitors` loop; the healthchecks `meta-alerts` check gets `/fail` | **Stall.** This is the only armed meta-alert rule (`core/monitoring/meta-alert-params.ts`, L-8). It clears after 2 consecutive clean cycles. |
| `meta-alerts` check silent | healthchecks.io | The monitor loop itself is dead. It pings every cycle, success or `/fail`, so silence is a signal too. |
| `{"meta_alerts_unpaged": ...}` at start-up | worker stdout | `FIRE_WATCH_HEARTBEAT_URL` is unset, so no meta-alert can page. |
| `{"alert_dispatch": {...}, "pages": true}` | worker stdout, every 10 s | Dispatch halted for a paging reason: `breaker_latched`, `send_rate_anomaly`, `global_budget_exhausted` (G = 2,000 sends per 10 min, `core/config/alert-budgets.ts`) or `unknown_send_rate`. `kill_switch` is a halt that does not page, because a human pulled it. |
| `{"alert_dispatch_failed": {"error", "at"}}` | worker stdout | The dispatch cycle threw. |
| `{"dispatch_disabled": ...}` at start-up | worker stdout | Dispatch is off (the default, and the shadow-season state). Expected until H9. |
| `AlertSendsDropped` (any increase of `fw_alert_sends_dropped_total` in 15 min) | Mimir rule, `infra/metrics/rules/queue.yaml`; series from the worker's dispatch loop | A send a human or the pipeline authorised died undelivered (A1.12: any drop is an incident). `reason="ttl_expired"`: the gateway closed a claimed row as past its TTL. |
| `fw_alert_approval_pending_seconds`, `fw_loop_*{loop="dispatch"}` | worker `/metrics` | Approval backlog (A1.12); whether the dispatch loop is cycling at all. |
| A user report of a wrong or duplicate alert | email, Telegram, support | **Wrong send.** Nothing automatic detects a wrong message; the wording lints (H6) are the only preventive gate. |

Gaps:
- `/metrics` exports the outbox queue age (L-8) and approval-pending readings, with
  Mimir rules in `infra/metrics/rules/queue.yaml`, and the dispatch loop's dropped
  sends (`ttl_expired`) with the `AlertSendsDropped` page, and
  `fw_alert_sends_deferred_total` from the alert evaluation loop — which reads 0 until
  budget B or the manual broadcast is armed, since nothing enters `awaiting_approval`
  before then. `NOT YET BUILT (C5)`: `reason="expired_unapproved"` has no producer (no sweeper
  closes an unapproved row at its deadline), and the Grafana leg is not deployed (no
  host, no Grafana Cloud stack).
- `NOT YET BUILT (J1)`: the dispatch canary (`canary_round_trip_seconds` is `null`),
  `/api/health/meta`, thresholds for every other monitor key (`outbox_pending_rows`,
  `outbox_claimed_rows`, `outbox_claimed_oldest_seconds`,
  `outbox_awaiting_approval_oldest_seconds`, `identity_pending_batches`,
  `identity_oldest_pending_seconds` are all unarmed), and persistent hysteresis (state
  is in memory, so a restart resets the 2-in-a-row counter).
- `NOT YET BUILT (H4, founder decision)`: the anomaly breaker's absolute floor. The
  breaker is unarmed, so G is the only enforced ceiling on a runaway.
- There is no heartbeat for dispatch itself. Queue age is the signal.

## 2. Triage

1. **Storm, wrong send, or stall?** Read the last dispatch lines:
   ```sh
   cd /srv/fire-watch && docker compose logs --since 30m | grep -E 'alert_dispatch|meta_alerts|dispatch_disabled'
   ```
2. **Look at the outbox by status.** The statuses are `pending`, `awaiting_approval`,
   `claimed`, `sent`, `failed`, `cancelled_erasure`, `expired_unapproved` and the
   others in migration 001's CHECK.
   ```sh
   psql "$DATABASE_URL" -c "select status, channel, count(*) from alert_outbox group by status, channel order by status, channel;"
   ```
   - A growing `sent` count within minutes suggests a storm.
   - A growing `pending` with an old head suggests a stall.
   - A large `awaiting_approval` means budget B cut in. That is working as designed:
     the rows are waiting for a human.
3. **For a suspected wrong send**, find the rows. Every row carries its provenance:
   `trigger_ref_seq`, `rule_version`, `template_id`, `template_params`, and
   `trigger_type` / `actor_id` (migration 003). Identify the rule version and the
   trigger before stopping anything else.
4. **Stall with dispatch enabled.** If the lines show a halt reason, the halt is the
   cause. If there are no `alert_dispatch` lines at all, the worker or the dispatch
   loop is dead: go to [01](01-pipeline-stale.md) M1. If lines show zero claimed rows
   and no halt, check `/readyz`.

## 3. Mitigation

**Rule: when in doubt, stop sending.** A delayed alert can be caught up later; a sent
one cannot be unsent (R4, "fail closed").

- **M1 — Pull the kill switch** (storm or wrong send; also before re-enabling after
  any restore). This is the one live control, and it needs no restart. Presence of
  the file is the state (`adapters/storage/fs-dispatch-control-store.ts`). The store
  fails closed on any error other than "file not found".
  ```sh
  touch "$FIRE_WATCH_STATE_DIR/alert-dispatch/kill-switch"   # stop all dispatch
  ```
  Confirm the next `alert_dispatch` line (within 10 s) shows the `kill_switch` halt.
- **M2 — Resume after the cause is fixed.** A human removes the file:
  ```sh
  rm "$FIRE_WATCH_STATE_DIR/alert-dispatch/kill-switch"
  ```
- **M3 — Close a latched breaker.** The latch is written once (`wx`) and keeps its
  first instant and detail. Read the file before deleting it; its contents are the
  incident's evidence.
  ```sh
  cat "$FIRE_WATCH_STATE_DIR/alert-dispatch/breaker-latched"
  rm  "$FIRE_WATCH_STATE_DIR/alert-dispatch/breaker-latched"
  ```
- **M4 — Turn dispatch off entirely** (the heavier lever, e.g. back to shadow mode):
  set `FIRE_WATCH_ALERT_DISPATCH_ENABLED=false` (an env change, see the
  [README](README.md#shared-facts-every-runbook-assumes)). The flag accepts exactly
  `true` or `false`; anything else is refused at start-up. When enabled, dispatch also
  needs `FIRE_WATCH_STATE_DIR`, because the kill switch lives there. Without it the
  worker exits with a config error (`2`) before any loop starts.
- **M5 — `global_budget_exhausted`.** G is a ceiling that no runtime knob can raise
  (`clampToShipped` in `core/config/alert-budgets.ts` only tightens). Reaching it
  during a real mega-fire is the design working. Leave it halted, and check whether
  the sends were legitimate before the window rolls over. Raising G is a reviewed
  version bump of `alert_budgets_v1`, never an incident action.
- **M6 — `awaiting_approval` backlog.** `NOT YET BUILT (H4/H7)`: the approval surface.
  The self-approval caps (A1.4) are declared and enforced nowhere. Until it exists,
  there is no sanctioned way to release a held row. Do not flip `status` by hand in
  SQL; let the rows expire (`expired_unapproved`).
- **M7 — Rule or template fault** (wrong sends). After M1, the fix is a code change to
  the rule or template plus a deploy. `NOT YET BUILT (J4)`: that deploy.
- **M8 — Channel provider outage or a revoked credential** (Telegram
  `FIRE_WATCH_TELEGRAM_BOT_TOKEN`, email `FIRE_WATCH_SES_*`, push `FIRE_WATCH_VAPID_*`).
  `NOT YET BUILT (H5)`: the channel adapters and their token buckets. Rotation
  procedures: `NOT YET BUILT (OPERATIONS §8.2 rule 6)`. VAPID cannot be rotated
  without user-visible harm (§8.2 rule 8).

## 4. Communication

- **Operator.** Pages arrive via the healthchecks `meta-alerts` check into fw-alerts
  (OPERATIONS §3.1).
  - `NOT YET BUILT (C5)`: the check itself.
  - `NOT YET BUILT (J1)`: the operator Telegram bot. Operator pages cannot go through
    `alert_outbox`, which accepts user channels only.
- **Users, wrong send.** Send a correction through the same channel. It must be a new,
  reviewed template: there is no "all clear" or "resolved" alert type, by design
  (ADR-004 D4). `NOT YET BUILT (H6)`: the correction template.
- **Users, stall.** In-app remains authoritative (RISKS watchlist, iOS push row).
  - `NOT YET BUILT (J5)`: a status-page note ("alert delivery delayed since HH:MM;
    the map is current").
  - `NOT YET BUILT (founder decision, OPERATIONS §10 rule 2)`: the second
    announcement channel.
- A wrong or missed alert during a live fire is an R4 event. The public retrospective
  is mandatory (RISKS §3).

## 5. Recovery verification

1. `alert_dispatch` lines show no halt, or show the expected `kill_switch` halt if you
   are keeping dispatch stopped deliberately.
2. `outbox_queue_oldest_seconds` is back under 600 s. The `meta_alerts` pages list
   clears after 2 consecutive clean cycles.
3. The outbox status counts are stable: no `claimed` rows older than the recovery
   window (`outbox_claimed_oldest_seconds`, unarmed, so read it from the
   `meta_alerts` line).
4. For a wrong send, count the affected users and rows from provenance, and confirm
   the corrected rule version is what new rows carry.
5. `NOT YET BUILT (J1)`: a canary round trip as positive proof of delivery.

## 6. Post-incident note

Record in `WORKLOG.md`:
- the halt reason
- the `breaker-latched` contents, if any
- when the kill switch was pulled and removed
- the rows affected, by status and channel
- the rule version and template involved
- user-visible harm (sent-wrong count, delay distribution against the L-8 p95 target:
  60 s push, 5 min email)

A breach of L-8 or any wrong send gets a published postmortem within 72 h (OPERATIONS
§4.1 rule 2) and a RISKS watchlist update. If a wrong send exposed personal data, the
breach runbook applies: `NOT YET BUILT (WP7/I-track)`.
