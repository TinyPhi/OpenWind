# syntax=docker/dockerfile:1
# Targets:
#   runtime (default, last stage) - compiled JS, `node`, non-root, HEALTHCHECK. What servers run.
#   dev                           - the whole workspace run with tsx as root; used by the base
#                                   docker-compose.yml (`docker compose up -d`).
ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-slim AS base
RUN corepack enable
ENV HUSKY=0
WORKDIR /app

# build: install everything, compile this app and every package it depends on.
FROM base AS build
# Copy workspace manifests; install before copying source so this layer is
# cached unless the lockfile changes.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml turbo.json ./
COPY packages/ packages/
COPY modules/ modules/
COPY apps/worker/ apps/worker/
RUN pnpm install --frozen-lockfile
RUN pnpm exec turbo run build --filter=@platform/worker...

# dev: tsx from source, as root (a rebuild picks up source changes).
FROM build AS dev
EXPOSE 3002
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3002/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["pnpm", "exec", "tsx", "apps/worker/src/index.ts"]

# deploy: production dependencies only. --legacy because this workspace does not
# set inject-workspace-packages; workspace packages are still copied, not linked.
FROM build AS deploy
RUN pnpm --filter @platform/worker deploy --legacy --prod /out

# runtime
FROM node:${NODE_VERSION}-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deploy /out/ ./
# The app finds seed SQL by walking up to pnpm-workspace.yaml, then reading modules/.
COPY pnpm-workspace.yaml ./
COPY modules/ modules/
# docker-compose.prod.yml runs this OpenBao startup loader as the entrypoint.
COPY packages/openbao-deploy/src/bao-env-loader.mjs packages/openbao-deploy/src/bao-env-loader.mjs
# Code stays root-owned and read-only to the app; only the storage dir is writable.
RUN mkdir -p /data/files && chown node:node /data/files
USER node
EXPOSE 3002
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3002/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/index.js"]
