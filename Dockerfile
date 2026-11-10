# syntax=docker/dockerfile:1

# GossipMesh node image.
#
# Two stages. The first installs production dependencies; the second copies
# only the installed tree and the source into a clean image. Nothing from npm's
# cache, no dev dependencies and no build tools reach the final image - a
# smaller image is both faster to pull on every pod start and a smaller
# surface to audit.
#
# Layer order is deliberate: package files are copied and installed BEFORE the
# source. Docker caches each layer and invalidates everything after the first
# change, so editing src/ reuses the cached npm install, while changing a
# dependency correctly redoes it. Copying the source first would reinstall
# every dependency on every single code change.

# ---------- stage 1: dependencies ----------
FROM node:22-alpine AS deps

WORKDIR /app

# Only the manifests, so this layer is cached until a dependency changes.
COPY package.json package-lock.json ./

# `npm ci` (not `npm install`) installs exactly what package-lock.json pins:
# the same tree on a laptop, in CI and in the image. `--omit=dev` leaves out
# eslint and supertest, which a running node has no use for.
RUN npm ci --omit=dev && npm cache clean --force

# ---------- stage 2: runtime ----------
FROM node:22-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

# Baked in at build time and gossiped as metadata.version, so the dashboard
# can show which build each node is running during a rolling update.
ARG APP_VERSION=0.0.0-dev
ENV APP_VERSION=$APP_VERSION

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# Run as the unprivileged `node` user (uid 1000) that the official image
# already provides. A process that never needs to write to disk or bind a
# privileged port has no reason to be root: if it is ever compromised, the
# attacker lands as a user who cannot even modify the application files -
# they are owned by root and only readable here.
USER node

# Documentation only; it publishes nothing. The port is still chosen by the
# PORT env var, so one image serves every deployment.
EXPOSE 3000

# Liveness from Docker's own point of view. /health deliberately ignores the
# cluster, so an isolated node is never restarted for being isolated.
#
# wget is busybox's, built into Alpine - curl is not present, and adding it
# just for a health check would grow the image for nothing. Shell form (no
# JSON array) so ${PORT} is expanded at runtime.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-3000}/health" || exit 1

# `node` directly, not `npm start`: npm would sit between Docker and the
# process as PID 1 and forward signals unreliably, and SIGTERM reaching the
# node process intact is what makes the graceful leave work.
CMD ["node", "src/index.js"]
