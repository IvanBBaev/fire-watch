# Legal launch checklist (mapped to review 09)

> **DRAFT — requires legal review.** TASKS I6 is "done when the 09 launch checklist is
> green". Review 09 has no single checklist, so this file assembles one from its gates
> (§1), its risk register (§9) and its lawyer questions (§10). It is **not green**: every
> row below has a status, and only DONE counts.

Status legend:

| Status           | Meaning                                                             |
| ---------------- | ------------------------------------------------------------------- |
| **DONE**         | Done and verifiable.                                                 |
| **DRAFT**        | An artifact exists and awaits review.                                |
| **BUILT**        | Code exists but is not live, or not ticked.                          |
| **OPEN**         | Not started.                                                         |
| **FOUNDER**      | Waits on a founder decision.                                         |
| **⚖**            | Waits on the lawyer.                                                 |

## 1. [GATE-MVP] — free public map, no accounts

| #   | Item (09 §1)                                    | Evidence                                                                                                                                               | Status |
| --- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| M1  | Attribution block with the first public map (§2.4; risk 4) | Registry `packages/contracts/src/credits.ts`; gate CI-13 (`docs/GATES.md`) is live with **9 recorded findings**, e.g. the Copernicus wording, the OSM licence link and the OpenFreeMap credit missing from the map corner. TASKS G5 is unticked | BUILT — findings open |
| M2  | EOX / Esri imagery decision (§2.2.H–I; risk 3)   | EOX 2018+ dropped (`docs/DATA-SOURCES.md:503`, ADR-001 A1.3). Esri only via the ALP account, as an opt-in toggle (`server/src/app/imagery-config.ts`)       | DONE (EOX); FOUNDER (Esri account, DPF check, [dpa-inventory.md](dpa-inventory.md) D6) |
| M3  | Product name clearance (§7; risk 9)             | No record in the repo                                                                                                                                  | OPEN / FOUNDER |
| M4  | Privacy policy + layered disclaimer skeleton    | `web/src/ui/pages/privacy.tsx` (TASKS I5: built, 29 keys pending founder review, EN+BG legal review pending)                                            | BUILT ⚖ |
| M5  | ePrivacy: no non-essential cookies or trackers (§4.6) | Map needs no auth; only the session cookie at v1                                                                                                 | DONE (keep it) |

## 2. [GATE-v1] — accounts, alerts, paid membership

| #    | Item (09 §1, §5)                                                     | Evidence                                                                                                  | Status |
| ---- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------ |
| V1   | Operate through an ЕООД (§6; risk 1)                                  | —                                                                                                         | FOUNDER |
| V2   | Consumer ToS with the liability architecture (§3.4; risk 2; Q1)       | —                                                                                                         | OPEN ⚖ |
| V3   | VAT posture (§6.3; risk 7)                                            | —                                                                                                         | FOUNDER |
| V4   | Withdrawal-right mechanics for paid services (§4.7; Q11)              | —                                                                                                         | OPEN ⚖ |
| V5   | Legal basis for each processing activity (§5.1)                       | [ropa.md](ropa.md) §2; [lia.md](lia.md)                                                                    | DRAFT ⚖ |
| V6   | C-184/20 position documented in the DPIA (§5.2; Q2)                   | [dpia.md](dpia.md) §4                                                                                      | DRAFT ⚖ |
| V7   | Telegram designed as user-directed (§5.3; Q3)                         | Chat id only, user-initiated link (`server/db/migrations/012_channel_opt_in.sql:44–45`); [dpa-inventory.md](dpa-inventory.md) D3 | BUILT ⚖ |
| V8   | Push endpoints treated as personal data (§5.4)                        | In the RoPA, the export and erasure. **Not encrypted at rest** ([ropa.md](ropa.md) §7)                     | BUILT — gap |
| V9   | Transfer map (§5.5)                                                   | [dpa-inventory.md](dpa-inventory.md) §2                                                                    | DRAFT, FOUNDER (DB host, mail region, Esri) |
| V10  | RoPA (§5.6; risk 5)                                                   | [ropa.md](ropa.md)                                                                                          | DRAFT ⚖ |
| V11  | DPIA before v1 (§5.7; risk 5)                                         | [dpia.md](dpia.md), sign-off table empty                                                                    | DRAFT ⚖ |
| V12  | Processor DPAs signed (Art. 28)                                       | [dpa-inventory.md](dpa-inventory.md) §3, all unchecked                                                      | FOUNDER |
| V13  | Breach runbook + КЗЛД 72 h templates (05 §5.3.7)                      | [breach-runbook.md](breach-runbook.md); BG texts are skeletons                                              | DRAFT ⚖ |
| V14  | Right of access / portability (Art. 15, 20)                           | `server/src/adapters/http/account-export-route.ts`: built, **not registered** (waits on I1 auth + mailer)   | BUILT |
| V15  | Right to erasure (Art. 17)                                            | `server/src/core/erasure/erase-account.ts` (TASKS I4). Grace period and restore-replay runbook still open   | BUILT |
| V16  | Retention enforced (05 §5.3.3)                                        | Outbox pseudonymization jobs are **unarmed** until ratified (`server/src/app/worker.ts:34`); several purges are not built ([ropa.md](ropa.md) §7) | OPEN / FOUNDER |
| V17  | Evidence file: dispatch and provenance logs (§3.6; risk 2; Q5)        | `alert_outbox` send log (001), [lia.md](lia.md) LIA-2                                                       | BUILT ⚖ |
| V18  | Never-all-clear invariant (risk 2)                                    | `server/db/migrations/001_initial_schema.sql:461–463`                                                      | DONE |
| V19  | Double opt-in on channels (05 §5.3)                                   | `012_channel_opt_in.sql`, TASKS I3 (built, not ticked)                                                      | BUILT |
| V20  | Euro dual display at paid launch (§4.7; Q7)                           | —                                                                                                         | ⚖ |
| V21  | Breach rehearsal before the season                                     | [breach-runbook.md](breach-runbook.md) §8                                                                  | OPEN |

## 3. [GATE-v2] — B2B, API, webhooks

| #   | Item                                                                  | Status |
| --- | --------------------------------------------------------------------- | ------ |
| B1  | SLA as process promises (§3.5; risk 8)                                 | OPEN |
| B2  | B2B liability caps                                                    | OPEN ⚖ |
| B3  | Data Act switching clauses (§4.5)                                     | OPEN |
| B4  | EUMETSAT / EFFIS terms re-verified for API redistribution (§2.2; Q4)   | OPEN ⚖ |
| B5  | B2B Art. 28 DPA template; role flip to processor (§5.7; Q12)           | OPEN ⚖ |
| B6  | Professional-indemnity insurance (Q10); PLD watch date 09.12.2026 (risk 10) | OPEN |

## 4. Crowdsourcing gate (whichever release ships reports)

| #   | Item                                                                  | Status |
| --- | --------------------------------------------------------------------- | ------ |
| C1  | DSA hosting mechanics and classification memo (§4.2; Q9; risk 6)       | OPEN ⚖ |
| C2  | Content licence clause (§8.1)                                          | OPEN ⚖ |
| C3  | Moderation capacity (05 §5.2.5)                                        | OPEN / FOUNDER |
| C4  | DPIA revision: new data category (photos, EXIF location)               | OPEN ([dpia.md](dpia.md) §8) |

## 5. Lawyer questions (09 §10), with where each one lands

| Q   | Topic                                     | Answer goes into                          | Status |
| --- | ----------------------------------------- | ----------------------------------------- | ------ |
| 1   | ToS + privacy policy review               | V2, M4                                    | ⚖ |
| 2   | C-184/20 / Art. 9                         | [dpia.md](dpia.md) §4                      | ⚖ |
| 3   | Telegram characterization                 | [dpa-inventory.md](dpa-inventory.md) D3    | ⚖ |
| 4   | EUMETSAT / EFFIS tier                     | B4                                        | ⚖ (v2) |
| 5   | Log retention vs minimization             | [lia.md](lia.md) LIA-2                     | ⚖ |
| 6   | Hybrid ЕООД/ЮЛНЦ tax                      | V1 (only if the hybrid is pursued)        | ⚖ |
| 7   | Euro dual display                         | V20                                       | ⚖ |
| 8   | Register.BG `.bg` eligibility             | M3                                        | ⚖ |
| 9   | DSA classification                        | C1                                        | ⚖ |
| 10  | PI insurance                              | B6                                        | ⚖ (v2) |
| 11  | Withdrawal-right edge case                | V4                                        | ⚖ |
| 12  | B2B DPA template                          | B5                                        | ⚖ (v2) |

Additional questions raised by this artifact set, which go to the same lawyer:

- the DPO requirement ([ropa.md](ropa.md) §1);
- the export positions E1–E6 ([dpia.md](dpia.md) §6);
- the erasure grace period;
- the backup class of `erasure_requests`;
- Esri's role;
- the accepted КЗЛД notification channel ([breach-runbook.md](breach-runbook.md) §6).

## 6. What "green" means for I6

I6 can be ticked when all of the following hold:

1. every **[GATE-v1]** row above is DONE;
2. the DPIA sign-off table is signed;
3. the DPAs in [dpa-inventory.md](dpa-inventory.md) §3 are archived;
4. the export route is registered behind live auth.

MVP rows M1 and M3 are independent of I6, but they block the public launch.
