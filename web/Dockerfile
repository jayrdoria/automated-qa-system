FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat
WORKDIR /app

# ── Shared: install dependencies ─────────────────────────
FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm ci

# ── Migrations (full node_modules — prisma CLI needed) ───
FROM deps AS migrator
COPY prisma ./prisma
RUN npx prisma generate
CMD ["node", "node_modules/prisma/build/index.js", "migrate", "deploy"]

# ── Production: build ────────────────────────────────────
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
ENV NEXT_TELEMETRY_DISABLED=1
# Placeholder only — next build imports route modules for collection and never
# opens a connection. The real URL is injected at runtime by compose.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"
RUN npm run build

# ── Production: minimal runtime image ────────────────────
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=7071
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 7071
CMD ["node", "server.js"]
