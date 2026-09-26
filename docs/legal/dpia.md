# Data protection impact assessment (GDPR Art. 35)

> **DRAFT — requires legal review.** Owner: founder. Review annually before fire season
> (05 §5.3.4) and whenever a trigger in §8 fires. Version: draft 1, 2026-09-24, covering
> accounts, watch zones and alerts (v1 scope). Facts about stored data cite the schema; the
> full column list is in [ropa.md](ropa.md).

## 1. Why a DPIA is done

The WP248 criteria met (05 §5.3.4; 09 §5.7):

1. **Location data / data of a highly personal nature.** A watch zone is, in practice, a
   home or property location (05 §5.3.1).
2. **Vulnerable data subjects.** People in moments of disaster exposure; many are elderly
   rural residents (09 §5.7).
3. **Systematic location-based monitoring** of those zones against satellite detections.
4. **Innovative use.** Satellite feeds × home geofences × automated notification.
5. Arguably **large scale** within the region (not yet).

Two criteria usually suffice. КЗЛД's Art. 35(4) list includes large-scale location tracking;
whether or not the service is "large scale", the DPIA is done voluntarily as the defensible
posture (05 §5.3.4).

## 2. Description of the processing

| Element            | Description                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------ |
| Nature             | A user signs in by magic link, draws a zone (a centre and radius, 2–30 km), and chooses channels (Web Push, e-mail, Telegram). A worker matches fire events against zones and sends alerts. |
| Scope              | Ten tables (the `personal` backup class): see [ropa.md](ropa.md) §3.                                          |
| Context            | Free public fire map; accounts and alerts are the v1 feature. Users expect alerts, not tracking.             |
| Purposes           | Deliver the alerts the user configured (6(1)(b)); keep evidence of what was sent (6(1)(f)).                   |
| Recipients         | See [dpa-inventory.md](dpa-inventory.md).                                                                     |
| Retention          | See [ropa.md](ropa.md) per table; personal backups ≤ 28 days (`server/src/core/erasure/erasure-horizon.ts`).  |

### 2.1 Data flow

1. **Sign-in.** An e-mail address goes into `auth_link_requests.email`
   (`server/db/migrations/007_accounts_auth_zone_privacy.sql:101`). Only the SHA-256 of the
   link token is stored (007:103). The session likewise stores only a token hash (007:123).
2. **Zone creation.** The browser sends a centre. The server coarsens it and seals it with
   AES-256-GCM under a key held outside the database (`centre_ciphertext`, `centre_key_id`,
   007:61–62; `server/src/adapters/crypto/aes-gcm-zone-cipher.ts`). It stores a ~5 km grid
   cell in clear for candidate lookup (`grid_cell`, 007:65). A sealed zone has no plaintext
   geometry, enforced by constraint (`watch_zones_sealed_shape`, 007:72–84).
3. **Matching.** The worker finds candidate zones by grid cell and decrypts only those
   candidates in memory, for the precise distance test. It writes an `alert_states` row and
   an `alert_outbox` row with bound `template_params`, never a rendered body
   (`001_initial_schema.sql:434`, `:457`, `:474`).
4. **Delivery.** The gateway renders each message and hands it to:
   - Amazon SES (`server/src/adapters/alerts/channels/email/ses-channel.ts`);
   - the browser's push service, RFC 8291 encrypted
     (`server/src/adapters/alerts/channels/web-push/encrypt.ts`);
   - the Telegram Bot API (`server/src/adapters/alerts/channels/telegram/telegram-channel.ts`).
5. **Retention.** After 24 months an outbox row is pseudonymized in place: the zone and
   subscription links are removed and zone-derived parameters are dropped. The row is then
   kept to 5 years (001:511–512).
6. **Erasure.** A single transaction deletes zones, states, shadow rows, confirmations,
   subscriptions, sessions and link requests. It pseudonymizes the outbox, tombstones the
   account and writes a ledger row (`server/src/core/erasure/erasure-plan.ts`). Triggers
   refuse any later write under the erased account (010:56–103).
7. **Export.** `account_export_v1` covers the same tables using the same predicates
   (`server/src/core/account-export/`).

## 3. Necessity and proportionality

| Question                          | Answer                                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Is the location necessary?        | Yes, because the service is "alert me about this area". The radius is at least 2 km and the centre is coarsened before storage (001:415–420), so the house itself is never needed. |
| Least data?                       | There is no name, no phone number, no postal address and no reverse-geocoded label (05 §5.3.2). The e-mail address is the only direct identifier. Sessions store a UA *family*, not the full user agent (007:105). |
| Is the lawful basis right?        | Art. 6(1)(b), not consent. The alert *is* the service, and consent withdrawal would break a safety feature (09 §5.1; 05 §5.3.3). |
| Can the user exercise rights?     | Export is built (Art. 15/20). Erasure is built (Art. 17). Rectification means editing zones and settings in the UI. Identity is proved by the login itself; no ID documents are ever copied (05 §5.3.7). |
| Is retention bounded?             | Partly. See [ropa.md](ropa.md) §7: several purge jobs are still proposals.                               |

## 4. Special-category data by inference: CJEU C-184/20

**Question.** In C-184/20 (OT, 1 August 2022) the CJEU held that data *liable indirectly
to reveal* a special category falls under Art. 9. A zone centre near a mosque, a monastery
or a mono-ethnic village could, in theory, support an inference about religion or
ethnicity. Is zone data therefore Art. 9 data?

**Position (09 §5.2): no, but the service behaves as if it were.**

1. Art. 9 is engaged where the processing, by its nature or purpose, tends to reveal the
   sensitive attribute. This processing performs **no inference**. The coordinate serves one
   purpose only, which is geometric: geofence matching.
2. The coordinate is sealed at rest (007:61, 007:72–84) and never disclosed to a third party.
   Alert content carries the event location and a distance band, never the zone (09 §5.3(c)).
   Any inference would therefore need a third party that holds data it can never receive.
3. The contrary reading would make every location datum Art. 9 data. That is not the
   Regulation's scheme.
4. The EDPB reads C-184/20 broadly, so this is a **position, not a certainty**. That is why
   the engineering posture stays at Art. 9 grade regardless:
   - app-layer encryption of the centre;
   - a coarse plaintext index only;
   - no analytics, segmentation or profiling on zone locations, ever. This is a written
     product invariant and must be stated in the privacy policy;
   - no disclosure of zones to anyone.

   With these controls in place, the classification question becomes academic.

⚖ **LEGAL** (09 §10 Q2): bless or amend this argument. If counsel classifies zones as Art. 9,
the fallback basis is Art. 9(2)(a) explicit consent for zone creation, with the
consent-withdrawal consequences stated in 05 §5.3.3.

## 5. Risks to data subjects

Likelihood (L) and severity (S) are rated before controls, then the residual level is given.

| #   | Risk                                                                                                     | L    | S    | Controls in place                                                                                              | Residual |
| --- | -------------------------------------------------------------------------------------------------------- | ---- | ---- | -------------------------------------------------------------------------------------------------------------- | -------- |
| R1  | Breach of the database exposes home locations joined to e-mail addresses                                 | Low  | High | Centres are sealed with the key outside the DB (007:61). A leaked dump yields only grid cells (007:65). Least-privilege role; separate personal backups, 28 days. | Low–Med |
| R2  | Zone key compromise together with a DB leak                                                              | Low  | High | Key rotation through `centre_key_id` (007:62, retired keys supported by the cipher). SEC-2 runbook ([breach-runbook.md](breach-runbook.md)). | Low      |
| R3  | Alert content reveals the approximate zone to Telegram or the mail provider                               | Cert.| Med  | Content minimization: event location plus distance band, no zone name or address (09 §5.3(c)). Telegram is opt-in and never the only channel. Disclosed in the policy. | Low–Med |
| R4  | Push endpoints and Telegram chat ids stored in plaintext (`channel_subscriptions.endpoint`, 001:403)      | Low  | Med  | Least-privilege role; personal backup class. **Gap:** 09 §5.4 asks for encryption at rest.                     | Med      |
| R5  | Tile and imagery CDNs see viewport + IP, which approximates home when the user looks at their zone (05 §5.3.6) | High | Low–Med | OpenFreeMap advertises no tracking. Esri imagery is opt-in and metered. Disclosed in the policy. Self-hosted PMTiles is planned for phase 2. | Low–Med |
| R6  | A false or missed alert causes harm (a safety risk, not a data-protection one)                             | Low–Med | V. high | Never-all-clear invariant (001:461–463). Provenance and dispatch evidence (P4). Breakers. INT-1 and INT-2 runbooks (05 §5.7.2). | Med      |
| R7  | Over-retention of send logs (5 years)                                                                     | Cert.| Low  | Pseudonymized at 24 months (001:511–512). Erasure pseudonymizes immediately. `RETAINED_TEMPLATE_PARAM_KEYS` is empty, so no zone-derived value survives. | Low      |
| R8  | An erased account is resurrected by restoring a backup                                                   | Low  | Med  | The erasure ledger lists hashes to replay (010:106). Personal backups are capped at 28 days (≤ `deadline_at`, 010:117–118). The restore replay runbook is still open (`ERASURE_OPEN_ITEMS`). | Low–Med |
| R9  | Account takeover through the magic link                                                                  | Low  | Med  | Single use, UA-family binding, rate limit and supersede (007:99–111). Session token hashed (007:123).          | Low      |
| R10 | The export file leaks after download                                                                     | Low  | Med  | Session-only, no ids in the request, `Cache-Control: no-store`, no token hashes in the file (`server/src/adapters/http/account-export-route.ts`). | Low      |

Prior consultation (Art. 36) is **not expected**: no residual risk remains high (05 §5.3.4;
09 §5.7).

## 6. Positions in the self-serve export that need review

The export (`account_export_v1`) lists every withheld column, with its reason, inside the
document itself. These positions are engineering's choices:

| #   | Position                                                                                              | Rationale                                                                                   | ⚖ Question |
| --- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------- |
| E1  | Withhold `alert_outbox.approver_id` and `actor_id` (001:503, 003:41)                                   | These identify an operator, so they are another person's data (Art. 15(4)). `approval_mode` and `trigger_type` are exported instead. | Is this a sufficient Art. 15(4) balance? |
| E2  | Withhold the three `token_hash` columns                                                               | A one-way hash of a credential is a security control, not information about the person. Exporting it widens the exposure if the file leaks. | Is the hash "personal data concerning" the user that Art. 15 requires us to give? |
| E3  | Export the **decrypted** centre; withhold the ciphertext and key id                                   | The ciphertext is not intelligible to the person. The centre is what the service holds about them. | Agree? |
| E4  | Include push endpoint URLs and Telegram chat ids                                                      | They are the person's own identifiers.                                                       | —           |
| E5  | Include soft-deleted zones                                                                            | They are still held until erasure, so Art. 15 covers them.                                   | Agree; also see the retention question in [ropa.md](ropa.md) §3.4. |
| E6  | Exclude access logs, provider-side delivery records and outbox rows already pseudonymized (`EXPORT_LIMITS`) | Pseudonymized rows can no longer be linked to the account. Logs are held only at the edge or host, for at most 30 days. | Must access logs be produced on request? |

## 7. Measures still to take before launch

1. Arm the retention jobs, or record why not ([ropa.md](ropa.md) §7).
2. Encrypt channel endpoints at rest (R4), or accept the risk in writing.
3. Write the restore-replay runbook for the erasure ledger (R8).
4. Rate-limit the export route and mount it with auth (currently it is unregistered).
5. Privacy policy that names every recipient in [dpa-inventory.md](dpa-inventory.md),
   including the viewport leak (05 §5.3.6) and Telegram (09 §5.3).
6. Choose the DB host in an EU region and sign its DPA.

## 8. Triggers for revision

Extend or redo this DPIA before shipping any of the following:

- crowdsourced geotagged photos (09 §5.7, §8);
- a new alert channel (Viber, SMS);
- B2B recipients registered by a customer, where the role flips to processor and an
  Art. 28 template is needed (09 §5.7, §10 Q12);
- any "everyone in this area" broadcast (05 §5.3.3);
- analytics of any kind that touches accounts.

## 9. Sign-off

| Role                   | Name | Date | Decision |
| ---------------------- | ---- | ---- | -------- |
| Controller (founder)   |      |      |          |
| Legal reviewer         |      |      |          |
