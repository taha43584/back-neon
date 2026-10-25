import { resolveTestDatabaseUrl, TEST_UPLOAD_DIR } from "./testEnv";

/**
 * Exécuté avant chaque fichier de test, AVANT ses imports : la base et le dossier de fichiers
 * pointent vers ceux des tests. dotenv ne remplace pas une variable déjà définie, donc
 * `import "dotenv/config"` dans les tests ne peut plus ramener la base réelle.
 */
process.env.DATABASE_URL = resolveTestDatabaseUrl();
process.env.UPLOAD_DIR = TEST_UPLOAD_DIR;
