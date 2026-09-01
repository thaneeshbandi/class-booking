import { Router } from 'express';
import { z } from 'zod';

import { db } from '../db/knex.js';
import { authenticate } from '../middleware/authenticate.js';
import { requireRole } from '../middleware/authorize.js';
import { idParamSchema } from '../validation/ids.js';
import { zodErrorResponse } from '../validation/respond.js';

/**
 * Goal 2 — classes. Staff create, edit, archive and restore; every
 * authenticated user (staff or instructor) may list and view, since an
 * instructor needs to see the classes their sessions belong to and README
 * never restricts class *visibility* to staff — only creation, editing and
 * archiving are staff-only, per goal 1's server-enforced role split.
 *
 * Archiving is `archived_at` becoming non-null (005_classes.js), never a row
 * deletion: nothing here ever removes a class, and `sessions.class_id` is
 * `ON DELETE RESTRICT`, so a class's sessions and their bookings are
 * structurally impossible to lose by archiving it.
 */

const router = Router();

const booleanishQueryParam = z
  .enum(['true', 'false'])
  .optional()
  .transform((value) => value === 'true');

const listClassesQuerySchema = z.object({
  includeArchived: booleanishQueryParam,
});

const classBodySchema = z.object({
  title: z.string().trim().min(1, 'title is required'),
  description: z.string().trim().optional().default(''),
  discipline: z.string().trim().min(1, 'discipline is required'),
  defaultDurationMinutes: z.coerce
    .number()
    .int('defaultDurationMinutes must be an integer')
    .min(1, 'defaultDurationMinutes must be at least 1'),
  defaultCapacity: z.coerce
    .number()
    .int('defaultCapacity must be an integer')
    .min(1, 'defaultCapacity must be at least 1'),
});

const classUpdateSchema = classBodySchema
  .partial()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided.',
  });

function serializeClass(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    discipline: row.discipline,
    defaultDurationMinutes: row.default_duration_minutes,
    defaultCapacity: row.default_capacity,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Deny-by-default: every route below requires authentication; mutating
// routes additionally require `requireRole('staff')`.
router.use(authenticate);

router.get('/', async (req, res, next) => {
  try {
    const parsedQuery = listClassesQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      return res.status(400).json(zodErrorResponse(parsedQuery.error));
    }

    let query = db('classes').select('*').orderBy('title', 'asc');
    if (!parsedQuery.data.includeArchived) {
      query = query.whereNull('archived_at');
    }
    const classes = await query;
    res.json({ classes: classes.map(serializeClass) });
  } catch (error) {
    next(error);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const idResult = idParamSchema.safeParse(req.params.id);
    if (!idResult.success) {
      return res.status(400).json({ error: 'Invalid class id.' });
    }

    const row = await db('classes').where({ id: idResult.data }).first();
    if (!row) return res.status(404).json({ error: 'Class not found.' });
    res.json({ class: serializeClass(row) });
  } catch (error) {
    next(error);
  }
});

router.post('/', requireRole('staff'), async (req, res, next) => {
  try {
    const parsed = classBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json(zodErrorResponse(parsed.error));
    }

    const [row] = await db('classes')
      .insert({
        title: parsed.data.title,
        description: parsed.data.description,
        discipline: parsed.data.discipline,
        default_duration_minutes: parsed.data.defaultDurationMinutes,
        default_capacity: parsed.data.defaultCapacity,
      })
      .returning('*');
    res.status(201).json({ class: serializeClass(row) });
  } catch (error) {
    next(error);
  }
});

router.patch('/:id', requireRole('staff'), async (req, res, next) => {
  try {
    const idResult = idParamSchema.safeParse(req.params.id);
    if (!idResult.success) {
      return res.status(400).json({ error: 'Invalid class id.' });
    }

    const parsed = classUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json(zodErrorResponse(parsed.error));
    }

    const patch = { updated_at: db.fn.now() };
    if (parsed.data.title !== undefined) patch.title = parsed.data.title;
    if (parsed.data.description !== undefined) {
      patch.description = parsed.data.description;
    }
    if (parsed.data.discipline !== undefined) {
      patch.discipline = parsed.data.discipline;
    }
    if (parsed.data.defaultDurationMinutes !== undefined) {
      patch.default_duration_minutes = parsed.data.defaultDurationMinutes;
    }
    if (parsed.data.defaultCapacity !== undefined) {
      patch.default_capacity = parsed.data.defaultCapacity;
    }

    const [row] = await db('classes')
      .where({ id: idResult.data })
      .update(patch)
      .returning('*');
    if (!row) return res.status(404).json({ error: 'Class not found.' });
    res.json({ class: serializeClass(row) });
  } catch (error) {
    next(error);
  }
});

// Archiving and restoring are idempotent rather than a strict state-machine
// transition: re-archiving an already-archived class, or restoring an
// already-active one, is a no-op that returns the current row unchanged
// rather than a 409. Unlike a booking's lifecycle, nothing downstream depends
// on catching a redundant archive/restore as an error.
router.post('/:id/archive', requireRole('staff'), async (req, res, next) => {
  try {
    const idResult = idParamSchema.safeParse(req.params.id);
    if (!idResult.success) {
      return res.status(400).json({ error: 'Invalid class id.' });
    }

    const existing = await db('classes').where({ id: idResult.data }).first();
    if (!existing) return res.status(404).json({ error: 'Class not found.' });
    if (existing.archived_at) {
      return res.json({ class: serializeClass(existing) });
    }

    const [row] = await db('classes')
      .where({ id: idResult.data })
      .update({ archived_at: db.fn.now(), updated_at: db.fn.now() })
      .returning('*');
    res.json({ class: serializeClass(row) });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/restore', requireRole('staff'), async (req, res, next) => {
  try {
    const idResult = idParamSchema.safeParse(req.params.id);
    if (!idResult.success) {
      return res.status(400).json({ error: 'Invalid class id.' });
    }

    const existing = await db('classes').where({ id: idResult.data }).first();
    if (!existing) return res.status(404).json({ error: 'Class not found.' });
    if (!existing.archived_at) {
      return res.json({ class: serializeClass(existing) });
    }

    const [row] = await db('classes')
      .where({ id: idResult.data })
      .update({ archived_at: null, updated_at: db.fn.now() })
      .returning('*');
    res.json({ class: serializeClass(row) });
  } catch (error) {
    next(error);
  }
});

export default router;
