import { grantAppTablePrivileges } from '../src/db/grants.js';

/**
 * 010 — member_alert_dismissals.
 *
 * A table rather than `members.alert_dismissed_at`, because goal 10's
 * reappearance rule is the whole point: a dismissal is not a property of the
 * member, it is a statement about ONE SPECIFIC expiry date. Recording that date
 * makes reappearance fall out of the data with no reset logic and no background
 * job — change the expiry and the anti-join simply stops matching:
 *
 *   SELECT m.* FROM members m
 *    WHERE m.membership_expires_on <= $1          -- today + 7 days
 *      AND NOT EXISTS (SELECT 1 FROM member_alert_dismissals d
 *                       WHERE d.member_id = m.id
 *                         AND d.dismissed_expiry_date = m.membership_expires_on);
 *
 * A boolean flag would need clearing on every expiry edit, and the first time
 * someone forgot, a lapsed member would silently vanish from the alerts area —
 * exactly the failure the brief's binder story describes.
 *
 * The UNIQUE constraint doubles as the anti-join's index and makes a
 * double-clicked dismissal idempotent via ON CONFLICT DO NOTHING.
 *
 * ON DELETE CASCADE to members is the only cascade to a non-composition parent
 * and is correct: a dismissal is meaningless without its member, and a member
 * with no bookings is deletable.
 */

export async function up(knex) {
  await knex.raw(`
    CREATE TABLE member_alert_dismissals (
      id                    bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      member_id             bigint      NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      dismissed_expiry_date date        NOT NULL,
      dismissed_by_user_id  bigint      NOT NULL REFERENCES users(id)   ON DELETE RESTRICT,
      dismissed_at          timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT member_alert_dismissals_unique
        UNIQUE (member_id, dismissed_expiry_date)
    )
  `);

  await grantAppTablePrivileges(knex, 'member_alert_dismissals');
}

export async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS member_alert_dismissals');
}
