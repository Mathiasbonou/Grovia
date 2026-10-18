import mongoose from "mongoose";

const RETRY_MS = 5_000;
const MAX_RETRY_MS = 30_000;

/**
 * Se connecte à MongoDB et continue d'essayer.
 *
 * L'API reste en ligne tant que la base de données est injoignable :
 * `readinessGate` répond à chaque requête de données par un 503 JSON jusqu'au
 * retour de la connexion, et le driver se reconnecte tout seul dès qu'elle
 * existe. Un `MONGO_URI` manquant est la seule chose qui arrête encore le
 * processus, car rien ne peut s'en remettre.
 */
const connectDB = async (): Promise<void> => {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    console.error("MongoDB : MONGO_URI n'est pas défini dans le .env racine");
    process.exit(1);
  }

  mongoose.connection.on("disconnected", () =>
    console.warn(
      "MongoDB : déconnecté — les requêtes répondent 503 en attendant",
    ),
  );
  mongoose.connection.on("reconnected", () =>
    console.log("MongoDB : reconnecté"),
  );
  mongoose.connection.on("error", (error) =>
    console.error("MongoDB : erreur de connexion :", error.message),
  );

  let delay = RETRY_MS;
  for (;;) {
    try {
      const conn = await mongoose.connect(mongoUri, {
        serverSelectionTimeoutMS: 8_000,
        heartbeatFrequencyMS: 10_000,
        /* Assez de sockets pour un checkout chargé, quelques-unes gardées
           au chaud, les inactives libérées. */
        maxPoolSize: 20,
        minPoolSize: 2,
        maxIdleTimeMS: 60_000,
        socketTimeoutMS: 45_000,
      });
      console.log(`MongoDB connecté : ${conn.connection.host}`);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `Erreur de connexion MongoDB : ${message} — nouvel essai dans ${delay / 1000}s`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, MAX_RETRY_MS);
    }
  }
};

export default connectDB;
