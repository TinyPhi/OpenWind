ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-alpine AS base
RUN corepack enable

WORKDIR /app

# Copy workspace manifests; install before copying source so this layer is
# cached unless lockfile changes.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml turbo.json ./
COPY packages/ packages/
COPY modules/ modules/
COPY apps/worker/ apps/worker/

RUN pnpm install --frozen-lockfile

# Build workspace package dists so internal imports resolve at runtime.
# apps/worker itself is run via tsx (no compile step needed) — same pattern
# as apps/api/Dockerfile. The previous multi-stage build only copied
# apps/worker/dist + package.json into the runner stage, never node_modules,
# so @platform/* workspace imports failed with MODULE_NOT_FOUND at startup —
# this was never caught because the worker had never actually been run as a
# container before (see docker-compose.yml's ow-worker service).
RUN pnpm exec turbo run build --filter=@platform/worker^...

CMD ["pnpm", "exec", "tsx", "apps/worker/src/index.ts"]
