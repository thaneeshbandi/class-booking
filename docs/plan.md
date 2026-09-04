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
| 5 | 2026-09-02, later still | Goal 7 — recurring session generation (`POST /api/sessions/recurring`) and attendance CSV export (`GET /api/sessions/:sessionId/attendance.csv`), their test suites, and this documentation update. |
| 6 | 2026-09-02, later still | Goal 8 — the staff-only dashboard (`GET /api/dashboard`), its test suite, a pre-existing test-suite flakiness found and fixed along the way, and this documentation update. |
| 7 | 2026-09-02, later still | Goal 10 — expiring membership alerts (`GET /api/members/alerts/expiring`, `POST /api/members/:memberId/alerts/membership-expiry/dismiss`), its test suite, and this documentation update. |
| 8 | 2026-09-02, later still | Final pre-frontend audit — documentation consistency, security/timezone/state-machine/SQL review, and (found during the audit) implementing the missing goal-1 member create/edit endpoints. |
| 9 | 2026-09-02, later still | The frontend — a React/Vite app covering every mandatory-goal workflow, two small backend additions it genuinely needed (CORS, room/instructor listing), a real cross-origin CSV-download bug found and fixed, and this documentation update. |
| 10 | 2026-09-02, later still | Automated browser E2E verification with Playwright — real Chromium driving the actual running frontend and backend; one genuine responsive-layout bug and one genuine pagination bug found and fixed along the way; this documentation update. |
| 11 | 2026-09-02, later still | Final frontend UI/UX polish — a full visual redesign, a fixed booking-table action column, a client-side recurring-generation UX pass, and a new public signup flow (migration 011, `POST /api/auth/signup`), each with new Playwright coverage; this documentation update. |
| 12 | 2026-09-03 | Full frontend visual redesign — design tokens, a hand-rolled icon set, a redesigned app shell with a real mobile drawer, split-screen auth pages, and every page rebuilt on the new component set; one small backend addition (`bookedCount` on `GET /api/sessions`); this documentation update. |
| 13 | 2026-09-03 | Account/member linking (migration 012), a member portal (browse/book/cancel, reusing the existing booking domain logic), a profile page for every role, forgot-password by email OTP (migration 013), and a reusable error-presentation system replacing raw `{status}: {message}` everywhere; this documentation update. |
| 14 | 2026-09-03 | A frontend-only correction: fixed a real Bookings table structural bug (a missing `<td>` shifted every cell one column left of its header), a small table/button polish pass, a full table-structure audit across the app, one duplicate-CSS leftover removed, a new Playwright regression test, and real screenshot-based visual QA; this documentation update. |
| 15 | 2026-09-03 | Final submission audit against `README.md` directly — one genuine gap found and fixed (CSV/formula injection in the attendance export, `domain/csv.js`); everything else audited already matched the brief with a real passing test; this documentation update. |
| 16 (this one) | 2026-09-04 | Fixed a real member session-browsing bug (a shared `justBookedId` scalar let booking one session silently revert another's displayed state) at both the API layer (`GET /api/member/sessions` now reports each session's own `myBooking`) and the frontend (state derived per-session, never a shared flag), and added class/date/availability filters to the same endpoint; this documentation update. |

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

## Session 6 — goal 8

Read in order before writing any code: `README.md`, `CLAUDE.md`, every `docs/*.md` file, the current
`SUBMISSION.md`, the entire existing backend source, migrations, seed, and test suite, and `git log` —
specifically to find whether any earlier commit had already established a semantic for "bookings made
today"/"no-shows this week"/"members currently waitlisted" before writing a single query. Two of the
three turned out to already have a forward-looking comment committed against them: the
`bookings_created_at` index (`008_bookings.js`) names "bookings made today" as its goal-8 use case, and
`sessions_starts_at` (`006_sessions.js`) names "Dashboard day/week windows" — both consistent with, and
read before, being given the exact same semantics as an instruction for this session.

Implementation order: the seven aggregate query functions (`domain/dashboard.js`) were written and
smoke-tested directly against the database (a throwaway Node script, not the test suite) before any
route or test existed, specifically to catch a SQL syntax mistake — a bad `generate_series` alias, a
mistyped `AT TIME ZONE` composition — as cheaply as possible; the smoke script's own output on the
real seeded database is also what made the case for delta-based rather than absolute-value testing
concrete rather than theoretical (`bookingsByClass` had over a dozen entries from other suites'
leftover permanent fixtures before this file's own tests had inserted anything). The route
(`routes/dashboard.js`) and `app.js` wiring came next, then `tests/dashboard.test.js`, written last and
matching the brief's own ten listed test categories directly.

One thing went wrong during verification, caught by the full suite (not the new dashboard tests
themselves, which passed clean on the first run) — see `docs/ai-prompts.md` for the full account: the
second `npm test --test-concurrency=1` run of the full suite failed a completely unrelated,
pre-existing test in `sessions.test.js` ("lets staff delete a session with no bookings") with a
spurious 409. The root cause predates this session entirely — `sessions.test.js`'s "Undeletable
Session Fixture" test uses a fixed, unrandomized `WINDOW_START`-relative offset for a session that, by
its own design, is never deleted, so every one of this project's many `npm test` runs across today's
several milestones left one more permanent leftover behind at nearly the same instant, and enough had
finally accumulated to instructor-conflict with an unrelated test two hours away. Fixed by giving that
fixture the same wide randomized-offset treatment (`p6Base`) the file already uses elsewhere for
exactly this failure mode, then a fresh `db:reset` to clear the accumulated leftovers and three clean
consecutive full-suite runs before continuing.

No time estimate was written down before starting, for the same reason `CLAUDE.md` gives for every
earlier goal in this record: recording one now would be inventing a development story after the fact.
What's true and checkable is the verification record: the new test file was run individually first (26
tests, clean on the first run), then the full suite twice (the second run is what surfaced the
pre-existing flakiness above), then the fix, a fresh `db:reset`, and three more consecutive clean full
-suite runs against it, `npm run lint` (clean throughout, no fix needed), and the real running server
smoke-tested over real HTTP — the full dashboard payload as staff, and a 403/401 for an instructor and
an unauthenticated request — before this file was updated.

## Session 7 — goal 10

Read in order before writing any code: `README.md`, `CLAUDE.md`, every `docs/*.md` file, `SUBMISSION.md`,
the entire backend source, migrations, seed, and test suite, and `git log` — specifically to find and
read `010_member_alert_dismissals.js`'s own comment before designing anything, since the instruction
for this session said the alert-dismissal design was already approved and should be preserved, not
reconsidered. That comment turned out to already contain the exact canonical SQL predicate this goal
needed, written when the table was first migrated in an earlier session; nothing about the predicate
itself was invented fresh here. The seed (`seeds/001_demo_data.js`) also turned out to already contain
a full set of goal-10 fixtures — members at every relevant offset (expired, expiring in 3/5/6 days, and
several safely outside the window) plus one already-dismissed member — created during the
schema-foundation session in anticipation of this goal, and used directly as smoke-test material rather
than re-derived.

Implementation order: the two pure additions to `domain/membership.js` (`isWithinAlertWindow`,
`daysUntilExpiry`) were written first, alongside the existing `isMembershipExpired` they sit next to,
since they have no database dependency; the two SQL-touching functions
(`domain/membershipAlerts.js#listExpiringMemberAlerts`/`getAlertWindowBounds`) came next and were
smoke-tested directly against the seeded database with a throwaway script before either route existed,
confirming the query's shape and the seed's own fixtures matched expectations exactly. The two routes
in `routes/members.js` came last, followed by `tests/membershipAlerts.test.js` and one more round of
manual smoke-testing against the real running server (recorded verification below) before touching any
documentation.

Nothing went wrong during this session that required a correction — the targeted test suite (22 tests)
passed on its first complete run, and no bug was found during the full-suite runs or the real-server
smoke test. The one genuine judgment call was recognizing, from having just built the dashboard the
session before, that this endpoint has the same "studio-wide, permanent-fixture-polluted" testing
problem goal 8 did — confirmed directly by the same throwaway smoke script, which showed several other
suites' leftover test members (created to exercise goal 4's "expired membership can't book" rule)
already sitting inside the alert window on a fresh look at the seeded database. Unlike the dashboard's
pure aggregates, though, every alert row carries a stable member id to key off of, so the fix here was
simpler than delta-based counting: every assertion checks for the presence or absence of one specific,
freshly-created member id in the response, never the response's overall contents. `members` also turned
out to be freely deletable (no `RESTRICT` foreign key points at it besides `bookings.member_id`, which
this suite's fixtures never touch, and `member_alert_dismissals` cascades) — so, unusually for this
project by now, the new test file cleans up its own fixtures in `after()` rather than leaving them
permanently.

What's true and checkable is the verification record: the new test file was run individually first (22
tests, clean on the first run), then the full suite twice (both clean), `npm run lint` (clean, no fix
needed), a fresh `db:reset`, the full suite again against it (clean), and the real running server
smoke-tested over real HTTP — listing alerts as staff, dismissing one, confirming it disappeared,
directly changing that member's expiry date and confirming the alert returned, and a 403/401 for an
instructor and an unauthenticated request on both endpoints — before this file was updated.

## Session 8 — final pre-frontend audit

Read in order before changing anything: `README.md`, `CLAUDE.md`, every `docs/*.md` file,
`SUBMISSION.md`, the entire backend source, migrations, seed, and test suite, `git status`, and
`git log --oneline --decorate --graph` from the very first commit. Scope was explicitly audit-and
-cleanup only — no frontend, no new features, no style refactors, no database changes absent a real
correctness defect.

Documentation was checked systematically rather than by re-reading prose and trusting memory: every
markdown table's column count was verified programmatically, every commit hash cited in `docs/*.md`
was checked against `git cat-file`, every doc's headers were checked for exact duplicates, and every
file was grepped for "not yet"/"not started"/"not implemented" phrasing to separate genuinely stale
claims from accurate historical record (a past prompt transcript correctly saying "goal 10 was not
started" *at the time that prompt was given* is not stale — it's history). Three real staleness issues
turned up this way: `docs/schema.md`'s `member_alert_dismissals` heading still read "not yet consumed
by an endpoint" after goal 10 shipped two endpoints that consume it; `docs/ai-prompts.md`'s intro
paragraph still claimed to cover "the two sessions that built goal 4 and goal 6" when the file had grown
to cover five; and `backend/src/app.js`'s own top comment still said "membership alerts (goal 10) are
not implemented yet" — never updated because goal 10 needed no new top-level route mount, so `app.js`
was never touched during that milestone. All three were corrected.

The security/timezone/state-machine/SQL review was evidence-based rather than a re-read of prior
documentation's own claims: every route's authorization middleware chain was extracted with `grep` and
checked against the actual handler body (not against what a comment said it did); `git diff` confirmed
the booking state-machine files (`bookingTransitions.js`, `bookingTiming.js`, `bookingTransaction.js`)
have been byte-for-byte unchanged since the goal-4 hardening commit, meaning no later goal quietly
touched the invariants goal 9 depends on; a repo-wide grep confirmed no `CURRENT_DATE`/
`CURRENT_TIMESTAMP` anywhere and that every `Date.now()` in application code is confined to JWT
issuance/expiry (a real-world wall-clock concern, not a studio-civil-day one); and every `Promise.all`
and sequential-`for`-loop-around-a-query in the codebase was individually inspected and confirmed to be
either running against the connection pool (safe) or a small, already-documented, bounded sequential
pattern (session-conflict checks, waitlist promotion, recurring-candidate processing) rather than an
accidental N+1.

One real finding came out of this: `POST /api/members` and `PATCH /api/members/:id` — goal 1's own
"add members and set their membership expiry" — had never been built. `routes/members.js` had said so
itself, in a comment present since the file's very first version, and nothing built after goal 1 ever
needed to write a member (every later feature only reads `members`), so the gap never surfaced as a
failing test. Whether completing an already-mandatory, already-claimed-"Done" goal counts as the "new
features" this audit's own instructions forbid, or as a defect an audit is supposed to catch, was
asked rather than guessed at (see Decision 21) — the answer was to fix it, immediately, following
`routes/classes.js`'s existing create/update-schema shape exactly. `tests/members.test.js` (19 tests)
was written to the same standard as every other resource's test file and passed on its first complete
run; the full verification sequence (targeted tests, full suite twice, lint, a fresh `db:reset`, the
suite again, a real-server smoke test covering all ten goals plus the new endpoints) was then re-run in
full, since the audit was no longer purely read-only.

## Session 9 — the frontend

Read in order before writing any code: `README.md`, `CLAUDE.md`, `SUBMISSION.md`, every `docs/*.md`
file, every backend route and its validation schema, and the existing (empty, scaffold-only)
`frontend/` directory — specifically so the API layer would be built against the actual request/
response shapes rather than a guess, matching the milestone's own explicit instruction.

Implementation order: reading every route file first surfaced one real integration gap before any
frontend code was written — nothing in the API could list rooms or instructors, only validate a single
client-supplied id, so the session-create and recurring-generation forms could not function without
either a blind numeric-id text field or two small new backend endpoints. Added `GET /api/rooms` and
`GET /api/users` (Decision 22) and CORS (Decision 23, `src/middleware/cors.js`) first, each with its
own test file, before any frontend file existed — the frontend was always going to need a working
backend to integrate against, not the other way around. The frontend itself was then built bottom-up:
the API client and error normalization first (`api/client.js`), then auth state
(`context/AuthContext.jsx`), then routing/navigation (`App.jsx`, `components/RouteGuards.jsx`,
`components/AppShell.jsx`), then one page per required workflow, each checked against its exact backend
response shape as it was written rather than assumed from memory of having built that backend.

Verification leaned on `curl` heavily — simulating the browser's exact request shape (cookies, an
`Origin` header, the same JSON bodies the frontend code sends) — precisely because interactive browser
tooling was not available this session (no Chrome extension connected). This was disclosed to the user
rather than silently substituted for; where it mattered, `curl`'s own limitations were treated as a
real constraint on what could be verified, not papered over. That limitation is exactly what caused one
real bug to be found later than it should have been:

**A real bug, and why `curl` couldn't have caught it sooner.** The attendance CSV download's filename
logic (`api/client.js#downloadResponse`) reads the `Content-Disposition` header from the fetch
`Response` — but `Content-Disposition` is not one of the response headers a browser exposes to
cross-origin JavaScript by default, and `curl` never enforces that restriction at all, so every `curl`
based check of the CSV endpoint showed the header present and looked correct. The bug was caught only
by reasoning explicitly about what a *real* browser's `fetch` would and would not expose across origins
— not by any tool run in this session — and confirmed by checking the CORS specification's response-
header safelist directly. Fixed by adding `Access-Control-Expose-Headers: Content-Disposition` to
`src/middleware/cors.js` (Decision 23), with `tests/cors.test.js` added specifically to pin this down
so it can never silently regress.

**The other thing corrected along the way** was a smaller frontend-only inconsistency, caught by
re-reading `sessionUpdateSchema` against the session-edit form rather than assuming the create and edit
forms could safely share one body shape: the edit form was building its request body with a `classId`
field that `PATCH /api/sessions/:id` has no field for at all (a session's class cannot change after
creation) — Zod's default "strip unknown keys" behavior meant this was never a hard error, only a
silently-ignored field, so the class dropdown looked editable during an edit while doing nothing.
Fixed by disabling that field (and labeling it) specifically when editing, and by not sending `classId`
in the edit request body at all.

What's true and checkable is the verification record: `npm run lint` and `npm run build` both clean on
the frontend at every stage they were run; the backend's full test suite (`npm test
--test-concurrency=1`) run twice, a fresh `db:reset`, and the suite run again against it — all clean,
391 tests passing with the one pre-existing skip carried over from earlier sessions; and the `curl`
-simulated end-to-end flow (login → dashboard → members → rooms/users → session create → session detail
→ booking create → settle/cancel → attendance CSV → instructor-restricted-access checks) run against
the real backend before any documentation was touched.

## Session 10 — automated browser E2E verification with Playwright

Read in order before writing any code: `README.md`, `CLAUDE.md`, `SUBMISSION.md`, every `docs/*.md`
file, `frontend/package.json`, and every frontend page component — specifically to collect exact
button/label/heading text before writing a single locator, rather than guessing and discovering
mismatches only at test-run time. The milestone's own instruction was explicit and non-negotiable: use
real Playwright browser automation, not `curl`, and disclose plainly if browser automation was ever
unavailable (it was available this session — no such disclosure is needed here, unlike goal 9's own
frontend session).

Implementation order: `frontend/playwright.config.js` and `frontend/e2e/fixtures.js` (shared
login/logout/diagnostics/unique-fixture helpers) were written first, since every spec file depends on
them; `auth.spec.js` came next as the smallest possible real test, specifically to prove actual browser
automation was working end to end (a real Chromium instance navigating, filling forms, clicking, reading
localStorage/cookies) before writing anything larger. `staff-flow.spec.js` (the full 36-step staff
journey), `instructor-flow.spec.js` (the 9-point authorization-boundary suite), and `responsive.spec.js`
were written last, once the page-text reconnaissance and the diagnostic-assertion pattern were both
already proven correct by the smaller suite.

### What was correct

The overall architecture — one `test.describe.serial` block per journey sharing a single real browser
page, `webServer` auto-starting both the real backend and the real Vite dev server, `workers: 1` so every
test runs against one live, shared Postgres database one at a time — worked as designed from the first
run. The `attachDiagnostics()` pattern (fail the test on any unexpected console error, page error, or
4xx/5xx response, while precisely allowlisting only the responses/console noise a test deliberately
triggers) caught every regression described below; nothing was found by inspection afterward that this
mechanism hadn't already failed a test on directly.

### What was wrong, and what was corrected

Running the suite repeatedly (required by this milestone, and standard practice for this project by now)
surfaced two real defects in the application itself, plus several test-only bugs — all caught by
Playwright actually driving a real browser, not by `curl`, which is exactly the class of gap this
milestone existed to close:

1. **A real, previously-undetected pagination bug.** `BookingsPage.jsx`'s `updateParam(key, value)`
   unconditionally ran `next.delete('page')` after setting whichever param it was called with — including
   when the key being set *was* `'page'` itself, since `Pagination`'s own `onPageChange` calls
   `updateParam('page', String(next))`. The "Next" button therefore set `page=2` in the URL and then
   immediately deleted it again in the same function call, so pagination silently did nothing at all —
   clicking "Next" left the list on page 1 forever. Every prior verification pass (backend tests, `curl`
   simulation) tested `GET /api/bookings?page=2` directly and never exercised the frontend's own click
   -to-navigate path, which is exactly why this had never been caught before. Fixed by only deleting
   `page` when the key being changed is *not* `page` itself (`frontend/src/pages/BookingsPage.jsx`),
   preserving the intended "any filter/sort change restarts pagination" behavior for every other key.
2. **A real, previously-undetected responsive layout bug.** No page wraps its `<table className="table">`
   in a scrollable container, and `.app-content` had no `overflow-x` rule of its own — on a narrow
   viewport, a wide table (e.g. the members table) forced the *entire page* to scroll horizontally,
   dragging the sidebar/nav out of view with it, rather than only the table itself scrolling. Caught by
   `responsive.spec.js` measuring `document.documentElement.scrollWidth` against `clientWidth` at a
   375px-wide viewport (169px of unwanted overflow) — a check `curl` has no way to perform at all, since
   it has no layout engine. Fixed with one added CSS property, `overflow-x: auto` on `.app-content`
   (`frontend/src/styles.css`), which contains the scroll to the content area rather than changing any
   page's markup.
3. **A false-positive login-success check in the test helpers themselves**, not an application bug:
   `fixtures.js#login()` originally waited for the text "Class Booking" to become visible as proof the
   authenticated app shell had rendered — but `LoginPage.jsx` itself also renders `<h1>Class Booking</h1>`
   as its own heading, so that wait condition was satisfied instantly, before the login request had even
   resolved, on every single call. Every test using `login()` happened to still pass, because each one's
   very next assertion (`toHaveURL(...)`) has its own several-second retry window that absorbed the real
   login latency invisibly — until a `test.beforeAll` hook with no such assertion in between (setting up
   fixture sessions for `instructor-flow.spec.js`) hit the race directly and hung for the full 30-second
   hook timeout, having navigated back to `/login` mid-fixture-setup. Fixed by waiting for the URL to
   actually leave `/login` instead of for any specific visible text.
4. **A locator-ambiguity bug in the tests, twice**, both from Playwright's default substring/case
   -insensitive text matching: `getByLabel('Class')` inside the session-create form also matched the
   Duration and Capacity fields, whose labels read "...defaults from class" — fixed by adding
   `exact: true`. Separately, `selectOption({ label: <RegExp> })` doesn't accept a pattern at all (only
   `getByLabel` does) — fixed by constructing the exact expected option string directly, since the test
   already knew both halves of it (the member's own generated name and email).
5. **A read-before-render race in one test**, not an application bug: reading `.pagination-summary`'s
   `textContent()` immediately after clicking "Next" raced the async page-2 fetch/re-render — the URL had
   already updated (that assertion passed) but the visible text hadn't yet. Fixed by asserting with
   `expect(locator).toHaveText(...)`, which polls until it matches or genuinely times out, instead of
   reading a one-shot snapshot.
6. **The date-fixture self-collision bug described in Decision 25** — a fixed day offset for E2E session
   fixtures colliding with the same suite's own previous run. Fixed exactly as that decision describes.

None of the above six needed a second correction after being fixed; each was re-verified by re-running
the specific failing test, then the full suite, before moving on.

### Verification

What was actually run, in order: `npm run lint` (clean) and `npm run build` (clean) on `frontend/`; the
full Playwright suite (`npx playwright test`, 32 tests across `auth.spec.js`, `staff-flow.spec.js`,
`instructor-flow.spec.js`, `responsive.spec.js`) — which surfaced the six issues above across several
iterations — then two full, clean, consecutive runs (32/32 passing both times) once every fix landed,
satisfying this milestone's own repeatability requirement; the backend's full suite
(`npm test --test-concurrency=1`, 391 tests, 390 passing, 1 skipped — the same pre-existing
`APP_DB_URL`-gated grants test every earlier session has also skipped); a fresh `npm run db:reset`; and
the backend suite once more against the freshly reset database (identical result). No backend test
regressed from any frontend-side change made this session.

## Session 11 — final frontend UI/UX polish

Read in order before changing anything: `README.md`, `CLAUDE.md`, `SUBMISSION.md`, every `docs/*.md`
file, the entire frontend source, and the current Playwright suite — specifically to find, before
touching any authorization code, exactly which existing checks a new account role would and would not
satisfy (see Decision 26), and to confirm which existing Playwright locators were role/text-based
(safe to redesign around) versus structural (which would have constrained the CSS rewrite).

Implementation order: the signup backend (migration `011_user_role_member.js`, `POST /api/auth/signup`,
`tests/signup.test.js`, a member-role addition to `tests/authorization.test.js`) came first, since every
other piece of this milestone was frontend-only and this was the one place a genuine backend change was
both needed and explicitly pre-authorized by the milestone's own instructions ("add a backend endpoint
only if signup cannot be implemented entirely with the current backend API" — it could not, since no
self-service role existed at all). The full `styles.css` rewrite came next, before touching individual
pages, since every page already shared the same class names and a redesigned stylesheet is what let the
bookings-table fix, the Classes-page polish, and the new Signup/Welcome pages all inherit consistent
typography/spacing/focus states for free rather than each page reinventing them. The bookings-table
fixed-action-column fix (Decision 28) and the Classes-page polish came next, then the
`RecurringSessionsPage` rewrite (the largest single piece of new client-side logic this session), then
the signup frontend (`SignupPage.jsx`, `WelcomePage.jsx`, routing, `AuthContext`), each verified with a
targeted Playwright run before moving to the next.

### What was correct

Auditing every `requireRole(...)`/`role !== 'staff'` check in the backend *before* writing the
migration, rather than after, meant the new `member` role's authorization boundary was designed to be
safe by construction rather than discovered to be safe by testing afterward — the new
`tests/authorization.test.js` boundary suite (4 tests) and `tests/signup.test.js` (9 tests) both passed
on their first complete run. The CSS redesign — touching nearly every rule in `styles.css` — needed zero
changes to any pre-existing Playwright locator: all 28 tests in `auth.spec.js`, `staff-flow.spec.js`,
`instructor-flow.spec.js`, and `responsive.spec.js` passed unchanged on the first run after the
redesign, confirming those tests were genuinely role/label/text-based rather than accidentally coupled
to markup this session rewrote.

### What was wrong, and what was corrected

One real bug in this session's own new Playwright test, not in the application — detailed in full in
`docs/ai-prompts.md`'s account of this session, summarized here: the first version of the
"conflicting recurring session" test created its fixture session through the existing session-create
form and expected it to collide with a recurring-generation attempt at "the same" local time. It did
not, because the two forms deliberately convert "local time" using two different, both-correct timezone
bases (the browser's own timezone vs. `STUDIO_TIMEZONE`) — a genuine, pre-existing, intentional property
of the application this milestone's own instructions required leaving unchanged, not a bug to fix.
Root-caused by querying the database directly for the two sessions' actual stored instants (4.5 hours
apart, matching IST-vs-BST exactly) rather than guessing from the UI. Fixed by creating both the fixture
and the conflicting attempt through the same form, not by changing any application timezone logic.

### Verification

What was actually run, in order: backend `npm test` (404 tests, 403 passing, 1 skipped — the three new
signup/authorization tests are the entire delta from the previous milestone's 391) and `npm run lint`
(clean); frontend `npm run lint` and `npm run build` (both clean); the full Playwright suite
(`npx playwright test`, 41 tests — the previous milestone's 32 plus a new `polish.spec.js` with 13) —
which surfaced the timezone-basis test bug above, then two full, clean, consecutive runs (41/41 both
times) once it was fixed; a fresh `npm run db:reset` (now applying 11 migrations) followed by the
backend suite once more (identical 404/403/1/0 result) and the Playwright suite once more against the
freshly reset database (41/41). Every one of the twelve concrete flows this milestone's own instructions
listed is covered by name in `polish.spec.js`, `staff-flow.spec.js`, or `instructor-flow.spec.js` — see
`SUBMISSION.md` for the mapping.

One further, more extended verification pass ran the suite six more times in a row. Five were clean;
one failed a single test (`staff-flow.spec.js`'s "creates a session... then opens its detail" step) with
no code change in between it and the clean runs immediately before and after it. Investigated rather
than dismissed: that specific test's code is unchanged from the previous Playwright milestone, already
debugged there, and re-running it four more times immediately afterward reproduced nothing — no failure
recurred. Recorded honestly as an isolated, non-reproducible timing blip rather than a fixed bug, since
there was no code-level cause to identify or a fix to make; the required "run at least twice, both
clean" bar was independently met multiple times before and after it, including the final two official
verification runs immediately above.

## Session 12 — full frontend visual redesign

Read in order before changing anything: `README.md`, `CLAUDE.md`, `SUBMISSION.md`, every `docs/*.md`
file, the entire frontend source, and the current Playwright suite — specifically to catalogue, before
writing any CSS, which existing class names every page already depended on (so a stylesheet rewrite
could stay a redesign of those classes' own rules rather than a rename that would force touching every
page), and to note which locators in the existing suite were role/label/text-based versus structural.
Then, before writing any component, an actual visual audit: the real running app launched with a
throwaway Playwright script, screenshots taken of every major page at desktop and mobile, and looked at
— not assumed — to find concrete weaknesses (no icons anywhere, a `.btn` missing `text-decoration: none`
so an anchor-styled-as-button showed a stray underline, an unbounded "bookings by class" list, a mobile
nav that was just the desktop sidebar shrunk) before deciding what to build.

Implementation order: shared building blocks first — `Icon.jsx`, `Avatar.jsx`, `MetricCard.jsx`,
`AuthLayout.jsx`, and the full `styles.css` token/component rewrite — since every later page rewrite
depended on these existing first, not on rewriting each page's CSS inline as it went. `AppShell.jsx`
(the highest-leverage single change, present on every page) came next, verified with its own screenshot
pass before touching any individual page. Login/Signup came next (the first thing a recruiter opening
the app actually sees), then Dashboard ("the strongest page visually," per the milestone's own
instruction), then Classes/Members/Alerts, then the more complex Sessions/Session Detail pair (which
needed the one small backend addition, Decision 31), then Bookings/Booking Detail, then
RecurringSessionsPage last, since its client-side validation logic was already correct from the previous
milestone and only needed the new visual language applied around it. A screenshot check followed each
page, not just at the end — see "What was wrong" below for what several of those checks actually caught.

### What was correct

Cataloguing existing class names and locator conventions before writing a single line of CSS paid off
directly: 28 of the 41 pre-existing Playwright tests needed zero changes across a rewrite that touched
nearly every rule in `styles.css` and the JSX of every page in the app. The decision to keep
`RecurringSessionsPage`'s validation/preview *logic* completely untouched and only change its visual
presentation meant that page's most complex client-side code (candidate-date counting, weekday-coverage
detection, the single-day-mismatch message) needed no re-verification beyond confirming the wording
change in one test assertion (see below) — the logic itself was already correct and stayed correct.

### What was wrong, and what was corrected

Five real issues, every one caught by either a screenshot actually being inspected or the required
Playwright re-run actually being executed — full detail for each is in `docs/ai-prompts.md`'s account of
this session:

1. A missing `text-decoration: none` on the shared `.btn` class, found by inspecting a screenshot and
   confirmed with `getComputedStyle` rather than guessed.
2. Three empty, meaningless CSS rule bodies briefly left behind mid-edit, caught by a deliberate sweep
   for empty `{ }` blocks before they were ever run against.
3. Two Playwright regressions from the new off-canvas mobile drawer and the new dashboard greeting
   heading — both intentional behavior changes, fixed by updating the tests to match the new (better)
   behavior, not by reverting the redesign.
4. A real locator collision between a new dashboard alert banner's link text and the pre-existing
   "Members" nav link, caught by the Playwright run itself failing with a strict-mode violation.
5. A repeat of Decision 31's own fixture-cleanup lesson in the `bookedCount` backend test, caught
   immediately by the full suite failing an unrelated later test with a foreign-key error, and fixed by
   applying `sessions.test.js`'s own already-documented pattern for a session that carries a real,
   permanent booking.

The wording of the recurring-generation preview also changed ("N sessions will be attempted" → "N
sessions will be generated," matching the milestone's own example phrasing) — a deliberate copy
improvement, not a bug, but it required updating the two `polish.spec.js` assertions that had pinned the
old wording, which was done alongside the rest of the verification pass rather than treated as a
separate fix.

### Verification

What was actually run, in order: backend `npm test --test-concurrency=1` (406 tests, 405 passing, 1
skipped — the two new `bookedCount` tests are the entire delta from the previous milestone's 404) and
`npm run lint` (clean); frontend `npm run lint` and `npm run build` (both clean); the full Playwright
suite (`npx playwright test`, still 41 tests — no tests were added this session, several were corrected)
— which surfaced the mobile-drawer and dashboard-heading regressions and the "Members" locator collision
above, then two full, clean, consecutive runs (41/41 both times) once every fix landed; a fresh
`npm run db:reset` followed by the backend suite once more (406/405/1/0, identical) and the Playwright
suite once more against the freshly reset database (41/41). A further screenshot pass covered every page
this milestone's own instructions listed by name (login, dashboard, classes, sessions, bookings,
recurring sessions, members, alerts, session detail, signup, plus booking detail) at 375px, 768px,
1024px, and 1440px, including a direct `page.evaluate` check that a visually-wide table (Bookings, six
columns) scrolls only within its own `.table-scroll` container — zero page-level horizontal overflow —
rather than dragging the whole page sideways.

## Session 13 — account/member linking, member portal, profile, forgot-password, error-presentation system

Read in order before changing anything, matching the milestone's own explicit audit-first instruction:
`backend/src/routes/auth.js`, `bookings.js`, `members.js`; `backend/src/auth/{password,tokens,cookies}.js`
and `middleware/{authenticate,authorize,sessionAccess}.js`; `backend/migrations/002_users.js` and
`003_members.js` (specifically to confirm `members.email` is deliberately non-unique, the single most
load-bearing fact for how account linking could safely work at all); `backend/src/domain/
bookingTransaction.js`, `bookingTiming.js`, `bookingTransitions.js`, `membership.js`; the full frontend
`AuthContext.jsx`, `App.jsx`, `AppShell.jsx`, `components/States.jsx`, `api/client.js`; and a grep across
`backend/src/` for any existing email/OTP/rate-limiting code (none — confirmed the entire email/OTP
subsystem had to be built from nothing, not adapted from something already there).

Implementation order: schema first (`012_members_user_link.js`, `013_password_reset_otps.js`, applied and
`schema.test.js` updated for the new table/columns before writing anything that depended on them); then
backend domain/auth primitives with no route yet attached (`domain/memberLinking.js`, `auth/otp.js`,
`auth/resetTokens.js`, `email/emailService.js`) — small, independently reasoned-about pieces before
wiring them into HTTP; then the signup rework and the three forgot-password routes in `routes/auth.js`;
then `routes/profile.js`; then the booking-domain-logic extraction (`createBookingInTransaction`/
`cancelBookingInTransaction` pulled out of the existing staff `routes/bookings.js` handlers, that route
re-verified against the full existing suite before writing a single line of the new member route) and
`routes/memberBookings.js` built on those same two functions; backend tests were written and run
file-by-file as each piece landed, not batched to the end. Only once the whole backend surface was
green did the frontend start: the error-presentation system first (`errorCopy.js`, the `States.jsx`
rewrite) since every later page would use it; then the five new/replaced pages; then `AppShell`/`App.jsx`
routing; then the two new Playwright spec files plus the necessary updates to three existing ones for the
redesign's intentional copy/route changes; then the required screenshot-based visual QA pass, which is
what caught the Session's one real bug (see below); then documentation; then the single commit.

### What was correct

The transactional link-or-create design, the ambiguous-multiple-match fallback, the OTP security model
(hashed storage, expiry, attempt limit, request cooldown, generic anti-enumeration response), reusing the
exact booking-domain functions between staff and member routes, and redesigning `ErrorBanner` in place
rather than as a new component every page would need migrating to — all worked as designed the first
time, verified by the new test suites rather than merely asserted. See `docs/ai-prompts.md`'s account of
this session for the full "what was correct" detail.

### What was wrong, and what was corrected

One real product bug and several test-authoring mistakes, every one caught by actually running the
required verification rather than assumed clean — full detail for each is in `docs/ai-prompts.md`'s
account of this session:

1. A fresh, unlinked signup's starting membership expiry was set to *today*, which — because
   `isMembershipExpired` is a strict `<` — left it bookable for the rest of that day, a real (if
   short-lived) free membership. Not caught by any test (every existing expired-membership test used an
   explicit, obviously-past date); caught by actually reading the member home page's rendered membership
   badge during the required screenshot review. Fixed to yesterday's date instead, with a new backend
   test added to close the coverage gap the first pass's own suite had missed — documented as a reversed
   decision (`docs/decisions.md`, Decision 42), the one required "later reversed" entry for this project.
2. The redesigned error copy intentionally broke three pre-existing Playwright assertions pinned to the
   old raw text/old placeholder page (a login-failure message, a raw `'403'` substring, and the old static
   `WelcomePage`'s heading/nav) — all three were the *intended* consequence of the redesign, fixed by
   updating the assertions to match the new, correct behavior, not by watering down the redesign.
3. A new backend test file's cleanup hook tried to delete fixtures that had become permanently
   undeletable (a member who booked and cancelled writes `booking_events` rows referencing their own,
   now-`RESTRICT`-protected user id) — the failed delete threw before the server/DB connection were ever
   closed, hanging the test process indefinitely. Root-caused by checking for a stuck database query first
   (there wasn't one) before concluding it was a leaked resource, and fixed by adopting this project's own
   already-established "unique per run, never cleaned up" fixture pattern instead of forcing the delete.
4. Several Playwright locator ambiguities in the two new spec files (a "New password" field matching
   both itself and "Confirm new password"; a sidebar "My Bookings"/"Profile" link matching a same-named
   quick-action button on the member home page; a dev-OTP fetch racing the request it was meant to read
   the result of) — all caught by the suite actually failing with a strict-mode violation or a timeout,
   all fixed by scoping the locator or adding the missing wait, none a product bug.

### Verification

What was actually run, in order: backend `npm test --test-concurrency=1` (449 tests passing, 1 skipped —
the same `APP_DB_URL`-gated schema test, skipped whenever that optional role isn't configured, same as
every earlier session) and `npm run lint`, both clean, run twice consecutively; frontend `npm run lint`
and `npm run build`, both clean; the full Playwright suite (`npx playwright test`, 63 tests — 41
pre-existing plus 22 new across `member-portal.spec.js` and `account-security.spec.js`, plus one new test
added to `responsive.spec.js`'s existing parametrized viewport loop), run twice consecutively, both times
63/63 clean; a fresh `npm run db:reset` (cleanly applying all 13 migrations from zero and re-seeding),
followed by the backend suite once more (450 tests, 449 passing, 1 skipped — identical shape) and `npm run
lint` (clean) against the fresh database, then the full Playwright suite once more (63/63, clean) against
it. A genuine screenshot-based visual QA pass followed, via a throwaway script (not committed) driving a
real Chromium browser at 375px/768px/1024px/1440px across every page this milestone's own instructions
named by name (Login, Signup, Forgot Password at both its email and OTP steps plus an error state,
Dashboard, Member Home, Member Sessions, My Bookings, Profile for a member and for staff, Classes,
Bookings, Recurring Sessions, and the redesigned login error state) — this is what caught the membership-
expiry bug above; a second pass confirmed the fix.

## Session 14 — Bookings table structure bug fix and final visual QA

A short, explicitly scoped correction session, not a new milestone: no new business functionality, no
backend changes, no re-redesign. The user reported the rendered Bookings page's row content visually
misaligned with its own column headers and gave a concrete example of what they saw. Before writing any
fix, the actual claim was verified directly — `BookingsPage.jsx`'s table JSX was read, then the real page
was rendered with Chromium and `table.table thead th`/first-row `td` counts were compared programmatically
(6 vs. 5), confirming a genuine structural bug: the class title had been folded into the Member cell
instead of getting its own `<td>`, leaving one header (`Class`) with no cell of its own and shifting every
following cell — session time, status, booked-at, the Cancel button — one column left, with nothing under
`Actions` at all.

Fixed by restoring the missing `<td>` and moving each field back to the column its own header names,
using the member's email (already in the existing API response) as the Member cell's secondary line in
place of the class title. Once the structure was correct, a small polish pass followed: the Session and
Booked-at columns no longer wrap their timestamps across two lines, cell padding was opened up slightly,
and the Cancel button gained a subtle border so it reads as a defined control at rest. Every other table
in the app (Members, Classes, Sessions, Session Detail, Alerts) was audited the same way — header/cell
counts compared, each row's field assignment read directly — and all five were already correct; the bug
was isolated to Bookings, so nothing else was rewritten. One genuine leftover was found and removed: a
duplicate `.field-error` CSS declaration from the previous session's own work.

A new Playwright test was added specifically to guard this bug's exact shape (pinning each header to its
own cell by content, not just by count) — and, before trusting it, was verified to actually fail against
the pre-fix code (the fix was stashed, the test re-run, a real "Expected: 6, Received: 5" failure
confirmed, then the fix restored) rather than assumed to be a meaningful regression test.

### Verification

Backend `npm test --test-concurrency=1` (450 tests, 449 passing, 1 skipped — unchanged, no backend files
touched) and `npm run lint`, both clean; frontend `npm run lint` and `npm run build`, both clean; the full
Playwright suite (64 tests — the 63 from Session 13 plus the one new structure-regression test), run twice
consecutively, both times clean; a fresh `npm run db:reset` followed by the backend suite once more
(450/449/1, identical) and the Playwright suite once more against the freshly seeded database (64/64,
clean). Real screenshots were captured with Chromium against the freshly reset database at 1440px/375px
for Dashboard, Members, Classes, Sessions, Bookings, Session Detail, Recurring Sessions, and Profile
(desktop) and Dashboard, Bookings, Sessions, and Profile (mobile), with `document.documentElement.
scrollWidth - clientWidth` measured as exactly `0` on every mobile page. The Bookings screenshot was
specifically inspected by eye against the exact structure required — member name and email under Member,
class title under Class, session date/time under Session, status badge under Status, booked-at timestamp
under Booked at, Cancel button or em-dash placeholder under Actions — and confirmed correct, not merely
inferred from the passing test.

## Session 15 — final submission audit

A verification-only session: re-read `README.md` in full from the repository (not from any earlier
summary), built a private requirement-by-requirement checklist against it, and verified each of the ten
mandatory goals against actual code, an actual passing test, and actual documentation — not against
whether a page merely existed. This included directly inspecting the `booking_events` immutability
trigger migration and its live test coverage (goal 9, treated as high-priority per this session's own
instruction), the recurring-generation same-batch-conflict handling, the half-open overlap-interval
predicate, the membership-alert window's exact boundary tests (+7 included, +8 excluded), the nav badge's
shared predicate with the Alerts page, a grep of the entire frontend for raw status-prefix/stack-trace/
SQL leakage, the git history and working tree for accidental artifacts or secrets, and the full env-var/
CORS/cookie/production-startup deployment-readiness checklist.

One genuine gap was found and fixed: the attendance CSV export (goal 7) had no protection against CSV/
formula injection in the member-name field — see `docs/decisions.md`, Decision 43, for the full
reasoning and `docs/ai-prompts.md` for this session's account of finding and verifying it. Nothing else
audited required a code change: every other goal's authorization boundary, concurrency protection, and
documented behavior matched what `README.md` actually asks for, backed by a real, currently-passing test.
One observation, not a fix: goal 4's concurrency test suite explicitly races booking creation, capacity
changes, and cancellation-triggered promotion, but has no *concurrent* duplicate-cancel or concurrent-
settlement race test specifically (only a sequential "reject cancelling an already-cancelled booking"
test) — both paths go through the identical session-then-booking lock protocol the other race tests
already prove correct, so this is recorded as a coverage gap worth knowing about, not a defect being
claimed or silently ignored.

`.Rhistory` remains present and untracked in the working tree, exactly as it was found at the start of
the very first session of work in this repository — pre-existing, unrelated to this project, and left
untouched per this session's own explicit instruction not to remove it without cause.

### Verification

Backend `npm test --test-concurrency=1` — 451 tests, 450 passing, 1 skipped (the same `APP_DB_URL`-gated
schema test every earlier session also skips) — and `npm run lint`, clean. Frontend `npm run lint` and
`npm run build`, clean. The full Playwright suite, 64 tests, run twice consecutively (64/64 both times).
A fresh `npm run db:reset` (cleanly applying all 13 migrations from zero and re-seeding) followed by the
backend suite once more (451/450/1, identical) and `npm run lint` (clean), then the Playwright suite once
more against the freshly reset database (64/64, clean).

## Session 16 — member session-browsing state bug, and session filters

A user-reported bug: on the member session-browsing page, booking a second session visually reverted the
first session's card from "Booked" back to "Book," even though the backend's own booking was correct (it
still showed in My Bookings). Investigated before writing any fix: `MemberSessionsPage.jsx` tracked "the
session I just booked" in one scalar, `justBookedId`, set to the newly-booked session's id and never
reconciled against anything authoritative — booking a second session overwrote it, so the *first*
session's card, which had no other source of booking state to read from, fell back to rendering its
default "Book" button. Checking the backend confirmed the deeper issue: `GET /api/member/sessions` never
told the client which sessions the caller had already booked at all — there was no way to derive correct
state, per-session, from what the API returned, only from a single click the client happened to remember.

Fixed at both layers, not just the frontend symptom (see `docs/decisions.md`, Decision 44):
`GET /api/member/sessions` now reports each session's own `myBooking` field, and gained three query
filters (`classId`, `dateFrom`/`dateTo` — resolved to studio-local day boundaries via the same
`AT TIME ZONE` mechanism `recurringSchedule.js` already established, never a JavaScript-side timezone
conversion — and `availability=available|full|mine`). The class filter reuses the existing
`GET /api/classes` endpoint, already readable by any authenticated role; no new endpoint was needed for
it. The frontend now derives every card's state from `session.myBooking`, and tracks in-flight booking
requests in a `Set<sessionId>` rather than a scalar.

Verified the bug, not just fixed it: wrote the Playwright regression test first, then temporarily
reverted only the frontend page file (keeping the backend fix and the test in place) and re-ran it,
confirming a real failure at the exact assertion the bug predicts — session A's "Booked" text missing
after booking session B — before restoring the fix and confirming the same test passes clean.

### Verification

Backend `npm test --test-concurrency=1` — 457 tests, 456 passing, 1 skipped (unchanged shape) — and
`npm run lint`, clean. Frontend `npm run lint` and `npm run build`, clean. The full Playwright suite, 70
tests (64 before this session plus 6 new), run twice consecutively, both times clean.

## What was cut

Nothing was cut from goal 4's own scope — all eight specified phases, including the full required
concurrency-test battery, landed. Nothing was cut from goal 6's scope either — search, every filter,
the sort whitelist with its deterministic tiebreaker, pagination, and the total count all landed, along
with the full IDOR/security regression battery the brief asked for. Nothing was cut from goal 7's scope
either — recurring generation's full candidate-expansion/conflict/duplicate/DST behavior and the
attendance CSV's full authorization/escaping/status battery both landed, matching every test category
the brief listed. Nothing was cut from goal 8's scope either — all four headline numbers, both
breakdowns, and the eight-week attendance chart landed, each SQL-aggregated and covered by the
boundary/authorization/determinism tests the brief's own test-category list asked for. Nothing was cut
from goal 10's scope either — the full alert predicate (window boundaries, expiry-today validity),
dismissal (idempotency, the not-in-window rejection, the reappear/re-suppress lifecycle across an
expiry change), and the full authorization/IDOR battery the brief's own twenty-item test list asked for
all landed. Goal 1's member create/edit gap, present since the earliest session this record can see,
was found and closed during the final audit rather than left undocumented. All ten mandatory goals are
now genuinely done and tested.

The frontend covers every required workflow the milestone listed — dashboard, member CRUD, alerts and
dismissal, class CRUD/archive/restore, session CRUD, co-instructor management, recurring generation
with created/skipped rendered in full, booking search/filter/sort/pagination, booking create/cancel/
settle, the immutable history timeline, and the attendance CSV download — nothing from that list was
skipped. What was not attempted, deliberately, per that session's own restriction at the time: live
interactive browser testing (no Chrome extension was connected in the session that built the frontend;
verification there leaned on `curl`-simulated requests and a careful reading of the actual browser
CORS/fetch specification where `curl` alone could not tell the whole story). That gap was closed in
session 10 above with real Playwright browser automation, which is exactly what caught the two real
application bugs (pagination, responsive layout) `curl` had no way to see.

Session 11's own polish milestone added a public signup flow (a real, minimal, authenticated `member`
role) at the user's explicit request — this is infrastructure for the "online self-service booking for
members" stretch idea listed in `README.md`, not that stretch idea itself: a signed-up member can log
in and out, but there is still no booking capability for them anywhere in the product (see Decision 27,
and `docs/architecture.md`'s "What was deliberately not built" section). No stretch idea is complete,
and `SUBMISSION.md` says so plainly rather than letting a working signup form read as more than it is.

Session 13 closed that gap: a signed-up member can now actually browse and book real sessions, view and
cancel their own bookings, and self-service booking is genuinely built, not merely infrastructure toward
it (see Session 13 above, and `docs/architecture.md`'s "What was deliberately not built" section, updated
to reflect this). Nothing from that session's own instructions was cut — every numbered requirement
(account linking, the member portal, profile for every role, forgot-password by OTP, and the
error-presentation system) landed and is tested. What remains deliberately unbuilt going into this
milestone, each a documented, bounded gap rather than a silent omission: a verified email-change flow,
session revocation on password change, and integration with a real (as opposed to swappable-but-
unexercised) transactional email provider — see `docs/architecture.md` for why each was set aside and
`SUBMISSION.md` for what a next iteration would prioritize.
