# A pinned Novu image (api or worker) plus the OpenBao startup loader (ADR-023).
#
# Used only by docker-compose.prod.yml. The base images are third-party, so the
# loader is copied in at build time instead of mounted from a host path. The
# NOVU_IMAGE build argument must be the same pinned digest as the base
# docker-compose.yml uses for that service.
ARG NOVU_IMAGE
FROM ${NOVU_IMAGE}
COPY packages/openbao-deploy/src/bao-env-loader.mjs /opt/openbao/bao-env-loader.mjs
