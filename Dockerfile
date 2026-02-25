# ─────────────────────────────────────────────────────────
# Make It Legend — Discord Bot & Webhook Server
# Multi-stage Dockerfile for Railway, Render, Fly.io, etc.
# ─────────────────────────────────────────────────────────

# Stage 1: Build
FROM node:22-slim AS builder

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

# Stage 2: Production
FROM node:22-slim

RUN apt-get update && apt-get install -y python3 make g++ curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

RUN mkdir -p /app/data /app/logs

ENV NODE_ENV=production
ENV WEBHOOK_PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]
