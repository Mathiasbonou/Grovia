import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Remonte les dossiers parents pour trouver le `.env` à la racine du monorepo
 * (le dossier qui contient `pnpm-workspace.yaml`).
 */
function findRootEnv(): string | null {
  let dir = path.dirname(fileURLToPath(import.meta.url));

  /* apps/api/config → apps/api → apps → <racine>. Six niveaux suffisent ;
     la boucle s'arrête de toute façon à la racine du système de fichiers. */
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = path.join(dir, ".env");
    const isRoot = fs.existsSync(path.join(dir, "pnpm-workspace.yaml"));
    if (isRoot && fs.existsSync(candidate)) return candidate;

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const envPath = findRootEnv();

if (envPath) {
  dotenv.config({ path: envPath, quiet: true });
} else {
  /* Les hébergeurs (Vercel, Render, Railway) injectent les variables
     directement et ne fournissent pas de .env : c'est normal. */
  dotenv.config({ quiet: true });
}

/** Variables sans lesquelles l'API ne peut pas démarrer. */
const REQUIRED = ["MONGO_URI", "JWT_SECRET"] as const;

const missing = REQUIRED.filter((key) => !process.env[key]);

if (missing.length > 0 && process.env.NODE_ENV !== "test") {
  throw new Error(
    `Variables d'environnement obligatoires manquantes : ${missing.join(", ")}. ` +
      `Copiez .env.example vers .env à la racine du dépôt et remplissez-les.`,
  );
}

/**
 * Accesseurs typés pour les valeurs dont une mauvaise valeur pose un problème
 * de sécurité plutôt qu'une simple fonctionnalité cassée. Tout le reste
 * continue de lire `process.env` directement.
 */
export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  isProduction: process.env.NODE_ENV === "production",
  isDevelopment: process.env.NODE_ENV === "development",

  jwtSecret: process.env.JWT_SECRET ?? "",
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "30d",

  clientUrl: process.env.CLIENT_URL ?? "http://localhost:3000",
  adminUrl: process.env.ADMIN_URL ?? "http://localhost:3001",
} as const;

export default env;
