# Build context is the repository root (see docker-compose.yml) so the `wpp`
# CLI can be bundled and served to other machines from /api/cli/wpp.
FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache python3 make g++ curl

FROM base AS deps
COPY server/package.json server/package-lock.json* ./
RUN npm ci --omit=dev

FROM base AS dev
COPY server/package.json server/package-lock.json* ./
RUN npm ci
COPY server/src ./src
COPY wpp ./wpp
CMD ["node", "--watch", "src/index.js"]

FROM base AS production
COPY --from=deps /app/node_modules ./node_modules
COPY server/src ./src
COPY server/package.json ./
COPY wpp ./wpp
CMD ["node", "src/index.js"]
