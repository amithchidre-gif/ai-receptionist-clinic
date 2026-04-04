# ── Stage 1: build ─────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

# Build tools required for native modules (bcrypt, etc.)
RUN apk add --no-cache python3 make g++

# Install ALL dependencies (dev included — needed for TypeScript compiler)
COPY package*.json ./
RUN npm ci

# Copy source and compile TypeScript
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Copy SQL migrations into dist so runMigrations.js can find them at runtime
RUN mkdir -p dist/migrations && cp src/migrations/*.sql dist/migrations/

# ── Stage 2: runtime ────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

# Build tools required to compile native modules for Linux
RUN apk add --no-cache python3 make g++

# Production dependencies — native modules (bcrypt) compiled here for Linux
COPY package*.json ./
RUN npm ci --omit=dev

# Compiled JS + SQL migrations from builder
COPY --from=builder /app/dist ./dist

# Google service-account key (required for Calendar API)
COPY google-calendar-sa.json ./google-calendar-sa.json

# Temp audio dir (Telnyx needs to fetch MP3 files via HTTP)
RUN mkdir -p tmp/audio

EXPOSE 4000
ENV NODE_ENV=production
ENV GOOGLE_APPLICATION_CREDENTIALS=/app/google-calendar-sa.json

# Run migrations then start server
CMD ["sh", "-c", "node dist/scripts/runMigrations.js && node dist/server.js"]
