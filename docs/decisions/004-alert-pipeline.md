# ADR-004: Alert pipeline — outbox, gateway, state machine, fail-closed budgets

*Date: 2026-07-30. Status: accepted (pre-code). Amended 2026-08-02 — see
"Amendment A1" below; where they conflict, the amendment wins.*

Inputs: reviews 02 (outbox schema), 04 (SRE limits/SLOs), 05 (security & gateway
architecture, GDPR), 06 (alert state machine R3, correctness metrics, rollout gates),
07 (alert UX & explainability), 09 (legal: lawful basis, Telegram, disclaimers),
11 (score gating), 12 (never-send list, vocabulary). Companion to ADR-002 (event
identity alerts key on) and ADR-003 (read path; alerts are the fail-closed half of
"map fails open, alerts fail closed").

## Context

- An alert is the only part of the product that *acts on the user* — a wrong or missing
  push is the #1 reputational and legal exposure (12 H-scenarios; 09 §3 liability).
  The pipeline must therefore be: auditable end-to-end, idempotent under crashes,
  rate-bounded against runaway bugs, and incapable of sending vocabulary we banned.
- Fail direction is asymmetric by design: the **map** degrades to stale-but-visible;
  **alerts** stop when any invariant is in doubt ("fail closed"). A silent alert gap is
  detected by monitoring (canaries, 06 §5.5), not tolerated silently — but sending
  wrongly is worse than pausing.
- Volume reality: Bulgaria fire season peaks at tens of simultaneous events; a bug, not
  legitimate load, is the only way to reach thousands of sends in minutes. Limits are
  sized to that truth.

## Decision 1 — Transactional outbox with mandatory provenance

Alert decisions are made **in the same DB transaction** as the state change that
triggered them (event creation, escalation threshold, merge). The decision writes a row
to `alert_outbox`; nothing sends synchronously.

Every outbox row carries **provenance, enforced by the gateway** (it refuses rows
missing any field): `trigger_type` (new_fire | escalation | digest), `trigger_ref`
(event id + seq at decision time), `rule_version` (the versioned gating config that
fired, Decision 4), `template_id` (the exact copy template). Plus stage timestamps
filled as the row progresses: `decided_at`, `dispatched_at`, `provider_ack_at`,
`status`. This is simultaneously the audit trail, the latency instrumentation (PLB,
Decision 9), and the liability-defence artifact (09 §3 — retained per the 5-year
limitation period).

Delivery is **at-least-once from the outbox + idempotent dispatch**: the unique key
(Decision 3) makes redelivery after a crash a no-op at the provider-call layer
(providers are called with idempotency keys where supported; otherwise the row status
guard suffices because there is a single dispatcher).

## Decision 2 — Notification Gateway is the only sender

One module (`delivery/notification-gateway`) is the **sole consumer** of the outbox and
the **only code path that can reach a provider adapter** (web push, Telegram, email).
Adapter packages are importable *only* by the gateway package — enforced by lint
(dependency-cruiser rule), so "quick fix sends email directly" cannot pass CI (05).
The gateway owns: budget enforcement, circuit breaker, token buckets, template
rendering, the never-send lint (Decision 7), kill switch, and provider error handling
(permanent errors → prune dead tokens/subscriptions; 410 → mark for client re-prompt).

## Decision 3 — Per-(zone, event) alert state machine

State per `(zone_id, event_id)` (06 R3):

```
none -> notified_new -> notified_escalation -> cooldown
```

- **Idempotency key:** `UNIQUE (zone_id, event_id, alert_type)` on the outbox — the
  same alert type can be *decided* at most once per zone per event, ever. (Digests are
  keyed with their window start.)
- **Suppression window ~6 h** between successive notifications for the same
  `(zone_id, event_id)` regardless of type transitions; escalations queue into the next
  digest instead of piercing it, except a first `new_fire` which is never suppressed
  by earlier *other-event* traffic.
- **Merge inheritance (ADR-002 I3):** on merge, the survivor inherits the
  most-advanced notified state of **all** parents per zone — a merge can never produce
  a second "new fire" for a zone already notified about any constituent. Runs inside
  the merge transaction (`migrateAlertState`).
- **Digest floor:** never more than one notification per user per event per 30 min;
  overflow folds into the daily 09:00 digest.

## Decision 4 — Gating: what may alert at all

Composed with ADR-002's score (versioned config-as-data, `rule_version` on every row):

- Default: score **≥ 0.45** (Likely+) **AND** (≥2 detections **OR** 1 night-time
  high-confidence detection). Users may opt in to a lower floor (**≥ 0.30**) per zone.
- **Invariant (CI-tested on golden fixtures): zero alerts from a single
  low-confidence detection.** MTG/GEO detections alone never alert (Demonstration
  maturity, ADR-002).
- Alert taxonomy: **`new_fire`** (overrides quiet hours by default — user-changeable),
  **`escalation`** (growth/status worsening; respects quiet hours), **`digest`**
  (09:00 daily summary). **There is no "resolved"/"safe" notification and never will
  be** (false-reassurance is the #1 harm, 12): lifecycle downgrades and score
  downgrades never notify.
- Every sent alert links to **"Why this alert?"** (trigger, detections, score bucket,
  rule version in human words); the zone screen offers **"Why no alert?"** for visible
  nearby fires (07 §5.5) — explainability is a product feature and a complaint-deflection
  tool.

## Decision 5 — Budgets, breaker, kill switch (fail-closed machinery)

- **B = 500** users notified per event automatically; beyond that the event's remaining
  sends require **T-approve** (two-person rule, 05) — a mass-notification is by
  definition an extraordinary act.
- **G = 2,000** sends per 10 min globally, auto-enforced. Both budgets are
  **config-in-git, changed only by PR** — no runtime knob can raise them.
- **Anomaly circuit breaker:** dispatch halts when current send rate >
  max(5× seasonal baseline, floor) — a runaway bug trips it before budget G exhausts;
  tripping pages a human.
- **Kill switch:** one command stops all dispatch (outbox keeps accumulating decisions
  for post-mortem); **rehearsed before each season** (06 §5.7 checklist item).

## Decision 6 — Channels and delivery mechanics

- Per-channel token buckets (04): web push **300/s**, Telegram **25/s**, email
  **12/s**; SES production-quota raise filed before June. Push TTL **1800 s** (a fire
  alert older than 30 min must not land as if fresh); queue expiry **6 h** (undelivered
  decisions die, they are visible in the app anyway).
- **Dispatch SLO: p95 ≤ 60 s** decision→provider-ack (push; ≤5 min email);
  `fw_notification_queue_oldest_seconds` pages at 600 s (04).
- Channel signup is **double opt-in** on every channel (05); dead tokens pruned on
  permanent provider errors; web-push `pushsubscriptionchange` + 410 handling per 08.
- iOS: web push requires Home-Screen install (08 §5.4.4); **Telegram is an equal-rank
  channel**, not a fallback afterthought.

## Decision 7 — Content rules (the never-send list is code)

- Templates are the only source of alert text; the gateway lints rendered output
  against the **never-send list (12 §3.4, 8 hard rules)** — no "contained/extinguished/
  out/safe/all-clear" vocabulary from our own data, no authority voice, no evacuation
  instructions, no all-clear implication, etc. A template that trips the lint fails CI,
  not runtime.
- Wording follows the ADR-002 lifecycle ladder; curated `officially_*` states name
  their official source in the alert body.
- Every alert footer carries the source-attribution line and mirrors the **LANCE "not
  for tactical decision-making" disclaimer** (09 §2: FIRMS CC0 + disclaimer
  replication) plus the scope-of-service sentence ("best-effort informational
  monitoring — in an emergency call 112").

## Decision 8 — Privacy & data protection posture

- Lawful basis for watch zones + alert delivery: **Art. 6(1)(b) — performance of the
  service the user requested** — not consent; marketing remains separately opt-in
  6(1)(a) (09 §5.1).
- Zone coordinates are treated **Art-9-grade in practice** (05/09): app-layer
  encryption, coarse grid index, and the written product invariant "no analytics or
  segmentation on zone locations, ever". Default ~1 km coarsening of stored zone
  centers stays ON (07).
- **Telegram minimization** (09 §5.3): Telegram is a third-party controller the user
  chose, not our processor — bot messages carry only event location + distance band;
  never the zone's address/name, never account identifiers.
- Erasure propagation into backups: **≤ 30 days** — where 05 (≤30 d) and 04 (≤60 d)
  diverged, this ADR fixes the stricter figure; backup retention tooling must honor it.
- Alert-relevant personal data lives only in `zones` + channel endpoints; outbox
  provenance references zone *ids*, and audit retention (Decision 1) survives account
  deletion only in pseudonymized form (zone id unlinked, coordinates coarsened).
- Key custody per 05: provider credentials (VAPID, bot token, SES) in the secret
  store, rotated per playbook; gateway is the only holder at runtime.

## Decision 9 — Correctness metrics and rollout gate

Launch-blocking metrics (06 §5.1), measured continuously once live:

- **PCR** — perimeter coverage: alerts fired for ≥95% of EFFIS-confirmed ≥50 ha fires
  intersecting subscribed zones (≥85% for ≥10 ha).
- **CER ≥ 80%** — corroboration of alerted events within 7 d (EFFIS BA, ≥2 later
  detections, or news log ±5 km ±1 d).
- **ZAP ≥ 85%** — zone-alert precision; **DAR ≤ 5%** shadow → ≤1% steady (Duplicate
  Alert Rate); **FLR** — flag any event with ≥3 lifecycle reversals in 48 h.
- **PLB** — controllable-latency budget p95: poll→ingest ≤ poll+2 min; ingest→event
  ≤60 s; event→decision ≤10 s; decision→ack ≤60 s push / ≤5 min email; **total
  controllable ≤15 min p95** (upstream satellite latency excluded and honestly
  displayed instead).

**Rollout:** alerts run **≥2 weeks in live shadow mode** (decisions written, nothing
sent, nightly diff reviewed) before the first real push; every diff explained before
promotion; staged enablement team → beta → all (06 §5.7). Fire-season release regime
applies to any change touching this pipeline (deploy gates, alert-logic diff
none-or-flagged, kill-switch verification, physical-device push test).

## Consequences

- Alerting is slower to ship than a naive `sendPush()` — deliberately: the shadow gate
  and budgets are the cost of being trustworthy on the season's first real fire.
- Every alert is reconstructible years later from one row (template + rule version +
  trigger ref) — the legal team's artifact and the debugging tool are the same thing.
- The two-person T-approve rule means a solo founder cannot mass-notify alone at 3 AM —
  accepted friction; the B budget keeps genuinely-automatic coverage for the realistic
  case (a zone rarely has >500 subscribers in season 1).
- No "resolved" notification is a permanent product stance, not a missing feature —
  documented here so future feature requests hit an ADR, not a debate.

## Amendment A1 (2026-08-02)

Outcome of the second-round audit (13 §3.5 item 22 and finding C5) and the corner-case
register (14 H4, M3, M4 and the §3 minors), applied per TASKS A16. Twelve changes;
**everything not mentioned below stands unchanged**. Each heading names the decision it
amends.

### A1.1 `trigger_type` gains `manual`; actor/approver provenance (D1)

The **T-approve act** — a human releasing sends above budget B (D5) — was
unrepresentable in the provenance record: the row that woke 4,000 people at 03:00
looked exactly like an automatic one. D1's enforced provenance set changes:

- `trigger_type` becomes **`new_fire | escalation | digest | manual`**. `manual` covers
  the two human-initiated cases: the over-budget continuation of an automatic event,
  and an operator incident/correction notice.
- New columns, `NULL` on automatic rows: **`actor_id`** (the human who initiated),
  **`approver_id`** (the human who approved), **`approval_mode`**
  (`two_person | solo_cooloff`, A1.4), `approved_at`, and the boolean
  **`budget_override`** (the row was released past B).
- **The gateway's refusal rule extends accordingly:** a row is undeliverable unless
  `trigger_type <> 'manual' OR (actor_id IS NOT NULL AND approver_id IS NOT NULL)`,
  and `approver_id <> actor_id` **except** when `approval_mode = 'solo_cooloff'`
  (A1.4). The same check applies to any row with `budget_override = true`, whatever
  its trigger type.
- `manual` does **not** unlock free text. D7 stands unconditionally: a manual send
  selects a reviewed template and binds parameters, and the never-send lint runs on
  the rendered output exactly as for automatic rows.

### A1.2 Outbox priority ordering — dispatch is not FIFO (D1/D2)

Strict FIFO is wrong: a `new_fire` decision must not queue behind a digest backlog.

- New column **`priority SMALLINT NOT NULL`**, derived at decision time by a pure
  function of `trigger_type` and **stored** (never recomputed at dispatch — replay
  stability): **`manual` = 0, `new_fire` = 10, `escalation` = 20, `digest` = 30**;
  lower dispatches first.
- Dispatcher claim order is **`ORDER BY priority, decided_at, id`** — `id` is the final
  tie-break, so the order is total and reproducible in replay.
- **Priority reorders the queue, it never raises a ceiling:** B and G, the per-channel
  token buckets, the breakers and the kill switch are unchanged and apply after
  ordering.
- `fw_notification_queue_oldest_seconds` gains a **`priority` label**; the 600 s page
  (D6) applies to classes ≤ 20. A 4,000-row digest backlog can no longer mask a starved
  `new_fire`, and the digest class is watched against its own 09:00 window.

### A1.3 Retention settled — 24 months full, pseudonymized to 5 years (D8) [13 C5]

D1's "retained per the 5-year limitation period" and 05's normative "24 months, then
anonymize" are reconciled into **one decision**; the ≤30 d erasure promise wins over
both.

- **Full-fidelity outbox retention: 24 months** from `decided_at`. At T+24 months the
  row is **rewritten in place** (never deleted) and kept until **5 years**, then hard
  deleted. The liability defence needs the *decision*, not the *recipient*.
- **Retained verbatim at pseudonymization:** row id, `trigger_type`, `trigger_ref`
  (event id + seq), `rule_version`, `template_id`, `priority`, `status`, the four stage
  timestamps, channel *type* (push/telegram/email), the rendered distance **band**, and
  `actor_id`/`approver_id`/`approval_mode` (operator accountability trail — an
  employment record, not user data).
- **Destroyed at pseudonymization:** `user_id` → NULL; the channel endpoint reference →
  NULL; `zone_id` → salted one-way hash whose **per-year salt is destroyed in the same
  job** (unlinkable, not merely "not looked up"); every zone-derived template parameter
  (zone name, exact distance, place string) → dropped, leaving `template_id` plus
  non-personal parameters. The outbox stores template + bound parameters, **never a
  rendered body**.
- **Erasure ≤ 30 d is unaffected:** on account deletion the pseudonymization above runs
  **immediately** for that account's rows (together with A1.9's cancellation), not at
  24 months. What survives is not personal data — no reasonable means of relinkage
  remains — so the erasure promise and the audit artifact no longer contradict.
- **Binding consequence for the backup design:** any backup tier holding alert-path
  personal data is capped at **30 days**; longer-retained tiers (the 56-day design
  flagged in 13 C5) must exclude those tables or hold them already pseudonymized.
  Asserted by the WP7 erasure drill.
- 24 months is the operating decision; 09's open lawyer question can change it only by
  PR to this ADR.

### A1.4 T-approver — named second human, with a recorded solo fallback (D5)

The two-person rule currently has no second person (13 C4), so the B ceiling degrades
into a hang in exactly the mega-fire it was designed for. Recorded, not reversed:

- **Primary:** the T-approver is a **named second human**. The nomination is a founder
  action (TASKS §1, not agent-delegable) and the name lives in the ops runbook, not in
  this ADR.
- **Solo fallback, in force until a nominee exists.** Self-approval is permitted only
  as `approval_mode = 'solo_cooloff'`, and only with **all** of:
  1. **Cool-off ≥ 15 min** between the budget hold and the approval
     (`approved_at − decided_at ≥ 900 s`) — the cool-off buys what the second pair of
     eyes was buying at 03:00;
  2. an **impact preview re-read at approval time** (recipient count, event id,
     `rule_version`, rendered template), confirmed by typing the event id;
  3. **caps: one self-approval per event, ≤ 2 per rolling 24 h**;
  4. it **never raises B or G** — a released batch still walks the token buckets, the G
     ceiling, the breakers and the kill switch.
- **The ceiling is a deferral, not a hang:** the first 500 recipients (A1.12) are
  already dispatched, the remainder sit at `status = awaiting_approval`, and the event
  is visible in the app regardless (the map fails open). Unapproved rows die at queue
  expiry as `expired_unapproved` — loudly, per A1.12's metrics.

### A1.5 Ingest-side breaker leg (D5)

A sibling to the dispatch-rate breaker. A satellite reprocessing dump, a duplicated
`day_range` window, or a bbox change must never become an alert storm.

- **Trip condition:** an ingest batch whose detection count exceeds **5 × the trailing
  baseline** for that source (median of that source's last 14 same-hour batches), with
  an absolute floor so a small denominator cannot trip it.
- **Effect — quarantine:** raw bytes retained (WP1's E1 validation/quarantine path),
  rows not promoted into clustering, and **no alert decision made from that batch**.
  Prior data keeps serving the map (fails open, staleness banner); alerting fails
  closed for the quarantined batch. Tripping **pages a human**; release is manual after
  inspection.
- **Release is not a catch-up burst:** a released batch replays through the normal
  deterministic path, its decisions obey the ordinary suppression window, and any
  `new_fire` whose triggering detection is older than the push TTL (1800 s) folds into
  the next digest instead of pushing.
- Metrics: `fw_ingest_batch_anomaly_ratio{source}`,
  `fw_ingest_quarantined_batches_total{source}`.

### A1.6 Reignition alerts are `escalation`, never `new_fire` (D3/D4)

A `possible_reignition` event (ADR-002 D2: past T_LINK, **new** event id, carrying
`related_event_id`) would, on the bare `(zone_id, event_id)` key, fire `new_fire` — to
a zone we just told "no longer detected" that reads as contradiction or spam. Following
07 §5.5.3, which already lists reignition as an `escalation` trigger:

- **The type is chosen on the parent chain, not on the event id.** If any ancestor of
  the event — merge parents (I3) or a `possible_reignition` predecessor — has reached
  `notified_new` for that zone, the decision is **`escalation`** with the reignition
  copy variant. If the zone was never notified about the predecessor, this genuinely is
  its first alert about that fire and `new_fire` is correct.
- `migrateAlertState` gains a **reignition leg**: on creation of the reignition link the
  child inherits each zone's most-advanced notified state from the predecessor — the
  merge-inheritance rule, one link further.
- **Copy states both facts without adjudicating** (previously reported no longer
  detected on `<date>`; new detections on `<date>`) — the GLOSSARY §3b dual-fact string;
  the D7 lint is unchanged, so no "restarted"/"out again" vocabulary.
- Quiet hours: being an `escalation`, it respects them unless the zone is marked
  "always wake me" (07 §5.5.3).
- Fixtures: **S6** extends to assert the alert *type*; **S12** asserts
  escalation-not-`new_fire` after `officially_extinguished`.

### A1.7 System gate vs per-zone sensitivity; quiet-hours default (D4)

07 §5.5.1's zone default ("Confirmed fires — recommended") and D4's ≥ 0.45 gate are not
in conflict — **they are different knobs**. Which is which:

- **System gate (floor, D4, unchanged):** ≥ 2 detections **OR** 1 night-time
  high-confidence detection, plus the invariant "zero alerts from a single
  low-confidence detection". **The persistence condition is not user-adjustable** — the
  sensitivity control moves the score threshold only.
- **Per-zone sensitivity (product knob)** — two positions in the creation flow plus one
  advanced opt-in, mapped onto ADR-002's buckets:

| Position | Threshold | Surface |
|---|---|---|
| **Confirmed fires — recommended (default)** | score ≥ **0.75** (Confirmed) | zone creation |
| Confirmed + likely — earlier but noisier | score ≥ **0.45** (Likely+) | zone creation |
| Early signals — expert opt-in | score ≥ **0.30** | zone settings only, behind an explicit warning |

- D4's "default ≥ 0.45" is therefore the **system** default; a new zone is created
  *stricter* than the system gate and the user opts down, never below 0.30.
- Alerts issued under the 0.30 opt-in always carry the Unverified copy variant ("may
  still be a real fire") and **never override quiet hours** — the override belongs to
  `new_fire` at Likely+ only.
- **Quiet-hours default: 22:00–07:00 local (Europe/Sofia)**, applying to `escalation`
  and `digest`; `new_fire` overrides by default, user-changeable (07 §5.5.4). The 09:00
  digest sits outside the window by construction. The timezone is stored per account
  (v1 default Europe/Sofia). Classification uses the decision **instant** converted
  through the tz database, never a naive local string: the repeated hour on DST
  fallback is inside quiet hours either way, and an instant landing in a skipped local
  hour is classified from the instant. Fixture **S14**.

### A1.8 Zone creation seeds state for pre-existing fires — no send (D3) [14 H4]

The state machine started at `none`, so the standard onboarding path — user hears about
a fire, installs, draws a zone — immediately pushed `new_fire` for a week-old event:
alarming and false. Normative in D3:

- **On zone creation** (and on a zone edit that enlarges coverage), **inside the same
  transaction as the zone write**: for every currently alertable event intersecting the
  zone under that zone's sensitivity, insert `(zone_id, event_id)` state at
  **`notified_new`** with `seeded_at` set and **no outbox row** — zero sends.
- Those fires are surfaced **in the zone-creation UI** ("вече активни пожари във вашата
  зона") with permalinks — an onboarding surface, not a push.
- **Subsequent behaviour is normal:** a seeded event that later crosses an escalation
  step alerts as `escalation` (A1.11); events appearing after zone creation alert as
  `new_fire`. Seeded events are eligible for the **09:00 digest** from the next window —
  the low-urgency channel stays honest; only the high-urgency push is suppressed.
- Shrinking a zone does not unseed. A zone deleted and re-created **re-seeds from
  scratch** — no resurrection of old per-zone state.
- **Fixture S13:** zone created mid-scenario — assert zero sends for pre-existing
  events and normal alerts for subsequent ones.

### A1.9 Erasure cancels pending outbox rows; liveness re-check at dispatch (D8) [14 M3]

At-least-once dispatch plus the 6 h queue expiry let a deleted account receive an alert
after erasure; provider-side pruning does not help, because the endpoint is still live
at the provider.

- **In the same transaction as account/zone deletion**, every non-terminal outbox row
  for the affected zones (`pending`, `awaiting_approval`, claimed-but-unsent) is set to
  **`status = 'cancelled_erasure'`**. Cancelled rows are never dispatched and are
  retained pseudonymized (A1.3) as evidence that the send was stopped.
- **Belt and braces:** the gateway **re-checks zone and subscription liveness
  immediately before each provider call**; a row whose zone or channel subscription no
  longer exists is closed `cancelled_erasure` and never sent. Required because a retry
  can outlive the deletion transaction.
- One integration test, inside WP7's erasure drill: delete with rows in flight, assert
  zero provider calls afterwards.

### A1.10 Minimum zone radius 2 km (D8) [14 M4]

Stored zone centers are ~1 km coarsened, but alert geometry and distance bands are
computed **from the stored center** — so a 500 m-radius zone alerts on the wrong area
and states wrong distances.

- **Minimum watch-zone radius: 2 km** (slider 2–30 km, default 10 km, per 07 §5.5.1).
  Unconditional — it does not depend on the coarsening toggle.
- Documented in the zone UI as a **privacy-by-design consequence**, not a limitation:
  the place is stored approximately (~1 km), so zones start at 2 km and the alert still
  covers what the user drew (coarsening error ≪ radius).
- Pinned consequence: rendered distances are **bands**, never precise metre figures —
  an alert must not imply precision the coarsening destroyed.
- The polling-bbox rule (14 M2: *bbox ⊇ alertable area buffered ≥ 2×ε_max + max zone
  radius*) uses the **maximum** radius and is unaffected.

### A1.11 Escalation hysteresis — the watermark rule (D3)

`new_fire` is decided at most once ever by D3's idempotency key, but `escalation` had no
protection against score oscillation (FLR *monitors* flip-flop; nothing *prevented* it).

- **The idempotency key generalizes** to `UNIQUE (zone_id, event_id, alert_type,
  alert_subkey)` — the shape digests already used. Subkeys: `new_fire` = constant (still
  at most once, ever); `digest` = window start (unchanged); **`escalation` = the ladder
  step**.
- **Watermark:** per `(zone_id, event_id)` keep `escalation_watermark` — the highest
  ladder step ever notified. An escalation is decided only when the current step is
  **strictly greater** than the watermark; on decision the watermark is raised. It never
  decreases: a downgrade does not notify (D4, unchanged) and does not lower it, so
  re-crossing an already-notified step collides with the existing row and is a no-op.
  **Only a new higher step can fire.**
- **Ladder v1** — config-as-data, versioned like the gate and stamped as `rule_version`
  on the row: (1) score-bucket upgrade Likely → Confirmed; (2) burned-area doubling
  relative to the last notified area, with a 10 ha floor; (3) lifecycle worsening —
  re-detection after `signal_weakening`/`no_longer_detected`, including the reignition
  link (A1.6).
- The ~6 h suppression window and the digest floor compose on top, unchanged.

### A1.12 B-budget cutoff determinism, deferral metrics, multi-zone tie-break (D4/D5/D9)

- **Deterministic cutoff at B = 500.** Recipients are ranked in **decision order** —
  `(priority, decided_at, id)`, the dispatcher's own claim order — and the rank is
  stored on the row as `budget_seq`, computed once inside the decision transaction.
  Ranks ≤ 500 release automatically; the rest go to `awaiting_approval` (A1.4). The cut
  is therefore reproducible from the rows alone in replay and audit. No randomization,
  and deliberately **not** distance ordering (a distance-ordered cut is not stable
  across geometry revisions).
- **Deferrals are visible, never silent.** Added to D9's instrumentation:
  `fw_alert_sends_deferred_total{reason}` (rows entering `awaiting_approval`),
  `fw_alert_approval_pending_seconds` (age of the oldest awaiting row), and
  `fw_alert_sends_dropped_total{reason}` with
  `reason ∈ {expired_unapproved, ttl_expired}` for approvals landing after the 6 h queue
  expiry or the 1800 s push TTL. **Pages:** oldest awaiting row > 30 min (a
  mass-notification decision is waiting on a human); any `sends_dropped` increment (an
  approval that arrived too late is an incident, not a log line).
- **Multi-zone tie-break.** When one user has several zones matching the same event, the
  digest floor still sends **one** notification, rendered from the **nearest zone** —
  smallest distance from the (coarsened) zone center to the event geometry, ties broken
  by **lowest zone id**. That zone's name, template and distance band render. All
  matching `(zone_id, event_id)` states advance, so a second zone cannot re-fire later
  for the same event; the nearest zone is re-evaluated per decision.

### Original text superseded by this amendment

D1's three-value `trigger_type` and the bare "5-year" retention phrase (A1.1, A1.3);
D3's `UNIQUE (zone_id, event_id, alert_type)` key, now four-column (A1.11), and its
`none` start state at zone creation (A1.8); the Consequences bullet on the two-person
rule, which now reads with A1.4's solo fallback. Everything else in ADR-004 stands.
