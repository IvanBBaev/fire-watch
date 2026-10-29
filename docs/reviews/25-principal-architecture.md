# Review 25 — Principal architecture (as built)

*Reviewer role: senior principal architect (boundaries, composition, contracts and versioning, modularity, capacity envelope). Date: 2026-10-30. Status: complete.*

*Inputs reviewed: ADR-001…005 and `docs/decisions/README.md`, `.dependency-cruiser.cjs`, `eslint.config.js`, the composition roots `server/src/app/api.ts`, `api-composition.ts`, `worker.ts`, `health-wiring.ts`, `config.ts` and every `server/src/app/*-wiring.ts`, `server/src/adapters/http/*`, `server/db/migrations/*` (001–036, 060), `packages/contracts/src/*`, the `schema_version` producers in `server/src/core` and consumers in `web/src/core`, `docs/V3-FEATURES.md`, `docs/V3-WORKPLAN.md`, TASKS (release progress, Track V2), reviews 01, 02, 13 and 00-summary round 4. GitHub state was read through the API (workflow runs on `main`, branch protection). A regex import-graph walk over `server/src` measured reachability from the production entrypoints (method in Appendix B). Project state: v1 not deployed, no host, 51/123 TASKS rows ticked, V3 work started (5/39 V3-WORKPLAN items done).*

---

## 1. Summary verdict

**CONDITIONAL GO for the May 2027 launch. The architecture as built still matches the ADRs it rests on. The risk is no longer in the design. It is in how much has been built around the design before the design has run once in production.**

1. **The boundaries hold, and a machine enforces them.** dependency-cruiser keeps the core pure (`server-core-is-pure`, `server-core-has-no-platform`), keeps contracts platform-neutral and keeps the web core framework-free. ADR-004's single sender has three exemptions. Each one is pinned by its own rule (`.dependency-cruiser.cjs`: `auth-mailer-reuses-transport-only`, `webhook-pinger-reuses-transport-only`). That is how an exemption should be granted.
2. **Most of review 01 landed.** It asked for an outbox, ADR-002 identity, snapshot-first reads, the hot-source mask, passes, SP promotion and curation through a port. All of these exist as code and ADRs. The things that did not land are operational, not structural: a host, a connection budget and a green CI.
3. **About 30 % of the server tree is unreachable from production.** From `api.ts` + `worker.ts`, 399 of 547 non-test files (70.6 % of lines) are reachable. With every `*-cli.ts` added as a root, about 90 % are reachable. About 8.4k non-fixture lines (staff, WebAuthn/TOTP, sandbox decoders, FireSat) are reachable from no entrypoint at all. Auth, accounts, zones and webhooks are reachable but switched off by default flags.
4. **ADR-005 D3 is false as written.** It says the frontend consumes TypeBox schemas from `@fire-watch/contracts`. No package depends on TypeBox. Most wire documents (snapshot, passes, lightning, wind, history, outlines) are versioned in server core and re-declared in `web/src/core` with literal `schema_version: 1|2`. Only fixture tests couple the two sides.
5. **Registry versioning is semantically wrong, and CI caught it.** V3-P4 reserved three non-polled sources. That bumped `SOURCE_REGISTRY_VERSION` to `source_registry_v2`, which now stamps every v1 FIRMS detection. The PostGIS integration job on `main` fails on exactly this (`pg-detection-store.integration.test.ts:176`).
6. **CI on `main` is red and `main` is not protected.** The red has been continuous since at least 2026-10-12. Failing jobs: migrations, stale `types.generated.ts`, supply chain, CI-12 timing. The branch-protection API returns 404. "Gate green" in WORKLOG means the local gate only.
7. **Capacity is not budgeted.** The worker runs about 18 loops in one process. Only 3 take an advisory lock (`worker.ts:237,265,399`). 16 wiring files each open their own `pg` pool, about 30+ connections across two processes. Nothing in docs or infra states a `max_connections` budget.

**GO is conditional on:** (a) `main` green in GitHub CI, with branch protection requiring it (E-1); (b) a V3 build freeze until v1 runs on the host for one week (E-2); (c) the registry-version semantics fixed before any real row is written (E-3); (d) the contracts decision of E-4 recorded as ADR-006 and the duplicated `schema_version` literals moved into `packages/contracts`; (e) a written connection and loop budget (E-6).

## 2. Strengths (sound as built)

- **Honest composition roots.** `api.ts` is 54 lines and `api-composition.ts` is 87. Everything is wired explicitly in `*-wiring.ts`. There is no service locator and no DI container. Routes that depend on a secret or a vendor are registered only when that dependency is configured (`health-wiring.ts:426–433`). So a half-configured deploy fails closed, never open.
- **Fail-closed feature gating.** Auth needs `FIRE_WATCH_AUTH_ENABLED` *and* a complete mailer. The SES feedback route needs its topic ARN. Zones, exports and webhooks need their keyrings. This is the right pattern for building ahead. The cost is section 5.2.
- **Single-sender discipline survived two new channels.** I1 (auth mail) and V2-G2 (webhooks) both needed outbound I/O. Both went through narrow, rule-pinned exemptions and did not widen the gateway contract.
- **Advisory-lock loop guard exists** (`loopLocks.forLoop`) for the three loops whose double-run is unsafe: dispatch, ingest and alert evaluation. Clustering takes its own lock (`LIVE_RUN_LOCK_KEY = 7_331_002`, `pg-clustering-store.ts`).
- **Snapshot schema discipline.** `SNAPSHOT_SCHEMA_VERSION = 2` (`snapshot-builder.ts:47`). The v1→v2 change (uuid dropped) was deliberate, and fixtures were regenerated with it (`web/public/fixtures/snapshot.json`).
- **The migration check is set-based.** `checkMigrations` tolerates gaps, so the 060–071 V3 reservation does not break the boot checks.
- **The catalog-governance total map** (`catalog-governance.ts`, 1,444 lines) is large on purpose. It is a compiler-checked total `Record` over every catalog path (CI-11). It is not accidental size.

## 3. Risks & gaps

| # | Severity | Risk | Where |
|---|---|---|---|
| R-1 | Critical | GitHub CI on `main` has been red since at least 2026-10-12. Branch protection is absent (API 404). Every "gate green" claim since then means local only, and the integration suite is not in `pnpm verify`. | gh runs 38319673396 … 40939772318; `gh api repos/:o/:r/branches/main/protection` → 404 |
| R-2 | High | Reserving IDs bumps the provenance stamp. `SOURCE_REGISTRY_VERSION = 'source_registry_v2'` now labels v1 FIRMS rows, though nothing about how they are read changed. The integration test asserting `v1` fails. | `packages/contracts/src/sources.ts:77`; `server/db/migrations/060_source_registry_v2.sql`; `pg-detection-store.integration.test.ts:176` |
| R-3 | High | Building V2/V3 ahead of an undeployed v1. 29.4 % of server lines are unreachable from the prod roots, and ~8.4k lines from any root. The flag-dark surfaces (auth, accounts, zones, webhooks, staff) carry review, migration and erasure-plan cost (erasure plan v8) with zero users. | reachability walk (App. B); `health-wiring.ts:426–433`; TASKS Track V2; V3-WORKPLAN (17 todo, 17 blocked) |
| R-4 | High | ADR-005 D3 and `decisions/README.md:79,82` claim TypeBox contracts shared verbatim. No package depends on TypeBox. Wire shapes are duplicated in server core and web, held together by literals. | `docs/decisions/005-frontend-stack.md:59`; `web/src/core/passes.ts:49,178`, `lightning.ts:44,131`, `wind.ts:20,87`, `fire-outlines.ts:53,152`, `history-body.ts:179`, `pass-swaths.ts:68`, `ui/event/lightning-context-note.tsx:40` |
| R-5 | High | `server/src/db/types.generated.ts` drifted from the migrations on `main`, and the codegen check failed in CI. Kysely types are the compile-time contract with the schema. | gh run 40767718700 (cf40cc8) |
| R-6 | Medium | Worker capacity is unbudgeted: ~18 loops in one process, 3 locked, 16 independent pools (~30+ connections). No `max_connections` or pool budget is documented. There is no worker load test, only the API loadtest smoke. A second worker instance would double-run 15 unlocked loops. | `server/src/app/worker.ts`; `grep createPgPool server/src/app` (16 files); `grep -ri max_connections docs infra` → empty |
| R-7 | Medium | Migration-number policy conflicts with itself. After K4 the policy says "renumber at merge", but advisory lock classes derive from the migration number (`pg_advisory_xact_lock(7063, …)`). `db:migrate` runs dbmate without `--strict`, so out-of-order application on a live database is silent. | `docs/V3-WORKPLAN.md:121`; `server/package.json:28` |
| R-8 | Medium | No modularity limit. 125 non-test files exceed 300 lines, 41 exceed 500 and 10 exceed 800. `config.ts` is 959 lines with 38 env vars; `server/src` reads 81 distinct `FIRE_WATCH_*` vars. No `max-lines` or complexity rule exists. | `eslint.config.js`; `server/src/app/config.ts`; `pg-clustering-store.ts` (1,282), `pg-staff-store.ts` (820), `polling-feed.ts` (715) |
| R-9 | Low | `no-orphans` is `warn`, so the fully unreachable files of R-3 never fail the boundary gate. | `.dependency-cruiser.cjs:22–23` |
| R-10 | Low | Contracts version only 4 documents (`SOURCE_REGISTRY_VERSION`, `WEBHOOK_PAYLOAD_VERSION`, `CEMS_OVERLAY_SCHEMA_VERSION`, `OUTLINE_SERIES_SCHEMA_VERSION`). Ten other versioned wire documents keep their version constant in server core, where the web cannot import it. | `packages/contracts/src/*`; 21 server vs 10 web files using `schema_version` |

## 4. Detailed recommendations

**E-1 [MVP] → R-1, R-5. Make GitHub CI the gate.** Fix the three red jobs (registry assertion via E-3, codegen, supply chain). Then turn on branch protection for `main` with the CI jobs required, and add the PostGIS integration job to the required set. Record in TASKS that a row may be ticked only on a green remote run. *Owner:* agent + founder (protection setting). *Effort:* 4 h Opus + 0.25 founder-h.

**E-2 [MVP] → R-3. V3 build freeze and dark-code ledger.** No new V3-WORKPLAN item starts until v1 has run on the host for 7 days with the J-series monitors green. Add `docs/DARK-CODE.md`, generated by a script, listing every module unreachable from `api.ts`/`worker.ts` or reachable only behind a default-off flag. Each entry names its flag, its owning TASKS row and a kill date. *Owner:* founder (freeze), agent (ledger script). *Effort:* 0.5 founder-h + 4 h Opus.

**E-3 [MVP] → R-2. Split registry identity from provenance.** A detection row should be stamped with the version of the *parsing and normalisation rules* that produced it, not with the size of the source catalogue. Options: (a) keep `source_registry_v1` on FIRMS rows and bump per source; (b) leave reserved sources out of the version (`reserved` does not count as a change). Recommendation: (b), plus a contract test that reserving a source does not change the stamp. Revert the stamp to `v1` before any real row exists, which costs nothing today. *Owner:* agent. *Effort:* 3 h Opus.

**E-4 [v1] → R-4, R-10. ADR-006: contracts are plain TypeScript, versions live in contracts.** Accept what was built: plain TS types plus hand-written validators, no TypeBox. Supersede ADR-005 D3 and fix `decisions/README.md:79,82`. Move every wire-document type and its `*_SCHEMA_VERSION` constant into `packages/contracts`. Replace the web literals with imports, and add a type-level test (`satisfies`) on both sides. Re-introducing TypeBox now buys runtime validation the code already does by hand, at the cost of a dependency and a migration. *Owner:* agent (ADR draft), founder (ratify). *Effort:* 10 h Opus + 0.5 founder-h.

**E-5 [v1] → R-3, R-9. Reachability gate.** Add a CI check: no file under `server/src` outside fixtures/testkits may be unreachable from the union of `api.ts`, `worker.ts` and `*-cli.ts`, unless it is listed in the E-2 ledger. Raise `no-orphans` to `error` with the same allowlist. *Owner:* agent. *Effort:* 4 h Opus.

**E-6 [MVP] → R-6. Connection and loop budget.** Write a section in OPERATIONS that tables every pool (wiring file, `max`, process), the sum per process, the Postgres `max_connections` and its reserve for dbmate, backups and psql. Add a boot assertion that the sum is ≤ budget. Document "exactly one worker instance" as an invariant and enforce it with a process-level advisory lock taken at worker start, which covers the 15 unlocked loops in one move. Consolidate the read-mostly worker pools into one shared pool. *Owner:* agent. *Effort:* 6 h Opus.

**E-7 [v1] → R-7. Migration number policy that does not fight lock classes.** Never renumber. A merged-late migration keeps its number, and `db:migrate` stays set-based. Run `dbmate --strict` in CI against a database migrated up to the previous release tag, so an out-of-order file is visible and approved explicitly. Decouple lock classes from migration numbers via a registry constant in `server/src/adapters/pg/lock-classes.ts`. *Owner:* agent. *Effort:* 4 h Opus.

**E-8 [v2+] → R-8. Modularity limits.** Add ESLint `max-lines` (warn at 500, error at 900 for non-generated, non-catalog files, with an explicit allowlist). Split `config.ts` per wiring (each `*-config.ts` already exists for newer features; finish the move) and `pg-clustering-store.ts` into SQL, run-lock and query modules. *Owner:* agent. *Effort:* 8 h Opus.

**E-9 [v1] → R-6. Worker soak test.** A 6-hour local run with the live fixture feed, all default-on loops, PostGIS 16.4. Measure peak connections, loop overrun counts and RSS. It runs before K4 and again before the first host deploy. *Owner:* agent. *Effort:* 5 h Opus.

## 5. Principal architecture deep dive

### 5.1 ADR conformance, one by one

- **ADR-001 (single-VM, no serverless):** holds. Two Node processes, PostGIS, R2 as T2. No serverless code paths.
- **ADR-002 (identity and clustering):** holds. The detection UID lives in contracts (`detection-uid.ts`), the identity loop runs every 60 s, and clustering serialises itself with an advisory lock.
- **ADR-003 (snapshot-first T1, SSE T0, R2 T2):** holds. The snapshot builder is versioned, SSE freshness ticks every 30 s and the mirror push is wired. E6 rehearsed T2 failover.
- **ADR-004 (only the gateway sends):** holds with three pinned exemptions. Any fourth exemption should require an ADR amendment, not only a new cruiser rule.
- **ADR-005 (framework-free core, Preact, TypeBox contracts):** framework-free core and Preact hold, and the cruiser enforces them. **D3 does not hold** (R-4). Under the convention in `decisions/README.md`, this needs ADR-006, not a silent edit.

### 5.2 The cost of building ahead

Measured: from the two production roots, 73,407 of 103,965 server lines are reachable. The CLIs add another ~20k (drills, fit, backfill, rehearsal). That is legitimate operator tooling, but it is code that no request ever runs. The remaining ~8.4k non-fixture lines have no root at all: staff sessions and stores (~3.2k), WebAuthn/TOTP (~0.9k), the LSA/MTG sandbox decoders and bunzip2 (~2.2k), FireSat (~0.4k) and shadow/lint/test helpers. On top of that, auth, accounts, zones, webhooks and staff routes are compiled into the API but default-off.

The tax is real and compounds:
- each of those surfaces added migrations (015–036), erasure-plan rows (plan v8), never-send lint scope, catalog paths and integration tests;
- each breaking change in a shared core type now has to compile through it;
- the one CI failure on `main` today came from V3 work (P4) touching a v1 provenance field.

None of these surfaces has a user, and none has run on a host. My recommendation is not to delete them, but to freeze (E-2), ledger (E-2) and gate (E-5) them, so the set can only shrink until launch.

### 5.3 Contracts and versioning

There are three layers, and only one is really shared:
1. `packages/contracts` holds the source registry, webhook payload, CEMS overlay, outline series, problem codes and detection UID. The web imports these, and they are sound.
2. Server-core document builders hold the snapshot (v2), passes, swaths, lightning (document/record v2, overlay v1), wind, cloud, history and the event lightning context, each with its own `*_SCHEMA_VERSION`.
3. Web parsers in `web/src/core/*` re-declare those shapes and compare against literals. `lightning-context-note.tsx:40` returns `null` on anything other than `1`. A server bump would therefore *silently hide* the note rather than fail a build.

Fixture tests (`swaths-document.test.ts:187`, `outline-series-fixtures.test.ts`) read `web/public/fixtures` and catch drift only for the fixtures that exist. E-4 moves layer 2's constants and types into layer 1. That makes a version bump a compile error on the web side, which is the guarantee D3 promised.

`source_registry_v2` is a separate issue (E-3): the version currently measures the catalogue, not the semantics of a row.

### 5.4 Migrations 036 → 060

`060_source_registry_v2.sql` sits after a 23-number gap that V3-WORKPLAN §3 reserves for wave-0/v2. `checkMigrations` is set-based, so boot is fine. The dangers are later:
- dbmate without `--strict` applies a late 037 after 060 silently;
- the "renumber after K4" rule would break any lock class derived from the number;
- `types.generated.ts` already drifted once (R-5).

E-7 replaces renumbering with "numbers are immutable, out-of-order is detected and approved". Next free numbers today: 037 for v1/v2, 061–071 for V3.

### 5.5 Single-VM capacity versus the loops as built

Review 13 B3 said the capacity maths did not close. The design has since added ~10 loops: EFFIS, weather, passes, meteoalarm, CEMS, lightning, mirror push/age, digest, QA, lag. The worker is still one process. The cadences are modest; the fastest are dispatch at 10 s and the 60-s identity, outlines and monitor loops. So CPU is unlikely to bind on a 4-vCPU VM. The binding resources are the **Postgres connections** (16 pools, ~30+ connections plus the API's) and **loop overlap**: a 60-s loop that takes 70 s under a burst. Neither is measured. E-6 sets the budget and the single-worker invariant. E-9 measures it.

### 5.6 Modularity

The large files fall into three classes:
- **by design:** `catalog-governance.ts`, the message catalogs `en.ts`/`bg.ts`/`messages.ts`, and `types.generated.ts`. Leave them.
- **naturally cohesive but too long:** `pg-clustering-store.ts`, `alert-templates.ts`, `never-send.ts`, `polling-feed.ts`.
- **central and growing:** `config.ts`, `health-wiring.ts` (672), `worker.ts` (614). These grow with every feature and are where merge conflicts between the up-to-4 parallel V3 sessions will land.

E-8 caps the third class first.

## 6. Open questions for the founder

1. **Do you accept a V3 build freeze until v1 has run on a host for a week?** Recommended: yes. Each V3 item adds dark code and has already broken v1 CI once.
2. **TypeBox or plain TS as the contract technology (ADR-006)?** Recommended: plain TS, with versions and types moved into `packages/contracts`. It matches the code as built and avoids a migration.
3. **What should `source_registry_version` mean on a row?** Recommended: the normalisation rules that produced the row. Reserving a source must not change it.
4. **Enable branch protection on `main` with required CI?** Recommended: yes, now. It is a one-time 15-minute setting.
5. **Is "exactly one worker process" a v1 invariant?** Recommended: yes, enforced by a process-level advisory lock. Horizontal worker scaling is a v2+ topic.
6. **Should the never-reached code (staff WebAuthn/TOTP, sandbox decoders) get a kill date if it is not wired by K4?** Recommended: yes, 2027-03-01, recorded in the dark-code ledger.

## Appendix A

### (a) TASKS rows

- [ ] **R5-ARCH-1 — GitHub CI green on main and required by branch protection.** Spec: review 25 E-1. Writes: `.github/workflows/ci.yml`, `server/src/db/types.generated.ts`, `docs/TASKS.md` (ticking rule). Done when: the last 3 runs on `main` are green including the PostGIS integration job, and `gh api repos/:o/:r/branches/main/protection` returns the required checks. Est: 4 h. Status: blocked-owner.
- [ ] **R5-ARCH-2 — V3 freeze and generated dark-code ledger.** Spec: review 25 E-2. Writes: `docs/DARK-CODE.md`, `scripts/reachability.mjs`, `docs/V3-WORKPLAN.md` (freeze note). Done when: the script lists every module unreachable from `api.ts`/`worker.ts` or flag-gated, each with flag, TASKS row and kill date, and `docs/V3-WORKPLAN.md` states the freeze condition. Est: 4 h. Status: blocked-owner.
- [ ] **R5-ARCH-3 — Registry version stamps row semantics, not catalogue size.** Spec: review 25 E-3. Writes: `packages/contracts/src/sources.ts`, `server/db/migrations/060_source_registry_v2.sql` (or a follow-up migration), `server/src/adapters/pg/pg-detection-store.integration.test.ts`, a new contract test. Done when: reserving a source leaves the FIRMS row stamp unchanged (test), and the integration test passes on PostGIS in CI. Est: 3 h. Status: open.
- [ ] **R5-ARCH-4 — ADR-006 plain-TS contracts; wire-document versions move to packages/contracts.** Spec: review 25 E-4. Writes: `docs/decisions/006-contracts.md`, `docs/decisions/README.md`, `docs/decisions/005-frontend-stack.md` (superseded note), `packages/contracts/src/*`, `server/src/core/*` builders, `web/src/core/{passes,lightning,wind,fire-outlines,history-body,pass-swaths}.ts`, `web/src/ui/event/lightning-context-note.tsx`. Done when: `grep -rn "schema_version: [0-9]" web/src` and `!== [0-9]` comparisons return no literals, and bumping any `*_SCHEMA_VERSION` breaks the web typecheck. Est: 10 h. Status: blocked-owner.
- [ ] **R5-ARCH-5 — Reachability gate and no-orphans as error.** Spec: review 25 E-5. Writes: `.dependency-cruiser.cjs`, `scripts/reachability.mjs`, `.github/workflows/ci.yml`. Done when: CI fails on a new `server/src` module unreachable from the prod and CLI roots and absent from `docs/DARK-CODE.md`. Est: 4 h. Status: open.
- [ ] **R5-ARCH-6 — Connection and loop budget, single-worker lock.** Spec: review 25 E-6. Writes: `docs/OPERATIONS.md`, `server/src/app/worker.ts`, `server/src/app/*-wiring.ts`, a new `server/src/app/pool-budget.ts`. Done when: OPERATIONS tables every pool with its sum versus `max_connections`, boot fails when the sum exceeds the budget (test), and a second worker process exits on the start lock (integration test). Est: 6 h. Status: open.
- [ ] **R5-ARCH-7 — Immutable migration numbers, strict order check, lock-class registry.** Spec: review 25 E-7. Writes: `docs/V3-WORKPLAN.md` §3, `server/src/adapters/pg/lock-classes.ts`, `.github/workflows/ci.yml`. Done when: CI runs `dbmate --strict` from the previous tag and flags out-of-order files, and no lock class is computed from a migration number. Est: 4 h. Status: open.
- [ ] **R5-ARCH-8 — max-lines rule; split config.ts and pg-clustering-store.ts.** Spec: review 25 E-8. Writes: `eslint.config.js`, `server/src/app/config.ts`, `server/src/app/*-config.ts`, `server/src/adapters/pg/pg-clustering-*.ts`. Done when: lint errors at 900 lines outside the allowlist, and neither file exceeds 500 lines. Est: 8 h. Status: open.
- [ ] **R5-ARCH-9 — Six-hour worker soak with connection and overrun metrics.** Spec: review 25 E-9. Writes: `scripts/worker-soak.mjs`, `docs/reviews/25-soak-result.md`. Done when: a 6 h run reports peak connections ≤ budget, zero overlapping runs of locked loops and stable RSS. Est: 5 h. Status: open.

### (b) RISKS §2 / GATES rows

- **RISKS §2:** *Remote CI red, `main` unprotected; local gate is the only gate* — Likelihood high, Impact high. Mitigation R5-ARCH-1.
- **RISKS §2:** *Build-ahead surface (V2/V3, flag-dark, unreachable) outgrows a v1 that has never run* — Likelihood high, Impact medium. Mitigation R5-ARCH-2, R5-ARCH-5.
- **RISKS §2:** *Server/web wire drift is silent (literal schema versions)* — Likelihood medium, Impact high. Mitigation R5-ARCH-4.
- **RISKS §2:** *Postgres connection exhaustion or a double-run worker on the single VM* — Likelihood medium, Impact high. Mitigation R5-ARCH-6, R5-ARCH-9.
- **GATES (K4 pre-launch):** last 3 `main` CI runs green with branch protection on; DARK-CODE ledger has no entry without a kill date; connection budget documented and asserted at boot; worker soak passed.

### (c) 00-summary synthesis

The principal-architecture seat finds that the as-built system still matches ADR-001…004, and that dependency-cruiser enforces the boundaries the ADRs promised. The exception is ADR-005 D3: the TypeBox contracts it describes were never built, and wire-document versions are duplicated as literals in the web. The dominant risk has moved from design to accumulation. About 30 % of server lines are unreachable from production, V3 work has already broken v1 provenance (`source_registry_v2`) and turned `main` CI red, and the worker's connection and loop budget has never been written down or measured. The verdict is CONDITIONAL GO, gated on green, protected CI; a V3 freeze until v1 runs on a host; the registry-version fix; ADR-006; and a documented connection budget.

## Appendix B — What was verified, and how

| Claim | Method |
|---|---|
| 70.6 % of server lines reachable from `api.ts` + `worker.ts`; ~90 % with CLIs; ~8.4k non-fixture lines unreachable | Regex import-graph BFS over non-test `server/src/**/*.ts` (scratch script `reach.mjs`). It counts static imports only, so dynamic imports would be under-counted (none found by grep). |
| Only 3 loops take `loopLocks.forLoop` | `grep -n forLoop server/src/app/worker.ts` → lines 237, 265, 399 |
| 16 wiring files open their own pg pool | `grep -l createPgPool server/src/app/*.ts` and reading each `max` |
| No connection budget documented | `grep -ri max_connections docs infra` → no hits |
| TypeBox absent | `grep` of `package.json` in server, web, contracts and of imports across the tree → no hits; compared with `005-frontend-stack.md:59` |
| Web hard-codes schema versions | `grep -rn schema_version web/src` (10 files), cited lines read |
| CI red on `main`; causes | `gh run list --branch main`, `gh run view --log-failed` for runs 40939772318, 40767718700, 40591069990, 39829918069, 38319673396 |
| Registry bump causes the integration failure | Failed log of run 40939772318 plus `pg-detection-store.integration.test.ts:176` and `sources.ts:77` |
| `main` is unprotected | `gh api repos/:o/:r/branches/main/protection` → 404 "Branch not protected" |
| Migration policy and gap | `ls server/db/migrations`, `docs/V3-WORKPLAN.md:121`, `server/package.json:28` (no `--strict`) |
| File-size distribution, no max-lines rule | `wc -l` over non-test sources; `grep max-lines eslint.config.js` → none |
| 81 distinct `FIRE_WATCH_*` env vars | `grep -rhoE "FIRE_WATCH_[A-Z0-9_]+" server/src \| sort -u \| wc -l` |
| Route gating by flag/keyring | Read `health-wiring.ts:420–470` |
| Review 01 recommendations landed | Cross-read 01 §4 against the ADRs 002–004, `worker.ts` loops, and the F15/F16 and staff-route code |
