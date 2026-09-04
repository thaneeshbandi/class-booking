# AI prompts

Claude Code was used for the entire codebase, including this document. A gap, stated plainly rather
than papered over: goals 1–5 (authentication, classes, sessions, co-instructors, and the database
foundation) were built in an earlier session whose actual prompts were not recorded anywhere this
document can honestly draw from — `git log -- docs/ai-prompts.md` shows this file was never touched
before the session that built goal 4. Inventing that history now would violate the one rule this file
has to follow, so it isn't attempted. What follows is complete and accurate for the ten sessions that
built goals 4, 6, 7, 8, and 10, the final pre-frontend audit, the frontend itself, its Playwright
E2E verification, its "final" UI/UX polish pass, and the full visual redesign that followed it, each
the one this document's respective author actually has a record of.

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

## Final frontend UI/UX polish milestone

### Prompt

One long, specific instruction given at the start of this session, explicitly framed as "final frontend
polish before deployment" across seven numbered areas. In substance: (1) audit the Classes page for a
prominent create CTA, a polished form, clean validation/error/success states, without adding a staff
selector to class creation; (2) fix the Bookings table so a present-vs-absent Cancel button never
misaligns other rows — a fixed, always-rendered Actions column, a placeholder when no action applies,
horizontal scroll contained to the table on narrow screens — plus new/updated Playwright coverage for
rows with and without an action; (3) improve the recurring-session screen so a genuinely-empty-candidate
combination (the brief's own worked example: a single day whose actual weekday doesn't match the
selected weekday) is caught client-side with a readable inline message and a disabled submit button
rather than surfacing the backend's raw "400: ..." text, show which weekdays a date range covers, and
preview an estimated session count before submitting — with backend validation kept authoritative and
DST/timezone conversion left untouched — plus five specific test scenarios; (4) add a public signup flow
that can never create a staff or instructor account (no role field anywhere in the UI or the request),
inspecting the existing auth/schema design first and implementing the smallest safe solution rather than
inventing a new authorization model, adding a backend endpoint only if signup couldn't be done with the
existing API; (5) a full visual redesign of the whole app (typography, spacing, cards, buttons, badges,
tables, modals, states, nav, responsive, focus states) within the existing plain-CSS architecture, no
new component library; (6) make Login/Signup feel like the same product; (7) run the full verification
sequence (backend test+lint, frontend lint+build, Playwright twice, real-browser checks at 375px and
desktop) and twelve specific concrete flows, without stopping after code changes; update documentation
honestly; and close with one incremental commit, `git status`, and the latest commit log.

### What was produced

Backend: migration `011_user_role_member.js` (a third `user_role` enum value, `'member'`); `POST
/api/auth/signup` in `routes/auth.js` (Zod-validated, argon2-hashed, auto-authenticating, role always
hardcoded, never read from the body); `tests/signup.test.js` (9 tests) and a new member-role boundary
suite appended to `tests/authorization.test.js` (4 tests); `schema.test.js`'s enum-values assertion
updated to include `'member'`, the one existing test this milestone's own schema change required
touching. Frontend: `SignupPage.jsx`, `WelcomePage.jsx`, a `/signup` route and `HomeRedirect`/`AppShell`
nav handling for the new role, `api/auth.js#signup` and `AuthContext#signup`/`isMember`; a rewritten
`RecurringSessionsPage.jsx` with client-side candidate-date counting, weekday-coverage display,
single-day mismatch detection, and a pre-submission preview, all computed from the same "YYYY-MM-DD as
UTC midnight" convention the backend already uses for weekday determination; a fixed `.col-actions`
table-column pattern (Decision 28) applied to every table with a per-row action
(`BookingsPage`/`ClassesPage`/`MembersPage`/`AlertsPage`/`SessionsPage`/`SessionDetailPage`), each now
wrapped in a `.table-scroll` container; subtitles and success notices added to `ClassesPage`; a
full-file rewrite of `styles.css` (typography scale, spacing tokens, card/button/badge/modal/table/
form/state-block polish, focus-visible rings, `:has()`-driven weekday-chip highlighting) with every
existing class name preserved so no page's JSX needed a structural rewrite to pick it up. Four new
Playwright test files' worth of coverage landed in one new `frontend/e2e/polish.spec.js` (13 tests:
bookings alignment, four recurring-UX scenarios, four signup scenarios) plus `SECOND_ROOM_NAME` added to
`fixtures.js`.

### What was correct

Reading `003_members.js`'s and `001_enums.js`'s own migration comments before deciding how to build
signup at all paid off directly (Decision 26) — both already stated, as settled prior decisions, exactly
the two facts ("members don't log in," "adding an enum value is an accepted, priced-in cost") that made
"a third `user_role` value" the obviously smallest safe path rather than something arrived at by
elimination. Auditing every existing `role !== 'staff'`/`requireRole(...)` check before writing the
migration (not after) confirmed in advance, not just hoped, that a `'member'` account could not gain
elevated access anywhere — verified concretely by the new authorization-boundary tests, which passed on
their first run. The CSS redesign, despite touching nearly every rule in the file, needed zero changes
to any existing Playwright locator in `auth.spec.js`, `staff-flow.spec.js`, `instructor-flow.spec.js`,
or `responsive.spec.js` — all 28 of those tests passed unchanged on the very first run after the
redesign, which is what happens when every existing `role`/label/text-based locator never depended on
the styling or DOM-wrapper structure being replaced around it.

### What was wrong, and what was corrected

1. **A cross-timezone-basis bug in a new test, not in the application.** The first version of the
   "conflicting session" recurring-UX test created its fixture session through the existing
   "Create session" form and then generated a recurring session for "the same" local time and day,
   expecting an instructor-conflict skip. It got a clean `Created (1)` instead — no conflict at all.
   Querying the database directly showed why: the two sessions landed 4.5 hours apart in UTC.
   `SessionForm`'s "Starts at (**your** local time)" field is deliberately interpreted in the *browser's*
   own timezone (`new Date(datetimeLocalValue).toISOString()`), while `RecurringSessionsPage`'s "Local
   start time" field is deliberately converted using `STUDIO_TIMEZONE` (`Europe/London`) on the
   backend — two different, both entirely intentional, pre-existing timezone bases (the milestone's own
   instructions explicitly required leaving DST/timezone conversion on the backend unchanged, and this
   distinction predates this session). The test's assumption that "14:00" typed into either form refers
   to the same instant was simply wrong on a test machine set to IST. Fixed by creating both the fixture
   session and the conflicting attempt through the *same* form (`RecurringSessionsPage`, submitted
   twice), so both go through the identical `STUDIO_TIMEZONE` conversion — not by changing any
   application code, since the two forms' differing timezone semantics are correct as designed.
2. **A stale-reference bug in the same new test file**, caught before it ever ran (found while writing
   `isoDate()`, not by a failing assertion): the helper used `.toISOString()` (UTC calendar date) while
   the sibling `toDatetimeLocalValue()` helper used local date components — the same class of mismatch
   as above, just between two *test* helpers rather than two application forms. Fixed by making
   `isoDate()` use local date components too, so a given `daysFromNow` offset names one calendar day
   consistently everywhere it's used in this file.
3. **The pagination-summary read race described in this file's own auth-flow entry above recurred in
   spirit** but did not actually reoccur here — called out only because it was checked for deliberately:
   every new assertion added in this milestone that follows a state-changing click uses an
   auto-retrying `expect(locator).toHaveText(...)`/`toBeVisible()` rather than a one-shot
   `textContent()` read, specifically because that exact race was already found and fixed once in the
   previous milestone.

## Full frontend visual redesign

### Prompt

One long, specific instruction given at the start of this session, explicit that the previous polish
pass had improved CSS consistency but not reached the visual quality bar wanted, and framed as
"primarily about visual design and UX quality, not adding business functionality." In substance: audit
every page, AppShell, and shared component first, and do not assume "tests pass" means the visual
result is good; define real design tokens (colors including primary/soft-background/success/warning/
danger/info, a typography scale, a spacing scale, radii for small controls/cards/large containers/
pills, and a subtle shadow hierarchy); completely redesign the app shell (branded sidebar with icons and
a clear active state, a topbar with avatar/name/role/logout, a proper mobile navigation pattern — not
just the desktop sidebar shrunk); redesign Login and Signup as a strong split-screen layout with product
branding on one side; make the Dashboard the strongest page visually (a time-of-day greeting header,
icon-led metric cards, a visually meaningful status/class breakdown, an attention area for expiring
memberships); redesign Classes/Members/Alerts/Sessions/Session Detail/Bookings/Booking Detail/Recurring
Generation with stronger identity hierarchy, status treatment, metadata display, and (for Recurring) a
distinct sectioned form with a real preview card; redesign every modal consistently (header/subtitle/
close/footer/loading/error); build a polished reusable table system (rounded container, header
background, row hover, a fixed aligned action column, contained horizontal scroll, strong empty states,
clear pagination); polish every loading/empty/error/success state; standardize form controls and a
restrained set of button variants (primary/secondary/danger/ghost); use icons thoughtfully throughout —
small inline SVG components or, only if genuinely useful, a tiny dependency, never emoji; keep it
professional, not flashy or overly animated; explicitly design for 375/768/1024/1440px; and, critically,
do not consider the task complete merely because lint/build/Playwright pass — actually launch the app
with Playwright, inspect real screenshots at desktop and 375px for every major page, and do at least one
real visual refinement pass based on what was actually rendered, not assumed. It closed by requiring
every existing test to keep passing, no functional/authorization regressions, documentation updated
honestly (not fabricating visual-testing results), and one incremental commit.

### What was produced

A `components/Icon.jsx` (25 hand-rolled inline SVGs, Decision 29), `components/Avatar.jsx` (initials),
`components/MetricCard.jsx`, and `components/AuthLayout.jsx` (the shared split-screen login/signup
shell). A full-file rewrite of `styles.css` adding the requested token set (info/surface-elevated
colors, an elevated-card shadow, `.stat-icon`/`.cell-identity`/`.metadata-chip`/`.form-section`/
`.preview-card`/`.membership-cell`/`.alert-summary`/`.session-summary-*`/`.class-breakdown`/
`.status-breakdown` component classes, a `.btn-ghost-danger` variant for dense-table destructive
actions, and the off-canvas mobile-drawer rules) while preserving every existing class name the
previous milestone's own redesign and every page already depended on. `AppShell.jsx` rewritten for
icon-led navigation, a topbar avatar/page-context label, and a real mobile drawer (Decision 30).
Every page rewritten to use the new components/classes: `LoginPage`/`SignupPage` (via `AuthLayout`,
with a signup-safe, role-word-free shared brand panel and a login-only "Staff & instructor workspace"
tag); `DashboardPage` (time-of-day greeting, icon metric cards, a class-breakdown bar comparison
replacing an unbounded plain list, a status-breakdown bar list, an expiring-memberships attention
banner reusing the existing `useAlertCount` hook); `ClassesPage`/`MembersPage`/`AlertsPage` (identity
cells, a client-side-only membership status pill mirroring the alert window, an alert-count summary
header); `SessionsPage`/`SessionDetailPage` (a sectioned Create/Edit Session modal, a room name and
primary-instructor name now shown to every role via `GET /api/rooms`'s already-open access, an
occupancy pill backed by a new `bookedCount` field — Decision 31 — and a status pill computed from
`startsAt`/`endsAt`); `BookingsPage`/`BookingDetailPage` (a cohesive filter toolbar with a search icon
built without changing the filter selects' DOM order that existing tests already address by position, a
`.btn-ghost-danger` Cancel action, an icon-differentiated history timeline); `RecurringSessionsPage`
(the previous milestone's own client-side validation logic unchanged, now visually grouped into
"Session details"/"Date range"/"Schedule"/"Overrides" sections with a real preview card). One small,
genuine backend addition: `bookedCount` on `GET /api/sessions` (migration-free, a batched aggregate
query plus 2 new tests) — the one place a backend change was actually necessary for what the UI needed
to show, per the milestone's own stated exception.

### What was correct

Preserving every existing CSS class name while rewriting the whole stylesheet, and preserving every
existing form field `id`/`htmlFor` pairing and button/label text while restructuring page layouts, meant
28 of the 41 existing Playwright tests needed zero changes at all across this entire redesign — proof
those tests were genuinely role/label/text-based rather than coupled to markup structure. Screenshots
were taken and actually inspected (not assumed) after each major page rewrite — see "What was wrong"
below for what those screenshots caught — at both 1440px and 375px, plus a further pass at 768px and
1024px confirming the design holds at the two breakpoints not otherwise covered by Playwright's own
`responsive.spec.js`.

### What was wrong, and what was corrected

Several real issues, all caught either by a screenshot actually being looked at or by the required
Playwright re-run — not assumed away:

1. **A missing `text-decoration: none` on `.btn`**, found by inspecting the session detail page's
   screenshot: a `<Link className="btn btn-secondary">` ("Back to sessions") rendered with a browser
   default underline the button styling never explicitly overrode, despite `background`/`border`/
   `color` all computing correctly (confirmed directly via `getComputedStyle`, not by guessing from the
   screenshot alone). Fixed with one property on the shared `.btn` base class, benefiting every
   anchor-as-button in the app at once, not just the one that was visibly wrong.
2. **A CSS editing mistake caught by grep before it ever shipped**: mid-rewrite, three empty rule
   bodies (`selector:has(...) { }`) were briefly left in `styles.css` — dead, meaningless CSS from an
   abandoned approach to toggling the recurring-generation preview card's warning tone via `:has()`.
   Caught by a deliberate sweep (`perl` regex for empty `{ }` bodies) run specifically because an
   earlier milestone in this same project had once left a genuinely garbled CSS line unnoticed until a
   later audit — replaced with a plain `.preview-card.is-warning` modifier class toggled from React
   state, which is what the code should have done from the start.
3. **Two real Playwright regressions from the AppShell redesign, both expected consequences of an
   intentional behavior change, not accidents**: the new off-canvas mobile drawer (Decision 30) meant
   `responsive.spec.js`'s mobile tests could no longer click sidebar links directly — they were now
   genuinely off-screen by design, not a bug — fixed by teaching the test to open the drawer first,
   matching the new (better) UX rather than reverting it. Separately, `staff-flow.spec.js` asserted a
   literal `<h1>Dashboard</h1>` that the new time-of-day greeting heading intentionally replaced — fixed
   by asserting the greeting pattern instead (`/^Good (morning|afternoon|evening), /`), not by keeping
   the old, less friendly heading just to avoid touching a test.
4. **A genuine locator collision, found by the Playwright run itself failing with a strict-mode
   violation, not predicted in advance**: the new dashboard alert banner's link text, "N memberships
   need attention," contains the substring "member" — which Playwright's case-insensitive default
   substring matching for `getByRole('link', { name: 'Members' })` matched against, colliding with the
   pre-existing sidebar "Members" nav link the moment both existed on the same page. Fixed not by
   renaming the existing, widely-used "Members" nav link, but by narrowing the banner's own link to a
   small "View" affordance — the descriptive sentence stays as plain text outside any `<a>`, which is
   also better UX (a giant paragraph-as-link was never a good click target) as well as the fix for the
   collision.
5. **A repeat of Decision 31's own fixture-cleanup lesson, caught immediately by the full suite failing
   a completely unrelated later test with a foreign-key error**: the first version of the new
   `bookedCount` test used the shared `fixture.class`/default room and pushed its now-permanently-
   booked session onto the shared `createdSessionIds` cleanup array — exactly the mistake
   `sessions.test.js`'s own P6 describe block already has a comment warning against. Root-caused by
   reading that comment (not by trial and error) and fixed the same way that block already does: a
   dedicated, never-cleaned-up class and room for the one test that needs a real, permanent booking.

## Account/member linking, member portal, profile, forgot-password, and the error-presentation system

### Prompt

One very long, highly specific instruction given at the start of this session, opening with an explicit
audit-first requirement ("Before changing anything, inspect: users table/schema, members table/schema,
authentication middleware, password hashing, JWT/session cookie implementation, auth routes,
authorization middleware, AuthContext, all existing frontend routes...") and a hard constraint stated in
capitals: "DO NOT use email alone as a permanent identity relationship after signup... The actual
relationship must be represented by a database foreign key." In substance: design the smallest safe
schema change linking a login (`users`) to a booking identity (`members`), so that a staff-created member
signing up later with the same email is *linked* to their existing record — never duplicated, never
losing their existing bookings or membership expiry; a genuinely new signup gets its own member with role
hardcoded to `member`, no client-controllable role field anywhere; build a full member portal (browse
sessions, book, view own bookings, cancel — reusing the existing booking domain logic exactly, never a
second implementation) with server-derived member identity, never a client-supplied member id; a profile
page for every role (name editable, password changeable with an explicit documented decision on session
invalidation, email deliberately conservative about whether to allow changing it, role never exposed as
editable); forgot-password by email OTP with an extensive, explicit security spec (cryptographically
random, hashed storage only, expiry, attempt limits, request cooldown, generic response regardless of
account existence, a test/dev email adapter for automated tests — never a real provider call); and a
"reusable error presentation system" replacing the literal complaint "401: Invalid email or password."
with icon+title+message+retry, applied consistently everywhere, with a centralized status-to-copy
mapping. It closed with an extensive, itemized testing/verification/documentation/git checklist (backend
tests run twice plus after a fresh `db:reset`, frontend lint/build, Playwright run twice, real screenshots
actually inspected at 375/768/1024/1440px with a genuine refinement pass, all six `docs/*.md` files plus
`SUBMISSION.md` updated honestly, one single incremental commit) and an explicit instruction not to
deploy.

### What was produced

Two new migrations (`012_members_user_link.js`, `013_password_reset_otps.js`); `domain/memberLinking.js`
(the link-or-create decision, called transactionally from a reworked `POST /api/auth/signup`);
`auth/otp.js` and `auth/resetTokens.js` (OTP generation/hashing and a purpose-scoped reset token,
deliberately not sharing code with the session-token signer — see `docs/decisions.md`, Decision 38);
`email/emailService.js` (a swappable provider abstraction plus a dev/test adapter); three new auth routes
(`forgot-password/{request,verify,reset}`) plus a dev-only OTP-retrieval route gated on
`NODE_ENV !== 'production'`; `routes/profile.js`; `routes/memberBookings.js`, built on two new shared
functions extracted from the existing staff booking route (`createBookingInTransaction`,
`cancelBookingInTransaction` in `domain/bookingTransaction.js`) so both routes call the identical booking
logic; five new backend test files (`memberLinking`, `profile`, `forgotPassword`, `memberPortal`, plus
updates to `schema.test.js` for the new table/columns) — 449 backend tests total, up from 406, run twice
plus after `db:reset`, all clean; on the frontend, `errorCopy.js` + a redesigned `ErrorBanner`/new
`PageError`/`FieldError` in `States.jsx`; `ProfilePage`, `ForgotPasswordPage`, `MemberHomePage`,
`MemberSessionsPage`, `MemberBookingsPage` (replacing the old static `WelcomePage`); updated `AppShell`
nav for all three roles and updated routing; two new Playwright spec files (`member-portal.spec.js`,
`account-security.spec.js`) plus updates to three existing spec files for the intentional copy/route
changes — 63 Playwright tests total (up from 41), run twice clean; and real screenshots captured and
inspected at 375/768/1024/1440px for every new/changed page via a throwaway QA script (not committed).

### What was correct

The transactional link-or-create logic, the ambiguous-multiple-match fallback (create rather than guess),
the OTP hashing/expiry/attempt-limit/cooldown/generic-response design, the shared booking-domain-logic
reuse between staff and member routes, and the in-place `ErrorBanner` redesign (retrofitting all eleven
existing call sites automatically) all worked as designed on the first implementation and needed no
correction — verified by the new backend and Playwright suites above, not merely assumed.

### What was wrong, and what was corrected

1. **A real bug, caught only by the required visual QA screenshots, not by any automated test**: the
   first implementation gave a brand-new self-registered member (no staff record to claim)
   `membership_expires_on` set to *today*. `domain/membership.js#isMembershipExpired` is a strict `<`
   comparison — an expiry equal to today is still valid for the rest of that civil day — so this left a
   fresh signup genuinely bookable for several hours, a real (if short-lived) free membership, exactly
   the outcome the design was trying to prevent. No backend test caught this because every existing test
   that checked the expired-membership rejection used an explicit, obviously-past date
   (`grantMembership('2000-01-01')`), never a truly fresh, untouched signup. It was caught reading the
   member home page's own rendered membership badge at 375px and 1440px during the required screenshot
   review and noticing it read "Expiring soon" for an account that should have had no membership at all.
   Fixed by setting the expiry to *yesterday* instead of today (`domain/memberLinking.js`), and a new,
   more direct backend test was added specifically to close the gap
   (`tests/memberPortal.test.js`, "rejects a new booking for a brand-new signup that was never granted a
   real membership") — documented in full as a reversed decision, `docs/decisions.md` Decision 42.
2. **The redesigned error copy intentionally broke three pre-existing Playwright assertions that checked
   for the exact old, raw error text** — `auth.spec.js`'s login-failure test asserted
   `/invalid email or password/i` (the old backend string), `instructor-flow.spec.js` asserted a raw
   `'403'` substring in the authorization-boundary alert, and `polish.spec.js`'s signup test asserted the
   old static `WelcomePage`'s literal `<h1>Welcome, {name}</h1>` heading and its single-link nav. All
   three were the *intended*, not accidental, consequence of the redesign (the whole point was to remove
   exactly this kind of raw text) — fixed by updating each assertion to match the new, polished copy and
   the new `MemberHomePage`'s time-of-day greeting and four-link nav, the same "fix the test to match an
   intentional change, don't revert the change" precedent this project's own `docs/decisions.md` already
   established for the mobile-nav-drawer and dashboard-greeting changes in an earlier milestone.
3. **A new Playwright test file hung indefinitely** (`memberPortal.spec.js`'s early draft, backend
   equivalent — `tests/memberPortal.test.js`): its `after()` hook tried to delete the test's own member/
   user fixtures, but nearly every member created in that file books (and most cancel) a real session,
   which writes `booking_events` rows whose `actor_user_id` is that member's own user id —
   `ON DELETE RESTRICT` (see `schema.test.js`) makes such a user permanently undeletable, and the delete
   call threw *before* `server.stop()`/`closeConnection()` ever ran, leaving an open HTTP listener and DB
   pool that kept the Node process alive forever. Root-caused by checking `pg_stat_activity` (no query was
   actually stuck) and then process CPU usage (idle, not spinning) before concluding it was a resource
   leak rather than a slow query, and fixed by removing the cleanup entirely in favor of this project's
   own established "unique per run, never cleaned up" fixture pattern (`tests/bookings.test.js`'s own
   documented precedent for exactly this situation) rather than trying to make the delete succeed.
4. **Several Playwright locator collisions** in the two new spec files, each a real strict-mode failure
   caught by actually running the suite, not predicted: `getByLabel('New password')` matched both that
   field and "Confirm new password" (fixed with `exact: true`); `getByRole('link', { name: 'My Bookings'
   })`/`'Profile'` matched both the sidebar nav link and a same-named quick-action button on the member
   home page (fixed by scoping to `nav.sidebar-nav`); and a dev-OTP fetch raced the UI's own in-flight
   request because the test didn't wait for the OTP-entry step to actually render before reaching for it
   out of band (fixed by adding that wait). None were product bugs — all were the tests written too
   quickly against a UI whose real DOM shape had more than one match.

## Frontend correction: a real Bookings table structure bug, and final visual QA

### Prompt

A short, tightly-scoped instruction explicitly framed as a correction, not a new milestone: no new
business functionality, no backend rule changes, no whole-app redesign, no changes to the auth/member
architecture, preserve the existing design system. The user reported inspecting the actual rendered
Bookings page and finding the row data visually shifted relative to its own headers (Member | Class |
Session | Status | Booked at | Actions), gave the exact wrong-looking row content they saw, and required:
fixing the DOM structure so header and row cell counts match exactly with each field under its own
header; a polish pass on the table's visual hierarchy, spacing, and the Cancel button once the structure
was correct; an audit of every other table in the app for the same class of bug; a check for leftover
duplicate JSX/CSS from the earlier redesign; a small visual audit of the app shell; real Playwright/
Chromium visual QA at 375/768/1024/1440px with the Bookings screenshot specifically inspected by eye, not
just asserted on; a new Playwright regression test asserting the table's structure by content, not just
by count; the full backend/frontend/Playwright verification battery, run twice and again after a fresh
`db:reset`; and documentation updated only if real behavior changed.

### What was produced

Read `BookingsPage.jsx`'s actual table JSX before touching anything, and — separately — rendered the real
page with Chromium and read `table.table thead th`'s count against the first row's `td` count
programmatically, which is what actually confirmed the bug (6 header cells, 5 body cells) rather than
assuming the user's screenshot description matched some other cause. Root cause: the class title had been
folded into the Member cell as "secondary" text instead of being given its own `<td>`, so a header meant
for Class had no cell of its own — every subsequent cell (session time, status, booked-at, the Cancel
button) rendered one column left of where its header said it would be, and the Actions header ended up
with nothing under it at all. Fixed by giving Class its own `<td>` and moving each of the following cells
back into its own correct position — six `<td>`s for six `<th>`s, with Member now showing the member's
email as secondary text (already present in the API response) instead of the class title, matching the
requested identity-cell hierarchy. Also fixed, once the structure was correct: the Session and Booked-at
columns no longer wrap their timestamps across two lines (a `col-nowrap` modifier), the row/header padding
was opened up slightly for breathing room, and the Cancel button gained a subtle border so it reads as a
defined, clickable control at rest rather than only on hover. Audited every other table in the app
(Members, Classes, Sessions, Session Detail, Alerts — Dashboard and Booking Detail have no `<table>`) by
comparing `<th>` and `<td>` counts and reading each row's actual field assignment; all five were already
structurally and semantically correct — the bug was isolated to `BookingsPage.jsx`. Found and removed one
genuine leftover: a duplicate `.field-error` CSS rule (the class already existed from an earlier
milestone; the previous session's own forgot-password/profile work had added a second, near-identical
declaration for the same selector without noticing). Added a new Playwright test
(`polish.spec.js`, "every header has exactly one matching cell, with the right content in the right
column") that pins each header to its own cell by content, not merely by count — verified it actually
fails against the pre-fix code (reverted the fix locally, re-ran the test, confirmed a real failure with
"Expected: 6, Received: 5," then restored the fix) before trusting it as a real regression guard.

### What was correct

The audit of every other table found no second occurrence of the bug — each already had matching header/
cell counts with content in the right place, so no changes were needed there, consistent with the
instruction not to blindly rewrite tables that were not actually broken. The filter bar and app shell were
inspected and found to already meet the brief's own bar (consistent control heights, a search icon,
wrapping, active nav state, alert badge, avatar/role badge/logout) — nothing there needed changing either.

### What was wrong, and what was corrected

The one real bug is described above — a missing `<td>`, not a CSS or layout issue, caught by directly
reading the rendered DOM's cell counts rather than only looking at a screenshot. Nothing else was found
wrong during this session's verification pass; every other change made (spacing, nowrap, the Cancel
button border, the duplicate CSS removal) was a genuine, targeted fix for something specifically named in
the brief, not a rewrite.

## Final submission audit

### Prompt

A long, exhaustively itemized final-audit instruction, explicitly scoped as verification-only: no new
product features, no UI redesign, no refactoring working architecture for style, no changes to
`README.md`. It required reading `README.md` directly from the repository (not relying on any earlier
summary), building a private requirement-by-requirement checklist against every mandatory goal with an
exact code path, test, and documentation location for each, and specifically flagged goal 9 (immutable
history) as a high-priority direct inspection of the trigger/privilege implementation rather than a
description of it. It itemized dozens of specific things to verify across every goal (concurrency race
scenarios, the alert window's exact day-boundary behavior, CSV escaping *and* formula-injection handling,
N+1 query patterns, OTP/email security, the global error-copy system via a targeted grep for raw status
prefixes), required a git/artifact audit (secrets, `.env` files, test artifacts, `.Rhistory`'s status
specifically), a documentation audit for stale or contradictory claims without erasing legitimate
historical entries, the full required test sequence run fresh, and a fix policy limited to genuine
functional/security violations, broken documentation, accidental artifacts, and real test/config issues —
explicitly nothing else.

### What was produced

Read `README.md` in full directly from the file. Verified, by reading the actual code (not from memory):
the `booking_events` append-only trigger migration and its live immutability test coverage; that no
application route anywhere issues an UPDATE or DELETE against `booking_events` (grepped for it directly);
the recurring-generation same-transaction sequential loop (confirmed later candidates in one batch do see
earlier candidates' just-inserted rows); the half-open overlap interval (`<`/`>`, confirmed back-to-back
sessions are not flagged); the membership-alert predicate and its dedicated boundary tests (+7 included,
+8 excluded, both already present and passing); that the sidebar alert badge calls the identical backend
endpoint the Alerts page itself does; and a repository-wide grep for raw status-prefix/stack-trace/SQL
leakage in the frontend, which found none. Audited the git history (36 real incremental commits, not a
squash), the working tree (clean except the pre-existing, unrelated `.Rhistory`), and every tracked file
for secrets (none — only `.env.example` templates, real `.env` files correctly gitignored and untracked).
Ran the full required verification sequence fresh, end to end, once for this session's own final numbers:
backend test+lint, frontend lint+build, Playwright twice, a fresh `db:reset`, backend test again, and
Playwright once more — all clean, all numbers recorded honestly in `SUBMISSION.md` and `docs/plan.md`
Session 15 rather than asserted from an earlier run.

### What was correct

Every mandatory goal's authorization boundary, concurrency protection, and documented behavior matched
`README.md` and had a real, currently-passing test backing it — nothing required a code change beyond the
one gap below. The account-linking, member-portal, and OTP subsystems built in the two prior milestones
held up under this session's independent re-verification (dev-only OTP route confirmed genuinely absent
from a production build via the `!isProduction` gate at registration time, not merely at response time;
no hardcoded credentials anywhere in `src/`; the seed script refuses to run without a real `SEED_PASSWORD`
env var).

### What was wrong, and what was corrected

One genuine gap, found by directly checking the specific thing the audit asked about ("formula-like
values handled appropriately") rather than assuming the existing RFC 4180 escaping already covered it: the
attendance CSV export had no protection against CSV/formula injection in the member-name field. Fixed and
covered by a new test verified to actually fail against the pre-fix code — full detail in
`docs/decisions.md`, Decision 43. One thing noted but deliberately not "fixed," per the audit's own scope
limits: goal 4's concurrency suite has no dedicated *concurrent* duplicate-cancel or concurrent-settlement
race test (only a sequential rejection test for each) — both paths are protected by the identical lock
protocol the suite's other race tests already prove correct, so this is recorded as an honest coverage
observation in `docs/plan.md` Session 15, not silently passed over and not treated as a defect requiring a
new feature-shaped fix that the audit's own instructions explicitly ruled out adding.

## Member session-browsing state bug, and session filters

### Prompt

A bug report plus a feature request in one, explicitly scoped: no unrelated changes, no rewrite of
working mandatory functionality, preserve the existing architecture and design system. It described the
exact symptom (booking a second member session visually reverted the first one's card from "Booked" back
to "Book," while the backend's own booking was genuinely correct), gave an explicit expected-behavior
list (independent per-session state, correct after refresh/filter/pagination, never a single shared
scalar), asked for root-cause investigation *before* any fix, asked for the API response to be verified
rather than assumed correct, asked for three member session filters (class, date/range, availability
including a "My Booked Sessions" option) implemented server-side where the backend could reasonably
support it, and required a Playwright regression test proven to actually fail against the pre-fix
implementation before being trusted.

### What was produced

Read `MemberSessionsPage.jsx` before changing anything and found the actual bug immediately: a single
`justBookedId` scalar, overwritten by every new booking, was the *only* thing the "Booked" badge rendered
from — there was no per-session source of truth for it at all. Checked the backend next, per the
brief's own instruction not to assume it was correct: `GET /api/member/sessions` never told the client
which sessions the caller had already booked, so even a perfectly-written frontend would have had nothing
authoritative to derive per-session state from. Fixed both: the endpoint now returns each session's own
`myBooking` (id + status, or `null`), computed by joining `bookings` scoped to the caller's own member id;
the frontend now reads that field directly, and tracks in-flight requests in a `Set<sessionId>` instead
of a scalar. Added the three requested filters to the same endpoint (`classId`, `dateFrom`/`dateTo`
resolved via the same studio-timezone `AT TIME ZONE` mechanism `recurringSchedule.js` already uses,
`availability=available|full|mine`), reusing the existing `GET /api/classes` endpoint for the class
filter's own options rather than adding a new one. Wrote the Playwright regression test, then verified it
the way the brief asked: stashed only the frontend page file (kept the backend fix and the test in
place), re-ran it, watched it fail at the exact line the bug predicts (session A's "Booked" text missing
after booking session B), restored the fix, and confirmed the same test then passes.

### What was correct

The backend's `createBookingInTransaction`/`cancelBookingInTransaction` domain logic — reused unchanged
by the new `myBooking` join and every existing member-portal route — needed no changes at all; the bug
and the missing filters were entirely at the read-query and frontend-state layer, exactly as the brief's
own framing suspected.

### What was wrong, and what was corrected

Nothing was wrong in this session's own output before verification — the regression test was written,
proven to fail against the real bug, then proven to pass against the fix, in that order, rather than
trusted on the first try.

## Member "My Bookings" filters, and the instructor Primary/Co-instructor "My Sessions" filter

### Prompt

A follow-on feature request, explicitly building on the just-fixed member booking-state bug and framed
with hard constraints: don't regress that fix, preserve the existing architecture/authorization/design
system, extend an existing endpoint rather than add a redundant one, keep all filtering server-side. It
asked for three filters on member "My Bookings" (status, class, date range), a role filter on instructor
"My Sessions" distinguishing primary-instructor sessions from co-instructor sessions from the union of
both — explicit that this must be enforced server-side against the authenticated user's own id, never a
client-supplied instructor id — plus class/date filters on the same instructor view, consistent filter UX
across all three member/instructor pages, and an explicit instruction to verify the booking-state fix
still held after filters were layered on top of it (book two sessions, apply a filter, refresh — both
must still show Booked).

### What was produced

Inspected `GET /api/member/bookings` and `GET /api/sessions` before writing anything. Extended both in
place: `GET /api/member/bookings` gained `status`/`classId`/`dateFrom`/`dateTo`, every one ANDed onto the
existing `bookings.member_id = member.id` scope. `GET /api/sessions` gained `dateFrom`/`dateTo` and
`role=all|primary|co`, the latter built as two new sibling functions in `sessionAccess.js`
(`scopeSessionsToPrimaryInstructor`, `scopeSessionsToCoInstructor`) rather than by modifying the existing
`scopeSessionsToInstructor` that every resource-level authorization check in the app already depends on —
see `docs/decisions.md`, Decision 45, for why that mattered enough to be its own decision. `role` reads
only `req.user.id`; there is no code path anywhere in the new query that accepts an instructor id from the
client, and it has no effect at all for a staff caller. Both new date filters reuse the exact
studio-timezone `AT TIME ZONE` conversion the previous session's member-session-browsing filters already
established, not a new mechanism. `MemberBookingsPage.jsx` and `SessionsPage.jsx` both got a
`useSearchParams` filter bar built to match `MemberSessionsPage.jsx`'s own existing shape exactly (same
CSS classes, same merge-not-replace filter-update pattern), per the brief's own cross-page-consistency
ask. Explicitly re-verified the booking-state fix under the new filters, per the brief's own script: booked
two sessions, applied the class filter, applied "My booked sessions," refreshed — all three Playwright
tests from the previous session covering exactly this were re-run and stayed green, and this session's own
class-filter test on the same page repeats the same shape as a second, independent check.

### What was correct

The core design decision — extend two existing endpoints rather than add new ones, and build the role
filter as two small siblings of the existing authorization predicate rather than changing it — held up
through implementation with no rework needed; `docs/decisions.md` records why each call was made, not just
what was built.

### What was wrong, and what was corrected

Two things, both caught by tests before being trusted, neither in the filtering logic itself:

1. **A genuine test-fixture collision, not a product bug**: the first version of the new
   `tests/sessions.test.js` role-filter tests used `at(600)`/`at(624)`/`at(648)` as session start-time
   offsets — the same `at(600)` a different, pre-existing test in that same file already used for its own
   session, producing a real room/instructor scheduling conflict the moment both tests ran in the same
   suite. Caught immediately by that unrelated pre-existing test failing with a confusing
   `TypeError: Cannot read properties of undefined (reading 'id')` (the create request had 409'd, not the
   200 the test assumed) rather than a clean assertion failure — root-caused by reading the actual error,
   grepping the file for every other `at(N)` offset already in use, and moving the new fixtures to a
   clearly disjoint window rather than guessing at a fix.
2. Two Playwright tests (this session's new instructor role-filter test, and an unrelated, untouched
   recurring-generation test from an earlier milestone) failed once during a full ~90-test suite run and
   passed cleanly when re-run in isolation immediately after — verified as transient rather than assumed:
   re-running the *entire* suite twice more, both times clean, before trusting the work as done.

## Duplicate member email prevention, and a profile-navigation UX fix

### Prompt

A two-issue bug/feature report with hard constraints stated up front: no push to GitHub, no rewriting git
history, keep current functionality intact, one new incremental commit, inspect the existing
implementation before changing anything, weaken no authorization rule. Issue 1: staff creating a member
from the Members page could create a second member row with an email that already existed — required a
server-side (not merely frontend) rejection, explicitly warning that `members.email` might have a
deliberate non-uniqueness rule tied to signup/account-linking and to inspect before changing it, explicitly
forbidding a race-prone "SELECT then INSERT" duplicate check in favor of a real database constraint, and
listing nine specific backend test scenarios plus five specific Playwright scenarios. Issue 2: the
sidebar's bottom-left user identity control did nothing when clicked — required it to become a real,
keyboard-accessible link (not a clickable `<div>`) to the existing `/profile` route for all three roles,
with an explicit security constraint that it must always resolve to the *authenticated* user's own profile
and never be constructed from a client-supplied id. Also asked for Playwright coverage of the navigation
for all three roles, an explicit regression-protection list of prior milestones' work to re-verify, and the
usual documentation/verification/git steps.

### What was produced

Inspected `migrations/003_members.js` and `linkOrCreateMemberForSignup` before writing any migration —
confirmed `members.email` non-uniqueness was in fact deliberate, and documented the reversal explicitly
(`docs/decisions.md`, Decision 47) rather than silently changing it. Added migration
`014_members_email_unique.js` (`members_email_unique`), which relies on the pre-existing
`members_email_normalised` `CHECK` constraint for case-/whitespace-insensitivity, matching the exact
pattern `users.email` already uses. `routes/members.js`'s `POST /` and `PATCH /:id` catch the `23505` and
return a clean `409`; no pre-check `SELECT` was added anywhere. Checked the shared dev database and every
test file for pre-existing duplicate emails before adding the constraint, and fixed the two that were
genuine committed setups (the seed's Lindqvist household members, and `memberLinking.test.js`'s ambiguous-
match test) rather than merely working around them. Added the nine backend test scenarios (across
`members.test.js`, `memberLinking.test.js`, and `schema.test.js`) and four Playwright scenarios covering
create, duplicate rejection (with a visible friendly error, retained form values, and no extra row),
case/whitespace-insensitivity, and edit-time rejection. For issue 2, read `AppShell.jsx` fresh and turned
`.sidebar-footer` into a `<Link to="/profile">`, added matching hover/focus CSS, and added four Playwright
tests (one per role, plus a link-semantics check) confirming the control is a real anchor pointing at
`/profile` and that logout — a separate, topbar control — still works.

### What was correct

Both root causes were exactly what the relevant file suggested on a first read: the migration's own
comment for the email issue, and a plain, unstyled, unlinked `<div>` for the navigation issue. No frontend
changes were needed for issue 1's error-display requirements — the existing `ErrorBanner`/`errorCopy.js`
system and `MemberForm`'s React state already satisfied every one of them once the backend returned a
clean 409.

### What was wrong, and what was corrected

Writing `tests/schema.test.js`'s new case-insensitivity test for `members.email`, the first draft asserted
a `23505` (unique violation) for a raw, uppercase-email direct insert — reasoning by analogy to the
duplicate-email tests rather than checking the actual established pattern. Before running it, the existing
`users.email` case-insensitivity test in the same file was checked, which expects `23514` (check
violation) for exactly this case, because the `_email_normalised` `CHECK` constraint fires before the
`UNIQUE` constraint on a value that was never pre-normalized by the application layer. The new test was
corrected to expect `23514` to match, before it was ever run — a wrong assumption caught by checking
precedent rather than by a failing test.

## Staff can create staff/instructor accounts (Team page)

### Prompt

Not a bug report — a deployment question, asked across a short back-and-forth. First: with all the demo
seed data used for testing, what happens once the app is actually deployed, and how would anyone access a
staff or instructor account at all? Then, after a first explanation of the options (edit the seed into real
bootstrap data, a one-off CLI script, a real in-app "staff creates staff/instructor" feature) wasn't clear
enough, asked for the tradeoffs in more detail. Finally: "can we do something like the one who is a staff
can add any other staff or instructor... just tell me if its possible or not and if yes, what will be
done," followed by an explicit hand-off of the implementation decision: "i am giving you the power, think
how a real web application in the deployment works and implement it and tell me what you are doing."

### What was produced

Chose the in-app feature (the third option discussed), reusing this codebase's own established patterns
rather than inventing new ones: `POST /api/users` (staff-only, restricted to `role: 'staff'|'instructor'`
by its own schema — never `'member'`) follows the exact create/hash-password/catch-`23505`-into-409 shape
`routes/members.js` already uses for `members.email`; the new `TeamPage.jsx` follows `MembersPage.jsx`'s
own table-plus-modal shape exactly. The new account's password is set directly by the staff member creating
it, communicated out of band, with a form hint that the new user can change it from their own profile page
afterward — chosen over an email-invite flow specifically because this app has no real transactional email
provider wired up (only the dev-only OTP stand-in), so an invite flow would need infrastructure that does
not exist yet; and over a forced-password-change flag because the existing change-password flow already
covers the same need with no new mechanism. No migration was needed (`users.email` was already unique).
Documented as an explicit, out-of-spec addition in `docs/decisions.md`, Decision 49 — not one of the
README's ten mandatory goals or its own stretch list, built only because it was asked for directly.

### What was correct

The reused-patterns approach worked with no rework: the `23505` → 409 handling, the modal form shape, and
the staff-only route gating all matched their `routes/members.js`/`MembersPage.jsx` counterparts exactly on
the first pass.

### What was wrong, and what was corrected

Two real issues, both surfaced by this feature's own first Playwright test run, not shipped silently:

1. **A genuine, pre-existing application bug**, not something this session introduced but something its own
   new caller was the first to expose: `GET /api/users`'s unfiltered branch had never excluded
   `role = 'member'` — every caller before the new Team page had always passed an explicit `role` filter, so
   nothing had ever asked it for "everyone" and gotten every self-registered member account back along with
   the intended staff/instructor roster. Found by looking at a failing test's screenshot (attached for a
   different, unrelated assertion) and noticing the staff Team page's table was full of member rows. Fixed
   at the route itself, with a new regression test (`roomsAndUsers.test.js`) that would have caught this
   directly.
2. **A test-writing mistake**: the first version of the "an instructor cannot reach the Team page" test used
   fixture names starting with "Team Test Instructor" and asserted zero `Team`-named links on the
   instructor's own nav. It failed — but for the wrong reason: Playwright's default role-name matching is
   substring and case-insensitive, so the sidebar identity link (which renders the logged-in user's own full
   name, itself containing "Team") matched the query, producing a false "the Team link leaked into the
   instructor's nav" failure. The failure's own screenshot showed the instructor's actual nav was correct
   (no Team link at all), which is what revealed the real cause. Corrected by scoping the locator to
   `nav.sidebar-nav` (matching `account-security.spec.js`'s own established pattern for this exact kind of
   ambiguity) and renaming the test fixtures to avoid the word "Team" entirely.
