# back-neon

API d'Elegance Deco : Node (Express + tRPC) et MySQL.

```
server/    code du serveur et tests
drizzle/   schéma de la base et migrations
scripts/   dev, migrations, création d'admin, mot de passe
shared/    règles communes au back et au front (validation, prix, néon…)
```

```bash
pnpm install
pnpm dev        # API sur http://localhost:3000, base de TEST (DATABASE_URL_TEST dans .env)
pnpm test
pnpm build      # dist/index.js
```

`.env` et `storage/` (fichiers envoyés) restent locaux, jamais dans Git.

Mise en ligne sur un VPS Dokploy : voir `DEPLOIEMENT.md` dans le dépôt [front-neon](https://github.com/taha43584/front-neon).
