import { grantAppendOnlyPrivileges } from '../src/db/grants.js';

/**
 * 009 — booking_events: the append-only timeline behind goal 9.
 *
 * `actor_user_id` is nullable, and NULL is itself the marker for a system/seed
 * event — no separate `is_system` boolean, which would be a second source of
 * truth needing its own consistency check. The semantics are strict: NULL means
 * "no human performed this", never "a human did it but we did not capture who".
 * Inventing an actor to satisfy NOT NULL would falsify the very record goal 9
 * exists to protect.
 *
 * Automatic promotions are NOT system events: they carry `is_automatic = true`
 * *and* the human whose cancellation triggered them, enforced by
 * `booking_events_automatic_has_actor`. There is no state in which an automatic
 * promotion has no accountable human.
 *
 * Immutability has two layers that fail differently:
 *   - triggers reject UPDATE, DELETE and TRUNCATE for every role that is not
 *     the table owner or a superuser;
 *   - the grants (when APP_DB_ROLE is configured) mean the application role
 *     never holds those verbs in the first place.
 *
 * Row-level triggers do not fire on TRUNCATE, so that door is closed by a
 * separate statement-level trigger rather than being assumed shut.
 *
 * The honest limit: neither layer stops the table owner or a superuser, who can
 * DROP TRIGGER and then write freely. PostgreSQL has no constraint binding its
 * own owner. The claim this supports is exactly goal 9's — history cannot be
 * edited or deleted through the application, including by studio staff — not
 * that it is tamper-proof against database administrator access.
 */

export async function up(knex) {
  await knex.raw(`
    CREATE TABLE booking_events (
      id                   bigint             GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      booking_id           bigint             NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
      event_type           booking_event_type NOT NULL,
      from_status          booking_status,
      to_status            booking_status,
      note                 text,
      actor_user_id        bigint                      REFERENCES users(id)    ON DELETE RESTRICT,
      is_automatic         boolean            NOT NULL DEFAULT false,
      caused_by_booking_id bigint                      REFERENCES bookings(id) ON DELETE RESTRICT,
      occurred_at          timestamptz        NOT NULL DEFAULT now(),

      -- Because history is append-only, a malformed row can never be repaired.
      -- This constraint therefore does more work here than the same constraint
      -- would on a mutable table.
      CONSTRAINT booking_events_well_formed CHECK (
           (event_type = 'created'
              AND from_status IS NULL
              AND to_status IN ('booked', 'waitlisted')
              AND note IS NULL)
        OR (event_type = 'status_changed'
              AND from_status IS NOT NULL
              AND to_status   IS NOT NULL
              AND from_status <> to_status
              AND note IS NULL)
        OR (event_type = 'note'
              AND from_status IS NULL
              AND to_status   IS NULL
              AND note IS NOT NULL AND btrim(note) <> '')
      ),

      CONSTRAINT booking_events_automatic_is_status_change
        CHECK (NOT is_automatic OR event_type = 'status_changed'),

      CONSTRAINT booking_events_automatic_has_actor
        CHECK (NOT is_automatic OR actor_user_id IS NOT NULL),

      CONSTRAINT booking_events_cause_requires_automatic
        CHECK (caused_by_booking_id IS NULL OR is_automatic),

      CONSTRAINT booking_events_cause_is_not_self
        CHECK (caused_by_booking_id IS NULL OR caused_by_booking_id <> booking_id)
    )
  `);

  // The booking timeline (goal 9), in order.
  await knex.raw(`
    CREATE INDEX booking_events_booking
      ON booking_events (booking_id, occurred_at, id)
  `);

  await knex.raw(`
    CREATE FUNCTION booking_events_reject_mutation() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'booking_events is append-only; % is not permitted', TG_OP
        USING ERRCODE = 'restrict_violation';
    END;
    $$
  `);

  await knex.raw(`
    CREATE TRIGGER booking_events_no_update_delete
      BEFORE UPDATE OR DELETE ON booking_events
      FOR EACH ROW EXECUTE FUNCTION booking_events_reject_mutation()
  `);

  // Row triggers do not fire on TRUNCATE; this closes that door separately.
  await knex.raw(`
    CREATE TRIGGER booking_events_no_truncate
      BEFORE TRUNCATE ON booking_events
      FOR EACH STATEMENT EXECUTE FUNCTION booking_events_reject_mutation()
  `);

  await grantAppendOnlyPrivileges(knex, 'booking_events');
}

export async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS booking_events');
  // The table's triggers go with it; the function is independent.
  await knex.raw('DROP FUNCTION IF EXISTS booking_events_reject_mutation()');
}
