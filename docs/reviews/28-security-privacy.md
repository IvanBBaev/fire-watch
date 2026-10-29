# Review 28 — Security & privacy (as built)

*Reviewer role: senior application security & privacy engineer (round 5, as-built review). Date: 2026-10-30. Status: complete.*

*Inputs reviewed: `docs/reviews/05-security.md` (round-1 threat model, R1–R14, A1–A7, B1–B8, C1–C3), `docs/reviews/00-summary.md` (round-4 synthesis), `docs/reviews/21-platform-release-engineering.md` (format), `docs/TASKS.md` (B3, H1–H8, I1–I7, V2-E2, V2-G2), `docs/WEBHOOKS.md`; code at `main` = `ccd541a`: `server/src/app/{api,api-composition,auth-wiring,config}.ts`, `server/src/core/{auth,staff,erasure,webhooks,alerts}/`, `server/src/adapters/{http,crypto,db,mail,alerts/channels/webhook}/`, `web/src/core/{config,before-after}.ts`, `web/functions/`, `.github/workflows/{ci,deploy}.yml`, `pnpm-workspace.yaml`, `.gitignore`; GitHub repository settings for `IvanBBaev/fire-watch` read through `gh api` (read-only); a secret-shape scan of the full git history (shapes counted, no values printed).*

---

## 1. Summary verdict

**CONDITIONAL GO for May 2027.** The application-layer security work is better than most products at launch: cookie sessions, magic links and the webhook SSRF guard are textbook. The gaps are almost all at the edges the code does not own: repository settings, HTTP response headers, abuse budgets, retention that is built but switched off, and a staff plane whose two-person rule assumes a second human the project does not yet have.

1. **The public repository has no secret scanning and no push protection.** `gh api repos/IvanBBaev/fire-watch` reports `secret_scanning`, `secret_scanning_push_protection`, `secret_scanning_non_provider_patterns`, `secret_scanning_validity_checks` and `dependabot_security_updates` all `disabled`. `main` has no branch protection (HTTP 404) and the repository has no deployment environments. The CI comment at `.github/workflows/ci.yml:370` names GitHub push protection "the primary control"; that control is off, and there is no gitleaks. The history is clean today (§5.3). Nothing stops the first real `.env` value, which arrives with the first host.
2. **No Content-Security-Policy and no security headers ship anywhere.** There is no `_headers` file, and neither `web/functions/` nor the API sets CSP, HSTS, `frame-ancestors`/`X-Frame-Options` or `Referrer-Policy`; only `x-content-type-options: nosniff` appears on some API routes. TASKS B3 (`docs/TASKS.md:464–469`) is ticked, yet its clause "CSP/security headers from first deploy config" was never met.
3. **Magic-link mail can be used for bombing.** The only auth-specific limit is 3 links per **address** per hour (`server/src/core/auth/auth-policy.ts:35`). Per source IP, the link route sits under the generic 60 requests/min limiter (`server/src/adapters/http/health-server.ts:150,323`), which is about 3,600 mails per hour per IP across distinct addresses, with no global cap on auth mail. That spends SES reputation, the account that also carries fire alerts.
4. **Retention is built and unarmed.** Every `PURGE_RETENTION` value is `null` (`server/src/core/erasure/purge-plan.ts:49–66`), so `auth_link_requests` keeps the email addresses strangers typed in, indefinitely. `staff_audit_log` client IPs have no purge target at all. Erasure coverage, by contrast, is complete (§5.4).
5. **The two-person rule compares staff ids, not people.** `decideBroadcastApproval` refuses only `creator.staffId === approver.staffId` (`server/src/core/staff/staff-policy.ts:86`). An `admin` holds `staff.manage` (`:49`) and so can mint the second identity. For a solo founder the rule is a ceremony, not a control.
6. **The first second factor is enrolled from a first-factor-only session.** `mayEnrollSecondFactor` allows enrollment from `pending_second_factor` when zero factors exist (`server/src/core/staff/staff-session-policy.ts:148–154`), so whoever reads the new member's mailbox first owns their 2FA.
7. **Changes since review 05.** Its C1/C2 (cookie sessions, magic link), A1/A3/A5 (gateway, two-person rule, kill switch), A7 (send audit), B-track zone encryption with key rotation, and R13 (signed webhooks) are now built. Its R9 (single-maintainer supply chain) is half met: Actions are SHA-pinned, installs run with `--ignore-scripts`, and a 7-day `minimumReleaseAge` applies. However, the repository-side controls in point 1 are off, and CI on `main` has been red on every recent run, so no gate is enforced on what lands.

**Conditions for GO:**
- E-1: secret scanning, push protection and branch protection on, plus gitleaks in CI.
- E-2: a CSP and header set in the first deploy config.
- E-3: per-IP and global auth-mail budgets.
- E-4: retention numbers armed.
- E-5 and E-6: the two-person rule and 2FA bootstrap fixed or explicitly waived by the founder before the staff routes are registered.
- E-7: the client-IP header trust tied to a verified firewall rule.

## 2. Strengths (sound as built)

- **User sessions.**
  - The cookie is `__Host-fw_session` with `HttpOnly; Secure; SameSite=Lax; Path=/` (`server/src/adapters/http/session-cookie.ts:23,25`). The `__Host-` prefix forbids `Domain`, so a sibling subdomain cannot plant or shadow it.
  - Max-Age follows the DB row and expiry slides by 30 days (`auth-policy.ts:38,172`).
- **Magic-link tokens.**
  - 32 bytes from the CSPRNG, base64url, stored only as SHA-256 (`server/src/adapters/crypto/auth-tokens.ts`).
  - Consumption is one guarded `UPDATE` (`consumed_at IS NULL AND superseded_at IS NULL AND expires_at > now`, `server/src/adapters/db/pg-auth.ts:77–120`), so a link is single-use under concurrency.
  - Consumption is a POST (`/api/v1/auth/continue`), so mail scanners that prefetch GET links cannot burn them.
  - Issuance always answers 202, so there is no account enumeration.
  - Links are bound to the UA family.
- **CSRF.** The Origin check runs in an `onRequest` hook on state-changing auth routes (`server/src/adapters/http/auth-route.ts:90–93`). `isAllowedOrigin` refuses an absent, empty or `null` Origin and then matches exactly (`auth-policy.ts:99`). Allowed origins must be exact `https:` origins (`server/src/app/config.ts:626–690`).
- **Staff plane primitives.**
  - The staff cookie is `SameSite=Strict` (`staff-session-route.ts:70`).
  - The second-factor window is 10 min, idle timeout 30 min, absolute lifetime 12 h.
  - At most 5 second-factor failures are allowed per pending session.
  - TOTP is RFC 6238 with ±1 step, a `last_used_step` replay guard (migration 026) and a `timingSafeEqual` compare.
  - The TOTP secrets and webhook secrets are sealed with AES-GCM sealers.
  - The admin role has no send right (`staff-policy.ts:49`).
- **Webhook SSRF guard.** This is the best piece of security engineering in the repository.
  - Only `https:` is accepted: no credentials, no fragment, port 443 only, and at most 2048 characters.
  - Internal-only suffixes are refused (`server/src/core/webhooks/webhook-url.ts:62–78`).
  - The IPv4 and IPv6 exclusion tables cover RFC 6890, CGNAT, link-local and metadata addresses, NAT64, mapped/compatible forms, Teredo and 6to4 (`:158–259`).
  - *Every* resolved address must be public (`:122`).
  - Commit `b4991af` pins the socket lookup to the checked address while keeping SNI on the hostname (`pinned-https-post.ts`). It follows no redirects and re-validates before every send (`webhook-transport.ts:105–134`). That closes DNS rebinding.
- **No user-driven upstream fetch.** The EFFIS, CEMS, Meteoalarm and wind overlay routes serve stored copies and refuse query strings.
- **Zone privacy at rest.**
  - AES-256-GCM with a random 96-bit IV.
  - The AAD binds `layout|zoneId|keyId` (`aes-gcm-zone-cipher.ts:17,145`).
  - It has one active key plus retired keys and a rotation CLI.
  - The API does not serve zone or webhook routes when their keyring is missing: it fails closed (`server/src/app/auth-wiring.ts`).
- **Erasure.** `erasure_plan_v8` has a rule or a recorded out-of-scope reason for every table classed `personal`, and the coverage is test-enforced. The outbox is pseudonymised rather than deleted, and the request survives only as a hash.
- **Logging.** The SES auth mailer redacts the link, the token, the recipient and both AWS credentials (`server/src/adapters/mail/ses-auth-mailer.ts:116`).
- **Client-IP header.** `x-forwarded-for` and `forwarded` are refused by name (`config.ts:841–855`): no spoofable left-most-entry parsing.
- **Supply chain.**
  - `pnpm install --frozen-lockfile --ignore-scripts`, with `onlyBuiltDependencies: []` and three build scripts explicitly denied.
  - `minimumReleaseAge: 10080` (7 days), with Renovate matched to it.
  - Actions are SHA-pinned and `pnpm audit --audit-level=high` runs in CI.
- **Alert path.**
  - Budgets, the breaker and the kill switch gate *claiming* in `server/src/app/dispatch-wiring.ts`. A row that must not go out never reaches a worker.
  - The never-send lint now lives in `packages/contracts/src/never-send.ts` and also gates the web catalogs.
  - A seeded direct send fails `boundary.test.ts`.

## 3. Risks & gaps (severity-ranked)

Ranked by what an outsider can exploit on launch day, not by how much code a fix touches.

| # | Severity | Risk | Where |
|---|---|---|---|
| R-1 | **High** | Public repo with secret scanning, push protection, Dependabot security updates and branch protection all off. No gitleaks. The CI regex covers only 4 shapes. The first host brings real secrets into a tree where several parallel agents work. | `gh api repos/IvanBBaev/fire-watch` (`security_and_analysis`), `…/branches/main/protection` → 404; `.github/workflows/ci.yml:370–390`; no `.gitleaks.toml` |
| R-2 | **High** | No CSP, HSTS, frame-ancestors or Referrer-Policy on the web or the API. Any future XSS has no second wall, the map can be framed for clickjacking, and event URLs leak in `Referer` to the tile and imagery hosts. B3 is ticked over the unmet clause. | `web/` (no `_headers`), `web/functions/`, `server/src/adapters/http/*`; `docs/TASKS.md:468` |
| R-3 | **Medium-High** | Magic-link bombing and SES reputation burn: 3/hour per address, but 60/min per IP and no global auth-mail budget. A botnet or an IPv6 /64 rotation sends unlimited mail to third parties. A suspended SES account also stops fire alerts. | `auth-policy.ts:35`; `health-server.ts:150,323–383`; `auth-route.ts` (no route limiter) |
| R-4 | **Medium-High** | Retention unarmed. Non-consenting emails in `auth_link_requests`, ended sessions, tombstones, decision and digest logs and webhook delivery logs are kept forever. `staff_audit_log` IPs have no purge target. This is a GDPR Art. 5(1)(e) storage-limitation gap from day one. | `server/src/core/erasure/purge-plan.ts:49–66`; `erasure-plan.ts:243,272` |
| R-5 | **Medium** | The two-person broadcast rule is enforced on `staffId` only. An admin can create a second member. With one founder there is no second human. | `staff-policy.ts:49,76–88` |
| R-6 | **Medium** | The first-2FA bootstrap from a mailbox-only session: the person who reads the onboarding mail first owns the account's second factor, permanently. | `staff-session-policy.ts:148–154` |
| R-7 | **Medium** | `FIRE_WATCH_CLIENT_IP_HEADER` is trusted on the premise that "the firewall lets nothing but that edge reach the port". No host or firewall exists yet. A direct-to-origin client sets the header and rotates rate-limit keys freely, which makes R-3 worse. | `server/src/app/config.ts:835–860`; `client-key.ts` |
| R-8 | **Medium** | Client-direct third parties: NASA GIBS imagery (IP plus event area) and OpenFreeMap basemap (IP plus viewport). Zones are encrypted at rest, but a user who pans to their home tells the tile host. The privacy notice must say so, or tiles must be proxied. | `web/src/core/before-after.ts:229`; `web/src/core/config.ts:140–141`; `docs/TASKS.md:2666` |
| R-9 | **Medium** | CI on `main` is red on every recent run (5/5 `failure` in `gh run list`), so the audit, the secret-shape step and the boundary tests guard nothing that lands. | `.github/workflows/ci.yml`; `gh run list --branch main` |
| R-10 | **Low-Medium** | The staff plane is out of erasure scope and has no off-boarding erasure procedure. Staff routes are unregistered, and the cookie name and host are undecided. | `erasure-plan.ts:272`; `server/src/app/api.ts` |
| R-11 | **Low** | A webhook can target the service's own public IP (hairpin into its reverse proxy). Only port 443 is reachable that way, but it is a loop. | `webhook-url.ts:127–133` |
| R-12 | **Low** | Comment drift on a security boundary: `webhook-url.ts:17,27–30` still says the transport uses `fetch` with `redirect: 'error'` and that rebinding is an open "known limit". `b4991af` closed it and `docs/WEBHOOKS.md:53` is correct. `auth-policy.ts:21` says staff sessions "are not built yet" (migration 029 built them). | as cited |

## 4. Detailed recommendations

- **E-1 [MVP] → R-1. Turn the repository's own controls on.**
  - Enable secret scanning, push protection, non-provider patterns, validity checks and Dependabot security updates.
  - Protect `main` with the required CI checks, no force-push and linear history.
  - Add a `gitleaks` job with a `.gitleaks.toml` that allowlists the AWS documentation key and the redaction-test fixtures by path.
  - Owner: founder (settings, 0.3 founder-h) + agent (gitleaks job, 1.5 h).
- **E-2 [MVP] → R-2. Ship a header set with the first Pages deploy.**
  - `web/public/_headers` or a Pages middleware with:
    - CSP: `default-src 'self'`, `img-src 'self' data: blob: https://gibs.earthdata.nasa.gov https://tiles.openfreemap.org`, `connect-src` for the API and tile hosts, `worker-src 'self' blob:` (MapLibre), `style-src 'self' 'unsafe-inline'` only if MapLibre still requires it, `frame-ancestors 'self'` except on the embed route, `base-uri 'none'`, `form-action 'self'`.
    - `Strict-Transport-Security: max-age=31536000; includeSubDomains`.
    - `Referrer-Policy: strict-origin-when-cross-origin`.
    - `Permissions-Policy: geolocation=(self)`.
  - Do the same for API JSON responses.
  - Add a CI test that greps the built output for the header file and an e2e check that the CSP produces no violations on the CI-18 route table.
  - Untick B3 until this lands.
  - Owner: agent. Effort: 4 h.
- **E-3 [MVP] → R-3. Budget auth mail on three axes.**
  - Per IP, 10 link issues/hour; per /64 for IPv6.
  - Global, N auth mails/hour, with a meta-alert when 50% is reached (J1).
  - Per address, the existing 3/hour.
  - Over budget, answer 202 and send nothing, so the answer still does not reveal anything.
  - Put the counters on the existing limiter port.
  - Owner: agent. Effort: 3 h. The founder sets N (Q3).
- **E-4 [MVP] → R-4. Arm retention.**
  - Proposed values:
    - `expired_link_requests` 7 d.
    - `ended_sessions` 30 d.
    - `account_tombstones` 35 d (the erasure horizon).
    - `webhook_deliveries` 30 d (already proposed in `webhook_params_v1`).
    - `alert_decision_log` and `alert_digest_log` 90 d.
    - `erasure_ledger` = horizon + 30 d.
  - Add a `staff_audit_log` IP-truncation target: keep the row, null the IP after 90 d.
  - Owner: founder decides (0.5 founder-h); agent arms and tests (2 h).
- **E-5 [MVP before staff routes register] → R-5. Make the two-person rule bind people.**
  - Require the approver's second factor to be a **different WebAuthn credential** from the creator's.
  - Refuse approval by a member created less than 7 days earlier, or by a member created by the creator.
  - Log both identities to `staff_audit_log`.
  - While the founder is the only staff member, adopt an explicit, documented single-operator mode: a 15-minute cool-off plus a hard B=500 budget and no G broadcast. That is more honest than a sock-puppet approver.
  - Owner: agent (3 h) + founder decision (Q1).
- **E-6 [MVP before staff routes register] → R-6. Bootstrap 2FA out of band.**
  - Make the first factor enrollable only with a one-time enrollment code that an existing admin issues over a second channel, valid for 24 h.
  - The founder's own first enrollment is the CLI ceremony (`staff-ceremonies.ts`), not the web.
  - Owner: agent. Effort: 2.5 h.
- **E-7 [MVP] → R-7. Prove the edge-only premise.**
  - At deploy, the host firewall (Hetzner Cloud Firewall) allows the API port only from Cloudflare ranges.
  - The deploy smoke test connects to the origin IP directly and expects a refusal.
  - Alternatively, the API ignores the header unless the peer address is inside a configured CIDR list.
  - Owner: agent (2 h) at the first host.
- **E-8 [v1] → R-8. Decide client-direct vs proxy for third-party tiles.**
  - Recommended: proxy GIBS through the existing overlay cache pattern. The area is the event's, so it is cacheable.
  - Keep OpenFreeMap client-direct but disclose it in the privacy notice.
  - Owner: founder (Q4), agent (3 h for the GIBS proxy).
- **E-9 [MVP] → R-9. Restore green CI before any security gate is claimed.** This overlaps reviews 21 and 27; the security ask is only that E-1's required checks make red unmergeable. Owner: agent (counted in 27).
- **E-10 [v1] → R-10. Write the staff off-boarding erasure procedure.**
  - Keep audit rows (accountability) but erase factors, recovery codes and sessions at off-boarding.
  - Truncate the IP per E-4.
  - Bump `erasure_plan_v9`.
  - Owner: agent. Effort: 2 h.
- **E-11 [v1] → R-11. Refuse the service's own egress addresses.** Add a configured `FIRE_WATCH_SELF_ADDRESSES` deny list, checked alongside `allAddressesPublic`. Owner: agent. Effort: 1 h.
- **E-12 [MVP] → R-12. Fix the two stale security comments.** A wrong comment at a trust boundary misleads the next reviewer. Owner: agent. Effort: 0.3 h.

## 5. Security & privacy deep dive

### 5.1 Authentication and authorisation

The user plane is complete and conservative, and is wired only when `FIRE_WATCH_AUTH_ENABLED` is set and the mailer config is complete (`auth-wiring.ts`). It also uses separate pg pools for auth and account work, so an export storm cannot starve sign-in.

Weaknesses in the user plane:
- **Bombing (R-3).** A per-address limit alone protects the inbox owner from repeated mail, but not the sender's reputation.
- **The UA-family binding.** It is a usability-safety trade-off, not a security control: the UA is attacker-chosen. That is fine as long as nobody describes it as one.

The staff plane is built as pure rules plus routes, but **not registered**. That is the right state to be in, because the two weaknesses above (R-5, R-6) are design-level and cheap to fix before any staff member exists. WebAuthn exists (`adapters/crypto/webauthn.ts`). E-5 should make it the required factor for `alert-operator` and `admin`, with TOTP left to editors and moderators.

### 5.2 SSRF and egress

There is exactly one user-controlled egress, webhooks, and it is done right:
1. The URL is validated at registration and before every send.
2. Every resolved address must be public.
3. The socket is pinned to the checked address.
4. No redirects are followed.
5. The response body is discarded once the headers arrive.
6. A single connect-to-headers timeout applies.

The rate limiter on test pings (`WEBHOOK_TEST_PING_RATE_LIMIT`, `auth-wiring.ts:314`) stops the endpoint becoming a port-443 scanner, because the target set is limited to what one account registers.

The remaining items are the hairpin (R-11) and the comment drift (R-12). The other outbound fetches are operator-configured upstreams (FIRMS, EFFIS, CEMS, Meteoalarm, wind, SES), with no user input in the URL.

### 5.3 Secrets and keyrings

- **Tree.** `.gitignore:10–12` ignores `.env` and `.env.*` except `.env.example`.
- **History.** A shape scan over `git log --all -p` found:
  - AWS key-id shape: 1 distinct value, the AWS documentation example.
  - Private-key armour: 0.
  - Stripe live, GitHub PAT and Slack tokens: 0.
  - One JWT-shaped string, in `server/src/core/observability/free-text.test.ts`, a redaction fixture.
  - Postgres URLs with inline credentials: all hosts are `localhost`, `127.0.0.1`, `10.0.0.5`, `db`, `*.internal`, `*.example` or `*.invalid`, in tests and redaction fixtures.
  - So the history is clean today.
- **Keys at runtime.** The zone, webhook and TOTP keys come from the environment that the secret manager fills, never from the DB. They carry key ids in the AAD and have a rotation CLI for zones.
- **The gaps.**
  - The repository-side scanning is off (R-1).
  - The webhook-secret and TOTP sealers have no rotation job equivalent to `zone-key-rotation` (not verified as a gap in practice; recorded as Q5).
  - No secret store exists yet, because no host does.

### 5.4 Personal data

- **Zones.** Centres are encrypted at rest, and precision coarsening is in the plaintext path before sealing.
- **Exports.** Exports are rate-limited (`ACCOUNT_EXPORT_RATE_LIMIT`, `auth-wiring.ts:305`). The export schema carries one `gitleaks:allow` (`export-schema.ts:202`) for a column name, not a value.
- **Erasure.** Erasure covers every `personal` table (14 rules plus the request hash), which is a test-enforced invariant worth keeping.
- **What is missing.** What is missing is *time*: nothing is ever purged (R-4). The out-of-scope list (staff tables, incident-log contributors) is defensible for accountability, but needs E-10 and IP truncation.
- **Logs.** The mailer redacts; the free-text redaction of C8 covers structured logs. No raw zone coordinates were found in log calls during this review (grep of `log.` call sites in `core/zones` and `adapters/http/zones*`).

### 5.5 Web security

There are no headers at all (R-2). The SPA renders catalog copy and server JSON through Preact, which escapes by default. No `dangerouslySetInnerHTML` was found in `web/src`, so today's XSS surface is small. CSP is the second wall for the day that changes.

The embed and OG functions (`web/functions/og`, `web/functions/event/[id]`) need an explicit `frame-ancestors *` only on the embed route, and `'self'` everywhere else.

Third-party client-direct calls are covered in R-8.

### 5.6 Supply chain and the public repository

The install-time posture is strong (§2). The repository posture is not (R-1): there is no branch protection and no environments, so `deploy.yml` will run from any push once it is armed (`deploy.yml:178` defers `environment: production`). A single-maintainer public repo needs exactly these settings, because the threat in review 05 R9 is a stolen token pushing to `main`. Also enable the private vulnerability reporting setting and add a `SECURITY.md` that points to it.

### 5.7 Abuse resistance of the alert path

The order is right: budgets, breaker and kill switch gate the claim, and the never-send lint gates rendered copy (`dispatch-decision.ts:25–33`). A seeded direct send fails CI. Two caveats:
- The breaker's floor and seasonal baseline are `null` pending a founder decision (TASKS H4, `blocked-owner`), so the breaker is unarmed in the same way as retention.
- The two-person rule (R-5) is the human half of review 05 A3 and is the weakest link.

The kill switch read fails closed (a failed read fails the cycle). That is correct.

## 6. Open questions for the founder

1. **Single operator.** Until a second trusted person exists, do we run the broadcast path in an explicit single-operator mode (cool-off plus a hard B budget, no G) rather than a two-person rule satisfiable by a second account? *Recommended: yes; document it in OPERATIONS and the DPIA.*
2. **Repository settings.** May an agent prepare, and you apply, secret scanning, push protection, branch protection on `main` (required CI) and a `production` environment with you as the required reviewer? *Recommended: yes, this week; it costs nothing on a public repo.*
3. **Auth-mail budget.** What global ceiling on magic-link mails per hour? *Recommended: 200/h at launch, with a meta-alert at 100, and 10/h per IP.*
4. **Third-party tiles.** Proxy GIBS, and disclose OpenFreeMap? *Recommended: proxy GIBS (event-area, cacheable); keep OpenFreeMap direct and name it in the privacy notice.*
5. **Secret rotation.** Should the webhook-secret and TOTP sealer keys get a rotation job like zones, or is "rotate by re-enrollment" acceptable for v1? *Recommended: a job for the webhook sealer (customer-held secrets); re-enrollment for TOTP.*
6. **Retention numbers.** Accept E-4's proposed values (7 / 30 / 35 / 30 / 90 / horizon + 30 days, staff IPs truncated at 90 days)? *Recommended: yes, confirmed with counsel in the DPIA.*

## Appendix A — Proposed rows for the shared documents

**(a) TASKS rows**

- [ ] **R5-SEC-1 — Repository security controls and gitleaks.** Spec: review 28 E-1. Writes: `.github/workflows/ci.yml`, `.gitleaks.toml`, `SECURITY.md`. Done when: `gh api repos/IvanBBaev/fire-watch` shows secret scanning and push protection `enabled`, `branches/main/protection` returns 200 with required checks, and a seeded fake key in a test branch fails the gitleaks job. Est: 1.8 h. Status: blocked-owner.
- [ ] **R5-SEC-2 — CSP and security headers for web and API.** Spec: review 28 E-2. Writes: `web/public/_headers`, `server/src/adapters/http/security-headers.ts`, e2e CSP check. Done when: every CI-18 route serves CSP, HSTS, Referrer-Policy and frame-ancestors with zero CSP violations in e2e, and B3 is re-ticked against it. Est: 4 h. Status: open.
- [ ] **R5-SEC-3 — Per-IP and global magic-link mail budgets.** Spec: review 28 E-3. Writes: `server/src/core/auth/auth-policy.ts`, `server/src/adapters/http/auth-route.ts`, tests. Done when: the 11th link request from one IP in an hour and the (N+1)th globally return 202 and send no mail, with a test for each and a meta-alert at 50%. Est: 3 h. Status: blocked-owner.
- [ ] **R5-SEC-4 — Arm retention and truncate staff audit IPs.** Spec: review 28 E-4. Writes: `server/src/core/erasure/purge-plan.ts`, migration 037+, tests. Done when: `planPurge` reports every target `armed: true` and a staff-audit IP older than 90 days is nulled in an integration test. Est: 2 h. Status: blocked-owner.
- [ ] **R5-SEC-5 — Two-person rule bound to distinct people.** Spec: review 28 E-5. Writes: `server/src/core/staff/staff-policy.ts`, tests, OPERATIONS. Done when: approval by a member created by the creator, or created less than 7 days ago, is refused in tests, and single-operator mode is documented. Est: 3 h. Status: blocked-owner.
- [ ] **R5-SEC-6 — Out-of-band first 2FA enrollment.** Spec: review 28 E-6. Writes: `server/src/core/staff/staff-session-policy.ts`, `staff-session-route.ts`, tests. Done when: a pending session without an enrollment code cannot enroll a first factor (test). Est: 2.5 h. Status: open.
- [ ] **R5-SEC-7 — Edge-only origin verified at deploy.** Spec: review 28 E-7. Writes: deploy smoke, `server/src/app/config.ts`. Done when: a direct-to-origin request in the deploy smoke is refused, or the header is ignored outside the configured CIDRs (test). Est: 2 h. Status: blocked-external.
- [ ] **R5-SEC-8 — GIBS proxy and third-party disclosure.** Spec: review 28 E-8. Writes: `server/src/adapters/http/gibs-route.ts`, `web/src/core/before-after.ts`, privacy notice. Done when: the web makes no request to `gibs.earthdata.nasa.gov` (e2e network assertion). Est: 3 h. Status: blocked-owner.
- [ ] **R5-SEC-9 — Staff off-boarding erasure.** Spec: review 28 E-10. Writes: `server/src/core/erasure/erasure-plan.ts`, runbook 06. Done when: `erasure_plan_v9` removes factors, codes and sessions of an off-boarded member, as an integration test. Est: 2 h. Status: open.
- [ ] **R5-SEC-10 — Self-address webhook deny list and stale comments.** Spec: review 28 E-11, E-12. Writes: `server/src/core/webhooks/webhook-url.ts`, `server/src/core/auth/auth-policy.ts`. Done when: a webhook resolving to a configured self address is refused (test), and both comments match the code. Est: 1.3 h. Status: open.

**(b) RISKS §2 and GATES rows**

- RISKS: *SEC-R5-1 Public repo without secret scanning or push protection; first host secret leaks irrecoverably. Likelihood M, impact H. Mitigation R5-SEC-1.*
- RISKS: *SEC-R5-2 SES suspension through magic-link bombing silences fire alerts. Likelihood M, impact H. Mitigation R5-SEC-3.*
- RISKS: *SEC-R5-3 Storage-limitation breach: personal data never purged. Likelihood H, impact M. Mitigation R5-SEC-4.*
- GATES: *Pre-deploy security gate: secret scanning and push protection on, `main` protected with required green CI, CSP/HSTS headers present on every CI-18 route, every purge target armed, client-IP header trust tied to a verified edge-only rule.*
- GATES: *Pre-staff-registration gate: R5-SEC-5 and R5-SEC-6 done, or waived in writing by the founder.*

**(c) Synthesis paragraph for 00-summary**

The security of the code as built is strong where the code owns the problem. Cookie sessions, single-use POST-consumed magic links, Origin CSRF and a DNS-pinned webhook SSRF guard are all launch-grade, and erasure covers every personal table. The launch risks sit at the edges: the public repository has secret scanning, push protection and branch protection off while CI on `main` is red; there are no CSP or security headers despite B3 being ticked; magic-link mail has no per-IP or global budget; and every retention purge is unarmed. On the staff plane, the two-person rule compares account ids, not people, and the first second factor can be enrolled from a mailbox-only session. Both are cheap to fix now, while the staff routes are still unregistered.

## Appendix B — What was verified, and how

- **Repository settings:** `gh api repos/IvanBBaev/fire-watch` (the `security_and_analysis` block), `…/branches/main/protection` (404), `…/environments` (0) and `…/vulnerability-alerts` (404 = off). `gh run list --branch main --limit 5`: 5/5 `failure`.
- **History secret scan:** `git log --all -p -G<shape>` for seven shapes, counting distinct values after masking user and password. No value was printed or copied into this document.
- **Headers:** grep over `web/`, `web/functions/` and `server/src/adapters/http/` for `Content-Security-Policy`, `Strict-Transport-Security`, `frame-ancestors`, `X-Frame-Options`, `Referrer-Policy` and `_headers`. No hits except `x-content-type-options`.
- **Auth and staff:** read `auth-policy.ts`, `auth-route.ts`, `session-cookie.ts`, `auth-tokens.ts`, `pg-auth.ts`, `staff-policy.ts`, `staff-session-policy.ts`, `staff-session-route.ts` and `totp.ts`. Confirmed that staff routes are absent from `server/src/app/api.ts`.
- **Rate limiting:** read `health-server.ts:150,323–383`, `client-key.ts` and `config.ts:835–860`.
- **Webhooks:** read `webhook-url.ts`, `dns-host-resolver.ts`, `pinned-https-post.ts`, `webhook-transport.ts` and `docs/WEBHOOKS.md:53`.
- **Erasure and retention:** read `erasure-plan.ts` and `purge-plan.ts`; cross-checked the `personal` classes in the migrations against the rules.
- **Crypto at rest:** read the header and AAD of `aes-gcm-zone-cipher.ts`; listed the sealers in `server/src/adapters/crypto/`.
- **Supply chain:** read `pnpm-workspace.yaml`, `.gitignore:10–12` and `ci.yml:347–390`.
- **Alert path:** read `dispatch-decision.ts:22–33` and the header of `dispatch-wiring.ts`; checked TASKS H4.
- **Not verified:** runtime behaviour (nothing was deployed or run; no suites or builds were executed, per the review constraints), `docs/legal/*` and the DPIA text, and the content of runbook 06.
