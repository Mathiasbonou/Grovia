import type { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";

/*
 * Routes toujours accessibles, même si la base de données est coupée :
 * la santé de l'API et la documentation, pour qu'on puisse diagnostiquer
 * le problème.
 */
const OPEN_PATHS = [
  "/api/health",
  "/api/docs",
  "/api/docs.json",
  "/api/docs/info",
];

/**
 * Temps maximum qu'une requête attend une connexion encore en cours
 * d'ouverture (un démarrage à froid).
 */
const CONNECTING_WAIT_MS = 8_000;

/*
 * Attend que MongoDB soit connecté, pendant `ms` millisecondes au maximum.
 * Renvoie une promesse qui vaut :
 * - true  si la connexion s'établit à temps ;
 * - false si le délai est dépassé ou si la connexion échoue.
 */
function waitForConnection(ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    // Après `ms`, on abandonne et on répond false.
    const timer = setTimeout(() => resolve(false), ms);
    // `unref()` : ce minuteur n'empêche pas Node de s'arrêter proprement.
    timer.unref();
    mongoose.connection
      .asPromise()
      .then(
        () => resolve(true),
        () => resolve(false),
      )
      // Dans tous les cas, on annule le minuteur devenu inutile.
      .finally(() => clearTimeout(timer));
  });
}

// Répond 503 (service indisponible) avec un JSON expliquant le problème.
function unavailable(req: Request, res: Response) {
  res.status(503).json({
    success: false,
    code: "db_unavailable",
    message: "The database is not connected yet. Try again in a moment.",
    path: req.originalUrl,
    // Indique au client dans combien de secondes réessayer.
    retryAfterSeconds: 5,
  });
}

/**
 * Échoue vite quand la base de données est coupée, au lieu de laisser chaque
 * requête attendre le délai du buffer de Mongoose. La santé et la
 * documentation restent accessibles pour que les opérateurs voient ce qui ne
 * va pas. Une connexion en cours d'ouverture (la première requête après un
 * démarrage à froid en serverless) est attendue brièvement plutôt que
 * refusée.
 *
 * Monté sur `/api`, donc `req.path` n'a plus le préfixe : on compare
 * `originalUrl` avec les chemins complets.
 */
export function readinessGate(req: Request, res: Response, next: NextFunction) {
  /*
   * readyState de Mongoose : 0 = déconnecté, 1 = connecté,
   * 2 = en cours de connexion, 3 = en cours de déconnexion.
   */
  const { readyState } = mongoose.connection;

  // Base connectée : tout va bien, on continue.
  if (readyState === 1) return next();

  // On retire les paramètres d'URL (?a=1) pour comparer le chemin seul.
  const path = req.originalUrl.split("?")[0] ?? "";

  // Routes ouvertes (santé, docs) : on laisse passer même sans base.
  if (OPEN_PATHS.some((p) => path === p || path.startsWith(`${p}/`)))
    return next();

  // Connexion en cours : on attend un peu avant de décider.
  if (readyState === 2) {
    void waitForConnection(CONNECTING_WAIT_MS).then((ok) =>
      ok ? next() : unavailable(req, res),
    );
    return;
  }

  // Déconnecté : on refuse tout de suite avec un 503.
  unavailable(req, res);
}

// Durée maximale par défaut d'une requête : 60 secondes.
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Termine une requête qui dépasse le délai avec un 503 JSON, au lieu de
 * laisser une connexion bloquée.
 */
export function requestTimeout(ms = DEFAULT_TIMEOUT_MS) {
  return (req: Request, res: Response, next: NextFunction) => {
    res.setTimeout(ms, () => {
      // Si la réponse a déjà commencé à partir, on ne peut plus rien changer.
      if (res.headersSent) return;
      res.status(503).json({
        success: false,
        code: "timeout",
        message: `The request took longer than ${Math.round(ms / 1000)} s and was stopped.`,
        path: req.originalUrl,
      });
    });
    next();
  };
}
