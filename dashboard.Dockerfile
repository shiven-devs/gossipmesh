# syntax=docker/dockerfile:1

# Dashboard image: the same two-stage shape as the node image.
#
# It is a separate image on purpose. The dashboard is not part of the
# protocol - it only reads - so it should be deployable, restartable and
# upgradable without touching a single cluster member. Baking it into the node
# image would also mean every pod shipped a web UI it never serves.

# ---------- stage 1: dependencies ----------
FROM node:22-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json ./

# The dashboard needs only express and pino out of the production set. Node 22
# has fetch built in, so polling the cluster needs no HTTP client at all.
RUN npm ci --omit=dev && npm cache clean --force

# ---------- stage 2: runtime ----------
FROM node:22-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

ARG APP_VERSION=0.0.0-dev
ENV APP_VERSION=$APP_VERSION

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY dashboard ./dashboard

# No src/: the dashboard never imports the protocol code. If it ever needs a
# member entry's shape, it reads the JSON the nodes already serve.
USER node

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-8080}/health" || exit 1

CMD ["node", "dashboard/server.js"]
