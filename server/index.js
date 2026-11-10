import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { openDatabase } from './db.js';
import { createStore } from './store.js';
import { createLogger } from './logger.js';
import { openBrowser, runCycle } from './browser.js';

/**
 * Point d'entrée du bot autonome.
 *   node server/index.js
 * Variables : voir server/README.md et .env.example.
 */
export async function main(env = process.env) {
  const config = loadConfig(env);
  const logger = createLogger(config.logLevel);

  const db = openDatabase(config.databaseFile, { log: (message) => logger.info(message) });
  const store = createStore(db);

  const { server, worker } = createApp({ config, store, logger, openBrowser, runCycle });

  // Un redémarrage ne doit pas laisser de visites « running » éternelles.
  const stale = store.resetStaleRunning(10);
  if (stale) logger.warn(`${stale} visite(s) interrompue(s) par le dernier arrêt marquée(s) en échec.`);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => resolve());
  });

  logger.info(`Bot InstaVA ${config.version} à l’écoute sur http://${config.host}:${config.port}`);
  logger.info(`Base : ${config.databaseFile}`);
  logger.info(`Fuseau des quotas quotidiens : ${config.timeZone}`);
  if (config.secretKeySource !== 'env') {
    logger.warn(config.secretKeySource === 'generated'
      ? 'Clé de chiffrement générée (data/secret.key). Sauvegardez-la avec la base.'
      : 'Clé de chiffrement lue depuis data/secret.key.');
  }

  let closing = false;
  async function shutdown(signal) {
    if (closing) return;
    closing = true;
    logger.info(`${signal} reçu : arrêt en cours…`);
    await worker?.stop();
    await new Promise((resolve) => server.close(resolve));
    db.close();
    logger.info('Arrêt terminé.');
    process.exit(0);
  }
  process.on('SIGINT', () => { shutdown('SIGINT'); });
  process.on('SIGTERM', () => { shutdown('SIGTERM'); });

  return { server, store, worker, db, config, shutdown };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Démarrage impossible :', error?.message || error);
    process.exit(1);
  });
}
