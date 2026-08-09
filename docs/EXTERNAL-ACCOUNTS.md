# External accounts & registrations checklist

*Status: operational checklist.* Every external account, key, or application the
project needs, with lead times and costs, ordered by when it must exist. Licence
context per source lives in [`DATA-SOURCES.md`](DATA-SOURCES.md); custody rules per
ADR-004 D8: **all credentials live in the secret store, never in git; the
notification gateway is the only runtime holder of provider credentials.**

**"DPA accepted?" column.** Every account that could process personal data on our
behalf needs a data-processing agreement recorded *before* it touches such data.
The column is the tracking field: `required` = a DPA must be accepted/signed and
filed; `n/a` = the account sees no personal data (with the reason stated). This
column is the input to the WP7 processor register / RoPA and to the privacy
policy's processor-transparency table (05 §5.3.5) — keep it current, because at
WP7 it is copied, not reconstructed.

## Wave 0 — now / WP0 (Aug 2026)

| # | Account / registration | Needed for | Lead time & notes | DPA accepted? | Cost |
|---|---|---|---|---|---|
| 1 | **FireSat Early Adopter registration** | evaluating the FireSat feed (data Q4 2026; free licences 2027) | **Time-sensitive — register now.** Free tier is non-commercial → evaluation only until terms allow more | n/a — no personal data | free |
| 2 | GitHub private repo | code hosting, CI | instant | n/a — code and CI only | free |
| 3 | NASA Earthdata login | FIRMS archive downloads (2020–2025 backfill), LANCE | instant | n/a — no personal data | free |
| 4 | FIRMS **MAP_KEY** | Area API polling (backbone source) | instant e-mail key; 5,000 transactions / 10 min | n/a — no personal data | free |
| 5 | Hetzner account + VM | the server | instant | **required** — hosting processor; EU region | €6–21/mo |
| 6 | Cloudflare account + **R2 bucket** | CDN, tiles, glyphs, static snapshots | instant; R2 egress-free | **required** — processes IPs / request metadata | free tier + R2 cents |
| 7 | **healthchecks.io** | dead-man's switch on every scheduled job — `firms_poll`, `fci_fetch`, `effis_refresh`, `snapshot_push`, **`backup`**, deploy smoke. Jobs ping **after success**; silence past the grace window pages | instant; free tier **20 checks**. Load-bearing for B2: this is the only leg that survives the VM being entirely dead, and the only thing that catches "cron ran but failed" | n/a — operator telemetry only; check names and pings must never carry user data | free |
| 8 | **UptimeRobot** | external probes on `/healthz`, the freshness health endpoint (500 on stale ⇒ external freshness pager), homepage, the R2 snapshot URL, TLS expiry; free public status page at MVP | instant; free tier **50 monitors, 5-min interval**. Load-bearing for B2: sees Cloudflare/DNS/origin failures that are invisible from inside the box | n/a — probes public endpoints only | free |
| 9 | **Sentry** (free tier) | error tracking from the first commit; the "it threw" leg that metrics alone miss | instant; free single-user tier (small monthly event quota — check the current cap at signup and set an alarm before it). GlitchTip self-hosted is the later escape hatch if the quota bites | **required** — stack traces/breadcrumbs can carry personal data; enable PII scrubbing, choose the EU region | free |
| 10 | **Grafana Cloud** (free tier) | metrics + logs via Alloy on the VM; alert rules evaluate in *their* cloud, so they still fire when our box is sick; k6 load runs for the 50× baseline | instant; free tier **10k series, 50 GB logs, 14-day retention, 3 users, 500 VUh k6** — the metric set is <500 series, so the budget is ample | **required** — logs/labels may carry identifiers; EU region, and no user identifiers in labels | free |

**Rows 7–10 are three independent failure-detection paths plus error tracking**
(healthchecks.io ⟂ UptimeRobot ⟂ Grafana Cloud alerting). They exist in Wave 0 —
not in WP8 — because WP1 goes live in **early September 2026** and the recorded
Sep–Oct 2026 shadow season is **unrepeatable**: blocker B2 says that season
currently runs with no pager and no off-VM backup, one disk failure away from a
one-year loss. The `backup` check in row 7 is pinged *after* the nightly encrypted
`pg_dump` lands in R2, so a silent backup is an alert, not a discovery.

**Twilio — deliberately later, not now.** SMS/voice paging escalation (a webhook
target that calls the phone when a critical alert stays unacked for 10 min) is a
**season-mode add for June 2027**, not a Wave-0 account: ~€1.2/mo for the number
plus ~€0.014/min, ~€2/mo for the four months it is armed. Until then the pager is
Telegram with a loud sound and a Do-Not-Disturb exception. Noted here so it is a
scheduled decision rather than a launch-week discovery.

## Wave 1 — WP1 ingest (Aug–Sep 2026)

| # | Account / registration | Needed for | Lead time & notes | DPA accepted? | Cost |
|---|---|---|---|---|---|
| 11 | **EUMETSAT Data Store** (EO Portal) + LSA SAF licence acceptance | LSA-502 SEVIRI FRP, FCI/SEVIRI cloud mask (CLM — hard decay dependency), MTG LI | instant account; API limits 30 req/s, 5 TB/day | n/a — no personal data | free |
| 12 | **CDSE** account | Sentinel-2/3 data, quarterly mosaics | instant; quotas 10k PU/mo + 12 TB/30 d — alarm at 80% (RISKS §2) | n/a — no personal data | free |
| 13 | ECMWF account (ADS/EWDS) | CAMS European AQ, EWDS climatology (ECMWF Open Data itself needs no account, CC BY 4.0) | instant | n/a — no personal data | free |
| 14 | CLMS / WEkEO account | SWI/SSM soil-moisture layers (wave 2–3) | instant; register early, use later | n/a — no personal data | free |
| 15 | **Cloudflare Project Galileo application** | free enhanced DDoS/security protection — the launch-time posture against R1 (success-disaster: a viral fire putting 100k+ concurrent users on €6–21/mo infra) | **Apply now, use much later.** Approval is a human review with an unbounded lead time (months, not days) and it gates the *launch* security posture, so it cannot wait for Wave 3; needs the civic-benefit case written up (~2 h). Fogos.pt precedent | n/a — covered by the Cloudflare DPA (row 6) | free |
| 16 | **Mapbox community / nonprofit application** | parallel sponsorship track to row 15 — basemap/tile headroom if the self-hosted path slips or a fire spike blows the tile budget | apply in the same sitting as Galileo (~2 h); approval is discretionary and slow. **Do not design against it** — the self-hosted tile path stays the plan; this is insurance | **required if it reaches production** — end-user tile requests expose IPs to Mapbox | free if granted |

## Wave 2 — frontend, alerts & the legal entity (Nov 2026–Feb 2027)

| # | Account / registration | Needed for | Lead time & notes | DPA accepted? | Cost |
|---|---|---|---|---|---|
| 17 | **ArcGIS Location Platform** API key | Esri World Imagery toggle | instant; free tier 2M tiles/mo, metering alarm mandatory before the cliff (ADR-001 A1.3); never proxied/pre-cached server-side | **required** — the browser hits Esri directly (end-user IP) | free tier |
| 18 | **VAPID keypair** | web push | generated locally; straight into the secret store; rotation playbook per 05 | n/a — locally generated keypair | free |
| 19 | **Telegram bot** (BotFather) | Telegram alerts (equal-rank channel) | instant; data-minimization rules per ADR-004 D8 | not a plain processor — independent platform that sees content; **disclose** in the privacy policy rather than paper it over | free |
| 20 | **AWS account + SES** | email alerts | sandbox instant; **production-quota raise filed before June 2027** (L-6), takes days | **required** — AWS GDPR data-processing addendum; EU region | cents |
| 21 | Domain + name/brand clearance | product identity, push origin, email domain (SPF/DKIM) | founder task; trademark search before attachment to the name | n/a — registrant data is ours, not users' | ~€10–30/y |
| 22 | **ЕООД formation** (Търговски регистър) | the entity that owns the service. **Required before the first stored watch zone** and before the first euro of revenue — a watch zone is a home/property coordinate, and it must not be held by a natural person (L-10 launch gate; 09 §6.1 [GATE-v1]) | **Longest legal lead time — start it in this wave, not in Wave 3.** Founder-side prep (name check, capital deposit, notarized documents, bank account) is the slow part: budget 2–4 weeks end-to-end even though the registry itself is days. Unblocks `.bg` eligibility (09 §7.3) | n/a — the ЕООД becomes the **controller**; every processor row above is signed in its name | state fee low (verify current tariff); agency-assisted a few hundred €; accounting ~€600–1,200/y thereafter |
| 23 | **Bulgarian lawyer engaged** (ToS / privacy pass) | a real lawyer's pen on the ToS, the privacy policy and the B2C property-damage liability cap before the first paid user or the first stored zone (09 §10 Q1 [GATE-v1]) | **Engage early — availability, not billable hours, is the constraint.** Send the 09 legal map as the brief so the review is efficient; expect weeks between engagement and marked-up drafts. Must land before L-10 | n/a — independent professional, not a processor | TBD — request a fixed-fee quote for the ToS + privacy review |
| 24 | **EUTM trademark filing** (EUIPO) | brand protection once the name carries spend; filed only after the §7 clearance (EUIPO eSearch plus + TMview classes 9/38/42, BG national marks, Търговски регистър, absolute-grounds screen against the "official-sounding name" trap) | **~4–6 months to grant plus a 3-month opposition window** — filing at launch means protection arrives long after. Clearance first: a name that evokes BG-ALERT or the fire service fails ЗМГО чл. 11 outright | n/a — no personal data | €850 first class, +€50 second, +€150 each further; 10-year term |

## Wave 3 — pre-launch (Mar–May 2027)

| # | Account / registration | Needed for | Lead time & notes | DPA accepted? | Cost |
|---|---|---|---|---|---|
| 25 | Viber channel / business account | Viber fallback channel (R8) | business verification can take weeks; **pricing review before committing** — Viber business messaging is not free | not a plain processor — platform sees content; **disclose** (as Telegram, row 19) | TBD |

## Standing rules

- **Hardware-key 2FA on every root-of-trust account — this rule applies to every
  row in every wave above, with no exceptions and no "later".** For a solo project
  these accounts *are* the root of trust: domain registrar, Cloudflare, GitHub,
  the cloud provider (Hetzner), the email/AWS account, plus the secret store, npm,
  EUMETSAT and every monitoring account in Wave 0. Concretely: WebAuthn hardware
  key enrolled at account creation, **two keys** (primary carried, backup stored
  offline), recovery codes printed and stored offline, **no SMS 2FA anywhere**, and
  no shared logins. An account that cannot do hardware-key 2FA gets TOTP in an
  authenticator app (never SMS) and a note in this file saying why. Creating the
  account and arming its 2FA are the same task — a registration is not done until
  the key is enrolled (05 F1).
- **No processor touches personal data before its DPA row says `required` → done.**
  The DPA column is not decoration: it is the processor register that WP7 turns
  into the RoPA and the privacy policy's processor table, and it must be re-checked
  whenever a provider changes subprocessors. US-headquartered processors need DPF
  certification or SCCs inside the DPA; EU region is chosen wherever offered.
- Any new source or service passes the 09 licence review **before** an account is
  wired into code — the NC-traps row in `DATA-SOURCES.md` is the pre-flight
  checklist (EOX 2018+, GEE, Open-Meteo free tier, Planet E&R, Maxar OD,
  Blitzortung, FireSat free tier).
- Every key gets: secret-store entry, rotation note, and an owner of its quota
  alarm. No shared keys between dev and prod. Free-tier limits (rows 7–10, 12, 17)
  each get a metering alarm at 80% — a monitoring account that silently hits its
  cap is worse than no monitoring account, because it is trusted.
- Registrations are cheap; **lead times are not** (ЕООД formation, lawyer
  availability, EUTM grant, Galileo/Mapbox approval, SES quota, Viber
  verification, FireSat window) — this file exists so none of them is discovered
  during launch week.
