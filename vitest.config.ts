import { defineConfig } from "vitest/config";
import path from "path";

const templateRoot = path.resolve(import.meta.dirname);

export default defineConfig({
  root: templateRoot,
  resolve: {
    alias: {
      "@shared": path.resolve(templateRoot, "shared"),
    },
  },
  test: {
    environment: "node",
    include: ["server/**/*.test.ts", "server/**/*.spec.ts"],
    // Base de test dédiée (DATABASE_URL_TEST) : préparée avant la suite, nettoyée après, même en cas d'échec
    globalSetup: ["server/test/globalSetup.ts"],
    setupFiles: ["server/test/setupEnv.ts"],
    // Délais larges : hachage bcrypt et MySQL ralentis quand la machine manque de RAM
    testTimeout: 30_000,
    hookTimeout: 120_000,
    teardownTimeout: 60_000,
    // Un fichier à la fois : moins de RAM, et aucun fichier ne gêne les données d'un autre dans la même base
    fileParallelism: false,
  },
});
