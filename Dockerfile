# Back Elegance Deco pour Dokploy : API sur le port 3000.
# Toutes les dépendances restent installées (tsx, drizzle-kit) pour lancer les migrations
# et la création d'admin depuis le terminal du conteneur.
FROM node:20-alpine
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.4.1 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

ENV NODE_ENV=production \
    PORT=3000 \
    UPLOAD_DIR=/app/storage/uploads
# Photos et vidéos envoyées : à monter en volume persistant dans Dokploy
VOLUME ["/app/storage"]
EXPOSE 3000
CMD ["node", "scripts/start-production.mjs"]
