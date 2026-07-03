# --- Build : compile le serveur TypeScript et le front Vite ---
FROM node:22-slim AS build
WORKDIR /app

# Outils nécessaires si better-sqlite3 doit être compilé (pas de prebuild)
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci

COPY . .
RUN npm run build
# Ne garder que les dépendances de production pour l'image finale
RUN npm prune --omit=dev && mkdir -p server/node_modules

# --- Run : image minimale de production ---
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
# Données persistantes (SQLite + justificatifs) : monter un volume Railway sur /data.
# NB : les volumes Railway sont montés root ; avec l'utilisateur non-root ci-dessous,
# définir la variable de service RAILWAY_RUN_UID=0 (cf. docs.railway.com/volumes/reference).
ENV DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/server/node_modules ./server/node_modules
COPY --from=build --chown=node:node /app/server/dist ./server/dist
COPY --from=build --chown=node:node /app/server/package.json ./server/package.json
COPY --from=build --chown=node:node /app/web/dist ./web/dist

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT ?? 3000}/api/health`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "server/dist/main.js"]
