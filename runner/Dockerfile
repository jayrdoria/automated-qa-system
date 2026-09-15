# The image tag MUST match the @playwright/test version in package.json.
# Bump both together or the preinstalled browsers will mismatch the client.
FROM mcr.microsoft.com/playwright:v1.63.0-noble AS base
WORKDIR /app
ENV CI=true
ENV NODE_ENV=production

# ── Dependencies ──────────────────────────────────────────────────────
# @playwright/test is a runtime dependency here, not a devDependency —
# running tests *is* this container's job, so --omit=dev must not strip it.
FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# ── Runner ────────────────────────────────────────────────────────────
FROM base AS runner
# --chown on COPY, not a later `chown -R` — recursive chown over node_modules
# would duplicate the entire tree into a new layer.
COPY --from=deps --chown=pwuser:pwuser /app/node_modules ./node_modules
COPY --chown=pwuser:pwuser playwright.config.ts ./
COPY --chown=pwuser:pwuser tests ./tests

# pwuser (uid 1000) ships with the Playwright image. We drive a browser against
# third-party sites, so don't run it as root.
RUN mkdir -p /app/artifacts && chown pwuser:pwuser /app/artifacts /app
USER pwuser

CMD ["npx", "playwright", "test"]
