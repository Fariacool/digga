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

# Only public configuration belongs in build arguments. Secrets are runtime env.
ARG SITE_URL=http://localhost:3000
ARG NEXT_PUBLIC_ANALYTICS_SCRIPT=""
ARG NEXT_PUBLIC_ANALYTICS_ID=""
ARG NEXT_PUBLIC_ANALYTICS_DOMAINS=digga.dev
ARG NEXT_PUBLIC_TURNSTILE_SITE_KEY=""
ENV SITE_URL=${SITE_URL} \
    NEXT_PUBLIC_ANALYTICS_SCRIPT=${NEXT_PUBLIC_ANALYTICS_SCRIPT} \
    NEXT_PUBLIC_ANALYTICS_ID=${NEXT_PUBLIC_ANALYTICS_ID} \
    NEXT_PUBLIC_ANALYTICS_DOMAINS=${NEXT_PUBLIC_ANALYTICS_DOMAINS} \
    NEXT_PUBLIC_TURNSTILE_SITE_KEY=${NEXT_PUBLIC_TURNSTILE_SITE_KEY}
RUN pnpm test && pnpm run build

FROM base AS runner
ARG SITE_URL=http://localhost:3000
ENV NODE_ENV=production \
    ENVIRONMENT=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    SITE_URL=${SITE_URL} \
    HOME=/home/node
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=dependencies --chown=node:node /app/bin/subfinder ./bin/subfinder
COPY --chown=node:node LICENSE ./LICENSE
USER node
EXPOSE 3000
CMD ["node", "server.js"]
