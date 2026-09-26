# Legitimate interest assessments (GDPR Art. 6(1)(f))

> **DRAFT — requires legal review.** Each assessment follows the three-part test:
> purpose, necessity and balancing. The activities are those given the 6(1)(f) basis in
> 09 §5.1 and in [ropa.md](ropa.md) §2.

## LIA-1 — Access logs, rate limiting and abuse defence (RoPA P7)

| Test        | Assessment |
| ----------- | ---------- |
| Purpose     | Keep the public map and API available and secure. Detect abuse (scraping, magic-link flooding, credential stuffing) and plan capacity. |
| Necessity   | IP address and user agent are the minimum signal for rate limiting and incident scoping. The health API deliberately uses the socket peer, not `X-Forwarded-For`, so a spoofed header cannot evade limits (`server/src/adapters/http/health-server.ts:94`, `:131`). |
| Balancing   | Visitors expect a website to log requests for security. Mitigations: retention of **≤ 30 days**, then deleted or truncated to /24 (05 §5.3.2, §5.3.3). No coordinates in application logs. No analytics tied to IP. |
| Result      | Legitimate interest applies. **FOUNDER DECISION**: where logs live (host, Cloudflare) and how the 30-day expiry is enforced. |

## LIA-2 — Dispatch evidence: retaining the send log (RoPA P4)

| Test        | Assessment |
| ----------- | ---------- |
| Purpose     | Prove what the service decided and sent, when and why, for dispute resolution and as a liability defence (09 §3.6; ADR-004 A1.3). Examples: "you did not warn me" and "you sent a false alarm". |
| Necessity   | A claim can arrive years later: the general limitation period is 5 years (ЗЗД Art. 110). The decision needs to be defended, not the recipient's identity. After 24 months the row is therefore pseudonymized in place: the zone and subscription links are removed and zone-derived parameters are dropped (`server/db/migrations/001_initial_schema.sql:511–512`; erasure plan `alert_outbox` rule; `RETAINED_TEMPLATE_PARAM_KEYS` is empty). |
| Balancing   | For 24 months the row links a person to a fire near their home. Mitigations: personal backup class (001:543); pseudonymization is final, enforced by trigger (`010_account_erasure.sql:56`); erasure pseudonymizes immediately. After pseudonymization the row is no longer linkable to the account (the export states this in `EXPORT_LIMITS`). |
| Result      | Legitimate interest applies to the 24-month full-fidelity window; the 5-year tail holds pseudonymized rows only. ⚖ **LEGAL** 09 §10 Q5: is keeping full fidelity for 24 months for *every* user defensible, or only once a dispute has arisen? |

## LIA-3 — Operator identifiers in the outbox (RoPA P9)

| Test        | Assessment |
| ----------- | ---------- |
| Purpose     | Accountability for held and manual alerts: two-person approval or a solo cool-off (001:499–504); the initiator of a manual alert (`003_outbox_actor_provenance.sql:41`). |
| Necessity   | Without the operator id, the approval rule cannot be audited. |
| Balancing   | The data subjects are staff and volunteers, who are informed at onboarding. The ids are kept verbatim at pseudonymization as an employment record (001:500–501). They are not disclosed to users (the export withholds them; [dpia.md](dpia.md) E1). |
| Result      | Applies. **FOUNDER DECISION**: operator onboarding notice; retention equal to the outbox (5 years). |

## LIA-4 — Shadow evaluation of candidate rule sets (RoPA P5)

| Test        | Assessment |
| ----------- | ---------- |
| Purpose     | Before a new alert rule set goes live, run it silently against live zones and compare what it would have sent (`006_shadow_tables.sql:76`). This improves accuracy, which is also an Art. 5(1)(d) duty. |
| Necessity   | Comparing rule sets needs the real zone distribution, because synthetic zones miss rural clustering. Nothing is sent; rows hold bound parameters only (006:89–90). |
| Balancing   | Expectations are low risk, because this is the same processing as the service itself, done in advance. Mitigations: rows cascade with the zone (006:79) and are erased with the account. **Gap:** no time bound yet ([ropa.md](ropa.md) §3.9). |
| Result      | Applies, subject to a retention bound. **FOUNDER DECISION**: proposal is 90 days after the candidate is decided. |

## LIA-5 — Erasure ledger (RoPA P6)

The primary basis is compliance (Art. 17 together with Art. 5(2) accountability), with
6(1)(f) as the fallback.

| Test        | Assessment |
| ----------- | ---------- |
| Purpose     | Prove the erasure happened. Replay it if a backup taken before the erasure is restored. |
| Necessity   | A restore inside the 28-day window would otherwise resurrect the account. The ledger stores only `sha256(account id)`, timestamps and counts (010:106–119). |
| Balancing   | The hash links to nothing live. The rows are purgeable after the 30-day horizon through `purge_erasure_ledger` (010:123). |
| Result      | Applies. **FOUNDER DECISION**: the purge age (the proposal is horizon + 30 days), and the backup class, which is `personal` today (010:170). |
