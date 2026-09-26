# Personal data breach runbook (SEC-1 / SEC-2)

> **DRAFT — requires legal review.** This runbook puts 05 §5.3.7 and §5.7.2 (SEC-1, SEC-2)
> into operational steps. The notification templates are working texts. The Bulgarian ones
> are skeletons that a native-speaking lawyer must finish; **only the Bulgarian version goes
> to КЗЛД**. On-call today is the founder (05 §5.7.2, bus factor 1).

## 0. Clock

The 72 hours of Art. 33(1) start when we become **aware** of a breach, meaning reasonably
certain that personal data was compromised. They do not start when the investigation ends.
Write the awareness time into the register (§5) first, before doing anything else.

| T+       | Must have happened                                                                  |
| -------- | ----------------------------------------------------------------------------------- |
| 0        | Register entry opened with the awareness time. Containment started (§2).            |
| ≤ 4 h    | Scope estimate per table (§3). Evidence preserved (§4).                              |
| ≤ 24 h   | Risk decision: notify КЗЛД? notify users? (§1). Draft notices.                       |
| ≤ 72 h   | КЗЛД notified (§6), or the reason for not notifying recorded. A phased notification is allowed (Art. 33(4)). |
| ASAP     | Users notified if the risk is high (Art. 34). For zone coordinates, **assume yes** (05 §5.3.7). |
| ≤ 30 d   | Postmortem, register closed, controls updated, DPIA revisited ([dpia.md](dpia.md) §8). |

## 1. Classify

| Class     | Trigger                                                                                   | Default notification                                   |
| --------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **SEC-1** | Confirmed or likely access to personal tables, backups or logs by someone unauthorized     | КЗЛД: yes. Users: yes if zones or addresses are involved |
| **SEC-2** | A credential or key is compromised, with no evidence of exfiltration                       | Rotate; audit the exposure window; escalate to SEC-1 if access is shown |
| INT-1/2   | Wrong or missed alert: an integrity incident, not a breach, unless personal data went to the wrong recipient | See 05 §5.7.2. A **misdirected alert** (zone data sent to another person's channel) **is SEC-1** |

Risk factors to record (EDPB Guidelines 9/2022): the type of data, how easily people can be
identified, how severe the consequences are, how many people are affected, and whether the
data was intelligible (encrypted or not).

## 2. Contain

1. **Stop dispatch** if the breach touches alerts or channels: create the kill-switch file,
   `touch "$FIRE_WATCH_STATE_DIR/alert-dispatch/kill-switch"`
   (`server/src/adapters/storage/fs-dispatch-control-store.ts:9`).
2. **Revoke sessions** for the affected accounts or all accounts. Sessions are server-side
   rows (`account_sessions.revoked_at`,
   `server/db/migrations/007_accounts_auth_zone_privacy.sql:130`). One UPDATE revokes all.
3. **Rotate the credential** that leaked:
   - DB role passwords;
   - `R2_*` keys;
   - SES keys;
   - the Telegram bot token (`/revoke` via BotFather);
   - VAPID keys (`server/src/adapters/alerts/channels/web-push/vapid.ts`; rotating them
     invalidates every push subscription, so the push channels have to be resubscribed).
4. **Zone key compromise.** The active key is `FIRE_WATCH_ZONE_KEY_ID` +
   `FIRE_WATCH_ZONE_KEY` (`server/src/app/zones-config.ts:11`). Steps:
   - add a new active key;
   - move the old key to `FIRE_WATCH_ZONE_KEYS_RETIRED`;
   - re-seal the rows.
   **Gap:** there is no re-seal tool yet. Until one exists, a leaked key together with a
   leaked database means the centres are readable. Treat that combination as coordinates
   exposed.
5. Preserve before you destroy (§4). Do not delete logs, rows or buckets as part of
   containment.

## 3. Scope: what an attacker got, per table

Run these queries on a **read-only** connection to a snapshot, not to the primary.

| Table                    | Personal content                                                            | Intelligible in a DB dump?                                                                                                                             | Scope query                                                                         |
| ------------------------ | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `accounts`               | E-mail address (007:92), verification time                                   | **Yes**                                                                                                                                                  | `SELECT count(*) FROM accounts WHERE email IS NOT NULL;`                            |
| `watch_zones`            | Zone name; sealed centre; 0.05° grid cell; radius                             | **Sealed centre: no without the key** (007:14–18). The **grid cell** (~5 km) and the zone **name**, which is user-typed and may name a village, are in the clear. Legacy plaintext `area` rows (001:416) are in the clear | `SELECT count(*) FILTER (WHERE centre_ciphertext IS NULL AND area IS NOT NULL) AS plaintext, count(*) AS total FROM watch_zones WHERE deleted_at IS NULL;` |
| `channel_subscriptions`  | E-mail, push endpoint or Telegram chat id                                     | **Yes**. Push endpoints are not encrypted at rest yet ([ropa.md](ropa.md) §7)                                                                           | `SELECT channel, count(*) FROM channel_subscriptions GROUP BY 1;`                   |
| `channel_confirmations`  | Token **hash** only (012:55)                                                  | No usable secret                                                                                                                                       | —                                                                                   |
| `auth_link_requests`     | E-mail, token hash                                                            | E-mail yes; token no                                                                                                                                   | `SELECT count(DISTINCT email) FROM auth_link_requests;`                             |
| `account_sessions`       | Token hash, UA family, timestamps                                             | Low                                                                                                                                                    | —                                                                                   |
| `alert_outbox`           | Which zone got which fire alert and when (24-month full window)               | **Yes**: links a person to a fire near home                                                                                                            | `SELECT count(*) FROM alert_outbox WHERE pseudonymized_at IS NULL;`                 |
| `alert_states`, `alerts_shadow` | Per-zone evaluation state                                              | Linkable through the zone                                                                                                                              | counts                                                                              |
| `erasure_requests`       | sha256 of the account id                                                      | No                                                                                                                                                     | —                                                                                   |
| Backups (R2, `personal`, ≤ 28 d) | All of the above as of the backup date                                | As for the DB. Check which backups the leaked key could read (`server/src/adapters/backup/r2-backup-store.ts`)                                           | list objects in the exposure window                                                 |
| Access logs              | IP, UA (≤ 30 d)                                                               | Yes                                                                                                                                                    | host/CDN log export                                                                 |

Affected people = the distinct `account_id`s reachable from the exposed rows. Get the
notification addresses from `accounts.email`.

## 4. Preserve evidence (WORM)

05 §5.3.7 requires the audit and access logs to be copied to write-once storage:

1. Copy the host, CDN and DB audit logs for the exposure window to an R2 bucket with an
   object lock (retention ≥ 1 year), or to offline media. Record the SHA-256 of each file in
   the register.
2. Snapshot the DB (the snapshot is itself personal data: store it under the same controls,
   and delete it when the case closes).
3. Suspend the retention jobs that would delete evidence (the outbox pseudonymization, the
   ledger purge) for the affected rows until the case closes. **Record that you did.**

## 5. Internal breach register (Art. 33(5))

Every breach goes in the register, **including the ones not notified**. Keep it outside the
production DB (a private document).

| Field                              | Value |
| ---------------------------------- | ----- |
| Ref                                | SEC-YYYY-NN |
| Awareness time (UTC and EET/EEST)  | |
| How detected                       | |
| Class (SEC-1 / SEC-2)              | |
| Data categories and tables (§3)    | |
| Approx. number of people / records | |
| Intelligible? (encryption state)   | |
| Consequences assessed              | |
| КЗЛД notified? When? Ref no.       | yes / no, and why not |
| Users notified? When? How?         | yes / no, and why not (Art. 34(3)) |
| Measures taken                     | |
| Closed                             | |

## 6. Contacts

| Party                             | Contact                                                                  |
| --------------------------------- | ------------------------------------------------------------------------ |
| КЗЛД (Commission for Personal Data Protection) | **FOUNDER DECISION / verify**: current breach-notification form and e-portal on cpdp.bg; address: 1592 Sofia, 2 Prof. Tsvetan Lazarov Blvd. ⚖ confirm the accepted channel (e-signature?) |
| Controller signatory              | **FOUNDER DECISION** (ЕООД manager)                                       |
| Lawyer                            | **FOUNDER DECISION**                                                      |
| Processors' security contacts     | from [dpa-inventory.md](dpa-inventory.md) §3 once the DPAs are signed        |

## 7. Templates

### 7.1 Art. 33 notification to КЗЛД — EN working text

> **Subject:** Personal data breach notification under Art. 33 GDPR — [Controller name],
> ref. SEC-YYYY-NN
>
> 1. **Controller:** [ЕООД name], UIC [ЕИК], [address]. Contact: [name, e-mail, phone].
>    DPO: [none appointed / name].
> 2. **Awareness:** we became aware of the breach on [date, time EET]. The breach occurred
>    [on / between] [dates]. [If later than 72 h: reasons for the delay.]
> 3. **Nature:** [confidentiality / integrity / availability] breach. [One-paragraph
>    description: what happened, how it was discovered.]
> 4. **Categories and approximate numbers:** about [N] data subjects (registered users of
>    the fire-alert service); about [M] records. Categories:
>    - e-mail addresses;
>    - the approximate location of user-defined alert zones [encrypted with a key that was /
>      was not compromised; grid cell of ~5 km in clear];
>    - notification channel identifiers;
>    - alert history.
>    No special-category data is processed. We have nonetheless treated the location data
>    as sensitive, because it may reveal a home location.
> 5. **Likely consequences:** [e.g. the approximate home area of affected people could be
>    known to a third party; phishing using the e-mail address].
> 6. **Measures taken and proposed:**
>    - [containment];
>    - [credential and key rotation];
>    - [sessions revoked];
>    - [users notified on (date) / will be notified];
>    - [further measures].
> 7. **Communication to data subjects:** [done on (date) via (channel) / not done because
>    (Art. 34(3) ground)].
> 8. **Phased notification:** [This is an initial notification; we will supplement it by
>    (date).]

### 7.2 Art. 33 notification to КЗЛД — BG skeleton

> **Относно:** Уведомление за нарушение на сигурността на личните данни по чл. 33 от
> Регламент (ЕС) 2016/679 — [наименование на администратора], реф. SEC-YYYY-NN
>
> 1. **Администратор:** [наименование на ЕООД], ЕИК [ЕИК], [адрес]. Лице за контакт:
>    [име, имейл, телефон]. Длъжностно лице по защита на данните: [няма / име].
> 2. **Узнаване:** [дата, час]. **Период на нарушението:** [дати]. [Причини за забавяне,
>    ако е след 72 часа.]
> 3. **Естество на нарушението:** [поверителност / цялост / наличност]. [Описание.]
> 4. **Категории и приблизителен брой субекти и записи:** [N] субекта; [M] записа.
>    Категории: [имейл адреси; приблизително местоположение на зони за известяване; …].
> 5. **Вероятни последици:** […]
> 6. **Предприети и предложени мерки:** […]
> 7. **Уведомяване на субектите:** [извършено на … / не е извършено, защото …].
> 8. **Поетапно уведомяване:** [ще бъде допълнено до …].
>
> ⚖ _To be completed and checked by the lawyer against the current КЗЛД form._

### 7.3 Art. 34 notice to affected users — EN working text

Send it through e-mail (`accounts.email`), not through a channel that may itself have been
compromised. Plain language; no alert-style wording.

> **Subject:** Important: a security incident affecting your [service name] account
>
> On [date] we discovered that [plain description, e.g. "an unauthorised person accessed a
> copy of our database"]. It included your e-mail address and [the approximate area of your
> alert zones, which we store in encrypted form / the ~5 km grid square of your zones].
>
> **What this could mean for you:** [e.g. someone could learn the general area your zones
> cover, which may be near your home. Be alert to e-mails that pretend to be from us.]
>
> **What we have done:**
> - [stopped the access];
> - [signed every account out];
> - [replaced our keys];
> - [reported this to the Bulgarian data protection authority (КЗЛД)].
>
> **What you can do:**
> - sign in again with a new link;
> - review or delete your zones;
> - download a copy of your data [link], or delete your account [link].
>
> Questions: [contact]. You can also complain to КЗЛД (cpdp.bg).
>
> We are sorry. [Founder name], [ЕООД name]

### 7.4 Art. 34 notice to affected users — BG skeleton

> **Относно:** Важно: инцидент със сигурността, засягащ Вашия профил в [услуга]
>
> На [дата] установихме, че [описание]. Засегнати са Вашият имейл адрес и [приблизителното
> местоположение на зоните Ви за известяване / квадрат от ~5 км].
>
> **Какво може да означава това за Вас:** […]
>
> **Какво направихме:** […]
>
> **Какво можете да направите:** […]
>
> Въпроси: [контакт]. Имате право да подадете жалба до КЗЛД (cpdp.bg).
>
> ⚖ _To be finished by a native-speaking lawyer; keep the tone factual, never alarming._

## 8. Rehearsal

Run a tabletop exercise of SEC-1 (leaked backup) before the first fire season with live
accounts (05 §5.7.2 "rehearse pre-season"). Record it in the register as an exercise.
