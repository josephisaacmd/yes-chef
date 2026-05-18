# --- Build stage: install deps (compile better-sqlite3 native binding) ---
FROM node:20-bookworm-slim AS deps
WORKDIR /app

# better-sqlite3 needs a C++ toolchain + python to build from source.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# --- Runtime stage: slim image, no toolchain ---
FROM node:20-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

# Drop privileges. node:20-bookworm-slim ships a "node" user (uid 1000).
RUN mkdir -p /data && chown -R node:node /data

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node . .

USER node
EXPOSE 3000
VOLUME ["/data"]

CMD ["node", "server.js"]
