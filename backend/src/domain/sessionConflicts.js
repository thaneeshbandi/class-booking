/**
 * Server-side session overlap detection (goal 3).
 *
 * The approved overlap rule, applied uniformly to every check below:
 *
 *   existing_start < proposed_end AND existing_end > proposed_start
 *
 * with `end` always derived as `starts_at + duration_minutes`, never stored.
 * Strict inequalities on both sides are what makes a session ending exactly
 * when another begins NOT an overlap.
 *
 * No exclusion constraint or extension is used — both room and instructor
 * conflicts are ordinary indexed queries, run inside the same transaction as
 * the insert/update they guard, per the approved architecture.
 *
 * `queryable` is either the shared `db` or an open transaction, so the same
 * functions serve a read-only preview and the transactional check-then-write
 * that actually creates or edits a session.
 */

/** `starts_at + duration_minutes` as a JS Date, never stored. */
export function computeEndsAt(startsAt, durationMinutes) {
  return new Date(new Date(startsAt).getTime() + durationMinutes * 60_000);
}

function applyOverlap(query, { startsAt, endsAt, excludeSessionId }) {
  query = query
    .where('sessions.starts_at', '<', endsAt)
    .andWhereRaw(
      'sessions.starts_at + make_interval(mins => sessions.duration_minutes) > ?',
      [startsAt],
    );
  if (excludeSessionId) {
    query = query.andWhereNot('sessions.id', excludeSessionId);
  }
  return query;
}

/** The first existing session that would double-book this room, or `undefined`. */
export function findRoomConflict(
  queryable,
  { roomId, startsAt, endsAt, excludeSessionId },
) {
  const query = queryable('sessions')
    .select('sessions.id', 'sessions.starts_at', 'sessions.duration_minutes')
    .where('sessions.room_id', roomId);
  return applyOverlap(query, { startsAt, endsAt, excludeSessionId }).first();
}

/**
 * The first existing session that would double-book this instructor, whether
 * they are that session's primary instructor or one of its co-instructors —
 * the same check applies to a proposed primary instructor and, once goal 5
 * adds co-instructor assignment, to each proposed co-instructor in turn.
 */
export function findInstructorConflict(
  queryable,
  { instructorId, startsAt, endsAt, excludeSessionId },
) {
  const query = queryable('sessions')
    .select('sessions.id', 'sessions.starts_at', 'sessions.duration_minutes')
    .where((qb) => {
      qb.where('sessions.primary_instructor_id', instructorId).orWhereExists(
        queryable('session_co_instructors')
          .select(1)
          .whereRaw('session_co_instructors.session_id = sessions.id')
          .andWhere('session_co_instructors.user_id', instructorId),
      );
    });
  return applyOverlap(query, { startsAt, endsAt, excludeSessionId }).first();
}

function describeConflict(type, row) {
  return {
    type,
    sessionId: row.id,
    startsAt: row.starts_at,
    endsAt: computeEndsAt(row.starts_at, row.duration_minutes),
  };
}

/**
 * Runs every conflict check for a proposed session and returns a list of
 * plain-language, structured conflicts (empty when there are none). Room and
 * instructor are checked independently so a caller double-booked on both
 * counts sees both reasons at once, rather than only the first one found.
 *
 * `instructorIds` covers every instructor the proposed interval must be
 * conflict-free for — the primary instructor, and, once goal 5 adds
 * co-instructors, every current co-instructor too, since a session's time or
 * room can change out from under them (007_session_co_instructors.js). Each
 * id is checked independently so a caller double-booked through more than one
 * instructor sees every reason at once.
 *
 * Checks run one at a time rather than via `Promise.all`: `queryable` is
 * often a single open transaction (one dedicated connection), and firing
 * several queries at once against one connection is deprecated in `pg` and
 * not something to depend on — there is no throughput reason to prefer it
 * here, since these are a handful of cheap, indexed lookups.
 */
export async function findSchedulingConflicts(
  queryable,
  { roomId, instructorIds, startsAt, durationMinutes, excludeSessionId },
) {
  const endsAt = computeEndsAt(startsAt, durationMinutes);
  const uniqueInstructorIds = [...new Set(instructorIds)];

  const conflicts = [];
  const roomConflict = await findRoomConflict(queryable, {
    roomId,
    startsAt,
    endsAt,
    excludeSessionId,
  });
  if (roomConflict) conflicts.push(describeConflict('room', roomConflict));

  for (const instructorId of uniqueInstructorIds) {
    const conflict = await findInstructorConflict(queryable, {
      instructorId,
      startsAt,
      endsAt,
      excludeSessionId,
    });
    if (conflict) {
      conflicts.push({ ...describeConflict('instructor', conflict), instructorId });
    }
  }
  return conflicts;
}
