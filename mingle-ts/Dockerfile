# Node is pinned to 22 (LTS) per ADR-0001 — keep all four stages on the same tag.
# The npm ci stages need a C toolchain: better-sqlite3 (ADR-0002) has no musl
# prebuild and compiles via node-gyp. The runtime stage stays toolchain-free —
# it only copies the already-built node_modules.
FROM node:22-alpine AS development-dependencies-env
RUN apk add --no-cache python3 make g++
COPY . /app
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
COPY ./package.json package-lock.json /app/
COPY --from=production-dependencies-env /app/node_modules /app/node_modules
COPY --from=build-env /app/build /app/build
# Migrations are applied at startup (ADR-0002) — the runtime image must
# carry them or the app refuses to boot.
COPY ./drizzle /app/drizzle
WORKDIR /app
CMD ["npm", "run", "start"]
