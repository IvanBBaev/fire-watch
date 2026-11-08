#!/usr/bin/env bash
# Rehearsal-only: host settings + a throwaway secrets bundle. Values are random per run.
set -euo pipefail
install -d -m 0755 /etc/fire-watch
cat >/etc/fire-watch/deploy.env <<'E'
PG_IMAGE=imresamu/postgis:16-3.4@sha256:6da75969915039b7356058b4310d43fde88c275ada982c2dfee29da68445ff4d
GRAFANA_CLOUD_PROM_URL=https://prometheus.invalid/api/prom/push
GRAFANA_CLOUD_PROM_USERNAME=rehearsal
FIRE_WATCH_ENVIRONMENT=rehearsal
E
chmod 0644 /etc/fire-watch/deploy.env
b=/root/bundle; rm -rf $b; umask 077; mkdir -p $b/secrets
pw="$(openssl rand -hex 24)"
printf '%s' "$pw" >$b/secrets/postgres_password
openssl rand -hex 24 | tr -d '\n' >$b/secrets/fire_watch_metrics_token
printf 'rehearsal' >$b/secrets/grafana_cloud_token
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=fire-watch-rehearsal \
  -keyout $b/secrets/origin_tls_key -out $b/secrets/origin_tls_cert 2>/dev/null
cat >$b/app.env <<E
DATABASE_URL=postgres://postgres:${pw}@postgres:5432/fire_watch?sslmode=disable
FIRE_WATCH_ENVIRONMENT=rehearsal
FIRE_WATCH_FIRMS_MODE=keyless
E
printf 'HEALTHCHECKS_DEPLOY_URL=\n' >$b/secrets.env
tar -C $b -cf /root/bundle.tar app.env secrets.env secrets
echo "bundle: $(tar -tf /root/bundle.tar | tr '\n' ' ')"
