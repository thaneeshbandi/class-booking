# Plan

This reflects actual development, reconstructed from `git log` and this session's own record of what
happened, not a retrofit.

## How the work split into sessions

| Session | When | What landed |
|---|---|---|
| 1 | 2026-08-31 – 2026-09-01 | Repo scaffold, `README.md`/`SUBMISSION.md`/`CLAUDE.md` in place as stubs. No code yet. |
| 2 | 2026-09-02, early | Backend scaffold (Express + validated env config); the full schema as migrations 001–010; an idempotent demo seed; a minimal server with a `/health` check; `tests/schema.test.js` verifying the schema live against Postgres. Then, in the same session: authentication/authorization (goal 1), classes and sessions with conflict detection (goals 2–3), co-instructor management (goal 5). |
| 3 | 2026-09-02, later the same day | Goal 4 — the full booking lifecycle — in the eight phases described in that session's own account below, plus the documentation describing it. |
| 4 | 2026-09-02, later still | Goal 6 — replaced the minimal, unfiltered `GET /api/bookings` with the full server-side search/filter/sort/pagination/count endpoint, its authorization regression suite, and this documentation update. |
| 5 (this one) | 2026-09-02, later still | Goal 7 — recurring session generation (`POST /api/sessions/recurring`) and attendance CSV export (`GET /api/sessions/:sessionId/attendance.csv`), their test suites, and this documentation update. |

Session 2's five foundation commits share one timestamp to the minute in `git log`, which is a real
gap in this record: they clearly did not all land in the same sixty seconds, and no finer-grained
account of that session survives. Sessions 1 and 2 predate this document's author (this session);
what's recorded above is what the commit history itself shows, not a memory of doing that work.

## Implementation order, and why

The schema came before any route, deliberately: `booking_events`' append-only trigger, the partial
unique active-booking index, and the FIFO waitlist index all had to exist and be proven correct
(`schema.test.js`) before any application code could be trusted to lean on them. Goal 1 (auth) came
next because every later goal's authorization depends on it. Goals 2–3 (classes, sessions) came before
goal 5 (co-instructors) because a co-instructor is an attribute of a session that has to exist first;
goal 4 (bookings) came last among the five built so far specifically because it's the most invariant
-heavy piece in the whole brief, and doing it after sessions/co-instructors meant the locking protocol
and FIFO promotion could be built and tested against a schema and an authorization model that were
already settled, not still moving.

Within goal 4 itself, the brief specified eight phases and this session followed that order exactly,
each with its own commit:

1. **P1 — pure domain rules.** Transition/timing/membership predicates and the `pg` date-type-parser
   fix, all unit-testable with no server and no HTTP layer. Done first so every later phase has a
   settled vocabulary (`BookingError`, `assertCancellable`, `isMembershipExpired`, …) to build on
   rather than inventing it inline as needed.
2. **P2 — transaction primitives.** `lockSessionForBooking`, occupancy counting, the event writer, FIFO
   promotion — exercised directly against Postgres, still with no routes. This is the piece every route
   in P3–P6 calls into, so it had to be correct and tested in isolation first.
3. **P3 — creation.** The first real route, and the first time the full lock protocol ran end to end.
4. **P4 — cancellation + promotion.** Built once creation existed to book seats and fill a waitlist
   against.
5. **P5 — settlement, `GET`, and the booking-authorization helper.** Needed a real booking in a real
   status to settle, hence after creation/cancellation.
6. **P6 — the session `PATCH`/`DELETE` fixes.** Deliberately *after* the booking routes, not before:
   the capacity-increase promotion path reuses the exact `promoteWaitlistFIFO` helper cancellation
   already exercised in P4, so fixing session updates last meant reusing already-proven code rather
   than writing the promotion logic twice.
7. **P7 — dedicated concurrency tests.** After every route existed, so the six required scenarios could
   run over real HTTP against the actual application, not a partial one.
8. **P8 — hardening and documentation.** Last, once there was a finished system to describe honestly.

## Estimated versus actual

No time estimate for goal 4 was written down before starting it, so there's nothing to honestly
compare against phase-by-phase — recording an estimate now would itself be inventing a development
story after the fact, which `CLAUDE.md` explicitly rules out. What is true and worth recording plainly:
the gap between P1's commit timestamp and P8's is about 23 minutes, and the actual wall-clock time
this phase took was substantially longer than that — the commit timestamps mark when each phase's work
was judged complete and tested, not how long producing it took. Three things extended it beyond a
straight run through the eight phases: Docker Desktop's Postgres container became unresponsive
mid-session (an I/O error reading its data files) and needed a full restart before any DB-backed test
could run again; a refactor of the existing `GET /api/bookings` handler briefly dropped its `sessions`
join and broke `authorization.test.js`'s scoping test, caught immediately by that existing suite and
fixed before the phase-3 commit; and two of the phase-6/7 test fixtures initially used fixed
timestamps for sessions that, being permanently undeletable once booked, collided with their *own*
leftover data from a previous run of the same file — caught by deliberately re-running the suite
several times before committing, and fixed by randomizing those fixtures' base offsets per run.

## Session 4 — goal 6

Read in order before writing any code: `README.md`, `CLAUDE.md`, then all four `docs/*.md` files, then
the entire existing backend source and test suite — specifically so the new endpoint would reuse
`scopeSessionsToInstructor` rather than re-deriving instructor ownership, and so its response shape and
validation-error conventions would match the rest of the API rather than inventing a fourth style.
`routes/bookings.js`'s `GET /` was the only route touched; every mutation route (create/cancel/settle)
and every other file's authorization logic was left exactly as goal 4 left it, per `CLAUDE.md`'s "do not
redesign existing booking/session authorization or booking-state logic."

Implementation order: the query architecture (one base query, cloned for count and page; see
`docs/architecture.md`) was designed and written first, since every other piece — the sort whitelist,
the pagination math, the response serializer — hangs off that shape. The existing collection-scoping
test in `tests/authorization.test.js` was updated next, before writing any new tests, because it
asserted the *old*, unpaginated contract (every authorized booking in one response) and would have kept
"passing" for the wrong reason — silently checking only page 1 — if left unpaginated-aware. The new
`tests/bookingSearch.test.js` suite was written and run last, phase by phase matching the brief's own
listed categories: base visibility, the critical OR-condition regression, filter-level IDOR, text
search, filters, sorting (including the deterministic-tiebreaker case), pagination, and total count.

One test came back wrong on the first run and was fixed before landing (see `docs/ai-prompts.md` for the
prompt/output/correction) — a status-filter IDOR test asserted every booking instructor A could see
under `?status=booked` belonged to one specific fixture session, which was true in isolation but false
once other describe blocks in the same file had already created instructor A other sessions (a
co-instructor fixture, the sorting fixtures) earlier in the same run; the assertion was rewritten to
check the thing actually under test — that instructor B's booking never appears — rather than an
assumption about how many of instructor A's own sessions exist.

No time estimate was written down before starting, for the same reason `CLAUDE.md` gives for goal 4:
recording one now would be inventing a development story after the fact. What's true and checkable is
the verification record itself — the full suite (`npm test --test-concurrency=1`) was run twice before
any documentation was touched, `npm run lint` was run and its one failure (an unused variable in the new
test file) fixed, the database was reset and reseeded from migrations 001–010 and the suite run twice
more against the fresh copy, and the running server was smoke-tested over real HTTP — login, the default
listing, a search, an out-of-range `pageSize`, an invalid `status`/`sort`, and an unauthenticated
request — before this file was updated.

## Session 5 — goal 7

Read in order before writing any code: `README.md`, `CLAUDE.md`, all five `docs/*.md` files, then the
entire existing backend source and every migration — specifically so recurring generation would reuse
`findSchedulingConflicts` rather than duplicating conflict SQL, and so the CSV endpoint would reuse
`loadAuthorizedSession` rather than re-deriving the primary-instructor-or-co-instructor check goal 5
already settled.

Implementation order: the pure calendar-date expansion (`domain/recurringSchedule.js`) was written and
unit-tested first, since it has no database dependency and every later piece builds on it. While
writing the local-time-to-instant conversion, `seeds/001_demo_data.js#insertSession` turned out to
already solve exactly this problem via PostgreSQL's `AT TIME ZONE` — reusing that (Decision 9) meant
the module stayed pure calendar-date logic with no timezone algorithm of its own to get subtly wrong.
The `POST /api/sessions/recurring` route came next (reusing `findClass`/`findRoom`/
`findActiveInstructor`/`findSchedulingConflicts`, all already in `routes/sessions.js` from goal 3),
then the read-only CSV route and its five-line serializer (`domain/csv.js`), each with its own test
file matching the brief's own listed test categories.

Two things were caught by tests and fixed before landing (see `docs/ai-prompts.md` for the
prompt/output/correction on each):

1. **A test-fixture date-collision bug**, not an application bug: the CSV test file's near-future
   fixture-session offsets landed inside the demo seed's own near-future scheduling window, and
   separately, its narrow randomized far-future window was still narrow enough relative to its own
   fixed per-describe-block offsets to occasionally collide with a *previous run's own leftover*
   fixture sessions (every session in that file carries a real booking, so none of them are ever
   deleted). Both were fixed by widening and repositioning the random window, following the same
   "wide random range relative to small fixed offsets" reasoning `sessions.test.js`'s own `p6Base`
   already documents.
2. **A real application bug**, caught only by actually reading the smoke-tested CSV output, not by
   any automated test at the time: the "Booked At" column rendered as
   `Wed Sep 02 2026 09:55:21 GMT+0530 (India Standard Time)` — the server process's own local
   timezone — instead of a stable timestamp, because `bookings.created_at` arrives from `pg` as a JS
   `Date` and the CSV serializer stringified it with the implicit, locale/timezone-dependent
   `Date.prototype.toString()` rather than `toISOString()`. Fixed in `routes/sessions.js`, with a
   regression test added asserting every "Booked At" cell matches ISO 8601 UTC.

No time estimate was written down before starting, for the same reason `CLAUDE.md` gives for goals 4
and 6: recording one now would be inventing a development story after the fact. What's true and
checkable is the verification record: the two new test files were run individually first, then the
full suite (`npm test --test-concurrency=1`) twice, then `npm run lint`, then a fresh `db:reset` and
the full suite again against it, then the real server was started and smoke-tested over real HTTP —
recurring generation, a room-conflict skip, the attendance CSV, and instructor authorization denials
for both new endpoints — which is what caught the CSV timestamp bug above; the fix was verified
against the running server and the full suite was run twice more before this file was updated.

## What was cut

Nothing was cut from goal 4's own scope — all eight specified phases, including the full required
concurrency-test battery, landed. Nothing was cut from goal 6's scope either — search, every filter,
the sort whitelist with its deterministic tiebreaker, pagination, and the total count all landed, along
with the full IDOR/security regression battery the brief asked for. Nothing was cut from goal 7's scope
either — recurring generation's full candidate-expansion/conflict/duplicate/DST behavior and the
attendance CSV's full authorization/escaping/status battery both landed, matching every test category
the brief listed. At the project level, goals 8 and 10 (the dashboard and membership alerts) and the
entire frontend have not been started, per the brief's own stated priority: finishing fewer goals
solidly over starting every goal partially. They're next, in that order, matching the brief's
numbering.
