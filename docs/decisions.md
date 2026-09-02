# Decisions

Real decisions that actually shaped this codebase, in the order they came up. Decision 5 is a genuine
reversal, verifiable in this repository's own history (`git diff 2ecb4bd 415819f --
backend/src/domain/sessionConflicts.js`), not invented for this file.

## Decision 1

- **Chose:** The session row's own `FOR UPDATE` lock as the single concurrency mechanism for every
  booking mutation (create, cancel, settle) and for session capacity/reschedule updates — lock the
  session first, re-read everything relevant from that lock, decide, write.
- **Rejected:** `SERIALIZABLE` isolation; a Postgres advisory lock keyed on the session id; a
  maintained `booked_count` column updated incrementally on every booking write.
- **Why:** `SERIALIZABLE` would make every booking transaction retryable-on-conflict, pushing retry
  logic into every route for a guarantee this design doesn't need — a plain row lock already gives
  exactly the serialization required (no writer can decide anything about this session's bookings
  without first blocking behind every other writer). An advisory lock would be a second mutex
  parallel to a row lock that already exists and is already correct, coordinated only by convention.
  A maintained counter is a second source of truth for occupancy that can drift the moment any write
  path forgets to update it; counting live under a lock already held for correctness costs one
  indexed `COUNT(*)` and structurally cannot drift.

## Decision 2

- **Chose:** Booking status changes only through three explicit-intent endpoints — `POST
  /api/bookings` (create), `POST /:id/cancel`, `POST /:id/settle` — each encoding its own narrow set
  of legal transitions.
- **Rejected:** A general `PATCH /api/bookings/:id { status }`.
- **Why:** A generic status-mutation endpoint pushes the entire transition table into runtime
  validation that every caller has to get right the same way, and it's one accidental deploy away from
  becoming "actually anyone can set any status." With three narrow endpoints, an invalid transition
  (say, `waitlisted -> attended`) is simply not an operation `settle` exposes — the API surface itself
  is the enforcement, not just a check inside a handler.

## Decision 3

- **Chose:** A global `pg.types.setTypeParser(1082, value => value)` (`db/pgTypes.js`), applied once at
  the earliest shared entry point (`db/knex.js`), so every `date` column comes back as an exact
  `YYYY-MM-DD` string everywhere in the application.
- **Rejected:** Leaving the default parser and instead wrapping every date comparison
  (`membership_expires_on` vs. studio-today) in `to_char(...)` at each call site.
- **Why:** node-postgres's default `date` parser builds a UTC-midnight `JS Date`, which renders as the
  *previous* calendar day once viewed through any negative UTC offset — exactly the kind of bug that
  silently corrupts a membership-expiry comparison rather than throwing. A per-call-site `to_char` cast
  fixes only the call sites someone remembers to cast, forever; the global parser fix removes the whole
  bug class in the one place every query already passes through, at the cost of a project-wide
  assumption (dates are strings, not `Date` objects) that has to be understood once and is now backed
  by a regression test (`tests/bookingDomain.test.js`).

## Decision 4

- **Chose:** `booking_events` immutability enforced by two independent layers — `BEFORE UPDATE OR
  DELETE`/`BEFORE TRUNCATE` triggers that reject every mutation regardless of role, *and* (when
  `APP_DB_ROLE` is configured) revoking `UPDATE`/`DELETE`/`TRUNCATE` from the application's own
  database role.
- **Rejected:** The trigger alone.
- **Why:** The trigger alone protects against every role, including a compromised or buggy application
  connection — but a trigger can be dropped by the table owner. Revoking the verbs from the
  application's own role means that even if some future code path forgot the append-only contract
  entirely, the database connection the app actually uses could not execute the mutation regardless of
  what SQL it sent. Neither layer claims to stop the table owner or a superuser; that is stated as the
  honest limit, not hidden.

## Decision 5

- **Chose:** `findSchedulingConflicts`/`findInstructorConflict` take an `instructorIds` array and check
  each one with a sequential `for` loop.
- **Rejected:** The original goal-3 shape — a single `instructorId`, with the room and instructor
  checks run together via `Promise.all`.
- **Why:** When goal 5 added co-instructors, a session's scheduling conflicts needed to be checked
  against every instructor attached to it (primary and each co-instructor), not only the primary — so
  the parameter had to become a set. At the same time, `Promise.all` over two queries on one
  transaction connection was replaced with sequential `await`s: firing concurrent queries down a single
  `pg` connection is deprecated and unsupported, and there was never a real throughput reason to prefer
  it for a handful of cheap, indexed lookups.
- **Later reversed:** the single-instructor, `Promise.all` version was the actual first implementation
  (commit `2ecb4bd`, goal 3); it was changed to the array/sequential form in commit `415819f` when goal
  5 landed. `domain/bookingTransaction.js#promoteWaitlistFIFO`, written after both of those commits,
  followed the same sequential-awaits reasoning from the start rather than needing its own reversal.

## Decision 6

- **Chose:** `PATCH /api/sessions/:id` returns `{ session, promoted }` — the bookings a capacity
  increase just promoted off the waitlist, in the same response.
- **Rejected:** Returning only `{ session }` and leaving a client to discover any promotions with a
  separate `GET`.
- **Why:** The brief's API section fixes the shape of the three booking-mutation responses exactly, but
  says nothing about this endpoint's response — so this was a real, undictated choice. A capacity
  increase can silently promote several people the instant it lands; returning `promoted` inline is the
  same transparency the brief already requires of `POST /:bookingId/cancel`; a caller who doesn't care
  can just ignore the field.
