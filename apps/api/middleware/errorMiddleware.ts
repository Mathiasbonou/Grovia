import type { Request, Response, NextFunction } from "express";
import { requestIdOf } from "./requestIdMiddleware.js";

/*
 * Type d'erreur « élargi » : une Error normale, plus les champs optionnels
 * que peuvent ajouter Mongoose, MongoDB, jsonwebtoken ou Express.
 * Cela permet de lire err.kind, err.code, etc. sans erreur TypeScript.
 */
type CustomError = Error & {
  kind?: string;
  code?: number | string;
  status?: number;
  statusCode?: number;
  type?: string;
  keyValue?: Record<string, unknown>;
  errors?: Record<string, { message: string }>;
};

/**
 * L'unique enveloppe JSON d'erreur sur laquelle tous les clients peuvent
 * compter :
 *   { success: false, code, message, path, requestId, hint? }
 *
 * Les codes de statut sont déduits de la forme de l'erreur : les contrôleurs
 * gardent donc le schéma `res.status(n); throw new Error(msg)` et ne
 * fabriquent jamais leurs réponses à la main. La stack n'est incluse qu'en
 * développement local.
 *
 * Le paramètre `_next` est obligatoire même s'il n'est pas utilisé : Express
 * reconnaît un gestionnaire d'erreurs à ses 4 paramètres. Le `_` devant le
 * nom dit à ESLint de ne pas le signaler comme « inutilisé » (c'est la règle
 * argsIgnorePattern: "^_" de ton eslint.config.js).
 */
export function errorHandler(
  err: CustomError,
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  /*
   * Statut de départ : celui déjà posé par le contrôleur avec res.status(n)
   * s'il est différent de 200, sinon celui porté par l'erreur, sinon 500.
   * [À VÉRIFIER] la fin de cette ligne était coupée sur la capture.
   */
  let statusCode =
    res.statusCode && res.statusCode !== 200
      ? res.statusCode
      : (err.statusCode ?? err.status ?? 500);
  let message = err.message || "Something went wrong";
  let code = "error";
  let hint: string | undefined = undefined;

  /*
   * On adapte statusCode, code et message selon le type d'erreur reconnu.
   * Une seule branche s'exécute : la première qui correspond.
   */
  if (err.name === "CastError" && err.kind === "ObjectId") {
    // Identifiant MongoDB mal formé dans l'URL (ex. /products/abc).
    statusCode = 404;
    code = "not_found";
    message = "Resource not found";
  } else if (err.code === 11000) {
    // Code 11000 de MongoDB : doublon sur un champ unique (ex. email déjà pris).
    statusCode = 409;
    code = "duplicate";
    // keyValue contient le champ en conflit ; on prend son nom pour le message.
    const field = Object.keys(err.keyValue || {})[0] || "field";
    message = `A record with that ${field} already exists.`;
  } else if (err.name === "ValidationError") {
    // Erreur de validation Mongoose : on regroupe tous les messages en un seul.
    statusCode = 400;
    code = "validation";
    message =
      Object.values(err.errors || {})
        .map((v) => v.message)
        .join(", ") || message;
  } else if (
    err.name === "JsonWebTokenError" ||
    err.name === "TokenExpiredError"
  ) {
    // Jeton JWT invalide ou expiré : l'utilisateur doit se reconnecter.
    statusCode = 401;
    code = "unauthorized";
    // [À VÉRIFIER] la fin du message (cas jeton invalide) était coupée.
    message =
      err.name === "TokenExpiredError"
        ? "Your session has expired. Sign in again."
        : "Invalid token. Sign in again.";
  } else if (err.type === "entity.parse.failed") {
    // Le corps de la requête n'est pas du JSON valide (erreur de express.json).
    statusCode = 400;
    code = "bad_json";
    message = "The request body is not valid JSON.";
  } else if (err.type === "entity.too.large") {
    // Corps plus gros que la limite de 2 Mo définie dans server.ts.
    statusCode = 413;
    code = "too_large";
    message = "The request body is too large (limit 2 MB).";
  } else if (
    err.name === "MongooseServerSelectionError" ||
    err.name === "MongoNetworkError" ||
    err.name === "MongoServerSelectionError" ||
    (err.name === "MongooseError" && /buffering timed out/i.test(err.message))
  ) {
    // La base de données est injoignable : on répond 503 (service indisponible).
    statusCode = 503;
    code = "db_unavailable";
    message = "The database is not reachable right now. Try again in a moment.";
    // [À VÉRIFIER] la fin de cette phrase était coupée.
    hint =
      "Check MONGO_URI in the root .env and the Atlas IP allowlist; the API reconnects on its own once the database is reachable.";
  } else if (statusCode === 500) {
    // Aucune erreur connue : erreur serveur générique.
    code = "server_error";
  } else if (statusCode === 401) {
    // Les branches suivantes attribuent un code lisible selon le statut posé
    // par le contrôleur avec res.status(...).
    code = "unauthorized";
  } else if (statusCode === 403) {
    code = "forbidden";
  } else if (statusCode === 404) {
    code = "not_found";
  } else if (statusCode === 400) {
    code = "bad_request";
  } else if (statusCode === 409) {
    code = "conflict";
  } else if (statusCode === 429) {
    code = "rate_limited";
  }

  // Identifiant de la requête, posé par le middleware requestId.
  const requestId = requestIdOf(res);

  /*
   * Pour les erreurs serveur (5xx), on écrit dans les logs de quoi retrouver
   * le problème : méthode, URL, statut et identifiant de requête.
   * [À VÉRIFIER] la fin de ce console.error était coupée.
   */
  if (statusCode >= 500) {
    console.error(
      `[api] ${req.method} ${req.originalUrl} → ${statusCode} (request ${requestId})`,
      err,
    );
    // En production, on cache le détail technique au client.
    if (statusCode === 500 && process.env.NODE_ENV === "production") {
      // [À VÉRIFIER] la fin de ce message était coupée.
      message = `Something went wrong on our side. The team has been notified — quote request ${requestId} if you contact support.`;
    }
  }

  // Si la réponse est déjà partie, on ne peut plus en envoyer une autre.
  if (res.headersSent) return;

  res.status(statusCode).json({
    success: false,
    code,
    message,
    path: req.originalUrl,
    // Les "...(condition ? {...} : {})" n'ajoutent le champ que s'il existe.
    ...(requestId ? { requestId } : {}),
    ...(hint ? { hint } : {}),
    // Seulement en développement local : un hébergeur qui oublie NODE_ENV ne doit pas exposer les stacks.
    ...(process.env.NODE_ENV === "development" ? { stack: err.stack } : {}),
  });
}

/**
 * Renvoie un 404 JSON pour les routes d'API inconnues, jamais le
 * « Cannot GET » HTML d'Express.
 */
export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({
    success: false,
    code: "not_found",
    message: `No route for ${req.method} ${req.originalUrl}`,
    path: req.originalUrl,
    requestId: requestIdOf(res),
  });
}
