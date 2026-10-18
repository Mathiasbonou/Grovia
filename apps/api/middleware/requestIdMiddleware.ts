// Génère un identifiant unique aléatoire (UUID), fourni par Node.js.
import { randomUUID } from "node:crypto";
// On importe seulement les types Express (rien n'est exécuté à l'import).
import type { NextFunction, Request, Response } from "express";

/**
 * Un identifiant par requête, renvoyé dans l'en-tête `X-Request-Id` et repris
 * dans la réponse d'erreur et dans le journal de l'API. Ainsi, quand un client
 * dit « j'ai eu l'erreur abc-123 », on retrouve la ligne de log qui
 * correspond. L'appelant peut fournir son propre identifiant (lettres,
 * chiffres, tirets, de 8 à 64 caractères) ; tout le reste est remplacé.
 */
const SAFE_ID = /^[A-Za-z0-9-]{8,64}$/;

/*
 * Middleware : s'exécute pour chaque requête, avant les routes.
 * 1. Lit l'en-tête X-Request-Id envoyé par le client (vide s'il est absent).
 * 2. Si cet identifiant respecte le format SAFE_ID, on le garde ; sinon on
 *    en génère un nouveau. Le contrôle évite qu'un client injecte du texte
 *    étrange ou très long dans nos logs.
 * 3. Le range dans `res.locals`, un espace réservé à la requête en cours,
 *    que les autres middlewares peuvent lire.
 * 4. Le renvoie au client dans l'en-tête de la réponse.
 * 5. `next()` passe la main au middleware suivant. Sans cet appel, la
 *    requête resterait bloquée.
 */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const supplied = req.get("X-Request-Id") ?? "";
  const id = SAFE_ID.test(supplied) ? supplied : randomUUID();
  res.locals.requestId = id;
  res.setHeader("X-Request-Id", id);
  next();
}

/**
 * Retourne l'identifiant attribué par le middleware, pour les loggers et la
 * réponse d'erreur. Renvoie une chaîne vide s'il n'existe pas.
 */
export function requestIdOf(res: Response): string {
  return typeof res.locals.requestId === "string" ? res.locals.requestId : "";
}