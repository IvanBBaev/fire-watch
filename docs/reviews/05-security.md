# Review 05 — Security & Privacy

*Role: senior security & privacy engineer. Scope: design review of `docs/ANALYSIS.md` and
`docs/decisions/001-map-stack.md`. Status: pre-code — this review defines the security/privacy
requirements that must be designed in, not retrofitted.*
*Date: 2026-07-21.*

---

## 1. Summary verdict

**Conditional GO.** The proposal is architecturally sound and unusually honest for a consumer
safety-adjacent product (freshness-as-data, "never imply live", no "all clear" messaging are
genuine security-relevant strengths). The free-data / flat-cost / CDN-first posture also happens
to be the right *availability* posture. However, the design is silent on its most dangerous
surface — **the alert pipeline as a mass-notification weapon** — and treats GDPR as a bullet
point when watch zones are, in practice, a database of home coordinates joined to disaster
exposure. Neither gap blocks the MVP (map-only, no accounts), but both **must be resolved in
design before v1 (accounts + geofence alerts) ships**. This document supplies the missing
designs: a threat model, an alert-integrity architecture, a data inventory with retention rules,
an auth design for MVP→v2, and an incident-response skeleton.

Gate for v1: items marked **[GATE-v1]** below. Gate for v2 (public API/B2B): **[GATE-v2]**.

---

## 2. Strengths (validated as sound)

1. **Honest-freshness UX as a design invariant** (`last_observed_at`, "never imply live").
   This is the single best liability *and* integrity control in the document. An alert system
   that communicates uncertainty truthfully is far harder to attack with "you told us X"
   claims, and it reduces the blast radius of upstream data errors. Keep it non-negotiable.
2. **Server-side single-poller ingestion.** One process polls FIRMS/EFFIS for the whole Balkan
   bbox. Users never trigger upstream fetches — this eliminates the most common
   cost-amplification and quota-exhaustion class by construction. Preserve this property when
   adding features (see §5.5.2).
3. **Flat-cost, CDN-fronted map stack (ADR-001).** Choosing MapLibre + self-hosted PMTiles on
   R2 for the exact reason that traffic spikes correlate with disasters is availability
   engineering done at the right layer. The "OpenFreeMap has no SLA → move before first real
   season" trade-off is explicitly acknowledged rather than hidden.
4. **Append-only raw detections + derived FireEvent.** Reprocessability doubles as forensic
   capability: if the clustering or an upstream feed is ever poisoned or buggy, the raw log
   lets you prove what was received and when. Extend the same append-only discipline to the
   notification outbox and editorial actions (§5.2).
5. **Persistence rules before alerting** (≥2 detections for default-sensitivity zones) — a
   correct integrity control against single-pixel false positives, already in the plan.
6. **Explicit non-goals** (no dispatch tooling, no prediction) keep the product out of the
   highest-liability categories.
7. **GDPR is at least named** (minimize, encrypt, allow deletion; push tokens recognized as
   personal data) and the licensing/attribution posture is checked per source, including the
   flag to re-verify EUMETSAT redistribution terms — correct instinct.
8. **"Never send all-clear" and panic-minimizing alert copy** — a real safety control, not
   just comms polish.

---

## 3. Risks & gaps (severity-ranked)

Severity = f(likelihood, impact) for *this* product: a trust business where one bad mass
notification or one leaked location database can end it.

| # | Sev | Risk / gap | Where the design is silent |
|---|-----|------------|---------------------------|
| R1 | **Critical** | **Unauthorized mass notification.** Nothing in the design constrains what can trigger a push/email/Telegram send to many users at once. A compromised admin session, a leaked VAPID/email key, or an upstream data glitch (e.g. FIRMS republishing an archive window) could push "fire near you" to the entire user base. For a trust business this is an extinction-level event. | Alert engine → "notification outbox" is drawn, but no approval flow, no rate/blast-radius guards, no kill switch, no key-management plan. §5.2 supplies the design. **[GATE-v1]** |
| R2 | **High** | **Watch zones are home/property coordinates.** A breach discloses where users live/own property *and* that they are fire-exposed. The plan says "minimize, encrypt, allow deletion" with no concrete mechanism, no retention rules, no DPIA, no processor (DPA) list. | §5.3 supplies data inventory, retention, DPIA rationale, DPA checklist. **[GATE-v1]** |
| R3 | **High** | **Upstream anomaly → automated false-alert storm.** The pipeline is fully automated from CSV to outbox. Upstream reprocessing, duplicated granules, a bbox typo, or a clustering bug can mass-generate "new" events. Persistence rules help per-event but nothing detects *systemic* anomalies. | No circuit breaker / send budget in the architecture. §5.2.3. **[GATE-v1]** |
| R4 | **High** | **DDoS timed to a real fire.** ADR-001 solves *tile* availability; the API layer (Fastify origin, SSE fan-out, auth endpoints) has no stated protection, no degraded mode, no origin-hiding plan. Attacks (or just organic 600k-overnight load, per the Watch Duty precedent) will arrive exactly when the service matters. | §5.5.1 + recommendations D1–D5. **[GATE-v1]** |
| R5 | **High** | **Fake fire panic via crowdsourced reports** (listed as a data layer with "needs moderation" and nothing else). Coordinated fake reports during a real season = weaponized panic, media blowback, possible legal exposure (BG penal code sanctions false alarm to emergency services; a platform amplifying fakes invites scrutiny). | §5.2.5 supplies a verification/moderation design. Gate: do not ship user reports without it. |
| R6 | **Medium-High** | **Curated incident log poisoning** via editor account takeover or weak editorial workflow. The log is the "human trust layer" — precisely why it is the highest-value integrity target after the alert pipeline. | No roles, no 2FA, no draft/review workflow specified. §5.4.3. **[GATE-v1]** |
| R7 | **Medium** | **Auth is entirely unspecified** ("Accounts + geofence alerts" is one line). Session model, credential type, CSRF, account recovery, admin separation — all open. Wrong defaults here (e.g. long-lived JWTs in localStorage) are expensive to unwind. | §5.4 supplies the design. **[GATE-v1]** |
| R8 | **Medium** | **Notification bombing / third-party abuse of alert settings:** attacker enters a victim's email + 20 zones in high-activity areas → harassment via our sender domain; also burns sender reputation. Magic-link issuance is a second email-bombing vector. | Double opt-in + caps, §5.5.3. **[GATE-v1]** |
| R9 | **Medium** | **Single-maintainer supply chain.** One person's GitHub/npm/Cloudflare/Neon accounts are the entire trust root; CI secrets, dependency policy, lockfile discipline unstated. | §5.6.1. |
| R10 | **Medium** | **Server-side parsing of untrusted upstream bytes** (FIRMS CSV, EFFIS WMS rasters, later FCI netCDF via native libs). Compromise or MITM of an upstream, or a malformed file, hits our ingestion process. netCDF (C libraries) is the riskiest parser in the roadmap. | §5.6.2. |
| R11 | **Medium** | **Privacy leakage to third parties not in the model:** the tile CDN sees each user's map viewport (≈ area of interest ≈ where they live); Telegram/Viber see alert content incl. approximate location; browser push services see delivery metadata. None of this is in the privacy plan. | §5.3.5–5.3.6. |
| R12 | **Low-Med** | **API scraping/repackaging.** Annoying and costs bandwidth, but the raw data is free upstream anyway; the defensible assets are the curated log, event history, and alerting. Don't over-invest; solve via CDN caching + per-key quotas + ToS. | §5.5.4. **[GATE-v2]** |
| R13 | **Low-Med** | **Webhook/API key handling for B2B** (v2): unsigned webhooks are trivially spoofable to *customers'* systems — an integrity failure that lands on their side but our reputation. | §5.4.4. **[GATE-v2]** |
| R14 | **Low** | **Disclaimer treated as sufficient liability control.** A disclaimer is necessary but weak alone; the strong controls are the honesty UX, alert-copy discipline, and a practiced incident-response process — the last of which doesn't exist yet. | §5.7. **[GATE-v1]** for the IR skeleton. |

---

## 4. Detailed recommendations

Grouped, each mapped to risks. "MVP" = map-only launch; "v1" = accounts+alerts; "v2" = API/B2B.

### A. Alert pipeline integrity (R1, R3) — see design in §5.2
- **A1 (v1):** All notifications flow through one **Notification Gateway** with enforced
  budgets; no other code path may reach a push/email/Telegram adapter. Enforce with module
  boundaries + lint rule (adapters importable only by the gateway package).
- **A2 (v1):** **Blast-radius budget:** one triggering event may auto-notify ≤ B users
  (start B=500); global ceiling ≤ G sends / 10 min (start G=2,000). Exceeding either
  **queues instead of sends** and pages a human.
- **A3 (v1):** **Manual broadcast = two-person rule** (creator ≠ approver, both 2FA'd),
  templated copy only, mandatory test-send to staff channel first.
- **A4 (v1):** **Anomaly circuit breaker** on ingestion: if new-detections/interval or
  matched-zones/interval exceeds Nx trailing seasonal baseline, pause the outbox drain, alert
  the operator. Fail *closed* for notifications, *open* for the map (map shows data with a
  banner; alerts wait for a human).
- **A5 (v1):** **Kill switch**: a single documented, tested command halts all sends. Rehearse
  before each fire season.
- **A6 (v1):** Secrets: VAPID private key, email/Telegram tokens live only in a secrets store
  (provider secret manager or Doppler/1Password), never in repo/CI logs; per-environment keys;
  rotation runbook written on day one (§5.2.4).
- **A7 (v1):** Append-only **send audit log**: every notification records trigger provenance
  (detection IDs, event ID, rule version, actor if manual). Retention 24 months.

### B. Privacy engineering (R2, R11) — see §5.3
- **B1 (v1):** Store watch zones as **center + radius only**; never persist reverse-geocoded
  addresses; offer a **precision-reduction option** ("round my zone to ~1 km") and make the
  radius, not the point, the primary UX concept.
- **B2 (v1):** **Application-layer encryption of zone coordinates** (per §5.3.2) on top of
  provider disk encryption, so a SQL-level leak (backup, misconfigured replica, SQL injection)
  doesn't yield plaintext home coordinates.
- **B3 (v1):** Implement the **data inventory & retention table** (§5.3.3) literally: TTL jobs,
  30-day account-deletion pipeline including push tokens and zone history, backup expiry ≤ 30
  days documented in the privacy policy.
- **B4 (v1):** **Conduct a lightweight DPIA before v1 launch** (§5.3.4). Half a day now;
  demonstrable-compliance gold later, and it forces the minimization decisions above.
- **B5 (v1):** Sign **DPAs** with every processor before v1: Neon *or* Supabase (choose EU
  region — Frankfurt), Cloudflare, the email provider, hosting. Maintain the processor list in
  the privacy policy (Art. 13 transparency). Prefer EU regions to keep most flows out of
  Chapter V transfer analysis; where a US provider is unavoidable, verify current DPF
  certification or SCCs in their DPA.
- **B6 (MVP):** Cookie/tracking posture, delivered as promised: no third-party trackers, fonts
  self-hosted, **self-hosted cookieless analytics** (Plausible/Umami) → no consent banner
  needed for MVP (strictly-necessary only); still publish a privacy policy from day one because
  server logs contain IPs.
- **B7 (v1):** Disclose third-party metadata flows in the privacy policy: tile CDN (viewport),
  push services (delivery metadata; payloads are end-to-end encrypted per RFC 8291 — say so,
  it's a selling point), Telegram/Viber (message content — offer web push/email as the
  private-by-default channel and label the bot channels accordingly).
- **B8 (v1):** **Strip EXIF (esp. GPS) from crowdsourced photos at upload**; store the
  reporter-selected map location, not device GPS trails, unless the user explicitly shares it.

### C. AuthN/AuthZ (R6, R7, R13) — see §5.4
- **C1 (v1):** First-party auth = **cookie sessions** (HttpOnly, Secure, SameSite=Lax,
  server-side session store in Postgres) — not JWTs — so takeover response is "revoke row".
- **C2 (v1):** **Magic link + OAuth (Google, Apple)**, no passwords at v1. Rate-limit link
  issuance (3/address/hour), links single-use, 15-min expiry, bound to requesting UA family.
- **C3 (v1):** Admin/editor plane: separate subdomain + separate session namespace, **2FA
  mandatory (WebAuthn/passkey preferred, TOTP fallback)**, role split
  `editor` / `alert-operator` / `admin` (§5.4.3); editors cannot send notifications at all.
- **C4 (v1):** Draft→publish workflow for incident-log entries; second review required only
  when an entry triggers notifications or is marked "major incident". Full audit trail.
- **C5 (v2):** B2B API keys: `fwk_live_` prefix, random 256-bit, **store only a SHA-256 hash**,
  show once, per-org scoping, self-serve rotation, last-used tracking.
- **C6 (v2):** **Sign webhooks**: HMAC-SHA256 over `timestamp + "." + body` with a per-endpoint
  secret, `FW-Signature: t=...,v1=...` header, receivers instructed to reject |now−t| > 5 min
  (replay defense). Publish verification snippets. Include event IDs for idempotency.

### D. Availability under fire (R4) — see §5.5.1
- **D1 (v1):** Everything unauthenticated must be **CDN-cacheable**: live events served as a
  snapshot GeoJSON regenerated every 30–60 s and cached at the edge (this also neutralizes
  most scraping and most DDoS economics). SSE is an enhancement, not a dependency — client
  falls back to polling the cached snapshot.
- **D2 (v1):** Origin behind Cloudflare proxy; origin firewalled to Cloudflare IPs; origin
  hostname/IP never published; rate-limit and Under-Attack mode runbooks written in advance.
- **D3 (v1):** **Separate the alert pipeline from the public web origin** (distinct process,
  ideally distinct small VM/worker): map DDoS must not delay notification sends.
- **D4 (v1):** Define **degraded mode** explicitly: static status page + last-good snapshot on
  R2, banner "map under heavy load; alerts unaffected". Practice the switch.
- **D5 (MVP):** Status page hosted **off-infrastructure** (e.g. a managed status service or a
  separate static host) so it survives our outage.

### E. Ingestion hardening (R3, R10) — see §5.6.2
- **E1 (MVP):** Treat FIRMS CSV as untrusted input: TLS-only with cert validation, response
  size cap (e.g. 20 MB), strict schema (column allowlist), numeric range validation
  (lat∈[-90,90], lon∈[-180,180], bbox sanity, FRP ≥ 0, timestamps within [now−7d, now+1h]),
  row-count anomaly check feeding the A4 circuit breaker.
- **E2 (MVP):** WMS overlays: prefer passing the WMS URL template to the client (MapLibre
  raster source) so our server never decodes third-party images; if we must proxy (for privacy
  or caching), proxy bytes with content-type/size checks — never decode server-side.
- **E3 (post-MVP, FCI):** netCDF decoding (native C libs) runs in an **isolated worker**
  (separate container/process, no DB credentials, output = validated JSON only, memory/time
  limits). This is the only parser in the roadmap worth sandboxing.
- **E4 (v2):** Any CSV/report export we generate: escape cells starting with `= + - @`
  (CSV-injection guard for customers opening exports in Excel).

### F. Platform & supply chain (R9) — see §5.6.1
- **F1 (MVP):** Hardware-key 2FA on GitHub, npm, Cloudflare, registrar, Neon/Supabase, EUMETSAT
  and email-provider accounts. As a solo project, these accounts are the root of trust.
- **F2 (MVP):** Committed lockfile + `npm ci`; Renovate/Dependabot; `npm audit` (fail on
  high) in CI; pin GitHub Actions by commit SHA; no new runtime dependency without a 5-minute
  review (maintenance, install scripts, transitive weight). Prefer zero-dependency parsing
  (FIRMS CSV is simple enough to parse with ~30 lines of TS — do that instead of a CSV lib).
- **F3 (v1):** CI secrets via GitHub Environments with required reviewers for deploy; prefer
  OIDC federation to cloud providers over long-lived keys; secret scanning + push protection
  enabled on the repo.
- **F4 (MVP):** Security headers from the first deploy: CSP (script-src 'self'; worker-src
  blob: for MapLibre; connect-src limited to our API + tile hosts), HSTS, X-Content-Type-
  Options, Referrer-Policy, frame-ancestors 'none' (except the future embeddable map, which
  gets its own route and policy).

### G. Legal-adjacent (R14) — see §5.7
- **G1 (v1):** Layered disclaimer: registration-time acknowledgement + footer in **every
  alert** ("satellite data, may be delayed/incomplete — emergency: 112") + ToS liability
  wording. Never rely on the homepage disclaimer alone.
- **G2 (v1):** Write and rehearse the **incident-response playbooks** in §5.7.2 (false alert,
  missed fire, data breach) before the first fire season with real users.
- **G3 (pre-revenue):** Operate through a limited-liability entity (ЕООД/ООД) before v1
  accounts launch; evaluate professional liability insurance at B2B stage.

---

## 5. Security & privacy deep dive

### 5.1 Threat model

Assets, in order of value: (1) alert pipeline integrity, (2) watch-zone/user database,
(3) curated incident log integrity, (4) service availability during fires, (5) API/data,
(6) brand/trust (derivative of 1–5).

Attackers: pranksters/griefers (high likelihood, low sophistication), ideologically motivated
panic-spreaders or arsonists wanting cover/chaos (low likelihood, medium capability),
commercial scrapers (medium, low), opportunistic credential-stuffers and botnets (high, low),
targeted attacker against admin accounts (low, medium-high). No nation-state modeling —
disproportionate for this product; note only that a regional-crisis scenario would raise the
panic-spreading tier.

Threat table (STRIDE class in brackets; L/I = likelihood/impact 1–5; controls reference §5.x
and recommendations A–G):

| ID | Threat (concrete scenario) | [STRIDE] | L | I | Risk | Controls |
|----|----------------------------|----------|---|---|------|----------|
| T1 | Leaked VAPID key / email API key used to push fake "evacuate now" to all subscribers | [S,E] | 2 | 5 | **High** | A6 key custody & rotation; §5.2.4 (push-token custody makes raw VAPID leak insufficient without DB access); A7 audit detects; A5 kill switch limits duration |
| T2 | Compromised admin session triggers manual mass broadcast | [E] | 2 | 5 | **High** | C3 2FA + separate admin plane; A3 two-person rule; A2 budgets cap damage; A7 attribution |
| T3 | Upstream glitch (FIRMS archive republish, duplicated FCI granules) auto-generates false alert storm | [T on data, integrity] | 3 | 4 | **High** | E1 timestamp/rowcount validation; A4 circuit breaker; A2 budgets; dedup on (source, pixel, acq_time) already planned |
| T4 | Coordinated fake crowdsourced reports create phantom fire during real season | [S] | 4 | 3 | **High** | §5.2.5 verification ladder: reports never auto-alert, satellite-corroboration tiers, new-account limits, moderation queue |
| T5 | DDoS on API/SSE during major fire (or organic 100× spike, indistinguishable) | [D] | 4 | 4 | **High** | D1 edge-cached snapshot; D2 origin shielding; D3 pipeline isolation; D4 degraded mode |
| T6 | DB breach exfiltrates watch zones + emails (home locations of fire-exposed people) | [I] | 2 | 5 | **High** | B1 minimization; B2 app-layer encryption; §5.4 auth hygiene; F1/F3 account & secret custody; §5.3.7 breach playbook |
| T7 | Editor account takeover poisons curated incident log ("fire is out" on an active fire) | [S,T] | 2 | 4 | **Med-High** | C3 2FA + roles (editors can't notify); C4 review for major entries; A7-style edit audit; "never all-clear" copy rule limits worst payload |
| T8 | Notification bombing: attacker registers victim's email with many zones | [D, abuse] | 3 | 2 | **Med** | B/§5.5.3 double opt-in before any alert email; per-user and per-address caps; suppression list |
| T9 | Magic-link email bombing / signup flood burns sender reputation | [D] | 3 | 2 | **Med** | C2 issuance limits; CAPTCHA-on-anomaly; separate sending domain for auth vs alerts |
| T10 | Credential stuffing / session theft on user accounts (zones reveal home) | [S] | 3 | 3 | **Med** | C1 sessions revocable; C2 passwordless (no password corpus to stuff); §5.4.1 cookie hardening |
| T11 | Scraper repackages our event feed / hammers API | [I,D] | 4 | 1 | **Med-Low** | D1 caching makes it cheap; C5 keys + quotas at v2; ToS + attribution; don't over-invest |
| T12 | MITM or compromise of upstream (FIRMS/EFFIS) serves poisoned data | [T] | 1 | 4 | **Med-Low** | TLS + cert validation (E1); cross-source corroboration for high-blast-radius alerts (A2 ties auto-send size to multi-source confidence); provenance stored per detection |
| T13 | Malformed upstream file exploits our parser (worst: netCDF native libs) | [E] | 1 | 4 | **Med-Low** | E1 hand-rolled minimal CSV parse; E2 no server-side image decode; E3 sandboxed netCDF worker |
| T14 | Spoofed webhooks sent to B2B customers "from us" | [S] | 2 | 3 | **Med** (v2) | C6 HMAC signatures + timestamp; customer verification docs |
| T15 | Cost-amplification: endpoint that fans out to Open-Meteo/CDSE per request | [D, cost] | 3 | 2 | **Med** | §5.5.2: enrich per *event* at ingest, never per user request; cache reverse-geocoding; no user-triggered upstream calls |
| T16 | Supply-chain: malicious npm dependency update exfiltrates secrets from CI or server | [T,E] | 2 | 4 | **Med** | F2 lockfile/pinning/review; F3 OIDC + scoped secrets; minimal dependency policy |
| T17 | Phishing site imitating Fire Watch during a fire event | [S, external] | 2 | 3 | **Med** | Defensive domain registrations (.bg/.com/.eu), DMARC p=reject + SPF/DKIM from day one, brand monitoring during season, report-abuse contact |
| T18 | Push-token DB misuse: tokens exfiltrated and spammed | [I,S] | 1 | 3 | **Low** | Tokens useless without our VAPID key (RFC 8292 binding); still: prune invalid tokens, treat as personal data (§5.3.3) |
| T19 | Repudiation: dispute over "you did/didn't send that alert" (user, media, or regulator) | [R] | 3 | 2 | **Med** | A7 append-only send log with provenance; retained 24 months; clock-synced servers |
| T20 | Insider/founder error: wrong bbox, test alert to prod | [T, human] | 3 | 3 | **Med** | A2 budgets apply to staff too; staging environment with fake tokens; test-send-to-staff step in A3; config changes in git |

### 5.2 Alert pipeline integrity (the crown jewel)

**Principle: the map may fail open; alerts fail closed.** A stale map is annoying; a false
mass alert is fatal to the product. Every design choice below follows from that asymmetry.

#### 5.2.1 Single choke point: the Notification Gateway

```
alert engine (geofence match)──┐
manual broadcast (2-person) ───┼──► notification_outbox (Postgres, append-only)
incident-log "notify" action ──┘            │
                                            ▼
                              Notification Gateway (sole consumer)
                              • budget check (per-event, global, per-user)
                              • circuit-breaker state check
                              • template rendering (no free text in v1)
                              • send + record in send_audit_log
                                            │
                              ┌─────────────┼─────────────┐
                              ▼             ▼             ▼
                          web push        email        telegram
                          (VAPID)       (provider)      (bot)
```

- The push/email/Telegram adapters are importable **only** by the gateway package (enforced
  by lint rule / project references). No script, cron, or admin route can reach a channel
  adapter directly. This turns "can an attacker send notifications?" into a single question:
  "can they write approved rows into the outbox *and* keep the gateway's guards green?"
- Outbox rows carry provenance: `trigger_type` (auto-geofence | manual | incident),
  `trigger_ref` (event/detection IDs or actor + approver IDs), `rule_version`, `template_id`,
  `params`. The gateway refuses rows without valid provenance.

#### 5.2.2 Budgets and approval tiers

| Tier | Trigger | Blast radius | Guard |
|------|---------|--------------|-------|
| T-auto | Geofence match from clustered event | ≤ B users per event (start B=500) | Fully automatic, but only for events meeting confidence floor (≥2 detections or multi-source); above B → queue + page human |
| T-approve | Any manual broadcast; any auto batch > B; any "major incident" notify | Up to segment/all | **Two-person rule** (creator ≠ approver, both 2FA), template-only copy, mandatory staff test-send, 10-min cool-off unless approver marks "urgent" |
| Global | All sends combined | G / 10 min (start G=2,000) | Exceeding G pauses drain + pages; resume is a human action |

Budgets are config-in-git, changed by PR — so loosening them is itself audited.

#### 5.2.3 Circuit breaker (defends against T3, T20)

Ingestion maintains rolling baselines (per source: detections/interval; alert engine:
matched-zones/interval). If current > max(k × baseline, absolute floor) — suggested k=5 —
the breaker opens: outbox continues to *fill* (nothing is lost) but the gateway stops
draining, and the operator is paged with a one-screen diff ("VIIRS returned 40× normal rows;
timestamps cluster in 2025 — probable archive republish"). Human closes the breaker
explicitly. The map keeps updating with a banner. This converts the worst automated-integrity
failure into a 15-minute delay plus a human decision.

#### 5.2.4 Key custody

- **VAPID keypair**: private key only in the runtime secret store of the gateway service;
  never in the web app, repo, or CI logs. Note the useful property of Web Push (RFC 8291/8292):
  payloads are encrypted per-subscription and sends are authenticated by our VAPID key, so an
  attacker needs *both* the key and the subscription DB to spam users — keep those two in
  separately-permissioned places (key in secret manager; DB creds not readable by CI).
- **Email**: dedicated subdomain for alerts (e.g. `alerts.firewatch.bg`) with its own DKIM;
  provider API key scoped to that domain, send-only. DMARC `p=reject` on all domains from day
  one (also anti-phishing, T17).
- **Telegram bot token**: same secret-store rules; bot can only *send*, business logic never
  trusts inbound Telegram content for state changes.
- Rotation runbook (one page): where each key lives, how to rotate, expected user impact
  (VAPID rotation invalidates subscriptions → re-subscribe flow must exist before v1).
- Environments: separate keys per env; staging sends only to an allowlist of staff addresses/
  tokens — enforced in the gateway, not by convention.

#### 5.2.5 Crowdsourced reports: verification ladder (defends T4)

Design rule: **user reports are evidence, never triggers.** They can corroborate and annotate;
they cannot cause notifications or create events on the public map by themselves.

1. **Intake**: report = location (map-picked), category, optional photo (EXIF-stripped, B8),
   optional text. Requires an account with verified email; per-account limits (e.g. 3 open
   reports); new accounts (<7 days) get lower limits and no photo publishing.
2. **Tier 0 — private**: visible to moderators only.
3. **Tier 1 — corroborated**: shown on the map as a small "unverified report" glyph (visually
   subordinate to satellite data) only if ≥2 independent accounts report within 2 km/1 h
   (independence: different accounts, different IP /24, account age > 7 days) **or** the
   report falls within N km of an active satellite-detected event.
4. **Tier 2 — verified**: moderator confirms (satellite corroboration, official bulletin,
   trusted reporter). Only Tier 2 may be referenced in incident-log entries; **even Tier 2
   never auto-notifies** — notification remains a T-approve human action.
5. **Trust ledger**: per-account reporter score (confirmed vs rejected history); repeated
   false reports → shadow-limit, then ban; retain evidence for potential referral (deliberate
   false alarm is an offence under BG law — mention in ToS as deterrent).
6. **Season readiness**: moderation staffing plan (even if it's "founder + 2 volunteers with
   a Telegram channel"), documented SLAs (Tier-1 triage < 30 min in season), and a one-tap
   "mark area as mass-false-report target" tool that freezes Tier-1 display in a polygon.

### 5.3 GDPR & privacy engineering

#### 5.3.1 What we actually hold, and why it's sensitive

Watch zones are not "coordinates"; they are **a registry of where people sleep and what they
own, joined to email addresses and to the fact that those places are threatened by fires**.
Under GDPR this is ordinary personal data (not Art. 9 special category), but WP29/EDPB
guidance treats location data as "data of a highly personal nature". Design accordingly: the
correct mental model is "we hold a small, highly-targetable subset of the population register".

#### 5.3.2 Minimization & protection mechanisms

- **Model zones as circle (center, radius)** with user-chosen radius ≥ 500 m. The radius is
  the product concept ("alert me about this area"), which honestly reflects both alerting
  semantics and privacy: we do not need the house, we need the neighborhood. Offer explicit
  **precision reduction** ("snap center to 1 km grid") as a setting; default the *display*
  (e.g. in emails: "your zone near Karlovo") to place names, never raw coordinates.
- **Application-layer encryption** for zone centers: encrypt (lat, lon) with a service-held
  key (AES-256-GCM, key in the secret manager, not in the DB). Geofence matching then works
  on a **coarsened plaintext index**: store the containing ~5 km grid cell id in clear for
  candidate lookup, decrypt candidates in the alert engine for the precise ST_DWithin test.
  Cost: a few ms per matching cycle at our scale. Benefit: SQL injection, a leaked backup, or
  a read-only replica leak yields grid cells, not homes. (If this is judged too heavy for v1,
  the documented fallback is: provider disk encryption + column-level pgcrypto for centers +
  strict DB-role separation — but say so in the DPIA rather than silently downgrading.)
- **No address book**: never store reverse-geocoded addresses or place labels alongside zones;
  compute display names on the fly.
- **Push tokens, emails, Telegram chat IDs** = personal data; same deletion pipeline as zones.
- **Logs**: no coordinates in application logs; log zone IDs only. IPs in access logs
  retained ≤ 30 days (legitimate interest: security), then dropped or truncated to /24.

#### 5.3.3 Data inventory & retention table (implement as TTL jobs)

| Data | Personal? | Purpose | Lawful basis | Retention | Notes |
|------|-----------|---------|--------------|-----------|-------|
| Raw satellite detections | No | Core product, reprocessing | — | Indefinite (append-only) | Environmental data, no personal nexus |
| Fire events (derived) | No | Product, history, B2B reports | — | Indefinite | |
| Account (email, name opt., locale) | Yes | Service delivery | Art. 6(1)(b) contract | Life of account + 30-day deletion grace | Email verification state stored |
| Watch zones (center, radius, settings) | **Yes — high** | Geofence alerts user configured | Art. 6(1)(b) | Life of account; hard-delete in deletion pipeline | §5.3.2 protections |
| Push subscriptions (endpoint, keys) | Yes | Deliver push | Art. 6(1)(b) + browser-level consent | Until unsubscribed/invalid; prune on 410 Gone | Payloads E2EE (RFC 8291) |
| Telegram/Viber chat IDs | Yes | Deliver alerts on chosen channel | Art. 6(1)(b) | Until channel unlinked | Content visible to platform — disclosed (B7) |
| Notification send log | Yes (links user↔alert) | Integrity, dispute resolution (T19) | Art. 6(1)(f) legitimate interest | 24 months, then anonymize (drop user ref, keep aggregate) | Append-only |
| Crowdsourced reports (loc, photo, text) | Yes | Ground truth, moderation | Consent for publication; 6(1)(f) for moderation record | Public content: until deleted by user/mod; moderation ledger: 24 months | EXIF stripped at upload (B8) |
| Reporter trust ledger | Yes | Abuse prevention | Art. 6(1)(f) | 24 months rolling | Documented in policy |
| Server access logs (IP, UA) | Yes | Security, capacity | Art. 6(1)(f) | ≤ 30 days | Then delete/truncate |
| Editorial/admin audit log | Yes (staff) | Accountability | Art. 6(1)(f) | 24 months | |
| Analytics | No (design goal) | Product usage | — (cookieless, aggregate) | Aggregate only | Self-hosted Plausible/Umami, no cookies, no cross-site IDs |
| Marketing/waitlist list | Yes | News, launch emails | Art. 6(1)(a) consent | Until withdrawn | Separate from alert emails; separate unsubscribe |
| Backups | Yes (contains above) | DR | Same as source | Expire ≤ 30 days | Deletion propagates by expiry; state this in policy |
| B2B org data (polygons, contacts, keys) | Yes (contacts) | Contract | Art. 6(1)(b) | Contract + statutory (accounting) | Org polygons are business data but often sensitive commercially — same encryption tier as zones |

**Lawful-basis analysis for alerts (the key call):** alerts the user explicitly configured are
**performance of contract (6(1)(b))** — the service *is* "notify me about my zones". Do not
model them as consent: consent withdrawal semantics would be duplicative and 6(1)(b) is the
honest basis. Consequences: (a) alert emails need no marketing-style opt-in but **do** need
verified ownership of the address (that's the abuse control, §5.5.3, and an accuracy duty);
(b) anything *beyond* the configured service — newsletters, product announcements, "smoke
advisory for your region" not tied to a saved zone — needs separate consent (6(1)(a)); (c) a
hypothetical future cell-broadcast-style "everyone in this area" feature would need a fresh
analysis (likely 6(1)(d)/(f) with a DPIA update) — out of scope now, flag it.

#### 5.3.4 DPIA: warranted — do a lightweight one before v1

Against the EDPB criteria (WP248): the service processes (1) **location data / data of highly
personal nature**, (2) at potentially **large scale** in-region, (3) concerning people in
moments of **vulnerability** (disaster exposure), (4) in an **innovative** combination
(satellite feeds × home geofences × automated notification). Two criteria usually suffice to
warrant a DPIA; we plausibly meet four. Verdict: **required in substance and cheap in
practice** — one structured document (processing description, necessity/proportionality,
risks from §5.1, mitigations from this review), owned by the founder, reviewed annually
pre-season. The Bulgarian DPA (КЗЛД/CPDP) blacklist need not be consulted as a blocker;
doing the DPIA voluntarily is the defensible posture either way. Prior consultation (Art. 36)
is not expected to be triggered given the mitigations above.

#### 5.3.5 Processors, DPAs, transfers

| Provider | Role | Action |
|----------|------|--------|
| Neon or Supabase (Postgres) | Processor (all personal data) | Choose **EU region (Frankfurt)**; sign/accept DPA (both publish standard DPAs incl. SCCs); verify current subprocessor list; both are US-headquartered → confirm DPF certification or rely on SCCs in the DPA |
| Cloudflare (CDN, R2, WAF) | Processor (IPs, request metadata) | Accept Cloudflare DPA; note requests transit globally by default — acceptable for content delivery; keep personal-data API responses uncached at edge or cached with care |
| Email provider (Postmark/Resend/SES) | Processor (emails, content incl. zone place names) | DPA; EU region if offered; alert copy should keep precise coordinates out of email bodies anyway (B1) |
| Browser push services (Google FCM endpoint, Mozilla, Apple) | Conduit; payloads E2EE | No DPA path for web-push conduits; document in policy: they see endpoint + timing metadata, not content |
| Telegram (later Viber) | Independent platform, sees content | Not a normal processor relationship — disclose clearly; position web push/email as the private channel (B7) |
| Hosting (VM/serverless) | Processor | EU region; DPA |
| Plausible/Umami (if cloud-hosted) | Processor | Prefer self-hosted (no third party at all); if cloud, EU-hosted option + DPA |
| EUMETSAT/NASA/Copernicus | Upstream data sources | No personal data flows to them (server-side polling only — keep it that way; E2/§5.5.2) |

Maintain this table in the privacy policy (processor transparency) and re-check at each new
provider. Records of processing (Art. 30): the data inventory table above *is* the seed —
keep it current.

#### 5.3.6 Third-party leakage the current design misses (R11)

- **Tile CDN sees viewports.** Whoever serves basemap tiles observes each user's IP + the map
  area they stare at — which, for a fire map with saved zones, approximates home location.
  OpenFreeMap advertises no tracking (good, but contractual/SLA-free); the Phase-2 move to
  self-hosted PMTiles on our own R2 **is also a privacy upgrade** — reflect that in ADR-001's
  rationale and in the privacy policy interim disclosure.
- **DEM/terrain tiles (AWS open data) and any Esri imagery toggle**: same viewport-leak
  pattern; list them in the policy; consider proxying or self-hosting terrain tiles at Phase 2.
- **Push metadata & messenger content**: covered above (B7).

#### 5.3.7 Data-subject rights & breach readiness

- Rights pipeline (v1): self-serve **export** (account, zones, notification history as JSON)
  and **delete** (immediate logical delete; hard-delete + token/queue purge within 30 days;
  backups age out ≤ 30 days). Identity for requests = login itself; no copies of ID documents.
- Breach playbook: detect → contain → assess scope (which tables, which users) → notify
  **КЗЛД within 72 h** (Art. 33) if risk; notify affected users (Art. 34) if high risk —
  for a watch-zone coordinate breach, assume Art. 34 applies. Pre-draft both templates now
  (§5.7.2). Log preservation duty in the playbook (copy audit + access logs to WORM storage).

### 5.4 Authentication & authorization design

#### 5.4.1 First-party auth (v1): cookie sessions, passwordless

- **Sessions, not JWTs**, for the web/PWA client: server-side session records in Postgres
  (id, user, created, last_seen, UA family), cookie `HttpOnly; Secure; SameSite=Lax; Path=/`,
  30-day sliding expiry. Rationale: (1) instant revocation on takeover or deletion — with
  stateless JWTs, "log out everywhere" and breach response require a denylist that recreates
  the session store anyway; (2) a PWA is still a browser — cookies work offline-first fine
  for our read-mostly UX (the map itself needs no auth); (3) one fewer key to protect. JWTs
  reappear only where they belong: nowhere in v1; v2 B2B uses API keys (5.4.4), not JWTs.
- **CSRF**: SameSite=Lax + same-origin checks (Origin header validation) on state-changing
  routes; @fastify/csrf-protection if we ever need cross-site POSTs (we shouldn't).
- **Magic link primary, OAuth secondary** (Google + Apple — the two the BG audience has):
  no password database means credential-stuffing (T10) and password-breach classes vanish.
  Magic-link hygiene: single-use, 15-min TTL, invalidated on new issuance, issuance
  rate-limited (C2), links bind to a server-side pending-auth record (not a signed
  self-contained token), and the landing page requires a click ("Continue") so mail scanners
  that prefetch URLs don't consume the link. Known trade-off: email delivery latency during
  peak fire events — OAuth is the fallback path, and sessions are long-lived so login is rare.
- Account recovery = magic link by construction; no security questions, no SMS resets.

#### 5.4.2 Why not passwords at all (v1)

Password support adds: hashing parameters to maintain, breach-notification duty for the hash
corpus, credential-stuffing surface, reset flows ≈ magic links anyway. Add passwords only if
user research shows real demand (e.g. shared family devices without email access); if so:
argon2id, zxcvbn-style strength floor, haveibeenpwned k-anonymity check, and 2FA offer.

#### 5.4.3 Staff plane: roles, 2FA, workflow (defends T2, T7)

- Separate admin app/subdomain, separate session namespace and cookie, IP allowlist optional
  but not relied on. **2FA mandatory: WebAuthn/passkey preferred, TOTP fallback**; recovery
  codes printed at enrollment; no SMS 2FA.
- Roles (least privilege):
  - `editor` — create/edit incident-log entries; **cannot send notifications**.
  - `alert-operator` — approve T-approve sends; cannot edit incidents (separation of the
    "content" and "reach" powers; one person may hold both roles but an approval still needs
    a second human, A3).
  - `moderator` — crowdsourced-report queue.
  - `admin` — user management, config; does not inherit send rights.
- All staff actions in an append-only audit table (actor, action, entity, before/after hash,
  IP, time). Incident-log entries have versions; public pages show "updated at" history —
  transparency doubles as tamper-evidence.

#### 5.4.4 v2 API & webhooks (B2B)

- **API keys**: `fwk_live_`/`fwk_test_` prefix + 256-bit random; store SHA-256 only; shown
  once; per-org, per-environment; scopes (`events:read`, `webhooks:manage`); self-serve
  rotation with 24-h dual-validity window; last-used timestamps surfaced (customer-side leak
  detection). Keys in `Authorization: Bearer`, never in query strings (log leakage).
- **Webhooks**: per-endpoint secret; signature `FW-Signature: t=<unix>,v1=HMAC_SHA256(secret,
  t + "." + rawBody)`; receiver guidance: constant-time compare, reject |now−t| > 300 s;
  event `id` for idempotent processing; retries with backoff + signed every time; optional
  static egress IPs published. URL validation on registration (deny private/link-local ranges
  — SSRF guard, since *we* call *their* URL).
- Org model: org accounts with member roles (owner/member), so a departing employee doesn't
  take the only credential.

### 5.5 Abuse & rate limiting

#### 5.5.1 Availability under fire (T5) — layered with the ADR-001 CDN plan

ADR-001 solves tiles; extend the same "flat-cost by construction" logic up the stack:

| Layer | Design | Effect |
|-------|--------|--------|
| App shell (PWA) | Static, CDN-cached, service-worker cached | Survives origin loss entirely |
| Basemap + terrain | R2/PMTiles (Phase 2) | Already spike-proof per ADR-001 |
| **Live events** | Snapshot GeoJSON regenerated every 30–60 s to R2/edge cache; clients poll it; SSE only as an enhancement over it | The hot read path never hits origin per-user; DDoS pays CDN prices, we don't |
| Event detail / history | Edge-cached per event (60 s TTL) | Same |
| Auth'd endpoints (zones, settings) | Origin, behind Cloudflare proxy + WAF + per-IP rate limit; origin firewalled to CF IPs; separate hostname not in DNS history | Small surface; attacker must be logged in or hits 401s at the edge |
| SSE | Hard connection cap; on saturation, server sends `retry`+close and clients fall back to snapshot polling; document as best-effort | Removes the only stateful fan-out from the critical path |
| Alert pipeline | Separate process/VM, no inbound public surface at all | Map DDoS cannot delay alerts (D3) |
| Status page | Off-infrastructure | Communication survives outage (D5) |

Load ≈ attack in this product (organic disaster spikes look like DDoS). Design for the
organic 100× case and DDoS mostly comes along for free; keep Under-Attack-mode and
"static-only degraded mode" as rehearsed runbooks, not improvisation (D4).

#### 5.5.2 Cost-amplification endpoints (T15)

Rule: **no user request may fan out to an external API.** Enrichment (wind vector, nearest
settlement, land cover) happens per *event* at ingestion time — bounded by fire count (10²–10³
/day), not user count. Audit every future endpoint against this rule; the likely violators to
watch for: "wind at my zone now", ad-hoc reverse geocoding in search, per-user smoke forecasts.
Pattern for all of them: precompute per event/region on a schedule, serve from our DB/cache.
Open-Meteo and CDSE quotas then bound our *cost*, never our availability under user load.

#### 5.5.3 Notification-bombing & email abuse (T8, T9)

- **Double opt-in before any alert leaves for an address/channel**: unverified email receives
  exactly one verification mail, nothing else, and pending-verification records expire in 48 h.
  Telegram linking = user-initiated from the bot side (deep-link token), so no unsolicited path.
- Caps: magic links ≤ 3/address/h; verification mails ≤ 3/address/day; alert emails per user
  ≤ N/day with automatic collapse into digests ("3 new detections near Zone A") — which is
  also better UX during big fires; per-IP signup limits + CAPTCHA only when anomaly detected
  (keep the happy path friction-free).
- Sender hygiene: separate subdomains for auth vs alert mail; suppression-list processing
  (bounces/complaints auto-disable channel, notify user in-app); DMARC/DKIM/SPF from day one.
- SMS (Phase-2 paid tier) is the expensive channel: budget per account, global daily budget
  alarm, and provider-side spend cap — SMS-pumping fraud (signup floods to premium-rate
  numbers) is a known attack; verify numbers via one OTP and rate-limit country prefixes.

#### 5.5.4 Scraping & repackaging (T11) — right-sized response

The raw hotspots are free upstream; over-defending them wastes effort. Posture: (1) the cached
snapshot endpoint is cheap to serve — let anonymous read happen within per-IP limits; (2) the
*valuable* surfaces (curated log with editorial content, event history API, webhooks) sit
behind v2 API keys with per-key quotas and ToS requiring attribution and forbidding
resale/re-alerting; (3) watermark editorial content (attribution line in payloads); (4) treat
persistent abusive scrapers as an ops problem (CF rules), not a product problem. Never respond
to scraping pressure by degrading the free public map — it's the mission and the moat.

### 5.6 Supply chain & platform hygiene (MVP scale)

#### 5.6.1 Accounts, secrets, dependencies (T16, R9)

Solo-maintainer reality: the root of trust is a handful of SaaS accounts. Controls that cost
almost nothing: hardware-key 2FA everywhere (F1); password manager; separate browser profile
for infra admin. Repo: secret scanning + push protection; branch protection on main; Actions
pinned by SHA; deploy secrets in GitHub Environments (required reviewer = yourself on a second
device is still a speed bump); prefer OIDC federation over long-lived cloud keys. Dependencies:
lockfile + `npm ci`; Renovate weekly batch (not instant-merge — a 3–7 day cool-down on new
releases dodges the classic hijacked-release window); `npm audit` gate; minimal-dependency
bias — specifically: hand-roll the FIRMS CSV parse (trivial, and removes a whole dependency
subtree from the most exposed input path); no `postinstall`-bearing deps without review.
Runtime: Node LTS only; containerized deploy with non-root user; env-var secrets injected at
runtime, never baked into images.

#### 5.6.2 Parser hardening for upstream data (T3, T12, T13)

Upstream feeds are honest but not *trusted*: they can be compromised, misconfigured, or weird.

- **FIRMS CSV** (highest frequency): HTTPS with certificate validation (default, but never
  disable for a "quick fix"); response size cap; content-type sanity; strict header allowlist;
  per-field validation (numeric parse without `eval`-adjacent coercion, lat/lon in bbox ∪
  sanity bounds, confidence in enum, acq timestamp within [now−7 d, now+1 h]); reject-and-
  quarantine rows that fail (store raw for forensics, alert on quarantine rate); row-count
  delta feeds the §5.2.3 breaker. Idempotent ingest keyed on (source, lat, lon, acq_date,
  acq_time, satellite) — already implied by the dedup plan; make it a DB constraint.
- **EFFIS WMS**: don't decode rasters server-side at all — client-side raster source (E2); if
  proxied later for privacy, stream bytes with size/content-type checks only.
- **FCI netCDF** (post-MVP): the one genuinely risky parser (native C via netCDF/HDF5 libs
  with a long CVE history). Isolate: separate worker container, read-only FS, no DB creds
  (emits validated JSON to a queue/file the main app validates again), memory/CPU/time limits,
  crash = skip granule + alert, never crash-loop into the main process.
- **Open-Meteo JSON**: schema-validate (zod) like any external input; bound array sizes.
- **Crowdsourced photos** (v1+): re-encode server-side (sharp) to strip EXIF *and* neutralize
  malformed-image payloads; size/dimension caps; serve from a separate cookie-less domain or
  R2 bucket with `Content-Disposition` safety and no HTML content types.

### 5.7 Legal-adjacent: disclaimers & incident response

#### 5.7.1 Is the planned disclaimer adequate?

As planned ("informational service, not an official warning system, call 112") it is
necessary but **not sufficient** as a liability posture. What actually minimizes liability is
the *system of record proving honest behavior*:

1. **Layered presentation**: one-time acknowledgement at account creation (logged, versioned);
   permanent footer **inside every alert** ("Satellite-based, may be delayed or incomplete.
   Emergency? Call 112. Official warnings: BG-ALERT"); map staleness UI (already planned).
   A homepage-only disclaimer is legally and practically weak — people receive alerts without
   visiting the homepage.
2. **ToS substance** (get one legal-review pass before v1): service "as is", no warranty of
   completeness/timeliness, liability cap, express statement that absence of an alert is not
   absence of fire, and that the service does not replace official channels. Bulgarian
   consumer law limits how far liability can be excluded for gross negligence — which is
   precisely why the *operational* controls (A1–A7, honesty UX, audit trail) matter more than
   wording: they are the evidence there was no negligence.
3. **Copy discipline as policy**: the "never all-clear, panic-minimizing copy" rule from the
   analysis should be written down as a reviewed style guide with banned phrases ("safe",
   "no danger", "contained" without source attribution) — template-only alerts (§5.2.1) make
   this enforceable in code.
4. **Entity**: operate via ЕООД before v1; revisit insurance (professional indemnity/cyber)
   when B2B SLAs appear — an SLA is a contractual liability we currently don't have; don't
   sign one before this review's controls exist. **[GATE-v2]**

#### 5.7.2 Incident-response plan (write now, rehearse pre-season)

Severity classes and playbooks (one page each):

- **INT-1 — false alert sent** (worst case: mass). Steps: (1) kill switch if still sending
  (A5); (2) within 30 min, send a **correction through the same channels to the same
  recipients** — template pre-drafted: what we said, what is actually known, why it happened
  in one sentence, what we're doing; never silent-delete; (3) freeze pipeline pending cause
  (breaker stays open); (4) preserve outbox + audit rows; (5) public postmortem within 72 h
  (the Watch Duty lesson: trust is built by owning errors during disasters, not by hiding
  them); (6) regression: add the trigger pattern to the breaker tests.
- **INT-2 — missed/late significant fire** (users reasonably expected an alert). Steps:
  reconstruct from raw detections (append-only log makes this possible — state the timeline
  factually: "first satellite pass detecting the fire was at HH:MM, data reached FIRMS at
  HH:MM, we alerted at HH:MM"); publish honestly, including the physics (pass gaps) — this is
  the scenario the honest-freshness UX exists for; check whether copy anywhere overpromised
  and fix it; if the miss was *our* bug (poller down, clustering), say so and fix visibly.
- **SEC-1 — data breach** (watch zones/emails): playbook per §5.3.7 — contain, scope, КЗЛД
  ≤ 72 h, users if high risk (assume yes for coordinates), rotate credentials, postmortem.
- **SEC-2 — account/key compromise without confirmed data exfiltration**: rotate (5.2.4
  runbook), audit send log for the exposure window, decide INT-1/SEC-1 escalation.
- Common infrastructure: on-call = founder (be honest about bus-factor 1 in season — a
  designated backup person with read access to runbooks is cheap insurance); off-infra status
  page (D5); media statement templates for INT-1/INT-2 pre-drafted in BG and EN; every
  incident file kept (regulator- and litigation-readiness).

---

## 6. Open questions for the team

1. **Who is the second human?** The two-person rule (A3), moderation SLAs (§5.2.5) and
   bus-factor-1 in fire season all assume at least one more trusted person. Is there a named
   volunteer/co-founder for season one, and do they get staff-plane accounts with 2FA?
2. **Neon vs Supabase**: the analysis says "e.g. Neon/Supabase". Decide early — Supabase
   bundles auth (tempting, but our passwordless design is small and owning sessions keeps the
   revocation story clean); either way the deciding security requirements are: EU region, DPA
   terms, PostGIS support maturity, backup retention configurability (must be ≤ 30 days or
   configurable, §5.3.3).
3. **Application-layer encryption of zone centers (B2)**: accepted for v1, or consciously
   deferred to the pgcrypto fallback? Decision goes in the DPIA either way.
4. **Telegram/Viber as alert channels**: the analysis treats them as pure reach; §5.3.5 shows
   they leak alert content to the platforms. Accept and disclose, or restrict bots to
   region-level (not zone-level) alerts?
5. **Blast-radius constants** (B=500 per event, G=2,000/10 min): sized from what user-count
   assumption? Revisit when v1 signup numbers are real; the *mechanism* matters more than the
   initial numbers, but the numbers need an owner.
6. **Embeddable media map** (business model mentions media licensing): embedding changes CSP
   (`frame-ancestors`), referrer, and scraping posture. In or out of v2 scope?
7. **B2B SLA wording**: what exactly will be promised (uptime of the map? alert delivery
   latency?)? Alert-latency SLAs are dangerous given upstream pass gaps we don't control —
   propose SLOs on *our* pipeline latency (detection-received → notification-sent) only.
8. **EUMETSAT redistribution terms** (flagged in the analysis): resolve before v2 exposes any
   FCI-derived events via the public API — licensing violations are a business-integrity risk
   this review inherits but cannot resolve.
9. **DPIA ownership and cadence**: proposed = founder writes v1 before alerts launch, reviews
   each spring pre-season. Agreed?
10. **Crowdsourced reports timing**: the analysis lists them as a data layer; this review
    gates them on the §5.2.5 ladder + moderation staffing. Which release do they actually
    target — and is the moderation capacity realistic for that season?

---

*End of review. This document is the security/privacy baseline; material deviations (dropping
app-layer encryption, loosening budgets, adding a notification path outside the gateway)
should be recorded as ADRs referencing the relevant section here.*
