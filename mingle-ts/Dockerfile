# Mingle — production image (ADR-0002: one container, one SQLite volume).
#
# Node is pinned to 22 (LTS) per ADR-0001 — keep all four stages on the same
# tag. The npm ci stages need a C toolchain: better-sqlite3 has no musl
# prebuild and compiles via node-gyp. The runtime stage stays toolchain-free —
# it only copies the already-built node_modules — and runs as an unprivileged
# user with /data (the database, the auto-generated session secret, and
# attachments) as the only writable location.
FROM node:22-alpine AS development-dependencies-env
RUN apk add --no-cache python3 make g++
COPY ./package.json package-lock.json /app/
WORKDIR /app
RUN npm ci

FROM node:22-alpine AS production-dependencies-env
RUN apk add --no-cache python3 make g++
COPY ./package.json package-lock.json /app/
WORKDIR /app
RUN npm ci --omit=dev

FROM node:22-alpine AS build-env
COPY . /app/
COPY --from=development-dependencies-env /app/node_modules /app/node_modules
WORKDIR /app
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_FILE=/data/mingle.db \
    ATTACHMENTS_DIR=/data/attachments
RUN addgroup -S mingle && adduser -S -G mingle mingle \
    && mkdir -p /data && chown mingle:mingle /data
COPY --chown=mingle:mingle ./package.json package-lock.json /app/
COPY --from=production-dependencies-env --chown=mingle:mingle /app/node_modules /app/node_modules
COPY --from=build-env --chown=mingle:mingle /app/build /app/build
# Migrations are applied at startup (ADR-0002) — the runtime image must
# carry them or the app refuses to boot.
COPY --chown=mingle:mingle ./drizzle /app/drizzle
WORKDIR /app
USER mingle
VOLUME ["/data"]
EXPOSE 3000
# The probe is the same /healthz the real-path test drives: a genuine
# database round-trip, not a process check.
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
    CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1
# node directly, not `npm run start`: npm does not forward SIGTERM, so a
# stop would wait for Docker's kill timeout instead of shutting down.
CMD ["node", "node_modules/@react-router/serve/dist/cli.js", "./build/server/index.js"]
