# syntax=docker/dockerfile:1
#
# The Fire Watch server image (review 27 E-5; OPERATIONS §9). One image runs `api`,
# `worker` and the `migrate` one-shot; compose picks the command. It also carries the
# stack definition for its own release under /app/stack, so `infra/deploy.sh <sha>`
# deploys — and a rollback restores — the compose file that shipped with that code.
#
# Every base image is pinned by index digest; Renovate bumps tag and digest together.
# No `$BUILDPLATFORM`: production is linux/amd64 and CI builds only that; an arm64
# rehearsal image is built natively on an arm64 host.

FROM ghcr.io/amacneil/dbmate:2.34.1@sha256:3298bdfcb651af608e06d2e13ae12398c4056e5326d38ef31885973d83248d9c AS dbmate

FROM node:22.23.4-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS build
WORKDIR /src
RUN corepack enable
COPY . .
# --ignore-scripts as in CI: no dependency runs code at install time (pnpm-workspace.yaml).
# One layer per step, so a failed or interrupted build resumes from the last good one.
RUN pnpm install --frozen-lockfile --ignore-scripts --filter "@fire-watch/server..."
RUN pnpm --filter "@fire-watch/server..." run build
# The runtime tree: production dependencies only, from the same lockfile and the store the
# first install just filled, so this step never touches the registry. (`pnpm deploy
# --legacy` re-resolves the whole workspace against the registry instead.) Workspace
# links stay relative symlinks, which COPY --from preserves.
RUN rm -rf node_modules server/node_modules packages/contracts/node_modules \
 && pnpm install --frozen-lockfile --prod --offline --ignore-scripts --filter "@fire-watch/server..."

FROM node:22.23.4-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
ENV NODE_ENV=production
COPY --from=dbmate /usr/local/bin/dbmate /usr/local/bin/dbmate
# The layout mirrors the repository: the server resolves its migrations and the static
# hot-source mask relative to its own compiled files.
COPY --from=build /src/node_modules /app/node_modules
COPY --from=build /src/packages/contracts/package.json /app/packages/contracts/package.json
COPY --from=build /src/packages/contracts/dist /app/packages/contracts/dist
COPY --from=build /src/server/package.json /app/server/package.json
COPY --from=build /src/server/node_modules /app/server/node_modules
COPY --from=build /src/server/dist /app/server/dist
COPY --from=build /src/server/db /app/server/db
COPY web/src/assets/geodata/static-sources.json /app/web/src/assets/geodata/static-sources.json
COPY infra/compose.yaml infra/deploy.sh /app/stack/
COPY infra/proxy/nginx.conf /app/stack/proxy/nginx.conf
COPY infra/metrics/config.alloy /app/stack/metrics/config.alloy
# uid 10001: no overlap with any host account; FIRE_WATCH_STATE_DIR is a named volume
# mounted here, and a fresh volume takes the ownership of the directory it covers.
RUN groupadd --system --gid 10001 firewatch \
 && useradd --system --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin firewatch \
 && install -d -o 10001 -g 10001 -m 0750 /var/lib/fire-watch/state
WORKDIR /app/server
USER 10001:10001
EXPOSE 8080
CMD ["node", "dist/app/api.js"]
