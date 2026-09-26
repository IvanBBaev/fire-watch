# loadtest — the GATES L-3 50× load test (K2)

`loadtest` drives the public read path at fifty times the A3 baseline. The traffic is the snapshot polling, SSE, client-config and T2 fallback mix. The tool then judges the run against the L-3 criteria and writes a report that can be attached to the gate.

It is the buildable half of K2. A gate verdict still needs a staging run against Cloudflare and R2 (see [What K2 still needs](#what-k2-still-needs)).

## Why a Node-native generator (and not k6, Artillery or Gatling)

- **Open model.** 100,000 sessions polling every 45 s form an arrival process, not 100,000 loops. The generator issues arrivals on a 10 ms tick from the integral of the target rate, and it does not wait for answers. A closed virtual-user model slows down exactly when the edge does, and that hides the saturation L-3 exists to find (coordinated omission). k6 can do this with `constant-arrival-rate`, but its SSE support is an extension (xk6-sse) that needs a custom binary. We need clean-close accounting per stream (a `degrade` frame, then EOF), and that is a few dozen lines on top of `fetch` plus a byte-level SSE parser.
- **Zero runtime dependencies.** The tool uses only Node 22's `fetch`, `AbortController` and `node:http`. Nothing is installed on the generator hosts beyond Node and this repository, so the tool adds no supply-chain surface.
- **Same language, same tests.** The scenario, thresholds, evaluation and report are pure TypeScript, unit-tested under the root `vitest` unit project. The smoke test imports the server's own route constants, so a renamed route breaks here before it breaks a staging run.
- **Shardable.** 3,333 req/s and up to 25,000 stream attempts is more than one process should own. Every shard runs `--shard i/n` with its own seed, and `loadtest merge` folds the shard reports into one, refusing a missing, duplicate or foreign shard. Managed k6 Cloud's 500 VU-hour tier does not cover a 17-minute run at this concurrency anyway.

## Layout

| File | What it is |
|---|---|
| `src/baseline.ts` | The A3 planning baseline (2,000 sessions / 4,000 req/min / 500 SSE), ×50, the 5,000 hub cap, and the traffic assumptions. |
| `src/scenario.ts` | The pure scenario model: per-stream rates, the request mix (cursor and `If-None-Match` shares), phases, sharding, and the arrival integrals. |
| `src/thresholds.ts` | The L-3 pass/fail criteria **as data**, one row per criterion with its spec source. |
| `src/evaluate.ts` | Metrics → metric table → verdicts → overall result, plus the cache-status classification. |
| `src/metrics.ts`, `src/histogram.ts` | The recorder (per phase and stream) and a mergeable log-bucket latency histogram. |
| `src/report.ts` | The JSON report (self-contained, mergeable) and its Markdown rendering. |
| `src/adapters/driver.ts` | The generator: the open-model scheduler, SSE slots, T2 probing, and phase hooks. |
| `src/adapters/cli.ts` | The runner: `run`, `merge`, `--dry-run`, and exit codes. |
| `src/smoke/smoke.test.ts` | The local smoke mode: the real driver against the in-process read path, at a tiny scale. |

## The scenario at 50×

`--dry-run` prints the scenario as JSON. With the planning baseline:

| Stream | Target | Notes |
|---|---|---|
| `/snapshot.json` (T1) | 200,000 req/min = 3,333 req/s | 92.5 % cursor (`?updated_after_seq=`), 95 % `If-None-Match` once a tag is known |
| `/api/v1/client-config` | 100,000 sessions / 10 min = 166.7 req/s | once per session start |
| `/api/v1/stream` (SSE) | 25,000 concurrent attempts | the hub must clamp at 5,000, demote, and close every stream after a `degrade` frame |
| T2 static copy | 3,333 req/s | only in the origin-kill phase |

The phases are `ramp` (2 min, linear), `steady` (10 min, which is what every edge number is judged on) and `origin-kill` (5 min, one T2 budget). The flags `--ramp-s`, `--steady-s` and `--origin-kill-s` override them, and `--origin-kill-s 0` drops the phase.

## Thresholds (`src/thresholds.ts`)

| Id | Criterion | Phase |
|---|---|---|
| `edge-hit-ratio` | ≥ 0.95 edge cache-hit ratio on `/snapshot.json` | steady |
| `origin-rps` | ≤ 5 req/s reaching the origin | steady |
| `snapshot-p95` | p95 ≤ 300 ms | steady |
| `sse-peak-open` | concurrently open streams ≤ the cap (5,000) | ramp + steady |
| `sse-demotion-observed` | a `degrade` frame was seen (applies when demand > cap) | ramp + steady |
| `sse-unclean-closes` | 0 streams ended without a `degrade` frame | ramp + steady |
| `sse-unexpected-status` | refusals are 503/429 with `Retry-After`, nothing else | ramp + steady |
| `client-config-flip` | the config document says `poll` ≤ 30 s after the first `degrade` | ramp + steady |
| `map-client-5xx` | 0 5xx on snapshot, client-config and T2 | all |
| `t2-success-ratio` | every T2 request answered 2xx/304 with the origin dead | origin-kill |
| `t2-max-object-age` | T2 object age ≤ 300 s (`x-amz-meta-generated-at`, else `Last-Modified`) | origin-kill |
| `generator-achieved-rate` | the generator issued ≥ 90 % of the planned arrivals (**validity**) | all |

Each verdict is `pass`, `fail`, `not_measured` or `not_applicable`. The overall result ranks them as follows:

- **invalid** (a validity row failed, so re-run with more generator capacity) beats
- **fail** (a gate row failed), which beats
- **incomplete** (a gate row was not measured, e.g. no cache-status header), which beats
- **pass**.

A run that is not 50× at scale 1 on a `measured` baseline is flagged **rehearsal** in the report, whatever its result.

## Report and exit codes

`--out report.json` writes the JSON report and a `report.md` next to it. The Markdown is also printed to stdout. The JSON holds the run info, shards, scenario, raw metrics (histograms included) and the evaluation, so `merge` can recompute everything from shard files alone.

| Exit | Meaning |
|---|---|
| 0 | pass |
| 1 | fail |
| 2 | usage error (bad flag, bad baseline file, inconsistent shards) |
| 3 | invalid or incomplete run: the run proves nothing either way |

## Running

There is no root script yet. From the repository root:

```sh
pnpm exec tsc --build loadtest
node loadtest/dist/src/adapters/cli.js run --base-url https://staging.example --dry-run
```

### Locally (smoke)

`pnpm run verify` (or `pnpm exec vitest run --project unit loadtest/src`) runs `src/smoke/smoke.test.ts`. It starts on 127.0.0.1:

- the real snapshot, stream and client-config routes (`createHealthServer`), with a fixture snapshot reader, a real stream hub capped at 5, and the real demotion controller driven by the real `createTransportWatch` tick;
- a small edge emulator that caches by `s-maxage`/`max-age`, coalesces misses, answers `If-None-Match` with a 304, sets `cf-cache-status`, and passes the stream through;
- a static T2 server.

The smoke run drives about 4 s of traffic with 12 stream attempts against the cap of 5 and kills the origin through the phase hook. It asserts the demotion, the cap, clean closes, no 5xx, a measured hit ratio, T2 serving with a dated object, and the config flip. It does not assert latency. When the sandbox forbids a loopback listener, the suite skips.

### Against staging

1. **Baseline.** Until season 1 measures the busiest hour, the planning baseline is used and the report says `rehearsal`. Once it is measured, write it down and pass `--baseline`:
   ```json
   { "label": "season 1 busiest hour 2027-08-03 14:00", "source": "measured",
     "sessions": 1800, "snapshotRequestsPerMinute": 3600, "sseConnections": 420 }
   ```
2. **Targets.** `--base-url` is the Cloudflare-fronted staging host (never the origin directly, because the edge is what is under test). `--t2-url` is the public R2 URL of the snapshot copy.
3. **The origin kill.** `--kill-origin-cmd` runs when the origin-kill phase starts, e.g. `ssh staging-origin 'sudo systemctl stop fire-watch-api'`. Without it, the runner prints a line and you kill the origin by hand. Restore the origin afterwards; the tool does not.
4. **Cache status.** `--cache-status-header` defaults to `cf-cache-status`. Unknown values over 1 % make the hit ratio `not_measured`, not guessed.
5. **Shards.** The per-client stream cap is 6 per source IP (`STREAM_MAX_PER_CLIENT` in `server/src/app/health-wiring.ts`), so a single generator IP can never hold more than 6 streams open. Reaching the 5,000 cap needs more than 833 source IPs across the generator fleet, or a staging-only raise of the per-client cap. Split the load over hosts:
   ```sh
   # on each of n hosts, i = 1..n
   node loadtest/dist/src/adapters/cli.js run --base-url https://staging.example \
     --t2-url https://snap.staging.example/snapshot.json --baseline baseline.json \
     --shard i/n --seed $i --kill-origin-cmd "…" --out shard-$i.json
   # then, anywhere
   node loadtest/dist/src/adapters/cli.js merge shard-*.json --out l3-report.json
   ```
   Only one shard should carry `--kill-origin-cmd`. Start the shards together, because phases are timed per process.
6. **Generator health.** If `generator-achieved-rate` fails, the generator is the bottleneck. Raise `--max-in-flight`, add shards and re-run. An `invalid` run is never evidence against the system.
7. **Cross-check.** Compare the report's origin req/s and hit ratio with Cloudflare analytics for the same window, then attach both to L-3.

## What K2 still needs

- A staging environment behind Cloudflare, with R2 carrying the pushed snapshot.
- A measured baseline from season 1, since the planning baseline only ever yields a rehearsal.
- Generator hosts: enough source IPs for the per-client cap, located so the edge p95 means what L-3 intends.
- A Cloudflare analytics cross-check of the edge numbers.

## Open decisions (founder)

- `meanSessionMinutes` (10) sets the client-config rate. No spec states it.
- What "kill the origin" means for L-3: stop the API process, stop the VM, or firewall it.
- T2 age budget: 300 s (the `snapshot-push` warn budget) is encoded. Should it be 900 s instead?
- Where the generators run, which is what the 300 ms p95 is measured from.
- Cloudflare cache-status classification, especially `REVALIDATED` (counted as both edge-served and an origin request).
- The generator fleet vs. the per-client cap of 6: many source IPs, or a staging-only cap raise.
- Whether stream 503s count as map-client 5xx. They are currently excluded, because a refusal with `Retry-After` is the designed demotion path.
- Whether origin req/s is taken from edge misses (as here) or from origin logs.
