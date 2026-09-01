import express from 'express';

import { env } from './config/env.js';
import { db } from './db/knex.js';

/**
 * The application surface for this milestone is deliberately one endpoint.
 * Authentication, classes, sessions, bookings, the dashboard and alerts are not
 * implemented yet — this exists so the database foundation can be started,
 * health-checked and deployed before any business logic depends on it.
 */
export function createApp() {
  const app = express();
  app.use(express.json());

  app.get('/health', async (_req, res) => {
    try {
      await db.raw('select 1');
      res.json({
        status: 'ok',
        database: 'up',
        environment: env.NODE_ENV,
        studioTimeZone: env.STUDIO_TIMEZONE,
      });
    } catch (error) {
      // A reachable process with an unreachable database is still unhealthy:
      // report 503 so a platform health check fails rather than passing blind.
      res.status(503).json({
        status: 'degraded',
        database: 'down',
        error: error.message,
      });
    }
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Express identifies error middleware by arity: the unused fourth argument
  // is required for this to be treated as an error handler at all.
  app.use((error, _req, res, _next) => {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
