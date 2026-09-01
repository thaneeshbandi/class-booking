import { createApp } from './app.js';
import { env } from './config/env.js';
import { assertConnection, closeConnection } from './db/knex.js';

/**
 * Startup order is deliberate: the environment is validated when
 * `config/env.js` is imported, then the database is proven reachable, and only
 * then does the process accept traffic. A server that listens before it can
 * reach its database just converts a configuration error into a stream of
 * runtime 500s.
 */
try {
  await assertConnection();
} catch (error) {
  console.error(`Cannot reach the database: ${error.message}`);
  console.error('Check DATABASE_URL (see backend/.env.example).');
  process.exit(1);
}

const server = createApp().listen(env.PORT, () => {
  console.log(
    `class-booking backend listening on :${env.PORT} ` +
      `(${env.NODE_ENV}, studio time zone ${env.STUDIO_TIMEZONE})`,
  );
});

async function shutdown(signal) {
  console.log(`\n${signal} received, shutting down.`);
  server.close(async () => {
    await closeConnection();
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
