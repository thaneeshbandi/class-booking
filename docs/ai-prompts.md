# AI prompts

Claude Code was used for the entire codebase, including this document. A gap, stated plainly rather
than papered over: goals 1–5 (authentication, classes, sessions, co-instructors, and the database
foundation) were built in an earlier session whose actual prompts were not recorded anywhere this
document can honestly draw from — `git log -- docs/ai-prompts.md` shows this file was never touched
before the session that built goal 4. Inventing that history now would violate the one rule this file
has to follow, so it isn't attempted. What follows is complete and accurate for the two sessions that
built goal 4 and goal 6, each the one this document's respective author actually has a record of.

## Implementing the booking lifecycle (goal 4)

### Prompt

One long, highly specific instruction, given in full at the start of the session. In substance: read
the existing implementation and every migration first; do not redesign the schema unless an actual
contradiction turns up; implement the booking status state machine exactly as specified (`booked`,
`waitlisted`, `cancelled`, `attended`, `no_show`, with an exact table of legal and illegal
transitions and no manual endpoint able to set an arbitrary status); implement the exact timing rules
(`now() < starts_at` to create or cancel, `now() >= starts_at + duration` to settle, all computed in
PostgreSQL, never `Date.now()`); implement the exact membership-expiry rule (`membership_expires_on <
studio_today`, with `studio_today` from `(now() AT TIME ZONE STUDIO_TIMEZONE)::date`); fix the
existing `pg` date-type-parser bug first; implement a specific session-row-lock concurrency protocol
for every booking mutation, with FIFO waitlist promotion sharing one helper between cancellation and
capacity increases; fix the existing session `PATCH`/`DELETE` endpoints to be booking-safe under the
same lock; build the whole thing in eight ordered, independently-tested, independently-committed
phases (domain rules → transaction primitives → creation → cancellation → settlement → the session
-update fix → dedicated concurrency tests → hardening and documentation); and finish with a
phase-by-phase report.

### What was produced

All eight phases, in order, each as its own commit: `bookingErrors.js`/`bookingTransitions.js`
/`bookingTiming.js`/`membership.js` (pure rules) and the `db/pgTypes.js` fix; `bookingTransaction.js`
(the session-lock/occupancy/event-write/FIFO-promotion primitives); the full `POST /api/bookings`,
`POST /:id/cancel`, `POST /:id/settle`, and `GET /:id` routes; the `PATCH`/`DELETE
/api/sessions/:id` rewrite; a dedicated concurrency test file exercising the six required scenarios
over real HTTP with client-side `Promise.all`; and finally `translateBookingPgError` plus an optional
`SET LOCAL lock_timeout` and this set of documentation updates.

### What was correct

The core design — one combined `lockSessionForBooking` query doing the `FOR UPDATE` acquisition and
the `hasStarted`/`hasFinished`/`studioToday` computation in a single round trip, reused identically by
create/cancel/settle — worked exactly as specified on the first pass, and the full required
concurrency battery (two-simultaneous-creates-one-seat, ten-simultaneous-creates-capacity-three,
same-member race, simultaneous cancellations, cancellation-vs-create, capacity-decrease-vs-create)
passed on the first implementation and stayed green across five repeated runs.

### What was wrong, and what was corrected

Two real mistakes, both caught by tests before being committed — not found by the author reading the
code back afterward:

1. **A regression in an existing endpoint.** While extending `routes/bookings.js`, the existing `GET
   /api/bookings` handler's query construction was consolidated into a shared
   `bookingWithMemberQuery()` helper meant for re-fetching a single booking after a mutation commits.
   That helper only joins `members`; the original handler also joined `sessions`, because
   `scopeSessionsToInstructor` (the instructor-visibility filter) is a predicate over `sessions`
   columns. The refactor dropped that join, and `authorization.test.js`'s existing "scopes results to
   exactly what each caller is authorized to see" test for `GET /api/bookings` failed with a 500 (an
   undefined-column SQL error) the first time the full suite ran. Fixed by keeping `GET /`'s own
   three-way join inline and reserving the shared helper for the cases that never need `sessions` —
   recorded in the phase-3 commit (`3a0e80f`) at the time, not reconstructed here after the fact.

2. **A self-colliding test fixture.** The phase-6 tests for capacity/reschedule rules book real
   members into sessions attached to a dedicated class/room, using fixed offsets like `at(700)` from
   the suite's `WINDOW_START`. Those sessions become permanently undeletable the moment they carry a
   booking (by design — `ON DELETE RESTRICT` plus append-only history), and they all use the same
   shared seeded instructor. The first version of these tests passed on a single run, but running the
   file a second time (done deliberately, to check for exactly this kind of hidden dependency on a
   clean slate) failed: the new run's session collided with the *previous* run's own leftover session
   for that instructor at nearly the same real-world instant, via the ordinary scheduling-conflict
   check — a false failure with nothing to do with the rule actually under test. Fixed by randomizing
   the base offset per run for every fixture in that describe block (and the analogous fixed date used
   for the settled-reschedule test, and the delete-race test in the following describe block), then
   confirmed stable across two more full re-runs before committing (`87a4d46`).

## Implementing booking search/filter/sort/pagination (goal 6)

### Prompt

One long, specific instruction given at the start of this session. In substance: read the existing
implementation and every `docs/*.md` file first; replace the current minimal, unfiltered `GET
/api/bookings` with the full goal 6 endpoint — text search over member name/email, filters for class,
session and status, a whitelisted sort with a deterministic tiebreaker, page/pageSize pagination, and a
total count — with every one of those computed in PostgreSQL, never in JavaScript after the rows arrive;
apply the instructor's authorization scope in SQL *before* any filter, reusing the existing
`scopeSessionsToInstructor` predicate rather than re-deriving it, and combine it with every filter using
AND, never OR (the prompt gave the exact wrong-vs-right shape for the text-search clause specifically,
since `query.where(scope).orWhere('members.email', ...)` is the concrete way this kind of endpoint leaks
data); build one base query and `.clone()` it for the count and the page rather than writing two
independent queries; do not add `pg_trgm` or any other Postgres extension — plain `ILIKE '%term%'` is
the expected implementation at this scale; review existing indexes before adding any migration; and
write a specific battery of IDOR/security regression tests, including a named "critical OR-condition"
test asserting that an instructor searching for another instructor's member returns zero results. It
closed by listing what to update in `docs/` and what not to start (goals 7, 8, 10, the frontend).

### What was produced

`routes/bookings.js`'s `GET /` was rewritten to the full contract: a `listBookingsQuerySchema` (Zod)
validating `q`, `classId`, `sessionId`, `status`, `sort`, `direction`, `page`, `pageSize`, each rejected
with 400 and a useful message on anything invalid; one base query — `bookings` joined to `sessions`,
`members`, `classes`, scoped by `scopeSessionsToInstructor` for a non-staff caller, then narrowed by
whichever filters were supplied — cloned once for a `count({count: 'bookings.id'})` and once for the
paginated, sorted `SELECT`; a fixed `BOOKING_SORT_COLUMNS` whitelist mapping `bookedAt`/`status`/
`session` to real column expressions, with `bookings.id ASC` always appended as a tiebreaker; and a new
`serializeBookingListItem` including nested `member`/`class`/`session` objects, since the list is the one
place the brief asks for that context inline. `tests/bookingSearch.test.js` (36 tests) covers base
visibility by role, the critical OR-condition regression, filter-level IDOR (classId/sessionId/status/
combined), text search, filters, sorting including the tiebreaker case, pagination, and total count; the
pre-existing `GET /api/bookings` scoping test in `tests/authorization.test.js` was updated to page
through results with `pageSize=100` rather than assume every authorized booking arrives in one
unpaginated response, since that assumption stopped being true the moment this goal shipped pagination.
No new migration was needed — the existing indexes (`bookings_created_at`, `bookings_session_status`,
`bookings_member`, `session_co_instructors_user`) already cover this query's access paths.

### What was correct

The base-query-plus-`.clone()` shape, the sort whitelist, the deterministic tiebreaker, and the
AND-grouped text-search clause all worked as specified on the first pass — the full new suite passed
on its first complete run except for the one issue below, and stayed green across two full-suite runs,
a fresh `db:reset`/reseed, and two more full-suite runs after that.

### What was wrong, and what was corrected

One test in the new suite made a false assumption about test isolation, caught immediately by running
it (not found by re-reading the code afterward): `status filter never surfaces another instructor's
booking of that status` asserted that *every* booking `?status=booked` returned for instructor A
belonged to one specific fixture session (`fixture.sessionA`). That was true only in isolation — but
by the time this test ran, earlier describe blocks in the same file had already created instructor A
other sessions of their own (a co-instructor fixture, several sorting fixtures), so instructor A
legitimately had `booked` bookings under sessions other than `fixture.sessionA`, and the test failed
with `'3' !== '354'` (a real session id from an earlier test, not a bug in the endpoint). The fix
rewrote the assertion to check the thing actually at risk — that instructor B's booking specifically
never appears in instructor A's `status=booked` results, both narrowed by `sessionId` and unnarrowed
across every session instructor A can see — rather than an incidental assumption about how many
sessions instructor A happens to have in this run. Re-run and passing before being committed.

## Implementing recurring session generation and attendance CSV export (goal 7)

### Prompt

One long, highly specific instruction given at the start of this session, split into parts A–F. In
substance: read `README.md`, `CLAUDE.md`, every `docs/*.md` file, all backend source, all migrations
and all existing tests first; implement `POST /api/sessions/recurring` (staff-only; instructors denied
even with a spoofed role; candidates expanded in application code from a weekly local-time pattern,
each converted to its stored instant only after determining the local calendar date/time, using
`STUDIO_TIMEZONE`, with DST handled correctly — an example given explicitly: a fixed local 09:00 must
stay 09:00 local across a DST transition, never silently drift to 08:00 or 10:00); reuse
`findSchedulingConflicts` rather than duplicating conflict SQL; process candidates sequentially in
chronological order inside one transaction (no `Promise.all` on the shared connection, no savepoints);
report both created sessions and skipped candidates with a small fixed, machine-readable reason set
(`room_conflict`, `instructor_conflict`, `existing_session` for an exact duplicate); reject an
archived class outright; implement `GET /api/sessions/:sessionId/attendance.csv` with the exact same
authorization boundary as `GET /:sessionId/bookings`, reading `bookings.status` directly rather than
replaying `booking_events`, exporting all five final statuses, with correct CSV escaping for commas/
quotes/newlines and no large dependency for "a tiny serializer"; keep the whole thing read-only; write
a comprehensive integration test suite matching an explicit list of required scenarios for both
features; run the full verification sequence (targeted tests, full suite twice, lint, a fresh
`db:reset` and the suite again, a real running-server smoke test); update the same five `docs/` files
plus `SUBMISSION.md`; commit as one incremental commit; and close by explicitly ruling out starting
goals 8 or 10 in this milestone.

### What was produced

`domain/recurringSchedule.js` (pure calendar-date expansion, no timezone conversion of its own —
see "What was correct" below) and `domain/csv.js` (a five-line RFC-4180-shaped escaper); two new
routes in `routes/sessions.js` — `POST /recurring` and `GET /:sessionId/attendance.csv` — each with
its own extensive comment explaining the authorization/conflict/concurrency reasoning; three new test
files (`recurringSchedule.test.js`, a pure-unit suite; `recurringSessions.test.js` and
`attendanceCsv.test.js`, both full HTTP integration suites) covering every scenario the prompt listed,
including a DST-crossing test that independently cross-checks the database-produced instant against
`Intl`-formatted local time rather than trusting the implementation to grade its own homework; and
this round of documentation updates.

### What was correct

Reusing `seeds/001_demo_data.js`'s existing `(local_string::timestamp AT TIME ZONE ?)` pattern for
the local-to-instant conversion, discovered while reading the seed file as instructed rather than
immediately reaching for a hand-rolled `Intl`-based algorithm, worked exactly as needed on the first
pass — the DST integration test (a year-long weekly recurrence in `Europe/London`, independently
verified against `Intl`) passed first try, and this decision is recorded as Decision 9 in
`docs/decisions.md`. The conflict-check/duplicate-check/insert loop, reusing `findSchedulingConflicts`
unchanged, also worked correctly on the first pass across every conflict/duplicate/boundary test.

### What was wrong, and what was corrected

Two issues, both caught by tests or smoke-testing before being committed — not found by re-reading the
code afterward:

1. **A test-fixture date-collision bug (not an application bug).** The first version of
   `attendanceCsv.test.js` scheduled its fixture sessions at small fixed hour offsets
   (`Date.now() + 24h/48h/96h/...`) from "now". The full suite's first run failed a co-instructor-add
   call with an unexpected 409 instructor conflict — because those offsets (1–5 days out) landed
   inside `seeds/001_demo_data.js`'s own near-future demo-session window (roughly -21..+16 days),
   colliding with seeded data. The fix moved to a far-future randomized window, matching
   `sessions.test.js`/`coInstructors.test.js`'s existing convention. That first fix still wasn't wide
   enough: because every session in this file carries a real booking and is therefore never deleted,
   a second full-suite run failed the same way again, this time against the *previous run's own*
   leftover fixture — the random window (120 days) was still narrow relative to the fixed offsets used
   *within* one run (24h/48h/72h/96h/120h apart), which resonate against each other far more than a
   single-point collision analysis suggests. Fixed by widening the random window by roughly two orders
   of magnitude (mirroring `sessions.test.js`'s own `p6Base` ratio of range to offset spread) and
   confirmed stable across three consecutive runs before being folded into the full-suite verification.
2. **A real application bug, caught by smoke-testing, not by the automated suite at the time it was
   found.** Manually exporting a CSV from the real running server showed a "Booked At" cell reading
   `Wed Sep 02 2026 09:55:21 GMT+0530 (India Standard Time)` — the smoke-testing machine's own local
   timezone — instead of a stable timestamp. `bookings.created_at` arrives from `pg` as a JS `Date`
   object; `domain/csv.js`'s `escapeCsvField` calls `String(value)` on whatever it's given, and
   `String(date)` uses `Date.prototype.toString()`, which renders in the *process's* local timezone —
   not a studio-meaningful one, and not stable across deployments. Fixed in `routes/sessions.js` by
   calling `.toISOString()` before handing the value to the CSV serializer, matching every other
   timestamp this API already returns; a regression test asserting every "Booked At" cell matches ISO
   8601 UTC was added to `attendanceCsv.test.js`, and the fix was re-verified against the real running
   server before being folded into the full-suite verification.
