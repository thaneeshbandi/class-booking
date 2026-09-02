# Architecture

This describes the system as it actually stands after goals 1–6: accounts and roles, classes,
sessions, the booking lifecycle, co-instructors, and server-side booking search/filter/sort
/pagination. Goals 7–10 (recurring schedules and CSV export, the dashboard, and membership alerts)
and the frontend are not built yet — see "What was deliberately not built" below.

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

## Goal 6 — `GET /api/bookings` search, filter, sort, pagination, total count

The one collection endpoint in the whole API that takes a real query-parameter contract, because it's
the one place the brief explicitly forbids the JavaScript-side shortcut: "do not load every booking
into the browser and filter there." Every operation below — search, filter, sort, pagination, count —
runs as one query shape in PostgreSQL; none of it happens after the rows leave the database.

**One base query, built once, cloned twice.** `routes/bookings.js`'s `GET /` builds a single Knex
query — `bookings` joined to `sessions`, `members`, and `classes` — and applies, in order: the
instructor scope (`scopeSessionsToInstructor`, the exact predicate `middleware/sessionAccess.js`
already uses for the session/booking single-resource checks, imported rather than re-expressed), then
`classId`, `sessionId`, and `status` as plain equality filters, then the text search. That query is
never executed directly — `.clone()` produces a `count({count: 'bookings.id'})` query for the total and
a second clone gets `.select(...)`, `.orderBy(...)`, `.limit()`, `.offset()` for the page, and the two
run concurrently (`Promise.all`, against the pool — not a single locked connection, so this is safe
unlike the transaction-internal sequential-query rule in `bookingTransaction.js`). Because both the
count and the page descend from the same base query object, there is no way for the two to see a
different set of authorized, filtered rows — the alternative (two independently hand-written
`WHERE` clauses, one for counting and one for fetching) is exactly the kind of drift a `.clone()` is
meant to make structurally impossible.

**Every join here is on a single not-null foreign key** (`bookings.session_id → sessions.id`,
`bookings.member_id → members.id`, `sessions.class_id → classes.id`), so a booking row can never fan
out into more than one result row — no `DISTINCT` is needed anywhere in this query.

**Authorization is AND, never OR.** The scope predicate and every filter are separate `.where(...)`
calls, which Knex always ANDs together at the top level; the text search is the one place two
conditions (name-match OR email-match) had to be combined, and that OR is grouped inside its own
`query.where((qb) => qb.where(...).orWhere(...))` callback — rendered as one parenthesized clause ANDed
onto everything else, so it can only ever narrow an instructor's already-scoped rows, never widen them
into another instructor's. `q=<a member visible only in another instructor's session>` is exactly the
regression `tests/bookingSearch.test.js` exists to pin down: the naive-but-wrong shape
(`query.where(scope).orWhere('members.email', ...)`) would leak every studio member matching the term,
scope or no scope, and there is a dedicated test asserting zero results for exactly that query.

**The sort whitelist is a fixed object, not a client-controlled column name.** `sort` (one of
`bookedAt`, `status`, `session`) is validated by a Zod enum before it ever reaches SQL, then looked up
in `BOOKING_SORT_COLUMNS` to the actual `bookings.created_at` / `bookings.status` / `sessions.starts_at`
expression — an unrecognized value 400s before any query is built, and no string the client sends is
ever interpolated into an `ORDER BY`. Every ordering — including `direction=desc` — appends
`bookings.id ASC` as a second `orderBy`, so two rows tied on the primary sort column (two bookings with
equal `status`, say) still resolve to one deterministic total order and can never trade places between
page 1 and page 2 of the same query.

**Pagination is `LIMIT`/`OFFSET` computed from validated `page`/`pageSize`** (`offset = (page - 1) *
pageSize`), with `pageSize` capped at 100 — a client cannot ask for an unbounded page. An empty result
(no filter matched anything) and a page requested past the last one look the same in one respect and
different in another: both return `bookings: []`, but `total`/`totalPages` stay whatever the filters
actually matched — `totalPages: 0` only when `total` itself is `0`
(`Math.ceil(total / pageSize)`, which is `0` exactly when `total` is `0`, and never otherwise).

**Why plain `ILIKE '%term%'` and no `pg_trgm`.** The brief explicitly names this endpoint's scale as a
single studio's bookings, not a search-engine workload; a leading-wildcard `ILIKE` cannot use a normal
B-tree index and never will, but at this scale that's a sub-millisecond sequential scan against a
handful of joined rows, not a bottleneck worth a Postgres extension, an index type, and the
deployment-environment assumption ("the extension is installed") that comes with it. `docs/schema.md`
already states plainly what happens first as the data grows; a trigram index would be the answer if
that pressure point were ever actually reached, not a pre-emptive one.

**Indexes reviewed, none added.** Every access path this query needs already existed before goal 6:
`bookings_created_at (created_at, id)` for the default sort, `bookings_session_status (session_id,
status)` for the session/status filters, `bookings_member (member_id)` for the join to `members`,
`sessions_class_starts_at (class_id, starts_at)` for the class filter and the `session`-column sort,
and `session_co_instructors_user (user_id, session_id)` for the scope predicate's `EXISTS` subquery.
Nothing new was migrated in for this goal.

## What was deliberately not built, and why

- **A frontend.** The brief scores ten server-enforced goals; every hour spent on a UI before the
  server-side rules were all correct and tested would have been an hour not spent proving the thing
  the assignment is actually assessing. It comes after goal 6 lands cleanly.
- **Goals 7–10** (recurring schedule generation, CSV export, the dashboard, membership alerts) — not
  started. Per the brief's own priority order, they come after booking search/filter/sort/pagination
  (goal 6), now done and tested.
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
