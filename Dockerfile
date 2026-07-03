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
# Données persistantes (SQLite + justificatifs) : monter un volume Railway sur /data
ENV DATA_DIR=/data

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/node_modules ./server/node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/web/dist ./web/dist

EXPOSE 3000
CMD ["node", "server/dist/main.js"]
