import { Router } from 'express';
import { z } from 'zod';

import { daysUntilExpiry, isMembershipExpired, isWithinAlertWindow } from '../domain/membership.js';
import {
  getAlertWindowBounds,
  listExpiringMemberAlerts,
} from '../domain/membershipAlerts.js';
import { env } from '../config/env.js';
import { db } from '../db/knex.js';
import { authenticate } from '../middleware/authenticate.js';
import { requireRole } from '../middleware/authorize.js';
import { idParamSchema } from '../validation/ids.js';
import { zodErrorResponse } from '../validation/respond.js';

/**
 * Staff-only member data. Instructor access to members is not part of the
 * README brief — an instructor's data access is scoped to sessions they are
 * authorized to see, not to the studio's whole membership list — so this is
 * denied by default rather than granted absent a stated reason to allow it.
 *
 * Goal 1 — "studio staff ... add members and set their membership expiry" —
 * is `POST /` (create) and `PATCH /:id` (edit, including moving the expiry
 * date), following the same create/update-schema and validation shape
 * `routes/classes.js` already uses.
 *
 * Goal 10 — membership expiry alerts — also lives in this file:
 * `GET /alerts/expiring` (the current alert population) and
 * `POST /:memberId/alerts/membership-expiry/dismiss` (dismiss one member's
 * current alert). Both staff-only, same as everything else here. See each
 * route's own comment and `domain/membershipAlerts.js` for the predicate.
 */

const router = Router();

const memberCreateSchema = z.object({
  fullName: z.string().trim().min(1, 'fullName is required'),
  email: z.string().trim().toLowerCase().min(1).email('email must be a valid email address.'),
  membershipExpiresOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'membershipExpiresOn must be YYYY-MM-DD.'),
});

const memberUpdateSchema = memberCreateSchema
  .partial()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided.',
  });

function serializeMember(row) {
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    membershipExpiresOn: row.membership_expires_on,
  };
}

/** `row` carries `studio_today` alongside the member fields
 * (`listExpiringMemberAlerts`), so `isExpired`/`daysUntilExpiry` are derived
 * here from the exact same instant the query itself was filtered against —
 * never a separately-computed "now". */
function serializeAlert(row) {
  return {
    memberId: row.id,
    fullName: row.full_name,
    email: row.email,
    membershipExpiresOn: row.membership_expires_on,
    isExpired: isMembershipExpired(row.membership_expires_on, row.studio_today),
    daysUntilExpiry: daysUntilExpiry(row.membership_expires_on, row.studio_today),
  };
}

function serializeDismissal(row) {
  return {
    memberId: row.member_id,
    dismissedExpiryDate: row.dismissed_expiry_date,
    dismissedByUserId: row.dismissed_by_user_id,
    dismissedAt: row.dismissed_at,
  };
}

router.get('/', authenticate, requireRole('staff'), async (_req, res, next) => {
  try {
    const members = await db('members').select('*').orderBy('full_name', 'asc');
    res.json({ members: members.map(serializeMember) });
  } catch (error) {
    next(error);
  }
});

router.post('/', authenticate, requireRole('staff'), async (req, res, next) => {
  try {
    const parsed = memberCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json(zodErrorResponse(parsed.error));
    }

    const [row] = await db('members')
      .insert({
        full_name: parsed.data.fullName,
        email: parsed.data.email,
        membership_expires_on: parsed.data.membershipExpiresOn,
      })
      .returning('*');
    res.status(201).json({ member: serializeMember(row) });
  } catch (error) {
    // `members_email_unique` (migration 014) is the actual enforcement — a
    // pre-check `SELECT` here would still leave a race window between two
    // concurrent staff requests for the same email; the database constraint
    // is what closes it. This only translates the resulting 23505 into the
    // application's normal conflict shape, never a raw Postgres error.
    if (error?.code === '23505') {
      return res.status(409).json({ error: 'A member with this email already exists.' });
    }
    next(error);
  }
});

router.patch('/:id', authenticate, requireRole('staff'), async (req, res, next) => {
  try {
    const idResult = idParamSchema.safeParse(req.params.id);
    if (!idResult.success) {
      return res.status(400).json({ error: 'Invalid member id.' });
    }

    const parsed = memberUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json(zodErrorResponse(parsed.error));
    }

    const patch = { updated_at: db.fn.now() };
    if (parsed.data.fullName !== undefined) patch.full_name = parsed.data.fullName;
    if (parsed.data.email !== undefined) patch.email = parsed.data.email;
    if (parsed.data.membershipExpiresOn !== undefined) {
      patch.membership_expires_on = parsed.data.membershipExpiresOn;
    }

    const [row] = await db('members').where({ id: idResult.data }).update(patch).returning('*');
    if (!row) return res.status(404).json({ error: 'Member not found.' });
    res.json({ member: serializeMember(row) });
  } catch (error) {
    // Same enforcement as create (see its own comment): `members_email_unique`
    // is the real guard. Updating a member to its own current email hits no
    // conflict — the constraint only rejects a value some *other* row already
    // has — so this never blocks a no-op or unrelated-field edit.
    if (error?.code === '23505') {
      return res.status(409).json({ error: 'A member with this email already exists.' });
    }
    next(error);
  }
});

// Goal 10 — the current alert population, oldest-expiry-first. `GET` here
// never collides with the `POST /:memberId/...` route below — different
// HTTP methods, and `idParamSchema` requires a bare positive integer
// anyway, so "alerts" could never be mistaken for a member id even if it
// did.
router.get('/alerts/expiring', authenticate, requireRole('staff'), async (_req, res, next) => {
  try {
    const rows = await listExpiringMemberAlerts(db, env.STUDIO_TIMEZONE);
    res.json({ alerts: rows.map(serializeAlert) });
  } catch (error) {
    next(error);
  }
});

/**
 * Goal 10 — dismiss one member's current membership-expiry alert.
 *
 * Transactional and re-derives everything from the database rather than
 * trusting anything the client sent beyond the member id in the URL: the
 * member row is locked `FOR UPDATE` and re-read, the alert window is
 * re-computed fresh, and the dismissal is written against the member's
 * *current* `membership_expires_on` — never a client-supplied expiry date,
 * which would let a stale request suppress an alert for a membership that
 * has since changed.
 *
 * Dismissing a member who is not currently within the alert window is
 * rejected (409) rather than silently accepted: a dismissal row not tied to
 * a real, current alert would just be dead data with no alert to suppress,
 * and the brief never asks for that.
 *
 * Idempotent via `ON CONFLICT (member_id, dismissed_expiry_date) DO
 * NOTHING` — the unique constraint already added in migration 010 — rather
 * than a separate read-then-insert existence check, which would be
 * race-prone for no benefit an atomic upsert doesn't already provide.
 */
router.post(
  '/:memberId/alerts/membership-expiry/dismiss',
  authenticate,
  requireRole('staff'),
  async (req, res, next) => {
    try {
      const idResult = idParamSchema.safeParse(req.params.memberId);
      if (!idResult.success) {
        return res.status(400).json({ error: 'Invalid member id.' });
      }
      const memberId = idResult.data;

      const outcome = await db.transaction(async (trx) => {
        const member = await trx('members').where({ id: memberId }).forUpdate().first();
        if (!member) {
          return { error: { status: 404, body: { error: 'Member not found.' } } };
        }

        const { windowEnd } = await getAlertWindowBounds(trx, env.STUDIO_TIMEZONE);
        if (!isWithinAlertWindow(member.membership_expires_on, windowEnd)) {
          return {
            error: {
              status: 409,
              body: {
                error: 'This member is not currently within the membership-expiry alert window.',
              },
            },
          };
        }

        const [inserted] = await trx('member_alert_dismissals')
          .insert({
            member_id: memberId,
            dismissed_expiry_date: member.membership_expires_on,
            dismissed_by_user_id: req.user.id,
          })
          .onConflict(['member_id', 'dismissed_expiry_date'])
          .ignore()
          .returning('*');

        const dismissal =
          inserted ??
          (await trx('member_alert_dismissals')
            .where({
              member_id: memberId,
              dismissed_expiry_date: member.membership_expires_on,
            })
            .first());

        return { dismissal };
      });

      if (outcome.error) {
        return res.status(outcome.error.status).json(outcome.error.body);
      }
      res.json({ dismissal: serializeDismissal(outcome.dismissal) });
    } catch (error) {
      next(error);
    }
  },
);

export default router;
