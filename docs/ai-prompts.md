# AI prompts

Claude Code was used for the entire codebase, including this document. A gap, stated plainly rather
than papered over: goals 1–5 (authentication, classes, sessions, co-instructors, and the database
foundation) were built in an earlier session whose actual prompts were not recorded anywhere this
document can honestly draw from — `git log -- docs/ai-prompts.md` shows this file was never touched
before the session that built goal 4. Inventing that history now would violate the one rule this file
has to follow, so it isn't attempted. What follows is complete and accurate for the eight sessions that
built goals 4, 6, 7, 8, and 10, the final pre-frontend audit, the frontend itself, and its Playwright
E2E verification, each the one this document's respective author actually has a record of.

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

## Implementing the dashboard (goal 8)

### Prompt

One long, specific instruction given at the start of this session. In substance: read `README.md`,
`CLAUDE.md`, every `docs/*.md` file, `SUBMISSION.md`, the entire backend implementation and test suite,
and the git history first; implement `GET /api/dashboard` computing every metric server-side in SQL,
never by downloading rows and aggregating in JavaScript; map each metric to its source table, time
basis, authorization rule, SQL aggregation, and edge cases before writing code; preserve two named
semantics exactly — "bookings made today" keyed by `bookings.created_at`, "no-shows this week" keyed by
`sessions.starts_at` — as already-established project decisions, not to be silently changed; determine
and document whether the dashboard is staff-only, instructor-scoped, or role-varying, using the
existing authorization helpers rather than a parallel mechanism; keep all time math in
`STUDIO_TIMEZONE`, explicit about inclusive/exclusive boundaries, and test them; use a small number of
efficient aggregate queries with no N+1 queries, no new ORM abstraction, no Postgres extension, no
materialized view, no cached counter, no background job, no cron; explicitly inspect whether the
existing test-cleanup strategy (permanent booking-carrying fixtures) makes dashboard tests sensitive to
leftover data, and avoid flaky small relative-date windows; write focused integration tests covering
ten listed categories including exact time boundaries and empty/zero-value correctness; fix any real
application bug a test or smoke test surfaces, with a regression test, before proceeding; run the full
verification sequence (targeted tests, full suite twice, lint, a fresh `db:reset` and the suite again,
a real running-server smoke test); update the same five `docs/`-plus-`SUBMISSION.md` files only after
verification succeeded; commit as one incremental commit; and close by requiring explicit confirmation
that goals 9/10 and the frontend were not started.

### What was produced

`domain/dashboard.js` (seven independent aggregate query functions — four scalar headline counts, a
fixed-key status breakdown, a class breakdown, and a `generate_series`-based eight-week attendance
series) and `routes/dashboard.js` (one staff-only route composing them with `Promise.all`);
`BOOKING_STATUSES` exported from `routes/bookings.js` instead of re-declared, so the dashboard's status
breakdown and the booking search endpoint's status filter can never quietly define the status set
differently; `tests/dashboard.test.js` (26 tests, delta-based throughout — see "What was correct"
below); and this round of documentation, including five new genuine decisions in `docs/decisions.md`
(staff-only scope, the no-shows-this-week time basis, distinct-member waitlist counting, sargable range
predicates over wrapped-expression equality, and the status/class breakdown asymmetry).

### What was correct

Reading the migrations before writing any query paid off directly: `008_bookings.js`'s
`bookings_created_at` index comment and `006_sessions.js`'s `sessions_starts_at` index comment both
already named their goal-8 use case ("bookings made today", "Dashboard day/week windows") at the time
those tables were first migrated, confirming the semantics given in the prompt rather than requiring a
fresh guess. The seven SQL queries themselves — including the `generate_series`/double-`LEFT JOIN`
eight-week bucketing and the four-times-repeated `date_trunc(...) AT TIME ZONE tz` boundary idiom —
were smoke-tested directly against the real seeded database with a throwaway script before any route or
test was written, and worked correctly on the first pass; every one of the 26 new tests in
`tests/dashboard.test.js` passed on its first complete run.

### What was wrong, and what was corrected

One issue, a pre-existing bug in the test suite rather than in the dashboard feature itself, caught by
the second full-suite run (not by any dashboard test): `sessions.test.js`'s "rejects deleting a session
that has bookings" test (the "Undeletable Session Fixture") schedules its permanently-undeletable
session at a fixed offset (`at(602)`) from a `WINDOW_START` that is *not* randomized
(`Date.now() + 60 days`, recomputed fresh but barely shifting between runs made minutes apart). Because
that session is never deleted by design, every `npm test` run across this project's several milestones
today left one more leftover instance behind at nearly the same instant, all using the same shared
seeded instructor; by this session's several verification runs, enough had accumulated within about
two hours of a *different*, unrelated, conflict-checked test (`at(600)`, "lets staff delete a session
with no bookings") that the two started colliding via an ordinary instructor-scheduling conflict — a
409 the second test was never expecting, unrelated to anything it was actually testing. Root-caused by
reading the file's own `p6Base` section, which documents exactly this failure mode and already fixes it
the same way for its own fixtures — the "Undeletable Session Fixture" test predates that fix and was
never brought in line with it. Corrected by giving it the same wide-randomized-offset treatment
(`602 + Math.floor(Math.random() * 20_000)` hours), then a fresh `db:reset` to clear the leftover
instances that had already accumulated, and three consecutive clean full-suite runs before continuing —
one more than the required two, given this exact class of bug had just been found.

## Implementing membership expiry alerts (goal 10)

### Prompt

One long, specific instruction given at the start of this session. In substance: read `README.md`,
`CLAUDE.md`, every `docs/*.md` file, `SUBMISSION.md`, the entire backend source, migrations, seed, and
tests, and `git log`/`git status` first; explicitly verify and understand the existing
`member_alert_dismissals` table before writing anything, and preserve that design rather than replacing
it with a mutable boolean; derive the exact alert behavior from the assignment and the existing approved
design rather than inventing requirements; use explicit staff-only endpoints for listing alerts and
dismissing one — `GET /api/members/alerts/expiring` and
`POST /api/members/:memberId/alerts/membership-expiry/dismiss`, following existing route conventions;
implement the canonical predicate exactly (`expiry <= studio_today + 7` and no dismissal row matching
the member's *current* expiry date), with expiry-today valid, expired-remains-alerting, and a dismissal
suppressing only that exact expiry date; use the project's existing studio-timezone semantics, never
`CURRENT_DATE` unassessed; keep the alert query server-side, one straightforward SQL query, no N+1, no
cron, no background worker, no cached boolean, no new dependency, no Postgres extension; implement
dismissal transactionally — re-read the member, verify it's actually in-window at the moment of
dismissal, insert against the *current* expiry date, make the insert idempotent via `ON CONFLICT` rather
than a race-prone read-then-insert; write a focused test suite covering twenty listed edge cases
including exact window boundaries, idempotency, the reappear/re-suppress lifecycle across an expiry
change, IDOR, and deterministic empty results, using controlled fixture dates and delta-based
assertions rather than absolute counts given this project's existing permanent test fixtures; run the
full verification sequence (targeted tests, full suite twice, lint, a fresh `db:reset` and the suite
again, six specific real-running-server smoke-test scenarios); fix any real bug found with a regression
test before committing; update the same five `docs/`-plus-`SUBMISSION.md` files only after verification;
commit as one incremental commit; and close by requiring explicit confirmation that the frontend and
stretch goals were not started.

### What was produced

Two additions to `domain/membership.js` (`isWithinAlertWindow`, `daysUntilExpiry`) alongside the
pre-existing `isMembershipExpired`; a new `domain/membershipAlerts.js` (`listExpiringMemberAlerts`,
`getAlertWindowBounds`) implementing the canonical query unchanged from
`010_member_alert_dismissals.js`'s own documented predicate; two new routes in `routes/members.js`; and
`tests/membershipAlerts.test.js` (22 tests). Three new genuine decisions in `docs/decisions.md`:
preserving the existing table design rather than reconsidering it, rejecting a dismissal request outside
the current alert window instead of silently no-op'ing it, and `ON CONFLICT DO NOTHING` idempotency over
a read-then-insert check.

### What was correct

Reading `010_member_alert_dismissals.js` before designing anything paid off directly and completely —
its own comment already contained the exact canonical SQL query this goal needed, written when the
table was first migrated, and `domain/membershipAlerts.js#listExpiringMemberAlerts` implements it
essentially verbatim. The seed also turned out to already contain a full set of goal-10 fixtures (members
at every relevant offset, one already dismissed), created in anticipation of this goal during the
schema-foundation session — confirmed directly with a throwaway smoke script against the real seeded
database before either route existed, and used as real smoke-test material afterward rather than
invented fresh. Every one of the 22 new tests passed on its first complete run, and the real-server
smoke test surfaced no bug.

### What was wrong, and what was corrected

Nothing was wrong this session in the sense of a failing test or an incorrect implementation caught and
fixed — everything passed on the first attempt at every stage (targeted tests, both full-suite runs, the
fresh-DB run, the real-server smoke test). The one thing genuinely worth recording here, in the same
spirit as `docs/plan.md`'s account of this session: the *test design*, not the implementation, needed a
correction in reasoning before any test was written, not after. The first instinct — informed directly
by having just hit exactly this problem building the goal-8 dashboard the session before — was to assume
this endpoint would need the same delta-based (before/after snapshot) testing strategy the dashboard
required, since a throwaway smoke script confirmed the alert list is just as studio-wide and just as
polluted by other suites' permanent leftover fixtures (several members created by `bookings.test.js` to
exercise the "expired membership can't book" rule already sit inside the seven-day window on a fresh
look at the seeded database). Unlike the dashboard's pure counts, though, every alert row carries a
stable member id — so the simpler, more direct fix was presence/absence checks scoped to one specific
freshly-created member id, not delta arithmetic. Caught before writing any tests by re-reading the
dashboard's own test file for the pattern rather than reusing it blind, so nothing here needed a second
pass.

## Final pre-frontend audit

### Prompt

One long, specific instruction given at the start of this session, explicitly framed as an audit, not
a feature milestone. In substance: before building any frontend code, read `README.md`, `CLAUDE.md`,
every `docs/*.md` file, `SUBMISSION.md`, all backend source, migrations, seed, and tests, and inspect
`git status`/`git log --oneline --decorate --graph`/the complete diff from the initial commit to HEAD;
confirm the ten mandatory goals actually exist in code and that `SUBMISSION.md` matches reality;
inspect every documentation file specifically for duplicated paragraphs/table rows, stale "not
implemented" statements, contradictions between documents, incorrect goal numbering, stale API
descriptions, incorrect commit references, fabricated history, and broken Markdown — without rewriting
prose merely for style; build a concise goal-by-goal checklist (route, implementation file, DB
structures, tests) without modifying code just to make it look better; audit every route for
authentication, server-side role enforcement, resource-level authorization, IDOR resistance,
collection-level scoping, client-role-spoof rejection, and deactivated-user behavior, reporting any
real vulnerability but not fixing hypothetical ones; confirm the booking state machine and its
invariants without redesigning them; confirm every civil-day/week feature consistently uses
`STUDIO_TIMEZONE` and never `CURRENT_DATE`/server-local time; audit for N+1 queries, client-side
aggregation, incorrect joins, missing authorization predicates, unnecessary extensions/indexes, and
stale/unused indexes, without prematurely optimizing; run the full verification sequence (targeted
tests, full suite twice, lint, a fresh `db:reset`, the suite again, real-server smoke tests covering the
major mandatory features); only fix a failing test if it's a genuine defect or a genuine determinism
problem, never just to make a failure disappear; correct documentation only after the audit itself was
complete, without fabricating additional decisions or events; and close with an explicit prohibition on
building the frontend, adding features, adding stretch goals, redesigning the backend, or refactoring
working code merely for style, plus one small documentation-only commit if — and only if — corrections
were actually required.

### What was produced

Three genuine documentation-staleness fixes: `docs/schema.md`'s `member_alert_dismissals` heading
("goal 10, not yet consumed by an endpoint" → now describes the two endpoints that consume it);
`docs/ai-prompts.md`'s own intro paragraph (claimed to cover two sessions when it already covered five,
now six); and `backend/src/app.js`'s top comment (claimed goal 10 was unimplemented, never updated
because that milestone needed no change to `app.js`). A programmatic sweep for duplicate headers,
markdown table column-count consistency, and every commit hash cited in `docs/*.md` against
`git cat-file` found nothing else wrong. A security/timezone/state-machine/SQL review (detailed in
`docs/plan.md`'s account of this session) found no vulnerability, no timezone bug, no state-machine
drift, and no accidental N+1 — every route's authorization chain was extracted and checked directly
against its handler, not against what a comment claimed. One real backend gap was found: goal 1's
"add members and set their membership expiry" had never been built as an API — no `POST`/`PATCH
/api/members*`, ever, in any commit. Asked directly whether to fix it or only document it, given this
audit's own explicit "no new features" restriction made the answer genuinely ambiguous rather than
obvious (see `docs/decisions.md`, Decision 21) — the answer was to fix it. `POST /api/members` and
`PATCH /api/members/:id` were added (staff-only, following `routes/classes.js`'s existing
create/update-schema shape exactly), along with `tests/members.test.js` (19 tests).

### What was correct

The documentation-scanning methodology — grep/programmatic checks rather than re-reading prose from
memory — caught real issues a memory-based pass could easily have missed (the `app.js` comment
specifically, since it lives in source code, not a `docs/*.md` file, and nothing prompted re-reading it
during the goal-10 session since that session never had a reason to open it). The security/state
-machine audit's evidence-based approach (checking `git diff` against the actual booking-domain files
rather than trusting `docs/decisions.md`'s own claim that they were untouched) confirmed the claim was
true rather than merely repeating it. `tests/members.test.js` passed in full on its first run, and the
full verification sequence — run twice before this fix and again in full afterward — stayed clean
throughout.

### What was wrong, and what was corrected

The one real finding — the missing member create/edit endpoints — is documented above and in
`docs/plan.md`/`docs/decisions.md` rather than repeated a third time here. No test failure, application
bug, or incorrect implementation was produced and then fixed during this session; the "wrong" thing
this session surfaced was a pre-existing gap in the codebase, not an error made during the session
itself, which is why it's recorded under "what was produced" rather than as a caught-and-corrected
mistake in the usual sense this section otherwise documents.

## Implementing the frontend

### Prompt

One long, specific instruction given at the start of this session. In substance: implement the
frontend only, as a client of the existing backend — do not change backend business rules unless a
genuine frontend integration incompatibility is discovered, do not redesign the schema, do not
duplicate server-side business rules client-side, do not trust frontend role checks as authorization,
do not create mock APIs for functionality that already exists; use React, Vite, and JavaScript (no
TypeScript, no Next.js, no large UI component library absent a stated reason); read every backend
route and validation schema first and build an exact API contract rather than guessing; use one
centralized API client for cookie/JSON/error handling, never store the auth JWT client-side; build
pages for every required staff/instructor workflow (dashboard, members, alerts, classes, sessions,
recurring generation, bookings, booking search, CSV download) rendering exactly what the backend
returns, never recomputing a metric or a status client-side; role-based navigation is a UX convenience
only, never authorization; keep data refresh simple (mutate, then refetch — no React Query unless
already present); audit the frontend for the usual client-side security mistakes (localStorage tokens,
`dangerouslySetInnerHTML`, embedded secrets); after frontend work, re-run the complete backend test
suite to prove nothing server-side regressed; exercise the real running application end to end rather
than stopping at "the frontend builds"; update documentation only where the actual project state
changed; and close by requiring an explicit confirmation that no stretch goals were implemented.

### What was produced

A React 18 + Vite + plain-JavaScript single-page app (`frontend/`) covering every required workflow:
an API client layer (one file per backend resource, all built on a shared `api/client.js` for
credentials/JSON/error handling), `AuthContext` for session state, role-aware routing/navigation
(`RouteGuards.jsx`, `AppShell.jsx`, both explicit that they are UX-only), small reusable UI primitives,
and one page per workflow — `DashboardPage`, `MembersPage`, `AlertsPage`, `ClassesPage`,
`SessionsPage`/`SessionDetailPage`/`RecurringSessionsPage`, `BookingsPage`/`BookingDetailPage`. Two
small backend additions the frontend genuinely could not function without: `GET /api/rooms` and
`GET /api/users?role=instructor` (Decision 22), and a hand-rolled CORS middleware (Decision 23) since
the frontend dev server and backend are different origins. Five separate commits, oldest to newest:
the backend CORS/rooms/users addition, the frontend shell, dashboard/members/alerts/classes,
sessions/recurring, and bookings-plus-router-wiring — grouped by logical concern rather than by strict
chronological increment, since (disclosed plainly, not left implicit) this session wrote the frontend
in one continuous pass rather than literally page-by-page, and splitting it into commits that looked
falsely incremental would have misrepresented how the work actually happened.

### What was correct

Reading every backend route and its Zod validation schema before writing the matching frontend code
paid off directly: every API call in every page matched the backend's actual field names and response
shapes on the first attempt, confirmed afterward by simulating the exact browser request shape with
`curl` (cookies, an `Origin` header, identical JSON bodies) end to end — login, dashboard, members,
rooms/users, session create, session detail, booking create, settle, cancel, attendance CSV, and
instructor-restricted-access checks all matched what the frontend code expects on the first complete
run. `npm run lint` and `npm run build` were both clean on the frontend the first time they were run
against the full page set, and the backend's full test suite stayed clean (twice, then again after a
fresh `db:reset`) throughout.

### What was wrong, and what was corrected

Two real issues, detailed in full in `docs/plan.md`'s own account of this session rather than repeated
here — a genuine backend bug and a smaller frontend-only one:

1. **A real CORS bug `curl` could not have caught.** The attendance CSV download reads the
   `Content-Disposition` response header client-side to name the downloaded file; `Content-Disposition`
   is not one of the response headers a browser exposes to cross-origin JavaScript by default, and
   `curl` never enforces that restriction, so every `curl`-based check of this endpoint looked correct
   throughout implementation. Caught by explicitly reasoning through what a real browser's `fetch`
   would and would not expose across origins — the one place in this session honesty about a tooling
   limitation (no interactive browser available) directly produced a better outcome than trusting a
   tool that couldn't see the problem. Fixed by adding `Access-Control-Expose-Headers:
   Content-Disposition` to the CORS middleware, with a dedicated regression test
   (`tests/cors.test.js`) added specifically so this exact bug can never silently return.
2. **A frontend-only inconsistency**, caught by re-checking the session-edit form's request body
   against `sessionUpdateSchema` directly rather than assuming the create and edit forms could safely
   share one shape: the edit form sent a `classId` field the update schema has no field for at all (a
   session's class cannot change after creation), which Zod's default "strip unknown keys" behavior
   turned into a silently-ignored no-op rather than a validation error — so the class dropdown looked
   editable during an edit while never actually doing anything. Fixed by disabling and labeling that
   field during edit, and by not sending it in the edit request body.

## Automated browser E2E verification with Playwright

### Prompt

One long, highly specific instruction given at the start of this session, explicit that the previous
session's browser-tool attempt had failed (no Claude-in-Chrome/browser automation was available then)
and that this session had real Playwright available and must use it. In substance: do not replace
browser testing with `curl`; do not claim browser testing succeeded unless Playwright actually launches
a browser and performs the UI interactions; do not add product features, this is verification only;
install Playwright with Chromium under `frontend/e2e/`, with a config targeting the real running
frontend, and make the tests deterministic; start the real backend and frontend, no mocked responses;
drive a full staff browser flow (login through dashboard, member CRUD, alerts appear/dismiss, class
CRUD/archive/restore, session CRUD, co-instructor add/remove, recurring generation with both created and
skipped results rendered, booking search/filter/sort/pagination/create/cancel, booking detail/history,
attendance CSV download and content verification); drive an instructor flow proving both what the UI
hides and what the backend actually rejects, including direct navigation to a staff-only URL; test
unauthenticated-redirect/login/logout/no-client-side-token; capture console errors, page errors, and
unexpected 4xx/5xx, failing the test on anything unexpected rather than merely printing it; verify the
CSV download specifically through the real browser, not `curl`, since a previous real bug lived
specifically in a browser-exposed CORS header; take basic responsive screenshots at a desktop and a
narrower viewport, not pixel-perfect; run the suite at least twice, and if flaky, fix the real cause
rather than adding sleeps; prefer role/label/text locators over brittle CSS selectors; after Playwright
succeeds, run frontend lint, frontend build, the Playwright suite twice, the backend full suite, a fresh
`db:reset`, and the backend full suite again; update `docs/plan.md`, `docs/ai-prompts.md`, and
`SUBMISSION.md` honestly — record that Playwright was used, not Claude-in-Chrome; and close with a
detailed list of what the final report must contain, including an explicit statement that testing was
performed in a real browser, not simulated with `curl`.

### What was produced

`frontend/playwright.config.js`; `frontend/e2e/fixtures.js` (shared login/logout/diagnostic helpers,
plus `uniqueLabel`/`randomFutureDayOffset` for run-to-run determinism); `auth.spec.js` (4 tests),
`staff-flow.spec.js` (a 12-test `describe.serial` journey covering the full 36-step staff flow),
`instructor-flow.spec.js` (an 8-test `describe.serial` authorization-boundary suite), and
`responsive.spec.js` (6 tests at two viewports) — 32 Playwright tests in total, all passing, run twice
consecutively and clean both times. One small, genuinely warranted accessibility addition to
`components/Modal.jsx` (`role="dialog"`, `aria-modal`, `aria-labelledby`) made modal-internal locators
unambiguous from same-text page-level buttons — a markup fix to an existing component, not a new
product feature.

### What was correct

The `attachDiagnostics()`/`assertClean()` pattern — fail on any unexpected console error, page error, or
4xx/5xx, while precisely allowlisting only the responses a test deliberately triggers (an intentional
403 authorization check, the expected 401 from checking auth while unauthenticated) — worked exactly as
designed and caught every real defect described below directly, with no need for after-the-fact code
review to find any of them.

### What was wrong, and what was corrected

Several things were wrong on the first (and second, and third) attempt, caught only by actually running
a real browser against the real application repeatedly — full detail, including the two genuine
application bugs this uncovered (a broken pagination "Next" button, a responsive layout that let a wide
table drag the whole page into horizontal scroll), is in `docs/plan.md`'s account of this session and
`docs/decisions.md`'s Decision 25, not repeated in full here. The single most instructive one for this
document's specific purpose — a Claude-produced result that was concretely wrong, then corrected — is
the `login()` test helper's own success check:

**What was requested implicitly** (by every spec file's own need to know "did login finish"): a reliable
way to tell that a login had actually completed, so the next step wouldn't run against a browser still
sitting on `/login`.

**What Claude produced first:** `fixtures.js#login()` filled the form, clicked submit, and then waited
for the text "Class Booking" to become visible, reasoning — stated in the code's own comment at the time
— that this text is the sidebar brand shown only in the authenticated app shell.

**What was wrong:** `LoginPage.jsx` itself renders `<h1>Class Booking</h1>` as its own page title. The
wait condition was satisfied instantly, before the login request had even been sent, on every single
call — a false positive baked into the very first version of the helper. Every test written against it
still passed regardless, purely by luck: each one's next assertion (a `toHaveURL(...)` check) has its
own several-second polling window that happened to absorb the real login latency invisibly. The bug
stayed hidden until a `test.beforeAll` hook with no such assertion immediately after `login()` (setting
up two fixture sessions for `instructor-flow.spec.js`) hit the unguarded race directly, hung for the
full 30-second hook timeout, and reported the actual state at failure: still on `/login`.

**What was changed:** `login()` now waits for `page.waitForURL((url) => !url.pathname.startsWith('/login'))`
instead — a check tied to the one thing that's actually true only after a real navigation away from the
login page, regardless of what text either page happens to render. (A `.sidebar-brand`-specific element
locator was tried as an intermediate fix and rejected: that element is `display: none` on the mobile
viewport `responsive.spec.js` also logs in under, which would have made the fix correct on desktop and
newly broken on mobile.)
