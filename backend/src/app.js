import express from 'express';

import { env } from './config/env.js';
import { db } from './db/knex.js';
import authRouter from './routes/auth.js';
import bookingsRouter from './routes/bookings.js';
import classesRouter from './routes/classes.js';
import membersRouter from './routes/members.js';
import sessionsRouter from './routes/sessions.js';

/**
 * The full booking lifecycle, co-instructor management, recurring
 * generation, CSV export, the dashboard and membership alerts are not
 * implemented yet. What is here is the authentication/authorization
 * foundation, classes (goal 2), and session scheduling with conflict
 * detection (goal 3): login/logout/current-user; class CRUD and
 * archive/restore; session CRUD scoped and authorized the same way
 * throughout — deny-by-default access, resource-level instructor ownership,
 * and collection scoping performed in SQL rather than in JavaScript after
 * the fact.
 */
export function createApp() {
  const app = express();
  app.use(express.json());

  app.use('/api/auth', authRouter);
  app.use('/api/classes', classesRouter);
  app.use('/api/sessions', sessionsRouter);
  app.use('/api/bookings', bookingsRouter);
  app.use('/api/members', membersRouter);

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
