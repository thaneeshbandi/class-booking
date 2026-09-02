# Plan

This reflects actual development, reconstructed from `git log` and this session's own record of what
happened, not a retrofit.

## How the work split into sessions

| Session | When | What landed |
|---|---|---|
| 1 | 2026-08-31 – 2026-09-01 | Repo scaffold, `README.md`/`SUBMISSION.md`/`CLAUDE.md` in place as stubs. No code yet. |
| 2 | 2026-09-02, early | Backend scaffold (Express + validated env config); the full schema as migrations 001–010; an idempotent demo seed; a minimal server with a `/health` check; `tests/schema.test.js` verifying the schema live against Postgres. Then, in the same session: authentication/authorization (goal 1), classes and sessions with conflict detection (goals 2–3), co-instructor management (goal 5). |
| 3 (this one) | 2026-09-02, later the same day | Goal 4 — the full booking lifecycle — in the eight phases below, plus the documentation you're reading now. |

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

## What was cut

Nothing was cut from goal 4's own scope — all eight specified phases, including the full required
concurrency-test battery, landed. At the project level, goals 6–10 (booking search/filter/sort
/pagination, recurring schedule generation and CSV export, the dashboard, and membership alerts) and
the entire frontend have not been started, per the brief's own stated priority: finishing fewer goals
solidly over starting every goal partially. They're next, in that order, matching the brief's numbering.
