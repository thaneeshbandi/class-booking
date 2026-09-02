# Architecture

This describes the system as it actually stands after goals 1–5: accounts and roles, classes,
sessions, the booking lifecycle, and co-instructors. Goals 6–10 (search/filter/sort/pagination,
recurring schedules and CSV export, the dashboard, and membership alerts) and the frontend are not
built yet — see "What was deliberately not built" below.

## Moving pieces

There are exactly two: a Node/Express backend, and a PostgreSQL database. That's it — no queue, no
cache, no separate auth service, no ORM beyond a query builder. For a 12-hour-budget, single-team
application with one write path per resource, a monolith talking directly to one database is the
simplest thing that is still correct, and every extra moving piece would have been complexity spent
on infrastructure instead of on the ten goals.

- **Backend** — `backend/`, a single Node process (`src/server.js` → `src/app.js`), Express for
  routing, [Knex](https://knexjs.org) as the query builder/migration runner over `pg`. Runs as one
  process; there is no worker pool, no background job runner, and no cron — every piece of work
  (including waitlist promotion) happens synchronously inside the HTTP request that triggered it.
- **Database** — PostgreSQL 17, run locally in Docker during development
  (`docker run ... postgres:17`, see `backend/.env.example`). Not yet deployed; the README's suggested
  path (Supabase for the database, Render for the backend) is the intended target once a frontend
  exists to deploy alongside it.

Both run from the same `backend/` package and share one configuration path
(`src/config/env.js`, validated with Zod at import time) and one Knex instance
(`src/db/knex.js`) — the server, the migration runner, the seed script, and the test suite all
construct their database connection identically, so there is no way for "how the tests connect" and
"how the server connects" to quietly drift apart.

## How they talk to each other

A browser (once one exists) or any HTTP client talks to the backend over plain JSON REST —
`POST /api/auth/login`, `GET /api/sessions`, `POST /api/bookings/:id/cancel`, and so on, all under
`/api`. Authentication is a signed, stateless session cookie (`src/auth/tokens.js` — a hand-rolled
HS256 JWT carrying only a user id and expiry, verified with `crypto.timingSafeEqual`); the cookie
proves identity only, never role or account status, both of which are re-read from `users` on every
single request (`src/middleware/authenticate.js`). That is a deliberate trade-off: a role change or a
deactivated account takes effect on the very next request instead of waiting for a 12-hour token to
expire, at the cost of one extra `SELECT` per request.

The backend talks to Postgres exclusively through Knex, either as ad-hoc queries or as an explicit
`db.transaction(async trx => { ... })` for anything that reads-then-writes under a concurrency
guarantee. There is no ORM layer translating rows into domain objects — routes read raw rows and
serialize them into the JSON shape a client gets, and domain logic (`src/domain/*.js`) is small, pure
functions and query helpers imported by routes, not a framework of its own.

## Where each piece runs

Today, everywhere is the same machine: the Node process and the Postgres container both run locally.
Nothing in the code assumes that, though — `DATABASE_URL` and `DATABASE_SSL` (`knexfile.js`) are the
only things that change between "a local Docker container" and "a managed Postgres instance with a
certificate outside Node's trust store," and `APP_DB_ROLE` (`src/db/grants.js`) is how a deployed
environment can run the application under a role with fewer privileges than the migration owner
(concretely: a role that cannot `UPDATE`/`DELETE`/`TRUNCATE` `booking_events`, so goal 9's
immutability holds even against a compromised or buggy application, not only against a well-behaved
one).

## One representative request path, end to end: `POST /api/bookings/:bookingId/cancel`

This one was picked over a simpler CRUD example because it actually exercises every layer described
above at once — authentication, authorization, a locked transaction, a domain rule, and an automatic
side effect.

1. **Express routing** (`app.js`) sends the request into `routes/bookings.js`.
2. **`authenticate`** (`middleware/authenticate.js`) reads the session cookie, verifies its signature
   and expiry, and re-reads the caller's current role/active-status from `users`. No valid session →
   401.
3. **`requireRole('staff')`** (`middleware/authorize.js`) — cancellation is staff-only per the brief.
   Any other role → 403, decided from the re-read row above, never from anything the client sent.
4. **Body validation** — Zod checks the optional `note` field; a malformed booking id in the URL is
   rejected as 400 before touching the database.
5. **An unlocked peek** finds which session this booking belongs to (`db('bookings').where(...)`) —
   just enough to know which row to lock next; nothing here is trusted for a decision yet.
6. **A transaction begins**, and `lockSessionForBooking` (`domain/bookingTransaction.js`) runs one
   raw query: `SELECT ... FROM sessions WHERE id = ? FOR UPDATE`, plus, computed by Postgres in the
   same round trip, `now() >= starts_at` (has this session started?). That `FOR UPDATE` is the whole
   concurrency story — it is the mutex every booking mutation on this session must acquire before
   deciding anything, so two concurrent cancellations (or a cancellation racing a create) on the same
   session can never interleave.
7. **The booking row itself** is then read `FOR UPDATE` too (lock order: session, then booking, never
   reversed) and validated: `assertCancellable` (`domain/bookingTransitions.js`) rejects anything that
   isn't currently `booked` or `waitlisted`; `assertCanCancel` (`domain/bookingTiming.js`) rejects a
   session that has already started — using the boolean Postgres just computed, never
   `Date.now()`.
8. **The write**: the booking's status becomes `cancelled`, and an immutable `booking_events` row is
   inserted in the same transaction (`writeBookingEvent`) — append-only by a database trigger, not
   merely by application convention.
9. **If the cancelled booking held a seat**, `promoteWaitlistFIFO` runs, still inside the same
   transaction and still holding the session lock: it selects the earliest-waitlisted bookings
   (`created_at ASC, id ASC`) up to the number of seats just freed, promotes each to `booked`, and
   writes each an *automatic* `status_changed` event pointing back at the booking that caused it
   (`caused_by_booking_id`).
10. **Commit.** The route re-reads the booking and any promoted bookings (joined with their member,
    for a nicer response) and returns `{ booking, promoted }`.

Every other booking mutation (create, settle) and the two session-update fixes (`PATCH`/`DELETE
/api/sessions/:id`) follow the identical shape: lock the session first, re-read state from that lock,
decide, write, promote if applicable, commit.

## What was deliberately not built, and why

- **A frontend.** The brief scores ten server-enforced goals; every hour spent on a UI before the
  server-side rules were all correct and tested would have been an hour not spent proving the thing
  the assignment is actually assessing. It comes after goal 5 lands cleanly.
- **Goals 6–10** (search/filter/sort/pagination, recurring schedule generation, CSV export, the
  dashboard, membership alerts) — not started. Per the brief's own priority order, they come after the
  booking lifecycle (goal 4) and co-instructors (goal 5), both of which are now done and tested.
- **A maintained `booked_count` column.** Occupancy is always counted from `bookings` under the
  session lock (`countOccupiedSeats`) rather than cached and incrementally updated. A counter is a
  second source of truth that can drift from the rows it's supposed to summarize the moment any code
  path forgets to update it; counting under a lock that already has to be held for correctness anyway
  costs one indexed `COUNT(*)` and can never drift.
- **`SKIP LOCKED` or advisory locks for waitlist promotion.** The session-row lock already serializes
  every writer touching this session's bookings, so there is no concurrent holder for `SKIP LOCKED` to
  skip past, and an advisory lock would just be a second, redundant mutex next to the row lock that's
  already there.
- **A background job for waitlist promotion.** Promotion happens synchronously inside the same
  transaction as the cancellation/capacity-increase that causes it. A queued job would introduce a
  window where a freed seat sits idle waiting for a worker — precisely the "spot sits empty" failure
  the brief opens with.
- **Soft-deleting sessions.** Unlike classes (which are archived, not deleted, because sessions and
  bookings must survive a class being taken off the default view), a session with no bookings is hard
  -deleted; the moment it has any booking, the database's own `ON DELETE RESTRICT` makes deletion
  structurally impossible regardless of what the application intends, which is a stronger guarantee
  than a soft-delete flag would be.
