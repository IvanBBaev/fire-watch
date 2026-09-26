# Record of processing activities (GDPR Art. 30)

> **DRAFT — requires legal review.** Built from the schema as of migrations 001–012
> (2026-09-24). Purposes and bases follow 09 §5.1; retention follows 05 §5.3.3 and ADR-004
> A1.3. Where the code and the policy disagree, the code wins and the gap is listed under
> "Open".

## 1. Controller

| Field              | Value                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| Controller         | **FOUNDER DECISION**: the ЕООД that will operate the service (09 §1 [GATE-v1], §6). Not yet incorporated. |
| Representative     | Founder (name, address and ЕИК once registered)                                                  |
| Contact for rights | **FOUNDER DECISION**: a dedicated address, e.g. `privacy@<domain>`                                 |
| DPO                | ⚖ **LEGAL**: probably not required (Art. 37: no large-scale systematic monitoring as core activity). Confirm. |
| Supervisory authority | Комисия за защита на личните данни (КЗЛД), Sofia                                              |

Why a RoPA despite the Art. 30(5) derogation: the processing is continuous, not occasional
(09 §5.6).

## 2. Processing activities

| #   | Activity                                   | Purpose                                                        | Basis (09 §5.1)                     | Data subjects        | Tables                                                                  |
| --- | ------------------------------------------ | -------------------------------------------------------------- | ----------------------------------- | -------------------- | ----------------------------------------------------------------------- |
| P1  | Account creation and sign-in               | Passwordless (magic-link) authentication, sessions              | 6(1)(b)                             | Account holders      | `accounts`, `auth_link_requests`, `account_sessions`                     |
| P2  | Watch zones                                | Store the area the user asked to be alerted about               | 6(1)(b)                             | Account holders      | `watch_zones`                                                           |
| P3  | Alert decision and delivery                | Decide and send the alerts the user configured                  | 6(1)(b)                             | Account holders      | `alert_states`, `alert_outbox`, `channel_subscriptions`, `channel_confirmations` |
| P4  | Dispatch evidence (send log)               | Integrity and dispute resolution; liability defence (09 §3.6)   | 6(1)(f), see [lia.md](lia.md) LIA-2 | Account holders      | `alert_outbox` (pseudonymized after 24 months)                           |
| P5  | Shadow evaluation of candidate rule sets   | Test a new alert rule set against live zones before release      | 6(1)(f), see [lia.md](lia.md) LIA-4 | Account holders      | `alerts_shadow`                                                         |
| P6  | Erasure ledger                             | Prove an erasure ran; replay it after a backup restore           | 6(1)(c) (Art. 17 + Art. 5(2) accountability) ⚖ | Former account holders | `erasure_requests`                                                 |
| P7  | Public map, access logs, rate limiting     | Serve the map; security and abuse defence                        | 6(1)(f), see [lia.md](lia.md) LIA-1 | Any visitor          | none in Postgres (edge and host logs)                                    |
| P8  | Backups                                    | Disaster recovery                                                | Same as the source activity          | As source            | the `personal` set (see §4)                                             |
| P9  | Operator accountability                    | Record which operator approved or initiated a send               | 6(1)(f) (employment record)          | Operators (staff)    | `alert_outbox.approver_id`, `alert_outbox.actor_id`                      |

Not live and out of scope of this version: payments and invoicing (6(1)(b)+(c), ЗСч 10-year
retention), marketing consent lists, analytics, crowdsourced reports, B2B contacts. Each
needs a row here before it ships (09 §5.1).

## 3. Categories of personal data, per table and column

"Exp." is what the self-serve export returns (export schema, `EXPORT_COLUMNS`); "withheld"
columns are in `EXPORT_WITHHELD` with a reason shown to the user.

### 3.1 `accounts` — P1 (`001_initial_schema.sql:384`, `007_accounts_auth_zone_privacy.sql:91`)

| Column                                                | Personal?            | Exp. | Source                          |
| ----------------------------------------------------- | -------------------- | ---- | ------------------------------- |
| `id` (uuid)                                           | Pseudonymous id      | yes  | 001:385                         |
| `email`                                               | Yes — contact        | yes  | 007:92                          |
| `email_verified_at`                                   | Yes                  | yes  | 007:93                          |
| `timezone`, `quiet_hours_start`, `quiet_hours_end`, `new_fire_overrides_quiet_hours` | Yes — preferences | yes  | 001:388–392 |
| `created_at`, `deleted_at`                            | Yes                  | yes  | 001:393–394                     |

Retention: life of the account. On erasure the row becomes a tombstone: `email` and
`email_verified_at` NULL, preferences reset, only `id`, `created_at`, `deleted_at` survive
(erasure plan, `accounts` rule). 05 §5.3.3 plans a 30-day deletion grace; **the code erases
immediately** (`ERASURE_OPEN_ITEMS`, last item) — **FOUNDER DECISION**.

### 3.2 `auth_link_requests` — P1 (`007_accounts_auth_zone_privacy.sql:99`)

| Column                                          | Personal?                        | Exp.     | Source |
| ----------------------------------------------- | -------------------------------- | -------- | ------ |
| `email`                                         | Yes                              | yes      | 007:101 |
| `token_hash` (SHA-256; token never stored)      | Credential-derived               | withheld | 007:103 |
| `ua_family` (browser family, not the full UA)   | Yes (low)                        | yes      | 007:105 |
| `requested_at`, `expires_at`, `consumed_at`, `superseded_at` | Yes                  | yes      | 007:106–111 |

Retention: **FOUNDER DECISION** — no purge job exists yet; proposal: 30 days after
`expires_at` (long enough for the 3-per-hour limit and abuse review). Deleted on erasure
(selected by address).

### 3.3 `account_sessions` — P1 (`007_accounts_auth_zone_privacy.sql:120`)

| Column                                                   | Personal? | Exp.     | Source      |
| -------------------------------------------------------- | --------- | -------- | ----------- |
| `id`, `account_id`                                       | Yes       | yes      | 007:121,124 |
| `token_hash`                                             | Credential-derived | withheld | 007:123 |
| `ua_family`                                              | Yes (low) | yes      | 007:125     |
| `created_at`, `last_seen_at`, `expires_at` (sliding 30 d), `revoked_at` | Yes | yes | 007:126–130 |

Retention: **FOUNDER DECISION** — no purge job yet; proposal: 30 days after
`expires_at`/`revoked_at`. Deleted on erasure.

### 3.4 `watch_zones` — P2 (`001_initial_schema.sql:410`, `007_accounts_auth_zone_privacy.sql:59`)

| Column                                           | Personal?                  | Exp.     | Source      |
| ------------------------------------------------ | -------------------------- | -------- | ----------- |
| `id`, `account_id`, `name`                       | Yes (`name` is free text)  | yes      | 001:411–413 |
| `centre_ciphertext` (AES-256-GCM, 44 bytes)      | **Yes — high** (home location, sealed) | withheld as ciphertext; exported **decrypted** as `centre` | 007:61 |
| `centre_key_id`                                  | No (names a server key)    | withheld | 007:62      |
| `centre_coarsened`                               | Yes                        | yes      | 007:63      |
| `grid_version`, `grid_cell` (~5 km cell, plaintext index) | Yes (coarse location) | yes | 007:64–65 |
| `area` (legacy plaintext geography)              | **Yes — high**             | yes, as GeoJSON | 001:416, 007:60 |
| `radius_m` (2–30 km), `min_score`                | Yes                        | yes      | 001:420–422 |
| `created_at`, `deleted_at`                       | Yes                        | yes      | 001:423–424 |

A sealed zone has no plaintext geometry by constraint (`watch_zones_sealed_shape`,
007:72–84). Retention: life of the zone; soft-deleted zones stay until account erasure,
which hard-deletes every zone including soft-deleted ones (erasure plan). **FOUNDER
DECISION**: purge soft-deleted zones after N days rather than keeping them to erasure.

### 3.5 `channel_subscriptions` — P3 (`001_initial_schema.sql:397`, `012_channel_opt_in.sql:41`)

| Column                                        | Personal?                                    | Exp. | Source |
| --------------------------------------------- | -------------------------------------------- | ---- | ------ |
| `id`, `account_id`, `channel` (push/telegram/email) | Yes                                    | yes  | 001:398–400 |
| `endpoint` — e-mail address, Telegram chat id (digits only, 012:44–45), or Web Push endpoint URL | **Yes — online identifier** | yes | 001:403 |
| `created_at`, `revoked_at`, `confirmed_at`    | Yes                                          | yes  | 001:404–405, 012:41 |

Retention: until revoked; pruned on a permanent provider error or HTTP 410 (001:401–402).
Revoked rows remain until erasure — **FOUNDER DECISION** on a purge window. 09 §5.4 asks
for push endpoints to be encrypted at rest like other channel identifiers; **they are stored
in plaintext today** (open item, see [dpia.md](dpia.md) R4).

### 3.6 `channel_confirmations` — P3 (`012_channel_opt_in.sql:47`)

Columns: `id`, `account_id`, `channel`, `channel_subscription_id`, `token_hash` (withheld),
`issued_at`, `expires_at`, `consumed_at`, `superseded_at`, `revoked_at` (012:47–70). Double
opt-in evidence. Retention: **FOUNDER DECISION** (no purge job); deleted on erasure before
the subscriptions they name.

### 3.7 `alert_states` — P3 (`001_initial_schema.sql:434`)

Columns: `watch_zone_id`, `fire_event_id`, `state`, `escalation_watermark`, `seeded_at`,
`last_notified_at`, `updated_at` (001:435–450). Links a zone (and so a person) to a fire
near their home. Retention: life of the zone (cascade, 001:435). Deleted on erasure.

### 3.8 `alert_outbox` — P3, P4, P9 (`001_initial_schema.sql:457`, `003_outbox_actor_provenance.sql:41`)

| Column                                                | Personal?                       | Exp.     | Source |
| ----------------------------------------------------- | ------------------------------- | -------- | ------ |
| `watch_zone_id`, `channel_subscription_id`            | Yes — links the row to a person | yes      | 001:459, 477 |
| `template_params` (bound parameters, never a rendered body) | Yes (zone-derived values, e.g. distance) | yes | 001:474 |
| `fire_event_id`, `alert_type`, `alert_subkey`, `trigger_ref_seq`, `rule_version`, `template_id`, `channel`, `priority`, `budget_seq`, `status`, timestamps, `last_error` | Yes while linked | yes | 001:460–509 |
| `approver_id`, `approval_mode`, `approved_at`         | Operator data (employment record, 001:499–501) | `approver_id` withheld | 001:502–504 |
| `actor_id`                                            | Operator data                   | withheld | 003:41 |
| `pseudonymized_at`                                    | —                               | yes      | 001:513 |

Retention (ADR-004 A1.3, 001:511–512): **full fidelity for 24 months** from `decided_at`,
then pseudonymized in place (zone and subscription links NULL, `template_params` reduced to
`RETAINED_TEMPLATE_PARAM_KEYS`, which is empty today), kept until **5 years**. Erasure runs the
pseudonymization immediately and cancels unsent rows (`cancelled_erasure`, 001:495). The
24-month and 5-year jobs are **not armed** (`server/src/app/worker.ts:34`: "every retention
is unarmed until ratified"). ⚖ **LEGAL** 09 §10 Q5: is the 5-year retention defensible for all
users, or only once a dispute arises?

### 3.9 `alerts_shadow` — P5 (`006_shadow_tables.sql:76`)

Columns: `candidate_version`, `watch_zone_id`, `shadow_event_key`, `alert_type`,
`alert_subkey`, `trigger_type`, `rule_version`, `template_id`, `template_params`,
`decided_at`, `recorded_at` (006:76–98). Never sent to anyone. Retention: cascade with the
zone (006:79); **FOUNDER DECISION** on a time bound (proposal: 90 days after the candidate is
decided).

### 3.10 `erasure_requests` — P6 (`010_account_erasure.sql:106`)

Columns: `account_hash` (SHA-256 of the account id; withheld from export), `erased_at`,
`deadline_at` (≤ `erased_at` + 30 days by constraint, 010:117–118), `plan_version`,
`counts` (numbers only). Purged only through `purge_erasure_ledger`, which refuses anything
inside the 30-day horizon (010:123). Backup class `personal` as a fail-closed default
(010:170) — moving it to `main` is a **FOUNDER DECISION** (`ERASURE_OPEN_ITEMS`).

## 4. Backups (P8)

The `personal` class (001:530–543, 006:106, 007:139–141, 010:170, 012:83) is dumped
separately and expires at 28 days with no weeklies (`server/src/core/erasure/erasure-horizon.ts`;
OPERATIONS §6.2 rules 5 and 9), inside the 30-day horizon of ADR-004 A1.3 and 05 §5.3.3.
The `main` artifact carries only the pseudonymized projection of `alert_outbox`. Storage:
Cloudflare R2 (`server/src/adapters/backup/r2-backup-store.ts`).

## 5. Recipients and transfers

See [dpa-inventory.md](dpa-inventory.md). Summary: DB host (**FOUNDER DECISION**, EU region),
Cloudflare (R2, CDN), Amazon SES as mail provider in code
(`server/src/adapters/alerts/channels/email/ses-channel.ts`), browser push services (conduits),
Telegram (user-directed disclosure, 09 §5.3), OpenFreeMap and Esri (viewport leak, browser
side).

## 6. Security measures (Art. 32, summary)

- Zone centres sealed with AES-256-GCM under a key outside the database; matching on a
  coarse plaintext cell (007:59–85; `server/src/adapters/crypto/aes-gcm-zone-cipher.ts`).
- Tokens stored only as SHA-256 hashes (007:103, 007:123, 012:55).
- Runtime role `fire_watch_app` with table-level grants; the erasure ledger is insert-only
  (010:173–175).
- Refuse-write triggers stop data being recreated under an erased account (010:56–103).
- Personal backups separate and capped at 28 days (§4).
- No coordinates in application logs (05 §5.3.2); IP truncation/expiry per [lia.md](lia.md).

## 7. Open

1. Retention jobs for P1 (link requests, sessions), revoked subscriptions, confirmations,
   soft-deleted zones and shadow rows: not built. Periods above are proposals.
2. The 24-month / 5-year outbox jobs exist as policy but are unarmed.
3. Push endpoints not encrypted at rest (09 §5.4).
4. Deletion grace period (05 §5.3.3 says 30 days; code erases immediately).
