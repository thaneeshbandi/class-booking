# Architecture

This describes the system as it actually stands after goals 1–8: accounts and roles, classes,
sessions, the booking lifecycle, co-instructors, server-side booking search/filter/sort/pagination,
recurring session generation with attendance CSV export, and the staff-only dashboard. Goal 10
(membership alerts) and the frontend are not built yet — see "What was deliberately not built" below.

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

## Goal 7 — recurring session generation and attendance CSV export

Two new routes in `routes/sessions.js`, both reusing existing machinery rather than inventing new
mechanisms: `POST /api/sessions/recurring` (staff-only bulk generation) and
`GET /api/sessions/:sessionId/attendance.csv` (read-only export).

**Recurring generation splits into two deliberately separate steps.** Expanding a weekly local-time
pattern into concrete calendar dates is pure, timezone-*unaware* JavaScript
(`domain/recurringSchedule.js#expandCandidateDates`) — it only walks whole calendar days and filters
by weekday (0=Sunday..6=Saturday, matching `Date.prototype.getDay()`), because a bare calendar date
has no timezone ambiguity to begin with. Converting a candidate's local wall-clock time into the
`timestamptz` instant that actually gets stored is a *separate* step, delegated entirely to
PostgreSQL: `(local_string::timestamp AT TIME ZONE ?)`. This is not a new mechanism — it is exactly
what `seeds/001_demo_data.js#insertSession` already does for the same problem — so DST correctness
for this feature rests on the one implementation already trusted for it (Postgres's own IANA
tzdata), not a second, hand-rolled JavaScript timezone algorithm that could quietly disagree with
it. See `docs/decisions.md` for why this was chosen over a JS-side `Intl`-based conversion.

**Candidates are processed sequentially, in chronological order, inside one transaction** — no
`Promise.all` against the shared transaction connection, no savepoints, matching every other
multi-step booking/session mutation in this codebase. For each candidate: resolve its instant, check
for an *exact* duplicate (same class, primary instructor, room, and instant — skipped as
`existing_session`, checked first so a repeated identical request does not blindly create
duplicates), then reuse `findSchedulingConflicts` — the identical function `POST /api/sessions` and
`PATCH /api/sessions/:id` already use — for `room_conflict`/`instructor_conflict`. A skip never
fails the whole request; only a genuinely unexpected database error propagates out of the
transaction and rolls back everything generated so far in that request. Because inserts happen
inside the same open transaction that later candidates are checked against, a later candidate's
conflict check already sees every session this same request inserted before it — no special
same-batch bookkeeping is needed beyond running sequentially.

**Concurrency is the same accepted window goal 3 already has, not a new one.** `POST /api/sessions`
itself never locks anything for its own room/instructor conflict check — it is a plain
check-then-insert inside a transaction — so two concurrent requests targeting an overlapping slot
could in principle both pass their own check and both insert. Recurring generation reuses that exact
check via `findSchedulingConflicts` and inherits the same limitation; no advisory lock was added, per
`docs/decisions.md`.

**Attendance CSV is read-only and reuses the exact authorization boundary of
`GET /:sessionId/bookings`** — `loadAuthorizedSession`, the same database-re-read
primary-instructor-or-co-instructor check used everywhere else in this file. It reads
`bookings.status` directly rather than replaying `booking_events`: the append-only history exists
for auditability, not as a second source of current status, and all five final statuses (`booked`,
`waitlisted`, `cancelled`, `attended`, `no_show`) are exported, not only settled ones. CSV escaping
is a five-line hand-written function (`domain/csv.js`) rather than a dependency, per the brief's own
guidance not to add a library for a serializer this small.

## Goal 8 — the dashboard

`GET /api/dashboard`, staff-only, one route (`routes/dashboard.js`) backed by seven independent
aggregate queries (`domain/dashboard.js`), run concurrently with `Promise.all` against the connection
pool and composed into one stable, named-field JSON response. Nothing here fetches a booking or
session row into JavaScript to count or group it — every count, group-by, and the eight-week series
is computed inside PostgreSQL.

**Staff-only, not instructor-scoped.** Every metric this endpoint reports — sessions today, bookings
made today, no-shows this week, members waitlisted, the status/class breakdowns, the attendance chart
— is a studio-wide aggregate with no session/class/room predicate in it anywhere. The brief describes
an instructor's own view as "every session where they are the primary instructor or a co-instructor"
(goal 5), a fundamentally different and narrower shape than "sessions today across every room"; it
never asks for an instructor-facing dashboard at all. Exposing any of this to instructors would be
inventing a capability the brief doesn't require, and would leak studio-wide operational data the same
way an unscoped `GET /api/members` would — so this endpoint is `requireRole('staff')`, full stop, the
same deny-by-default posture as the members list. See `docs/decisions.md`.

**Two metrics are keyed by different columns on purpose, and neither was changed once decided.**
"Bookings made today" is keyed by `bookings.created_at` — the index comment on `bookings_created_at`
(`008_bookings.js`) already named this as the goal-8 use case for that index, back when the table was
first migrated. "No-shows this week" is keyed by `sessions.starts_at`, not by when the booking was
created or settled: a no-show is an attribute of the session that happened, and settling a booking
`no_show` today for a session that ran three weeks ago must not make it appear in *this* week's count.
`tests/dashboard.test.js` pins this distinction directly — a booking created ten weeks before its
session, settled `no_show`, still counts in the week its session actually fell in.

**Every time-window predicate is a sargable range against the raw column, not an expression wrapped
around it.** The tempting first draft — `(sessions.starts_at AT TIME ZONE tz)::date = today` — wraps
the indexed column itself in an expression, which a plain B-tree index on `starts_at` can't be used
for. The actual queries instead compute the window boundary once as a real instant —
`date_trunc('day', now() AT TIME ZONE tz) AT TIME ZONE tz` — and compare the untouched column against
it with `>=`/`<`, exactly the same "local civil boundary, as a real instant" idiom recurring-session
generation and `lockSessionForBooking`'s `studioToday` boolean already use, just built from
`date_trunc` instead of a literal local-time string. `now()`/`date_trunc`/`AT TIME ZONE` are STABLE or
IMMUTABLE, so Postgres evaluates the boundary once per query, not once per row.

**"This week" is the ISO 8601 week** — `date_trunc('week', ...)`'s own definition, Monday 00:00
through the following Monday 00:00, studio-local — because Postgres already has one unambiguous,
built-in definition of a week and reaching for it is simpler than inventing a second one.

**The eight-week attendance chart always returns exactly eight weeks, oldest first, ending with the
current (possibly still in-progress) week — including weeks with zero attended bookings.**
`generate_series` produces the eight week-start rows regardless of what data exists, and two
`LEFT JOIN`s (session, then attended bookings for that session) are what turns an empty week into
`count: 0` rather than a missing row. "Attendance" is counted as `status = 'attended'` specifically —
the exact enum value the brief's own goal-4 settlement vocabulary already uses — not total bookings or
occupancy, which would answer a different question than "how many people showed up."

**Bookings-by-status always returns all five statuses; bookings-by-class only returns classes that
have at least one booking.** The status set is small and fixed (`BOOKING_STATUSES`, reused from
`routes/bookings.js` rather than re-declared), so every key is always present with `0` rather than
being silently absent. The class list is neither small nor fixed, so a class that has never been
booked — including one just created, or an archived one nobody ever scheduled a session for — simply
doesn't appear, the same way an empty bar wouldn't be drawn on a real chart; `tests/dashboard.test.js`
checks both directions explicitly.

**Testing a studio-wide aggregate endpoint needed a different strategy than every other suite in this
project.** Every other test file scopes its assertions to a session/class/booking id it just created,
so leftover permanent fixtures from earlier runs (unavoidable once a fixture carries a real booking —
see `bookings.test.js`) never affect what's being asserted. A dashboard metric has no id to scope
to — it counts *everything* — so `tests/dashboard.test.js` asserts deltas (dashboard before, insert one
precisely-controlled fixture row, dashboard after, assert the metric moved by exactly the expected
amount) instead of absolute values, which stays correct regardless of how much of today's or this
week's data every other suite has already left behind, and regardless of how many times the file
itself is re-run.

## What was deliberately not built, and why

- **A frontend.** The brief scores ten server-enforced goals; every hour spent on a UI before the
  server-side rules were all correct and tested would have been an hour not spent proving the thing
  the assignment is actually assessing. It comes after the server-side goals land cleanly.
- **Goal 10** (membership alerts) — not started. Per the brief's own priority order, it comes after
  the dashboard (goal 8), now done and tested.
- **An instructor-facing dashboard.** See the goal 8 section above — nothing in the brief asks for
  one, and every metric this endpoint reports is studio-wide, not scoped to what one instructor
  teaches.
- **A single mega-query (CTEs stitching all seven metrics together) instead of seven small ones.**
  Considered and rejected: a single query touching `sessions`, `bookings`, `classes`, and a
  `generate_series` all at once would be one round trip instead of seven, but at this endpoint's
  actual scale (a handful of small, well-indexed tables, one dashboard load, not a hot path) the
  round-trip cost is not the bottleneck that would justify trading away seven individually readable,
  individually testable queries for one that's harder to reason about — matching this project's
  standing preference for simple, explainable architecture over unnecessary complexity.
- **A new index for the dashboard's time-window queries.** `sessions_starts_at` and
  `bookings_created_at` already exist and already serve these range predicates directly (see above);
  nothing new was migrated in for this goal.
- **A persistent recurrence-definition table for goal 7.** The brief asks for *generating* concrete
  sessions from a pattern, not for storing the pattern itself to re-run later; `POST
  /api/sessions/recurring`'s request body is the pattern, used once and discarded. Nothing downstream
  (no "re-generate this recurrence" feature) needs it remembered.
- **An advisory lock or exclusion constraint for recurring generation.** See the goal 7 section
  above and `docs/decisions.md` — the same accepted concurrency window `POST /api/sessions` already
  has, not a gap specific to bulk generation.
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
