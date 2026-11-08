# Deploy rehearsal — R5-SRE-5 transcript

The deploy path (`.github/workflows/deploy.yml` → `fw-deploy` → the image's own
`/app/stack/deploy.sh`, see [infra/README.md "The deploy path"](../README.md#the-deploy-path))
rehearsed end to end on a local Debian 12 VM on 2026-11-08. There is still no production
host (TASKS B9); this transcript is the evidence that the path works before one exists.

Files here:

| File                   | What it is                                                                     |
| ---------------------- | ------------------------------------------------------------------------------ |
| `lima.yaml`            | The VM: Debian 12 genericcloud arm64, 4 vCPU, 5 GiB, the worktree mounted read-only. |
| `apply-cloud-init.py`  | Applies `infra/cloud-init.yaml` to the running VM (packages, users, files, runcmd). |
| `rehearse-setup.sh`    | Writes a rehearsal `deploy.env` and a throwaway secrets bundle (random per run). |

No secret value appears in this transcript. Every secret in the bundle was generated
inside the VM by `rehearse-setup.sh`, and the VM was deleted after the rehearsal.

## Deviations from production — read these first

1. **cloud-init was applied, not booted.** The VM booted Lima's own cloud-init and
   `apply-cloud-init.py` then applied `infra/cloud-init.yaml` to it. It skips one file,
   `/etc/ssh/sshd_config.d/10-fire-watch.conf`, because that lock-down would lock Lima's
   user out of SSH. The rendered `user_data` itself is covered by
   `infra/user-data/render.test.ts`, which decodes it back to the repo file byte for byte.
   A boot from the rendered `user_data` waits for the first real host (B9).
2. **arm64, not amd64.** The VM is Apple-silicon arm64. Production pins an amd64 PostGIS
   image, which has no arm64 build. `deploy.env` therefore sets
   `PG_IMAGE=imresamu/postgis:16-3.4@sha256:6da7…5ff4d` (arm64). This override is exactly what
   the `PG_IMAGE` hook in `deploy.sh` exists for.
3. **Images built in the VM, not pulled from GHCR.** The image was built inside the VM from
   the worktree and tagged `ghcr.io/ivanbbaev/fire-watch:<fake sha>`, so `deploy.sh` found
   it locally (`image … present locally`). The pull branch ran no registry round-trip. In
   production the `image` job pushes it and `fw-deploy --registry-login` pulls it.
4. **No heartbeat, no Grafana.** `HEALTHCHECKS_DEPLOY_URL` was empty, so the ping was
   skipped by design. `GRAFANA_CLOUD_PROM_URL` pointed at `.invalid`, so Alloy ran but
   shipped nothing.

## Images

| Tag (`ghcr.io/ivanbbaev/fire-watch:`) | Contents                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------ |
| `1111…1111`                           | The real release image, `docker buildx build` of the worktree.                       |
| `2222…2222`                           | `1111` with `dist/app/deploy-smoke-cli.js` replaced by a script that always exits 1. |
| `3333…3333`                           | `1111` with the final `deploy.sh` (per-attempt `timeout` on the smoke).              |
| `4444…4444`                           | `3333` with the same always-failing smoke.                                           |

The broken smoke (`/root/bad/Dockerfile`):

```dockerfile
FROM ghcr.io/ivanbbaev/fire-watch:1111111111111111111111111111111111111111
# Rehearsal only: a release whose deploy smoke always fails.
USER root
RUN printf "%s\n" "console.error(\"forced smoke failure (rehearsal)\"); process.exit(1);" > /app/server/dist/app/deploy-smoke-cli.js
USER 10001:10001
```

## Setup

```console
$ limactl create --name fw-rehearsal infra/rehearsal/lima.yaml && limactl start fw-rehearsal
$ limactl cp infra/rehearsal/apply-cloud-init.py fw-rehearsal:/tmp/
$ limactl shell fw-rehearsal sudo python3 /tmp/apply-cloud-init.py /mnt/repo/infra/cloud-init.yaml
skip /etc/ssh/sshd_config.d/10-fire-watch.conf
cloud-init applied
$ limactl shell fw-rehearsal sudo bash /mnt/repo/infra/rehearsal/rehearse-setup.sh
bundle: app.env secrets.env secrets/ secrets/postgres_password …
```

Every deploy below runs the way the `host` job runs it: the `deploy` user calls the
sudoers-allowed trampoline, and the trampoline starts the image's own `deploy.sh` as root.

## Round 1 — first deploy, misconfigured: no rollback

```console
$ sudo -u deploy sudo -n /usr/local/sbin/fw-deploy 1111…1111 --secrets < /root/bundle.tar
deploy: deploying 1111…1111
 Container fire-watch-postgres-1 Healthy
{"starting":{"migrate":{"dbmate":"dbmate","lock_timeout_ms":300000,"migrations_dir":"/app/server/db/migrations"}}}
Error: pq: SSL is not enabled on the server
{"migrate":{"dbmate_exit":2}}
deploy: migrations failed; no other last_good to return to — leaving the stack as it is
fw-deploy exit=1
```

The first real finding: the compose Postgres has no TLS, so `app.env`'s `DATABASE_URL`
must end in `?sslmode=disable`. This is now documented in the `deploy.yml` header and in
infra/README.md "The deploy path". The run also shows the first-deploy case: with no
`last_good` there is nothing to roll back to, and the script fails loudly.

## Round 2 — good deploy (`1111`)

After the `sslmode` fix:

```console
$ sudo -u deploy sudo -n /usr/local/sbin/fw-deploy 1111…1111 --secrets < /root/bundle.tar
deploy: deploying 1111…1111
Applying: 001_initial_schema.sql
…                                   (every migration through 036, each applied once)
{"migrate":{"dbmate_exit":0}}
{"deploy_smoke":{"failures":{},"passed":true,"rounds":1}}
deploy: deployed 1111…1111
fw-deploy exit=0
last_good=1111…1111
fire_watch_deploy_timestamp_seconds{sha="1111…1111",rollback="0"} …
```

## Round 3 — forced bad deploy (`2222`) rolls back, and a starvation finding

```console
$ sudo -u deploy sudo -n /usr/local/sbin/fw-deploy 2222…2222
2026-11-08T02:43:29Z deploy: deploying 2222…2222
{"migrate":{"dbmate_exit":0}}
forced smoke failure (rehearsal)          (×9)
2026-11-08T03:00:32Z deploy: smoke test failed; rolling back to last_good 1111…1111
2026-11-08T03:00:33Z deploy: deploying 1111…1111 (rollback)
{"deploy_smoke":{"failures":{},"passed":true,"rounds":1}}
2026-11-08T03:00:44Z deploy: deployed 1111…1111
fw-deploy exit=1
real	17m15s
last_good=1111…1111
fire_watch_deploy_timestamp_seconds{sha="1111…1111",rollback="1"} …
```

The rollback behaved correctly. The bad deploy exits 1, the previous image's own
`deploy.sh` redeploys `1111`, `last_good` is unchanged, and the metric records
`rollback="1"`.

The timing did not behave correctly. The smoke deadline is 180 s, but the failure took
17 minutes to detect. The Mac host was at a load average of ~210 from unrelated work,
which starved the VM, and one `docker compose exec` took about two minutes. The deadline
is only checked between attempts, so nine slow attempts ran past it. Under normal load
the same loop runs one attempt every ~5 s. The fix: `deploy.sh` now bounds each attempt
with `timeout --kill-after=10 150`. Round 4 re-runs this scenario with the fix in place.

## Round 4 — final `deploy.sh`: good (`3333`), bad (`4444`) → rollback, reboot-equivalent

`3333` and `4444` carry the `deploy.sh` that is committed now. The host was still loaded,
at a load average of ~95–120.

```console
$ sudo -u deploy sudo -n /usr/local/sbin/fw-deploy 3333…3333
2026-11-08T03:02:52Z deploy: deploying 3333…3333
{"migrate":{"dbmate_exit":0}}
{"deploy_smoke":{"failures":{},"passed":true,"rounds":1}}
2026-11-08T03:03:00Z deploy: deployed 3333…3333
exit=0
last_good=3333…3333
fire_watch_deploy_timestamp_seconds{sha="3333…3333",rollback="0"} 1794106980

$ sudo -u deploy sudo -n /usr/local/sbin/fw-deploy 4444…4444   # smoke forced to fail
2026-11-08T03:03:00Z deploy: deploying 4444…4444
{"migrate":{"dbmate_exit":0}}
forced smoke failure (rehearsal)          (×36, one attempt every ~5 s)
2026-11-08T03:06:07Z deploy: smoke test failed; rolling back to last_good 3333…3333
2026-11-08T03:06:07Z deploy: deploying 3333…3333 (rollback)
{"migrate":{"dbmate_exit":0}}
{"deploy_smoke":{"failures":{},"passed":true,"rounds":1}}
2026-11-08T03:06:10Z deploy: deployed 3333…3333
exit=1
last_good=3333…3333
fire_watch_deploy_timestamp_seconds{sha="3333…3333",rollback="1"} 1794107170
api ghcr.io/ivanbbaev/fire-watch:3333…3333 Up
worker ghcr.io/ivanbbaev/fire-watch:3333…3333 Up

$ sudo -u deploy sudo -n systemctl restart fire-watch.service   # what a reboot runs
exit=0
$ curl -sk https://127.0.0.1/healthz ; curl -sk https://127.0.0.1/readyz
{"status":"ok"} 200
{"status":"ok"} 200
```

The bad deploy was detected at the deadline (3 min 7 s) and rolled back in 3 s. After the
rollback, the systemd unit brings the stack back from `/srv/fire-watch/.env`, still on
`3333`, and both probes answer through the proxy.

## What this proves, and what it does not

- Proven on Debian 12:
  - the `cloud-init.yaml` host shape: users, sudoers, the `fw-deploy` trampoline, the systemd unit and docker
  - the trampoline's secrets hand-off
  - the `migrate` one-shot against a fresh database and an up-to-date one
  - the worker → api order
  - the smoke, `last_good` and the `.prom` deploy metric
  - an automatic rollback that runs the previous release's own script
  - the first-deploy no-rollback exit
- Not proven here:
  - a boot from the rendered `user_data` (deviation 1)
  - amd64
  - a GHCR pull with `--registry-login`
  - the `image` and `web` jobs of `deploy.yml`, which need GitHub
  - the Healthchecks ping
  - the Grafana remote-write

  All of these wait for a real host (B9) and its first dispatch.
