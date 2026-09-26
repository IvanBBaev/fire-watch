# Legal artifact set (TASKS I6)

> **DRAFT — requires legal review.** Nothing in this directory is legal advice or a
> ratified position. These are working drafts, written by engineering from the code and the
> review corpus, for a Bulgarian data-protection lawyer to correct and sign off. Where a
> fact needs the founder or the lawyer, it is marked **FOUNDER DECISION** or **⚖ LEGAL**.

| File                                       | Artifact                                                 | GDPR anchor       |
| ------------------------------------------ | -------------------------------------------------------- | ----------------- |
| [dpia.md](dpia.md)                         | Data protection impact assessment, incl. CJEU C-184/20    | Art. 35, 36       |
| [ropa.md](ropa.md)                         | Record of processing activities, per table and column     | Art. 30           |
| [dpa-inventory.md](dpa-inventory.md)       | Processors, recipients, conduits and the transfer register | Art. 28, 44–49   |
| [lia.md](lia.md)                           | Legitimate interest assessments                           | Art. 6(1)(f)      |
| [breach-runbook.md](breach-runbook.md)     | Breach runbook with КЗЛД 72 h and data-subject templates   | Art. 33, 34       |
| [launch-checklist.md](launch-checklist.md) | Launch checklist mapped to review 09's gates and questions | —                 |

## How claims are cited

Every statement about what the system stores cites where it comes from, in the form
`server/db/migrations/<file>.sql:<line>` or a source path. Line numbers are those of the
migrations as of 2026-09-24 (migrations 001–012). A statement without a citation is a
position or a plan, not a fact about the system.

Short names used throughout:

- **09** — `docs/reviews/09-legal-licensing.md` (legal review; §5 is the GDPR delta).
- **05** — `docs/reviews/05-security.md` (security review; §5.3 is GDPR engineering,
  §5.7.2 is incident response).
- **ADR-004** — alert pipeline decisions, including A1.3 (retention and pseudonymization).
- **Erasure plan** — `server/src/core/erasure/erasure-plan.ts` (`erasure_plan_v5`).
- **Export schema** — `server/src/core/account-export/export-schema.ts` (`account_export_v1`).

## What the code already guarantees

- **One list of personal tables.** The `personal` backup class (`table_backup_class`,
  `server/db/migrations/001_initial_schema.sql:47`), the erasure plan and the export schema
  cover the same ten tables. A unit test (`server/src/adapters/db/pg-account-export.test.ts`)
  holds the export statements to the erasure plan. An integration test
  (`server/src/adapters/db/pg-account-export.integration.test.ts`) holds both to the live
  schema: every column of every personal table is either exported or withheld with a reason.
  A new personal column therefore cannot ship without appearing in this RoPA's source list.
- **Erasure** is implemented (`server/src/core/erasure/erase-account.ts`); the ledger is
  `erasure_requests` (`server/db/migrations/010_account_erasure.sql:106`).
- **Export** (Art. 15/20) is implemented but **not mounted**
  (`server/src/adapters/http/account-export-route.ts`). No user can sign in until the mailer
  is live, so no personal data is collected in production today.

## Status

Accounts, zones and alerts are **not live**. No production database has run migrations
005–012 yet. This set exists so that the v1 gate (09 §1, [GATE-v1]) is not blocked on paperwork
when the code is ready.
