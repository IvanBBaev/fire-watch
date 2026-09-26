# infra/status — status page, email-auth check, defensive domains

TASKS **J5** (spec: `docs/OPERATIONS.md` §10 and §11.5; review 13 §3.6(27)). There are three
tools behind one CLI, and none of them needs the origin, a database or a secret:

```sh
pnpm run status probe             # probe public endpoints → static status site
pnpm run status email-auth        # SPF / DKIM / DMARC p=reject check for a domain
pnpm run status defensive-domains # look-alike domain checklist (registers nothing)
pnpm run status help
```

Layout follows `infra/deploy-gate`. `core/` is pure and unit-tested (no network, no
clock, no filesystem). `adapters/` holds the only I/O: `fetch`, `node:dns` and the wall
clock. `cli-options.ts` parses arguments (tested) and `cli.ts` wires everything together.

---

## 1. Status page (`probe`)

### What it probes

| Component        | Target                                           | Aged by                                                   |
| ---------------- | ------------------------------------------------ | --------------------------------------------------------- |
| `api`            | `GET <api-base>/healthz`                         | — (up / down)                                             |
| `map`            | `GET <snapshot-url>` (the document the map reads) | body `generated_at`: the same clock as the client banner |
| `map-backup`     | `HEAD <mirror-url>` (T2 mirror, TASKS E3)        | `x-amz-meta-generated-at`, else `Last-Modified`           |
| `data-freshness` | `GET <api-base>/api/health/freshness`            | its own per-row report (§1.2 bands)                       |

The map and its backup are banded by the `snapshot-push` budget. Warn is 5 min and
critical is 15 min. The warn threshold is pinned in a test against
`SNAPSHOT_PUSH_WARN_SECONDS` in `packages/contracts`. A timestamp more than 60 s in the
future reads as `degraded / future_stamp` rather than fresh.

### Levels and the headline

Components are `operational | unknown | degraded | outage`. The headline is the worst
configured component, with two exceptions for the two map legs:

- **A failing backup with a healthy primary is `degraded`, never `outage`.** Users are
  unaffected, but the safety net is gone.
- **A failing primary with an operational backup is `degraded`.** The client fails over
  to T2 (ADR-003 D1).

Components the probe was not configured for are left out of the headline. They are shown
as "not monitored yet".

**Two-consecutive-failures rule (§2.2 rule 7).** A first-seen outage publishes as
`degraded (unconfirmed)`. It becomes an outage only on the next run. `since` carries
across runs through the previously published `status.json` (`--previous`). If that file is
missing or unreadable, the run is treated as a first run, never as a failure.

**What never reaches the page (§10.4):** URLs, hostnames, error text and response headers.
The model carries reason codes only. The catalog (`core/strings.ts`) turns them into
sentences. Raw failure detail goes to the job log only.

### Output

The probe writes three files: `index.html` (Bulgarian, the default), `en.html` and
`status.json` (the model, which also serves as the next run's `--previous`), plus
`.nojekyll`. The pages are self-contained: inline CSS, one inline script, and no
external requests, fonts or images. Every time is shown in UTC. The page auto-refreshes
every `--refresh` seconds. It also shows its own generation time, and turns on a "this
page itself is out of date" banner after `--stale-after` minutes (default 45), because
scheduled CI runs can be late or skipped.

The probe exits 0 whenever it published, because an outage is page content, not a job
failure. `--fail-on-outage` changes this to exit 1. Invalid notices exit 2 and publish
nothing.

### Copy and notices

- `core/strings.ts` holds both locales in one catalog. It is marked
  **`pending-founder-review`** (both locales). Tests enforce key and placeholder parity,
  the never-send lint (`packages/contracts`, own voice) on every string, and the absence
  of vendor or tier names.
- `notices.json` holds founder-written incidents and maintenance notices (§10.5), in EN
  and BG. It is validated on every run and linted in `core/notices.test.ts`, so a bad
  notice fails CI before it can be published. Each notice looks like this:

  ```json
  {
    "notices": [
      {
        "id": "2026-10-02-map-delay",
        "kind": "incident",
        "startedAt": "2026-10-02T09:40:00Z",
        "resolvedAt": null,
        "en": "Map updates are delayed. Fire data shown may be up to an hour old.",
        "bg": "Обновяването на картата закъснява. Данните може да са до час стари.",
        "postmortemUrl": null
      }
    ]
  }
  ```

  `kind` is `incident` or `maintenance`. Maintenance must be posted at least 24 h ahead
  (§10.3). Ongoing notices are always shown. Resolved notices are shown for 14 days.
  Text is plain (no markup) and at most 600 characters. `postmortemUrl` must be https.
- A per-source **mute reason is published verbatim** from the freshness endpoint (§1.1
  rule 6). Write mute reasons as public copy.

### Where it runs

`github-workflow.example.yml` is a scheduled GitHub Actions job (every 15 min, plus
manual dispatch). It probes from GitHub's runners and deploys to GitHub Pages, which puts
it outside the origin's failure domain. It is an **example**: nothing under
`.github/workflows/` is added by J5. Before enabling it:

1. Choose the hosting repository. Pages on a private repository needs a paid plan. A
   small public `fire-watch-status` repository that vendors this directory avoids that and
   the Actions-minutes cost. See the questions below.
2. Pin the third-party actions to commit SHAs, as `ci.yml` does.
3. Set the repository variables listed in the workflow header. Point a
   `status.<domain>` CNAME at Pages.

This deviates from §10.1, which specifies R2 as the pre-launch host. Pages was chosen
because it shares neither the origin nor Cloudflare's control plane, but the choice must
be reconciled in OPERATIONS. Until launch, the monitoring vendor's hosted page (§10.1
MVP) remains the plan of record.

Local dry run (no network needed; every target will read as unreachable):

```sh
pnpm run status probe --api-base http://127.0.0.1:9 --timeout 500
open infra/status/dist/site/index.html
```

---

## 2. Email authentication (`email-auth`)

This command resolves the SPF, DMARC and DKIM-selector TXT records (and MX for parked
domains) with `node:dns`. The evaluation itself is pure (`core/email-auth.ts`). It exits
1 on any error-level finding. A DNS failure is reported as `lookup_failed` and never
counts as "absent", so a flaky resolver cannot make a check pass.

```sh
# The alert-sending subdomain (§11.5: p=reject from the first message ever sent)
pnpm run status email-auth --domain alerts.<domain> --dkim <selector> [--dkim <selector2>] \
  [--mail-from bounce.alerts.<domain>] [--strict-alignment] [--resolver 1.1.1.1] [--json]

# Every domain that must never send mail: the apex if unused, and each defensive domain
pnpm run status email-auth --domain <defensive-domain> --role parked
```

### Expected records

**Sending subdomain:**

```text
alerts.<domain>.                 TXT "v=spf1 include:<esp spf domain> -all"
_dmarc.alerts.<domain>.          TXT "v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s; rua=mailto:dmarc@<domain>"
<selector>._domainkey.alerts.<domain>.  TXT/CNAME per the ESP (RSA ≥ 2048 bits or Ed25519)
```

**Parked domain (null-sender posture):**

```text
<parked>.          TXT "v=spf1 -all"
_dmarc.<parked>.   TXT "v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s;"
<parked>.          MX  0 .            (RFC 7505 null MX)
```

### What it checks

**DMARC** (errors):

- a policy other than `p=reject` (the organizational record, if inherited, is named in
  the report);
- `sp` weaker than reject;
- `pct` below 100;
- a missing record or more than one record;
- duplicate tags.

**DMARC** (warnings): no `rua`, and a non-mailto `rua`. An external `rua` domain is
noted (info), because it needs the RFC 7489 §7.1 authorization record.

**SPF** (errors):

- a missing record or more than one record;
- `+all`, `?all`, or no `all` at all;
- more than 10 DNS-querying terms;
- a MAIL FROM domain that does not align.

**SPF** (warnings): `~all` and `ptr`.

**DKIM** (errors):

- no selector configured;
- a missing, revoked, malformed or unknown-type key;
- an RSA key under 1024 bits;
- a `d=` domain that does not align.

**DKIM** (warnings): RSA under 2048 bits, and `t=y` (testing mode).

**Strict alignment:** `--strict-alignment` also requires `adkim=s` and `aspf=s`.

**Parked domains:**

- the SPF record must be exactly `v=spf1 -all` (error);
- a null MX is expected (warning).

---

## 3. Defensive domains (`defensive-domains`)

This command prints a checklist of look-alike domains that should be registered, or at
least monitored. It registers and resolves nothing. The generator is pure and tested
(`core/defensive-domains.ts`).

```sh
pnpm run status defensive-domains --name <label> [--tld bg --tld com --tld eu] \
  [--priority register|consider|monitor] [--json]
```

The first `--tld` is the primary (the product's own domain), which is excluded from the
output. Candidates by priority:

| Priority   | Kinds                                                                                                                                         |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `register` | the name on every other TLD                                                                                                                   |
| `consider` | on the primary TLD: hyphenation variants, affixes (`bg`, `alert(s)`, `map`, before or after, with or without a hyphen), Latin homoglyphs (`rn`/`m`, `vv`/`w`, `cl`/`d`, `1`/`l`/`i`, `0`/`o`, `q`/`g`); whole-script Cyrillic look-alikes (IDN) |
| `monitor`  | the same on other TLDs; keyboard-adjacent, omission, duplication and transposition typos; mixed-script IDN look-alikes                        |

IDN candidates are printed as punycode together with their Unicode display. Many
registries, `.bg` included, reject mixed-script labels, which is why those candidates are
monitor-only. Each registered defensive domain should get the parked-domain records above
and be checked with `email-auth --role parked`.

The actual list depends on the product name, which is not final (EXTERNAL-ACCOUNTS row
21; trademark clearance comes first). Regenerate the list once the name is fixed.

---

## Founder / infra decisions this needs

1. The product name and primary domain, which gate every command here (EXTERNAL-ACCOUNTS
   row 21).
2. The status host: GitHub Pages (this example) or R2 (§10.1). Also: a separate public
   repository for the job, and the `status.<domain>` DNS name.
3. The second announcement channel (§10.2), for `FIRE_WATCH_STATUS_ANNOUNCE`.
4. The ESP (SES per §11.6), its DKIM selectors, whether to use a custom MAIL FROM
   subdomain, and the `rua` mailbox or DMARC report processor.
5. Which defensive domains to buy (`.bg`, `.com`, `.eu`, Cyrillic `.бг`?).
6. Review of the copy in `core/strings.ts` (EN and BG) and of the display timezone (UTC
   vs Europe/Sofia).
7. Whether internal job rows (backups, WAL archive) from the freshness endpoint belong
   on a public page, or should be filtered out there.
