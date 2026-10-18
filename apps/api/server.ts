/*
 * IMPORTANT : cet import doit rester en toute première ligne.
 * Il charge le fichier .env (via dotenv) et vérifie que MONGO_URI et
 * JWT_SECRET existent. Si un autre module était importé avant, il pourrait
 * lire process.env alors que les variables ne sont pas encore chargées
 * et obtenir `undefined`.
 */
import "./config/env.js";

// Express : le framework web qui gère les routes et les requêtes HTTP.
import express from "express";

// CORS : autorise (ou bloque) les requêtes venant d'autres origines,
// par exemple le front sur localhost:3000 qui appelle cette API.
import cors from "cors";

// Helmet : ajoute des en-têtes HTTP de sécurité (protection contre
// certaines attaques courantes comme le clickjacking ou le sniffing).
import helmet from "helmet";

// Compression : compresse les réponses (gzip) pour qu'elles soient
// plus légères et plus rapides à télécharger.
import compression from "compression";

// Mongoose : bibliothèque qui permet de dialoguer avec MongoDB.
// Ici, elle sert sans doute à lire l'état de la connexion.
import mongoose from "mongoose";

// Fonction qui se connecte à MongoDB et réessaie automatiquement
// tant que la base n'est pas joignable (voir config/db.ts).
import connectDB from "./config/db.js";

/*
 * Middlewares de gestion d'erreurs :
 * - notFoundHandler : répond 404 quand aucune route ne correspond.
 * - errorHandler : attrape toutes les erreurs et renvoie une réponse
 *   propre au lieu de planter. Il doit être déclaré en dernier.
 */
import { errorHandler, notFoundHandler } from "./middleware/errorMiddleware.js";

/*
 * Middlewares de disponibilité :
 * - readinessGate : répond 503 tant que la base de données n'est pas connectée.
 * - requestTimeout : coupe les requêtes qui prennent trop de temps.
 */
import {
  readinessGate,
  requestTimeout,
} from "./middleware/readinessMiddleware.js";

// Donne un identifiant unique à chaque requête, pratique pour retrouver
// une requête précise dans les logs en cas de bug.
import { requestId } from "./middleware/requestIdMiddleware.js";

/*
 * Lance la connexion à MongoDB, sauf pendant les tests.
 * `void` signifie qu'on n'attend pas la fin de la connexion : le serveur
 * démarre tout de suite, et `readinessGate` répond 503 tant que la base
 * n'est pas prête.
 */
if (process.env.NODE_ENV !== "test") {
  void connectDB();
}

// Crée l'application Express : c'est l'objet auquel on ajoute les middlewares et les routes.
const app = express();

/*
 * Derrière un proxy (Vercel, Nginx, load balancer), toutes les requêtes
 * semblent venir du proxy. `trust proxy: 1` fait confiance au premier proxy
 * pour lire la vraie adresse IP du client (utile pour les logs ou une limite
 * de requêtes par IP).
 */
app.set("trust proxy", 1);

// En-têtes de sécurité HTTP.
app.use(helmet());
/*
 * Par défaut, Helmet interdit aux autres sites de charger les ressources de
 * cette API (images, fichiers). "cross-origin" l'autorise, ce qui est
 * nécessaire si le front, sur un autre domaine, affiche des fichiers servis
 * par l'API.
 */
app.use(helmet.crossOriginResourcePolicy({ policy: "cross-origin" }));

// Compression des réponses pour les alléger.
app.use(compression());

/*
 * CORS : liste des sites autorisés à appeler l'API (la boutique et le
 * tableau de bord), avec les cookies. `.filter(Boolean)` retire les valeurs
 * vides si une variable d'environnement n'est pas définie.
 */
const allowedOrigins = [process.env.CLIENT_URL, process.env.ADMIN_URL].filter(
  Boolean,
) as string[];

app.use(
  cors({
    origin(origin, callback) {
      // Les appels de serveur à serveur et curl n'envoient pas d'en-tête Origin : on les accepte.
      if (!origin) return callback(null, true);
      // En développement, on accepte toutes les origines pour tester plus facilement.
      if (process.env.NODE_ENV === "development") return callback(null, true);
      // Sinon, on n'accepte que les origines de la liste.
      callback(null, allowedOrigins.includes(origin));
    },
    // Autorise l'envoi des cookies et des identifiants avec les requêtes.
    credentials: true,
    // Méthodes HTTP autorisées.
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    // En-têtes que le front a le droit d'envoyer.
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

/*
 * Tout ce qui a besoin du corps brut de la requête (comme le webhook Stripe,
 * qui doit vérifier une signature) doit être monté AVANT cette ligne.
 * Les deux lignes suivantes transforment le corps en objet JavaScript et
 * empêchent d'envoyer plus de 2 Mo.
 */
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ limit: "2mb", extended: true }));

app.use(requestId);

app.use("/api", readinessGate);
app.use(requestTimeout());

/**
 * Santé de l'API, lisible par une machine : ce processus tourne-t-il, et
 * peut-il joindre la base de données ?
 * Utile pour un hébergeur (Render, Railway...) ou un outil de surveillance
 * qui interroge cette URL régulièrement.
 */
app.get("/api/health", (_req: express.Request, res: express.Response) => {
  // readyState vaut 1 quand Mongoose est connecté à MongoDB.
  const db =
    mongoose.connection.readyState === 1 ? "connected" : "disconnected";

  // 200 si tout va bien, 503 (service indisponible) si la base est coupée.
  res.status(db === "connected" ? 200 : 503).json({
    // Résumé simple : true si la base est connectée.
    ok: db === "connected",
    // Libellé lisible : "healthy" (en forme) ou "degraded" (dégradé).
    status: db === "connected" ? "healthy" : "degraded",
    // État détaillé de la connexion à la base.
    db,
    // Durée de fonctionnement du processus, en secondes.
    uptime: Math.round(process.uptime()),
    // Environnement courant (development, production...).
    environment: process.env.NODE_ENV,
    // Date et heure de la réponse, au format ISO (ex. 2026-10-18T14:30:00.000Z).
    timestamp: new Date().toISOString(),
  });
});

app.use("/api", notFoundHandler);

app.use(errorHandler);

// Port d'écoute : celui défini dans le .env, sinon 8000 par défaut.
const PORT = process.env.PORT || 8000;

/*
 * On ne démarre le serveur que si :
 * - on n'est pas sur Vercel (VERCEL !== "1") : Vercel fournit lui-même le
 *   serveur et utilise l'`app` exportée en bas du fichier ;
 * - on n'est pas en test : les tests appellent `app` directement, sans
 *   ouvrir de port.
 */
if (process.env.VERCEL !== "1" && process.env.NODE_ENV !== "test") {
  // Lance le serveur HTTP et garde une référence pour pouvoir l'arrêter proprement.
  const server = app.listen(PORT, () => {
    console.log(
      `Server running in ${process.env.NODE_ENV} mode on port ${PORT}`,
    );
  });

  /*
   * Délais de maintien des connexions, légèrement au-dessus des délais
   * d'inactivité habituels des load balancers (60 s). Sinon, le load balancer
   * pourrait réutiliser une connexion que Node vient de fermer, ce qui
   * provoque des erreurs 502 aléatoires.
   * headersTimeout doit rester supérieur à keepAliveTimeout.
   */
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  /*
   * Une promesse rejetée que personne n'a attendue ne doit pas faire tomber
   * toute l'API : on journalise l'erreur et le serveur continue.
   */
  process.on("unhandledRejection", (reason) => {
    // [À VÉRIFIER] la fin de cette ligne était coupée.
    console.error(
      "[api] unhandled rejection:",
      reason instanceof Error ? (reason.stack ?? reason.message) : reason,
    );
  });

  /*
   * Une exception non rattrapée laisse le programme dans un état incertain :
   * on journalise, puis on arrête proprement le serveur avec le code 1
   * (code de sortie « erreur »). L'hébergeur redémarrera le processus.
   */
  process.on("uncaughtException", (error) => {
    console.error(
      "[api] uncaught exception — shutting down:",
      error.stack ?? error.message,
    );
    shutdown("uncaughtException", 1);
  });

  // Évite de lancer l'arrêt deux fois si plusieurs signaux arrivent à la suite.
  let closing = false;

  /*
   * Arrêt propre du serveur :
   * 1. on arrête d'accepter de nouvelles connexions (server.close) ;
   * 2. on laisse finir les requêtes en cours ;
   * 3. on ferme la connexion à MongoDB ;
   * 4. on quitte le processus.
   * Si ça traîne plus de 10 secondes, un minuteur force l'arrêt.
   */
  function shutdown(signal: string, exitCode = 0) {
    if (closing) return;
    closing = true;
    console.log(`[api] ${signal} received — closing connections`);

    // Arrêt forcé au bout de 10 s ; unref() n'empêche pas Node de se terminer avant.
    const force = setTimeout(() => process.exit(exitCode), 10_000);
    force.unref();

    server.close(() => {
      mongoose
        .disconnect()
        // On ignore une éventuelle erreur de déconnexion : on quitte quand même.
        .catch(() => undefined)
        .finally(() => process.exit(exitCode));
    });
  }

  // SIGTERM : l'hébergeur demande l'arrêt (déploiement, redémarrage).
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  // SIGINT : tu appuies sur Ctrl+C dans le terminal.
  process.on("SIGINT", () => shutdown("SIGINT"));
}

/*
 * Exporte l'application Express sans la démarrer. Vercel l'utilise comme
 * fonction serverless, et les tests peuvent l'importer directement.
 */
export default app;
