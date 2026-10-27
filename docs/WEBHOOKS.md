# Signed webhooks

*TASKS V2-G2. Built, unticked: every number on this page is a founder decision awaiting
review (`webhook_params_v1`, `server/src/core/config/webhook-params.ts`).*

A webhook is one more alert channel. Fire Watch can POST each alert for your watch zones
to an HTTPS endpoint you run. The request carries a versioned JSON body and an HMAC
signature, so you can check that it came from Fire Watch and was not replayed. Alerts reach
a webhook through the same pipeline as push, Telegram and email: the same decisions, the
same budgets, the same footer.

## 1. Registering an endpoint

The routes need a signed-in account session (the cookie) and, for anything that changes
state, an allowed `Origin`. An endpoint you do not own answers the same `404` as one that
does not exist.

| Route | What it does |
|---|---|
| `GET /api/v1/webhooks` | Your endpoints, without their secrets. |
| `POST /api/v1/webhooks` `{ "url": "https://…" }` | Registers an endpoint. Answers `201` with the endpoint **and its signing secret. The secret is shown this once.** |
| `DELETE /api/v1/webhooks/:id` | Removes the endpoint and revokes its subscription. Alerts already queued for it are not sent. |
| `POST /api/v1/webhooks/:id/rotate-secret` | Issues a new secret, shown this once. **The old secret stops signing at once**, so there is no overlap window (see §4). |
| `POST /api/v1/webhooks/:id/test` | Sends one signed `ping` now and answers `200` with the outcome (`delivery_id`, `outcome`, `status_code`, `error`, `duration_ms`, `confirmed`). |

**An endpoint gets no alerts until a test ping succeeds.** A `2xx` answer to the ping
confirms the endpoint, and it also re-enables an endpoint that was disabled automatically
(§5). A failed ping is logged and changes nothing else. Test pings are limited to **10 per
account per hour** (`WEBHOOK_TEST_PING_RATE_LIMIT`, `server/src/app/auth-wiring.ts`); past
the limit the route answers `429` with `Retry-After`.

Problem codes (`packages/contracts/src/problem-codes.ts`): `webhook_url_invalid` (400),
`webhook_limit_reached` (409, at most **5** live endpoints per account),
`webhook_endpoint_not_found` (404) and `rate_limited` (429). No error repeats the URL you
submitted, because its path or query may hold your own token. The two answers that carry a
secret are sent `Cache-Control: no-store`.

### URL rules

`server/src/core/webhooks/webhook-url.ts` validates every URL. It checks once at
registration and again before every send:

- `https://` only, at most **2048** characters, port **443** only;
- no user name or password in the URL, and no `#fragment`;
- the host is a public DNS name or a public IP literal. Names that only resolve inside a
  network are refused: `localhost`, `*.local`, `*.internal` and single labels;
- **every** address the host resolves to must be public. The registry checks this at
  registration as a courtesy. The transport checks it again immediately before each
  request. A single private answer refuses the send. "Private" means everything in the
  IANA special-purpose registries: loopback, RFC 1918, CGNAT, link-local (including the
  `169.254.169.254` metadata service), documentation, benchmarking, multicast, reserved,
  IPv6 unique-local (including `fd00:ec2::254`) and IPv6 forms that embed one of these;
- **redirects are never followed** (`redirect: 'error'`). A `3xx` aborts the request,
  which is retried like any network error until the attempts run out.

## 2. The request

```
POST <your url>
Content-Type: application/json
User-Agent: FireWatch-Webhook/1
X-FireWatch-Delivery: <delivery_id>
X-FireWatch-Signature: t=1798372800,v1=<64 lowercase hex>
```

The body is versioned JSON. Its types are in `packages/contracts/src/webhook.ts`
(`WebhookPayload`), and the version is `fire-watch.webhook.v1`. Adding an optional field
keeps `v1`. Renaming, removing or changing the meaning of a field means a new version,
announced before it ships.

```json
{
  "version": "fire-watch.webhook.v1",
  "type": "alert",
  "delivery_id": "8812",
  "sent_at": "2026-12-27T10:00:00Z",
  "alert": {
    "type": "new_event",
    "decided_at": "2026-12-27T09:59:41Z",
    "locale": "bg",
    "title": "…",
    "body": "…",
    "footer": "…"
  },
  "event": {
    "id": "fw-2026-00042",
    "permalink": "https://…/e/fw-2026-00042",
    "hazard": "wildfire",
    "severity": "likely",
    "status": "active",
    "started_at": "2026-12-27T09:31:00Z",
    "last_detection_at": "2026-12-27T09:52:00Z"
  },
  "attribution": [{ "id": "firms", "source": "NASA FIRMS", "text": "…", "href": "https://…" }]
}
```

A `ping` has `"type": "ping"` and an `endpoint_id` in place of `alert` and `event`.

- `delivery_id` stays the same across retries of one delivery: it is the alert's outbox
  id, or a fresh uuid for a ping. **De-duplicate on it.** If you have already seen it,
  answer `2xx` and do nothing.
- `severity` is the score bucket (`unverified` | `likely` | `confirmed`), never the raw
  score.
- `footer` is the mandatory alert footer. If you show the alert to people, show the footer
  too. The same applies to `attribution`.

## 3. Verifying the signature

`X-FireWatch-Signature: t=<unix seconds>,v1=<hex>`. Here `v1` is the lowercase hex
HMAC-SHA256, keyed with your signing secret (the whole string as UTF-8, `whsec_` prefix
included), of `<t>.<raw body>`. The timestamp is part of the signed content, so a captured
request cannot be replayed under a fresh `t`.

1. Read the **raw** body bytes, before any JSON parse. A re-serialised object will not
   match.
2. Parse the header. Accept it if **any** `v1=` value matches, because more than one is
   reserved for a future rotation overlap. Ignore schemes you do not know.
3. Reject a `t` more than **300 seconds** from your own clock in either direction
   (`DEFAULT_REPLAY_WINDOW_SECONDS`).
4. Compare in constant time.
5. De-duplicate on `delivery_id`.

Node (no dependencies):

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

const REPLAY_WINDOW_SECONDS = 300;

export function verifyFireWatch(secret, header, rawBody, nowSeconds = Date.now() / 1000) {
  let t = null;
  const signatures = [];
  for (const part of String(header).split(',')) {
    const [key, value] = part.split('=', 2).map((s) => s?.trim());
    if (key === 't' && /^\d{1,12}$/.test(value)) t = Number(value);
    else if (key === 'v1' && /^[0-9a-f]{64}$/.test(value)) signatures.push(value);
  }
  if (t === null || signatures.length === 0) return false;
  if (Math.abs(nowSeconds - t) > REPLAY_WINDOW_SECONDS) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`, 'utf8').digest();
  return signatures.some((s) => timingSafeEqual(expected, Buffer.from(s, 'hex')));
}
```

The same check ships as `verifyWebhookSignature` in `@fire-watch/contracts/node`, beside
`signWebhookPayload`, which is what Fire Watch signs with.

## 4. Secrets and rotation

The signing secret is 32 random bytes, encoded as base64url after a `whsec_` prefix. Fire
Watch has to recompute the HMAC on every send, so it must get the plaintext back. That is
why the secret is **encrypted, not hashed**. It is sealed with AES-256-GCM under a
service-held key (`aes-gcm-webhook-secret-sealer.ts`, the construction migration 026 uses
for staff TOTP secrets). The associated data binds the ciphertext to the endpoint id. A
database dump without the key holds no usable secret.

Rotation issues a new secret and **the old one stops signing immediately**. To rotate
without dropping alerts, make your verifier accept both secrets for a few minutes, then
rotate, then remove the old secret. The header format already allows two `v1=` values, but
the server does not send two yet (§7).

Service keys (env, on both the API and the worker, `server/src/app/webhooks-config.ts`).
They are separate from the zone-centre keyring, and none of them has a default:

| Variable | Notes |
|---|---|
| `FIRE_WATCH_WEBHOOK_KEY_ID` | Id of the active sealing key, `[A-Za-z0-9_.-]{1,64}`. Set together with the key, or not at all. |
| `FIRE_WATCH_WEBHOOK_KEY` | The active key: standard base64 of exactly 32 bytes. Never logged; only the id is. |
| `FIRE_WATCH_WEBHOOK_KEYS_RETIRED` | Optional, `id:base64,id:base64`. Retired keys only open existing secrets and never seal new ones. |

With no key configured, the routes are not registered and the channel is not wired. To
roll the service key, make the old key retired and set a new active key. New and rotated
secrets are then sealed under the new key, and existing ones still open. Nothing
re-encrypts the existing secrets in bulk (§7).

## 5. Delivery, retries and auto-disable

| Rule | Value (`webhook_params_v1`) |
|---|---|
| Timeout per attempt, connect to last byte | 5 s |
| Attempts per delivery, the first included | 6 |
| Backoff | exponential with full jitter: `random × min(60 min, 1 min × 2^(n−1))` |
| Auto-disable after consecutive failed attempts (alerts and pings alike) | 20 |
| `410 Gone` | disables the endpoint at once |
| Delivery-log retention | 30 days proposed, **not armed** (`PURGE_RETENTION.webhook_deliveries`) |

How each answer is treated (`server/src/core/webhooks/webhook-retry.ts`):

- `2xx`: delivered. It resets the failure count.
- `408`, `429`, `5xx`, a timeout, a DNS failure or a network error (a redirect included):
  retried.
- Any other `4xx`: failed at once, without a retry. It still counts toward auto-disable.
- An address refused by the SSRF guard: `refused`. Not retried, and counted as a failure.

Retries are re-claims of the alert's outbox row. A failed attempt releases the row
unclaimable until the webhook's own next try, so the schedule above, not the shared
alert backoff, sets the pace; a row claimed early anyway is released again without a
request and without spending an attempt. The webhook's attempt cap must not exceed the
outbox's own (`delivery_params.retry.maxAttempts`, also 6). The row expires 6 h after the
decision (`delivery_params_v1.queueExpirySeconds`), and the schedule is chosen to finish
inside that limit. **Acknowledge quickly with a `2xx` and do the work afterwards.**

After N consecutive failures the endpoint is disabled (`disabled_at`, `disabled_reason`)
and its subscription is revoked. A successful test ping re-enables it.

The delivery log (`webhook_deliveries`, migration 035) keeps one row per attempt: the kind,
`delivery_id`, the attempt number, the time, the outcome, the status code, the duration
and our own redacted error text. **It never stores a request or response body.**

## 6. Privacy

Both tables are keyed by account and classed `personal`. Account erasure (TASKS I4,
`erasure_plan_v8`) deletes the delivery log and then the endpoints, before the
subscriptions, and counts both in the ledger. The account export includes both tables. It
withholds the sealed secret and the id of the key that seals it. An outbox row names the
endpoint id, never the URL.

## 7. Known limits

- **DNS-rebinding window.** The guard and `fetch` resolve the name separately. A DNS
  server answering with a very short TTL could swap the answer between them. Closing the
  window needs a connect-time hook (an undici dispatcher pinned to the checked address) or
  an egress proxy.
- **The response body is read whole**, bounded only by the 5 s timeout.
- `dns-host-resolver.ts` (the `node:dns` adapter) has no unit test, because tests never hit
  the network.
- A test ping for an endpoint whose secret cannot be opened (its key was removed from the
  keyring) answers `500`.
- There is no rotation overlap window, and no bulk re-encryption job for a retired service
  key.
- The legal register rows (`docs/legal/ropa.md`, `breach-runbook.md`) do not list the two
  tables yet.
