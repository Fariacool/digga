# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

FROM base AS dependencies
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl unzip \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@12.12.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY scripts/install-subfinder.sh ./scripts/install-subfinder.sh
# A published image must include a verified subfinder for its target platform.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    SUBFINDER_REQUIRED=1 pnpm install --frozen-lockfile --store-dir=/pnpm/store \
    && test -x bin/subfinder \
    && bin/subfinder -version

FROM dependencies AS builder
COPY . .

RUN --mount=type=cache,target=/app/.next/cache pnpm test && pnpm run build

FROM base AS runner
ENV NODE_ENV=production \
    ENVIRONMENT=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    HOME=/home/node
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=dependencies --chown=node:node /app/bin/subfinder ./bin/subfinder
COPY --chown=node:node LICENSE ./LICENSE
USER node
EXPOSE 3000
CMD ["node", "server.js"]
