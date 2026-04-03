FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache python3 make g++ curl

FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

FROM base AS dev
COPY package.json package-lock.json* ./
RUN npm ci
COPY src ./src
CMD ["node", "--watch", "src/index.js"]

FROM base AS production
COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
COPY package.json ./
CMD ["node", "src/index.js"]
