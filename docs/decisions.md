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

## Decision 7

- **Chose:** `GET /api/bookings`'s count query and page query are both `.clone()`s of one base Knex
  query object — the joins, the instructor scope, and every active filter built exactly once.
- **Rejected:** Two independently written queries, one `COUNT(*)` and one `SELECT ... LIMIT/OFFSET`,
  each re-expressing the same scope-and-filter predicate.
- **Why:** Two hand-maintained copies of an authorization predicate are a maintenance trap, not just
  extra typing — the day someone adds a new filter (or fixes a scoping bug) to one copy and forgets the
  other, `total` silently stops meaning "how many rows match what the page actually enforces," and
  nothing in the code would catch that drift. Cloning one query object makes the two structurally
  identical by construction, so the failure mode is closed rather than merely documented against.

## Decision 8

- **Chose:** `GET /api/bookings` defaults to `sort=bookedAt&direction=desc` — the most recently created
  booking first — when neither is supplied.
- **Rejected:** Defaulting to ascending order, matching the insertion-order `ORDER BY created_at asc`
  the goal-4-era placeholder endpoint used.
- **Why:** The brief doesn't state a default, and the placeholder's ascending order was never a
  deliberate choice — nothing (no frontend, no documented contract) depended on it, since goal 6 is the
  first time this endpoint's ordering is part of a stated contract at all. Staff and instructors opening
  a booking list are almost always checking on recent activity, not the studio's oldest booking, so
  newest-first is the more defensible default for the actual use case the brief describes ("finding
  bookings").

## Decision 9

- **Chose:** Resolve each recurring-generation candidate's local wall-clock time to its stored
  `timestamptz` instant with PostgreSQL's own `(local_string::timestamp AT TIME ZONE ?)`, run once
  per candidate inside the generation transaction.
- **Rejected:** A hand-rolled JavaScript conversion — the standard "guess an instant, ask `Intl` what
  wall-clock time that instant reads as in the target zone, correct the guess by the difference,
  repeat" iterative technique that libraries like `luxon`/`date-fns-tz` use, implemented directly
  against `Intl.DateTimeFormat` with no new dependency.
- **Why:** `seeds/001_demo_data.js#insertSession` already solves this exact problem this exact way —
  DST correctness for the whole application already rests on Postgres's own IANA tzdata through that
  one code path. Writing a second, independent DST-aware conversion in JavaScript for goal 7 would
  mean two implementations of the same non-trivial correctness property that could, in principle,
  quietly disagree with each other at exactly the DST-transition dates where it matters most. Reusing
  the existing mechanism is both less code and a stronger correctness guarantee than a from-scratch
  one would be, at the cost of one extra tiny round-trip per candidate inside the transaction — cheap
  at this scale, and no different in kind from the per-candidate conflict-check queries the design
  already requires.

## Decision 10

- **Chose:** `POST /api/sessions/recurring` rejects a request whose date range and weekday pattern
  would expand to more than 500 candidate sessions, with a 400 before opening any transaction.
- **Rejected:** No limit at all.
- **Why:** Nothing in the brief bounds the date range a recurring request can cover, and the brief
  explicitly says not to invent requirements — so this is not a business rule, it's an operational
  safety valve: an unbounded range (a typo'd end year, say) would otherwise expand into an unbounded
  number of sequential per-candidate queries inside one open transaction. 500 candidates is generous
  for a single studio's weekly schedule (roughly 9.6 years of one weekly slot) while keeping a
  worst-case request's cost finite and fast to reason about.

## Decision 11

- **Chose:** A candidate that exactly matches an already-existing session (same class, primary
  instructor, room, and instant) is skipped with the specific reason `existing_session`, checked
  *before* the general room/instructor conflict check.
- **Rejected:** Letting an exact duplicate fall through to the generic `room_conflict`/
  `instructor_conflict` check, which would also correctly skip it (a session cannot overlap itself
  any more completely) but under a less informative reason.
- **Why:** The brief specifically asks for repeated identical generation requests not to blindly
  create duplicates, with a suggested reason name of exactly `existing_session`. An exact match is a
  qualitatively different situation from a partial scheduling conflict with some *other* session — a
  caller re-running the same request to see what's still missing needs to be able to tell "this exact
  session already exists" apart from "this slot is blocked by something else" — so it gets its own
  reason rather than being folded into the conflict machinery's output.

## Decision 12

- **Chose:** The attendance CSV's own small serializer (`domain/csv.js`, roughly a dozen lines) over
  a CSV library.
- **Rejected:** `csv-stringify` or a similar package.
- **Why:** The brief itself says not to add a large dependency for a tiny serializer, and RFC 4180's
  escaping rule really is one `if`: quote a field only when it contains a comma, a double quote, or a
  line break, and double any embedded quote. A five-line function is easier to read, review, and
  trust than auditing a new dependency's API and defaults for this single call site.

## Decision 13

- **Chose:** `GET /api/dashboard` is staff-only (`requireRole('staff')`), with no instructor-facing
  variant at all.
- **Rejected:** An instructor-scoped dashboard (own-sessions-only headline numbers), or a dashboard
  that returns different data depending on role.
- **Why:** The brief never asks for an instructor-facing dashboard, and every metric it does ask for —
  sessions today, bookings made today, no-shows this week, members waitlisted, the status/class
  breakdowns, the attendance chart — is a studio-wide aggregate with no session/class/room predicate
  in it anywhere; there is no natural way to "scope" a count of every member currently waitlisted to
  one instructor's sessions without inventing a metric the brief never described. Building an
  instructor-scoped version would mean inventing capability, and exposing the studio-wide version to
  instructors would leak exactly the kind of studio-wide operational data `GET /api/members` already
  restricts to staff for the same reason.

## Decision 14

- **Chose:** "No-shows this week" is keyed by the *session's* scheduled instant
  (`sessions.starts_at`), not by when the booking was created or settled to `no_show`.
- **Rejected:** Keying it by `bookings.updated_at` (when the status last changed) or
  `bookings.created_at` (matching "bookings made today"'s own basis, for consistency).
- **Why:** A no-show is an attribute of the session that happened — the class ran, and someone who
  was booked didn't show up — not an attribute of when staff got around to recording it. Settlement
  can legitimately happen any time after a session finishes; keying this count by settlement time
  would make a session from three weeks ago appear in *this* week's no-show count just because staff
  marked it late, which misrepresents what "this week" is supposed to describe. `bookings.created_at`
  fares no better — a booking made weeks before its session ran has nothing to do with which week the
  no-show actually happened in. `tests/dashboard.test.js` pins this directly with a booking created
  ten weeks before a this-week session it belongs to.

## Decision 15

- **Chose:** "Members currently waitlisted" counts distinct members (`COUNT(DISTINCT member_id)`), not
  waitlisted bookings.
- **Rejected:** A plain `COUNT(*)` of waitlisted bookings.
- **Why:** The brief's own wording is "members currently waitlisted", not "waitlist entries" — and the
  two genuinely differ: nothing stops one member from being waitlisted on two different sessions at
  once (the partial unique index only prevents two *active* bookings for the *same* session), and a
  studio-wide headline number is more useful answering "how many people are waiting on something"
  than "how many waitlist rows exist". `tests/dashboard.test.js` checks this explicitly: the same
  member waitlisted on two sessions moves the count by one, not two.

## Decision 16

- **Chose:** Every dashboard time-window predicate is a sargable range against the raw indexed column
  — `starts_at >= windowStart AND starts_at < windowStart + interval` — with the boundary computed
  once as `date_trunc('day'|'week', now() AT TIME ZONE tz) AT TIME ZONE tz`.
- **Rejected:** Wrapping the column itself in an expression and comparing for equality —
  `(starts_at AT TIME ZONE tz)::date = today`.
- **Why:** The wrapped-column form reads slightly more directly ("this row's local date equals
  today"), but it makes the existing `sessions_starts_at`/`bookings_created_at` indexes unusable for
  the comparison, since a B-tree index on a plain column can't be used to satisfy a predicate on an
  expression built from that column. The range form compares the untouched column directly, so the
  existing indexes still apply, and it's the same "local civil boundary, computed once as a real
  instant" idiom recurring-session generation and `lockSessionForBooking`'s `studioToday` already use
  — reused, not reinvented, for a third time.

## Decision 17

- **Chose:** `bookingsByStatus` always includes all five statuses (zero for one with no bookings);
  `bookingsByClass` only includes classes with at least one booking (nothing for a class with zero,
  including a brand-new or archived one).
- **Rejected:** Treating both the same way — either padding `bookingsByClass` with every class at
  zero, or letting `bookingsByStatus` silently omit a status with no bookings.
- **Why:** The two breakdowns aren't symmetric. `booking_status` is a small, fixed enum known at
  compile time — always returning all five, deterministically, is what makes "no bookings of that
  status yet" render as a zero-height bar instead of a gap a client has to specially handle. The class
  list is neither small nor fixed, and padding it with every class that has ever existed (including
  ones archived years ago and never scheduled) would turn a chart of what's actually happening into a
  chart mostly full of zeros — the less defensible reading of "breaks bookings down by class" for an
  operational landing view.

## Decision 18

- **Chose:** Kept `member_alert_dismissals` — a dismissal keyed to `(member_id,
  dismissed_expiry_date)` — as goal 10's storage, rather than reconsidering it.
- **Rejected:** A mutable `members.alert_dismissed` boolean, cleared whenever staff edit the expiry
  date.
- **Why:** This table (and its reasoning) was already decided when the schema was first migrated
  (`010_member_alert_dismissals.js`), well before this session — the migration's own comment already
  states the exact query goal 10 needed. A boolean flag would need a reset on every expiry edit, and
  the first code path that forgot would silently vanish a lapsed member from the alert list — precisely
  the failure the brief's binder story opens with. The date-keyed table makes "a later expiry date that
  falls back within seven days brings the alert back" (the brief's own wording) fall directly out of
  the anti-join, with no reset logic anywhere to forget. This session's actual decision was narrower —
  build the two routes against that existing design rather than replacing it — but it's recorded here
  because the instruction explicitly asked for the reasoning not to reconsider it, and that reasoning
  is worth having written down next to the code it justifies.

## Decision 19

- **Chose:** `POST /:memberId/alerts/membership-expiry/dismiss` rejects (409) dismissing a member who
  is not currently within the seven-day alert window, rather than accepting the request as a no-op.
- **Rejected:** Silently accepting the dismissal request regardless of whether the member is currently
  alerting, inserting a dismissal row for whatever their expiry date happens to be.
- **Why:** A dismissal row for a member with no active alert is dead data — nothing it could ever
  suppress unless their expiry date is later moved back to that exact value by coincidence, which is
  not a real use case the brief describes. Rejecting it loudly instead of accepting it silently also
  makes a caller's mistake visible (dismissing the wrong member, or a client racing a just-changed
  expiry date) rather than leaving an inert row nobody asked for.

## Decision 20

- **Chose:** Dismissal idempotency via `INSERT ... ON CONFLICT (member_id, dismissed_expiry_date) DO
  NOTHING`, with a follow-up `SELECT` only when the insert was skipped (to return the *original*
  dismissal's data on a repeated call).
- **Rejected:** A read-then-insert existence check (`SELECT` for an existing row, `INSERT` only if
  none found).
- **Why:** A read-then-insert has a window between the two statements where a second concurrent
  dismissal of the same member could also pass the `SELECT` and attempt its own `INSERT`, racing
  against the unique constraint anyway — so the check buys nothing but an extra round trip and still
  needs the constraint as a backstop. `ON CONFLICT DO NOTHING` is atomic by construction and already
  had a unique index to target (the one `member_alert_dismissals` was built with from the start), so
  there was no reason to duplicate its job in application code.

## Decision 21

- **Chose:** During the final pre-frontend audit, on discovering that `POST /api/members` and
  `PATCH /api/members/:id` had never been built (goal 1 literally asks for staff to "add members and
  set their membership expiry"), implement them immediately as a correctness fix, rather than leaving
  the gap for a later milestone or merely documenting it.
- **Rejected:** Treating the audit as read-only and only recording the gap in `SUBMISSION.md`; or
  quietly marking goal 1 "Done" with an undisclosed caveat.
- **Why:** This audit's own instructions drew a firm line against adding new features, which made the
  call genuinely ambiguous — is completing an already-mandatory, already-claimed-"Done" goal a "new
  feature" or a bug fix? Asked directly rather than guessed at, since the two readings lead to visibly
  different submissions and only the person accountable for the submission can weigh "audit stayed
  strictly read-only" against "goal 1 is now actually, not just nominally, complete." The answer was to
  fix it: a missing mandatory capability discovered while verifying mandatory capabilities is closer to
  a defect than a feature request, and the fix was small, additive, and followed an existing pattern
  (`routes/classes.js`'s create/update shape) exactly rather than inventing new design.

## Decision 22

- **Chose:** Two small, read-only, staff-scoped-where-needed endpoints — `GET /api/rooms` and
  `GET /api/users?role=instructor` — added specifically for the frontend milestone.
- **Rejected:** Leaving the frontend's session-create, recurring-generation, and add-co-instructor
  forms without any way to list valid rooms/instructors, forcing staff to type a numeric database id
  from memory.
- **Why:** The frontend brief explicitly forbids duplicating backend business rules and mock APIs for
  functionality that already exists, but also explicitly allows a backend change "if a genuine frontend
  integration incompatibility is discovered" — and this is exactly that: none of the ten goals ever
  needed to *list* rooms or instructors, only to validate a single client-supplied id
  (`findActiveInstructor` in `domain/instructors.js`), so no such endpoint existed anywhere in the API
  surface before this. `GET /api/users` stays staff-only and always filters to `is_active = true` — the
  only rows the write paths that actually consume one of these ids would ever accept — so this listing
  can never offer a choice the backend would then reject.

## Decision 23

- **Chose:** A hand-rolled CORS middleware (`backend/src/middleware/cors.js`, ~20 lines) over the
  `cors` npm package.
- **Rejected:** `npm install cors`.
- **Why:** This project already has a standing pattern of hand-writing something this size rather than
  taking a dependency for it — `auth/cookies.js` parses the `Cookie` header itself rather than adding
  `cookie-parser`, and `domain/csv.js` is a five-line RFC-4180 escaper rather than a CSV library. CORS
  for exactly one allowed origin, with credentials, is the same shape of problem: a handful of response
  headers, not a configuration surface broad enough to justify an external package. The one header this
  app actually needed and would have been easy to forget by hand —
  `Access-Control-Expose-Headers: Content-Disposition`, without which the browser cannot read the
  attendance CSV's real filename — was in fact missed on the first pass and only caught by testing the
  real download flow end to end (see `docs/ai-prompts.md`), which is exactly the kind of mistake a
  battle-tested library would have prevented for free. Kept anyway: the fix was one line once found,
  and it is now pinned down by a regression test (`tests/cors.test.js`) the same way any other
  hand-rolled piece of this codebase already is.

## Decision 24

- **Chose:** No client-side data cache on the frontend (no React Query, no Redux) — every mutation is
  followed by a plain re-fetch of whatever list it affected.
- **Rejected:** Adding React Query for automatic caching/revalidation.
- **Why:** The frontend brief explicitly says not to add it "unless it is already installed or there is
  a compelling existing reason," and there wasn't one: this app has no offline requirement, no
  background-sync need, and no page where refetching a list after a mutation is expensive at this
  scale. A plain "mutate, then refetch" is also simpler to verify correct — there is no cache-
  invalidation logic to get wrong, only a request-response pair each page already has to reason about
  for its initial load anyway.

## Decision 25

- **Chose:** Playwright E2E fixture scheduling (session start times, recurring-generation date ranges)
  uses a day offset randomized fresh on every process start (`randomFutureDayOffset()` in
  `frontend/e2e/fixtures.js`, a wide 700–5700-day-out window), the same way `uniqueLabel()` already
  randomizes member/class names.
- **Rejected:** A fixed day offset (e.g. always "30 days from now") for E2E session fixtures.
- **Why:** The milestone that added this suite explicitly requires running it at least twice against
  the same persistent database to prove determinism, and sessions are never deleted once they carry a
  booking (by the same `ON DELETE RESTRICT` design goal 4 already relies on) — so a fixed offset's
  second run schedules a new session at the exact same room/instructor/time as the first run's own
  still-present fixture and gets a real 409 scheduling conflict, not a clean pass. This is the same
  self-collision failure mode `docs/plan.md`'s account of goal 4, goal 7, and goal 8 each already
  document and fixed the same way for the backend's own test suite (`sessions.test.js`'s `p6Base`); this
  decision applies that already-proven fix to the new Playwright fixtures rather than rediscovering the
  bug a fourth time from scratch. Caught by actually running the suite twice, per that same requirement
  — the dialog stayed open (a 409 conflict response, not a validation error) after the second run's
  session-create step, not a timeout or a crash, which is what made the cause traceable.

## Decision 26

- **Chose:** A public signup form creates a real, authenticated `users` row with a new third `user_role`
  enum value, `'member'` (migration `011_user_role_member.js`), hardcoded server-side in
  `POST /api/auth/signup` — never read from the request body under any field name.
- **Rejected:** Writing the new account into `members` instead (the existing table for people who get
  booked into sessions); inventing a parallel, separate authorization model or a new "pending approval"
  account state; giving the signup form any UI to request a role at all, even a disabled/default one.
- **Why:** `003_members.js`'s own migration comment already states, as a settled design decision from
  the schema-foundation session, "Members do not log in, so there is no authentication reason for
  uniqueness either" — adding a password to that table would be reopening a decision this project had
  already made and documented, not the "smallest safe solution" this milestone's own instructions asked
  for. `001_enums.js` separately already priced in this exact cost up front: "adding a value needs
  `ALTER TYPE ... ADD VALUE`." Every existing authorization check in the codebase is either an explicit
  allowlist (`requireRole('staff')`, `requireRole('instructor', 'staff')`) or scopes a non-staff caller
  to sessions where *their own* user id is the primary or a co-instructor
  (`scopeSessionsToInstructor`) — a `'member'` account can never satisfy either, so this addition could
  not grant elevated access anywhere in the existing API even if every other safeguard failed. Verified
  directly, not just argued: `tests/authorization.test.js` now includes a member-role account in the same
  boundary battery staff/instructor accounts go through, and `POST /api/auth/signup` was smoke-tested
  with `"role": "staff"` in the request body, confirmed ignored (see `docs/ai-prompts.md`).

## Decision 27

- **Chose:** A signed-up member's landing page (`WelcomePage.jsx`) is a small, honest static page
  ("self-service booking isn't available yet") rather than the existing Sessions or Bookings views.
- **Rejected:** Routing a member into `SessionsPage`/`BookingsPage` the same way an instructor lands
  there.
- **Why:** Both of those pages are built around instructor ownership — `SessionsPage` is titled "My
  Sessions" and lists sessions scoped to "you are the primary or a co-instructor," which a member is
  never either of, so the backend correctly returns an empty list (proven in
  `tests/authorization.test.js`) but the *page itself* would read as broken or mislabeled for a role it
  was never built to describe. "Online self-service booking for members" is one of `README.md`'s own
  listed stretch ideas — genuinely building it (a member browsing classes and booking themselves in)
  was out of scope for this milestone, which asked for the signup *flow*, not that feature; a page that
  says plainly there is nothing to do yet is more honest than a page that implies a capability that does
  not exist. `SUBMISSION.md` records this distinction explicitly rather than letting a working login
  read as a completed stretch goal.

## Decision 28

- **Chose:** A fixed-width `.col-actions` table column (`96px`, growing only if a row's own content
  genuinely needs more) applied to every table with a per-row action, with an explicit
  `.table-actions-placeholder` ("—") rendered whenever no action applies to that row, rather than
  leaving the cell empty.
- **Rejected:** Leaving the actions `<td>` empty when no button applies (the pre-existing behavior) and
  relying on the table's own automatic column-width computation to stay stable.
- **Why:** HTML table layout sizes a column from the widest content across every row in it — with no
  explicit width, a column that's sometimes a full-width "Cancel" button and sometimes nothing at all
  computes a different natural width depending on which rows happen to be on screen (a filtered page
  with zero cancellable bookings vs. one with several), which is what actually produced the reported
  misalignment. An explicit pixel width removes that dependency entirely; the placeholder is not purely
  cosmetic — Playwright's own alignment test (`polish.spec.js`) asserts on it directly, and a rendered
  "nothing to do here" is a clearer signal than a blank cell a screen reader would skip past silently.

## Decision 29

- **Chose:** A hand-rolled set of ~25 inline SVG icons (`components/Icon.jsx`, one 20x20 stroke-path
  object, `stroke="currentColor"`) rather than an icon library.
- **Rejected:** `lucide-react`, `heroicons`, or a similar package; emoji as UI icons.
- **Why:** The milestone's own instructions allow "a tiny icon dependency... only if genuinely useful;
  otherwise use small inline SVG icon components" — the second option was strictly smaller: this
  project's entire icon need is a fixed set of ~25 shapes reused throughout the app (nav items, table
  actions, metric cards, timeline markers), never a searchable library of thousands. A hand-rolled set
  adds zero dependencies, zero version-pinning surface, and `currentColor` means every icon
  automatically matches its surrounding text/button color with no extra prop, the same way the rest of
  this project prefers a five-line CSV escaper over a CSV package (see the CORS/cookie-parsing
  precedents in `docs/decisions.md`'s earlier entries). Emoji were explicitly ruled out by the
  milestone's own instructions and would in any case render inconsistently across platforms — a real
  risk for a "professional SaaS" visual target.

## Decision 30

- **Chose:** A real off-canvas drawer for mobile navigation (`AppShell.jsx`, `position: fixed`,
  translated off-screen by default, opened by a topbar hamburger toggle, closed on navigation or by its
  own backdrop) below 800px, replacing the previous milestone's approach of shrinking the desktop
  sidebar into a horizontally-scrolling strip pinned to the top of the page.
- **Rejected:** Keeping the shrunk-sidebar pattern (simpler, already built, but explicitly what this
  milestone's own instructions ruled out: "turn navigation into a proper mobile navigation pattern —
  don't just shrink the desktop sidebar").
- **Why:** The shrunk sidebar permanently occupied a strip of every mobile page's vertical space and
  made every nav label small and cramped regardless of how few items needed to fit — a real UX cost paid
  on every single page load, for navigation used only occasionally. An off-canvas drawer costs nothing
  when closed (the default state) and, when open, gets the same full-size labels and icons the desktop
  sidebar already has, rather than a visually distinct, worse "mobile version" of the same information.
  This did require updating `responsive.spec.js`'s own nav-interaction helper (open the drawer, then
  click the link) — a real, correctly-flagged consequence of the behavior actually changing, not a test
  weakened to paper over a regression.

## Decision 31

- **Chose:** A `bookedCount` field added to `GET /api/sessions`'s list response — a single batched
  `LEFT JOIN` aggregate over `bookings` (grouped by `session_id`, filtered to the same `booked`/
  `attended`/`no_show` "occupied" statuses `countOccupiedSeats` already uses for the capacity-decrease
  rule), not a per-session query.
- **Rejected:** Leaving the Sessions list without any occupancy indicator (matching the milestone's own
  general instruction to avoid backend changes); calling `countOccupiedSeats` once per row in a loop.
- **Why:** The milestone explicitly asked the sessions list to show "booking occupancy" and separately
  said not to change backend business rules "unless absolutely necessary for the UI" — there was no way
  to show real occupancy without either a backend addition or an N+1 client-side fetch loop (one request
  per visible session), and the second option is exactly the query-shape antipattern this project's own
  architecture review (Session 8's audit) already checked the whole codebase for. A batched aggregate
  keeps the list endpoint at one query, reuses the existing, already-tested definition of "occupied"
  rather than inventing a second one, and changes nothing about any write path, authorization check, or
  business rule — purely additive read-only data. `OCCUPYING_STATUSES` was exported from
  `bookingTransaction.js` specifically so the two call sites can never quietly define "occupied"
  differently. New tests (`tests/sessions.test.js`, "GET /api/sessions — bookedCount") needed the same
  dedicated-throwaway-class-and-room treatment this file's own P6 describe block already documents for
  any session that ends up with a real booking attached (see that block's own comment) — the first
  version of this test used the shared `fixture.class`/default room instead and left a permanently
  undeletable session blocking that fixture's own cleanup, caught by the full suite failing on an
  unrelated, later test and root-caused by reading this exact file's own established pattern rather than
  inventing a new one.

## Decision 32

- **Chose:** A nullable, unique `user_id` foreign key on `members` (migration `012_members_user_link.js`)
  as the one and only relationship between a login (`users`) and a booking identity (`members`) —
  matched at signup time by normalized email, then never revisited.
- **Rejected:** Merging `users` and `members` into one table; treating `users.email == members.email` as
  a standing identity relationship, re-derived on every request instead of stored.
- **Why:** The two tables answer different questions and have different constraints for a reason already
  documented in `003_members.js` — `members.email` is deliberately *not* unique (a parent's email on two
  children's memberships), so it can never safely be the join key for anything beyond a one-time lookup.
  Merging the tables would either force `members.email` unique (breaking that real scenario) or leave a
  login-shaped row for every staff-created member who never signs up, most of whom never will. The brief
  itself was explicit here: "DO NOT use email alone as a permanent identity relationship after signup...
  The actual relationship must be represented by a database foreign key" — this is exactly that. Nullable
  because most existing `members` rows have no login and that stays true; unique because the invariant is
  at most one-to-one in both directions, enforced by the database, not application code.

## Decision 33

- **Chose:** When a signup's normalized email matches more than one *unlinked* `members` row (legitimate
  under Decision 32's own non-unique `members.email`), create a fresh member rather than linking to
  either candidate.
- **Rejected:** Linking to the first/oldest/most-recently-created match; linking to whichever row has the
  furthest-out membership expiry; rejecting the signup outright until staff resolves the ambiguity.
- **Why:** Guessing which of two (or more) same-email member records a signing-up person meant risks
  silently attaching a stranger's booking history and membership expiry to the wrong login — the exact
  failure Decision 32 exists to prevent for the single-match case. Rejecting the signup entirely would
  punish an ordinary person for a data shape (shared family email) the schema was explicitly designed to
  allow. A fresh member is the only outcome that never guesses wrong; it costs one duplicate-looking row
  in an already-rare edge case, recoverable by staff re-pointing `user_id` directly if it ever matters.
  Covered by `backend/tests/memberLinking.test.js`'s "ambiguous email match" test.

## Decision 34

- **Chose:** `POST /api/auth/signup` links-or-creates the `members` row inside the *same* database
  transaction as the `users` insert (`domain/memberLinking.js`, called from within `db.transaction`).
- **Rejected:** Two separate statements/requests (create the user, then separately link/create the
  member); a background job reconciling unlinked members after signup.
- **Why:** The brief calls this out directly ("linking is transactional") — a user with no member, or a
  member linked to a user that doesn't exist, are both states nothing in this application knows how to
  render or recover from cleanly (the member-portal routes assume every `role: 'member'` user has exactly
  one linked member). Doing both inside one transaction makes that invariant a database guarantee: either
  both writes commit or neither does, with no window where a half-created account is visible to a
  concurrent request.

## Decision 35

- **Chose:** Email is read-only on `/profile` for every role — no `PATCH /api/profile` field for it at
  all, not merely a disabled input.
- **Rejected:** A safe email-change flow (verify the new address, then atomically update both `users.email`
  and any linked `members.email`); allowing the field to be edited freely.
- **Why:** Email is the account's login identity *and*, since Decision 32, the one-time signal
  `domain/memberLinking.js` used to find (or not find) a member to claim at signup — a value with real
  structural weight elsewhere in the schema, not an inert profile field. A verified-email-change flow is a
  legitimate feature, but it's a second OTP-shaped flow this milestone did not ask for, and skipping
  verification would let an account silently take over anyone's inbox. The brief's own guidance was
  explicit about being conservative here ("do not casually allow changing email"); read-only, with the
  reason stated plainly in the UI (`ProfilePage.jsx`'s field hint), is the smallest safe choice — full
  email-change is a documented gap, not an oversight (see `docs/architecture.md`, "What was deliberately
  not built").

## Decision 36

- **Chose:** Changing or resetting a password never invalidates any other active session — the current
  session (change-password) or the pre-reset session, if one existed (forgot-password), simply continues
  to work exactly as before, and so does every other device's session token.
- **Rejected:** A `token_version`/`sessions` table added specifically so a password change could bump a
  version and invalidate every other outstanding token.
- **Why:** `auth/tokens.js`'s session token is deliberately stateless — a signed HMAC carrying only a user
  id, with no server-side session store to revoke against, an explicit prior design choice (see that
  file's own comment on why role is never embedded in the token, for the same "no stale-state window"
  reasoning). Adding revocation would mean adding exactly the kind of server-side session state that
  design exists to avoid, for a milestone whose actual ask was "decide and document," not "add token
  revocation infrastructure." The accepted tradeoff: an attacker who already has a stolen, valid session
  token keeps using it until it naturally expires (12 hours) even after the legitimate owner changes their
  password. This is the simplest behavior consistent with the existing architecture, not the most secure
  one available in the abstract — a real limitation, recorded here and in `docs/architecture.md` rather
  than left implicit.

## Decision 37

- **Chose:** Password-reset OTPs are hashed with a keyed HMAC-SHA256 (`auth/otp.js#hashOtp`, keyed with
  the existing `JWT_SECRET`), not Argon2id — the same algorithm `auth/tokens.js` already uses for signing.
- **Rejected:** Reusing `hashPassword`/`verifyPassword` (Argon2id) for OTPs too, "for consistency."
- **Why:** Argon2id's deliberate slowness defends a *password* — high entropy, attacker gets unlimited
  offline guesses against a stolen hash. A 6-digit OTP has only 1,000,000 possible values and is
  short-lived by design (`OTP_TTL_MS`, 10 minutes) with a hard attempt cap (`OTP_MAX_ATTEMPTS`, 5) enforced
  at verification time — the thing actually protecting it is the expiry and the attempt limit, not hash
  cost, and Argon2id's cost would only slow down the *legitimate* verification request for no real
  security gain. A keyed HMAC is fast, deterministic (needed for a simple equality check via
  `crypto.timingSafeEqual`), and reuses the one server-side secret this application already requires
  rather than inventing a second one — the same "small, dependency-free, `node:crypto`-only" pattern
  `auth/tokens.js` already established for this codebase.

## Decision 38

- **Chose:** A separate, structurally distinct token type for password-reset (`auth/resetTokens.js`) —
  same hand-rolled HMAC pattern as `auth/tokens.js`'s session token, but its own encode/verify functions,
  its own `purpose` claim, and no shared code path with session-token verification.
- **Rejected:** Reusing `issueSessionToken`/`verifySessionToken` directly for the reset token too (same
  claim shape, maybe an extra field).
- **Why:** A session token and a reset token must never be accepted for each other's endpoint — a stolen
  reset token (10-minute TTL, single specific purpose) is a much smaller blast radius than a stolen
  session token (12 hours, full account access), and the two should never be interchangeable by
  construction. Sharing one signing function risks exactly that becoming a one-line mistake later (an
  endpoint that forgets to check `purpose`, or a claim shape that happens to satisfy both verifiers).
  Duplicating roughly a dozen lines of HMAC boilerplate is a small, worthwhile price for that confusion
  being structurally impossible rather than merely disciplined-code-review-dependent.

## Decision 39

- **Chose:** A small, swappable email-provider abstraction (`email/emailService.js`) selected once from
  `EMAIL_PROVIDER`: a console/dev provider (default outside production, records sent messages in an
  in-memory array for tests to read) and a generic webhook provider (POSTs `{to, subject, text}` to an
  operator-configured URL, for a real deployment to point at whatever transactional service it uses).
- **Rejected:** Integrating a specific vendor SDK (SendGrid/SES/Postmark/etc.) directly; hardcoding SMTP
  credentials; skipping the abstraction and just logging OTPs everywhere including production.
- **Why:** No email provider existed anywhere in this codebase before this milestone, and deployment is
  explicitly out of scope for this submission — there is no real provider account to integrate against or
  test with. A generic webhook is the smallest interface that is genuinely swappable (any provider can sit
  behind one) without pretending to have tested a specific vendor integration this project cannot actually
  exercise. Production refuses to start sending email at all without `EMAIL_PROVIDER` set (`selectProvider`
  throws rather than silently falling back to the console provider) — a deployment mistake fails loudly
  instead of quietly leaking OTPs into a production log, which the brief explicitly forbids.

## Decision 40

- **Chose:** `ErrorBanner` (`frontend/src/components/States.jsx`) was redesigned in place — same import,
  same `{ error, onRetry }` call signature every existing page already uses, now additionally
  `onDismiss`/`context` — rather than introduced as a new, differently-named component every call site
  would need to be individually migrated to.
- **Rejected:** A new `ErrorPanel`/`ErrorAlert` component, adopted page by page; leaving the old raw
  `{status}: {message}` rendering in place and only fixing the specific login screenshot the brief called
  out.
- **Why:** Eleven existing pages already render `<ErrorBanner error={...} onRetry={...} />` for both form
  submission failures and page-load failures — redesigning the component's *internals* (icon, translated
  title/message via the new `errorCopy.js`, no raw status prefix) instead of its name means every one of
  those call sites is upgraded automatically, with zero risk of a page quietly being missed in a manual
  migration. This is what makes "used consistently across the entire application" true by construction
  rather than by auditing eleven files by hand. A distinct `PageError` variant (centered icon, headline,
  Retry) was added alongside it for genuine whole-page load failures, and `FieldError` for the newer
  multi-field forms (profile, forgot password) — three purpose-built pieces of one shared system, not one
  component asked to look right in every context.

## Decision 41

- **Chose:** The centralized error-copy mapping (`errorCopy.js`) shows the backend's own message for a
  409, falling back to a generic "conflicts with the current state" line only when no message is present
  — a narrower reading of the brief's own example mapping, which listed a single generic 409 string.
- **Rejected:** Literally always showing the generic mapped text for every 409, matching the brief's
  example table exactly with no exception.
- **Why:** Every 409 this backend ever raises is already a specific, hand-authored `BookingError` message
  — "This member's membership expired on 2024-01-01.", "An account with this email already exists.",
  "This member already has an active booking for this session." — never a raw database conflict code or
  constraint name. These are exactly the kind of genuinely useful, human-authored explanations the brief's
  own validation-message bullet already asks to preserve ("field-specific readable messages"); discarding
  them in favor of one generic sentence would be a real information loss for the user and would also have
  broken several already-passing Playwright assertions that check this exact specific text (e.g.
  `polish.spec.js`'s duplicate-signup-email test). Documented here as the "most defensible interpretation"
  of an ambiguous instruction, per this project's own stated rule for handling exactly this situation.

## Decision 42 — a fresh signup's starting membership expiry (Later reversed)

- **Chose (first pass):** A brand-new self-registered member (no staff-created record to claim) gets
  `membership_expires_on` set to the studio's current date (`(now() AT TIME ZONE STUDIO_TIMEZONE)::date`)
  at signup — "no free membership just for signing up."
- **Later reversed to:** `membership_expires_on` set to *yesterday* (studio time) —
  `(now() AT TIME ZONE STUDIO_TIMEZONE)::date - 1`.
- **Why reversed:** `domain/membership.js#isMembershipExpired` is a strict `<` comparison — "an expiry
  date equal to today is still valid, the member has until the end of that civil day" (that file's own
  comment, an existing and correct rule for a staff-set expiry). Setting a fresh signup's expiry to
  *today* therefore left it genuinely bookable for the rest of that day: a real, if short-lived, free
  membership — exactly the outcome the first pass was trying to avoid, just delayed by one civil day
  rather than prevented. This was not caught by any automated test (every backend test that checked this
  used `grantMembership` with an explicit, obviously-expired date, never a truly fresh signup) — it was
  caught during this milestone's own required visual QA pass, reading the member home page's rendered
  membership badge at `375px`/`1440px` and noticing it read "Expiring soon" for an account that had
  supposedly never been granted any membership at all. Fixed in `domain/memberLinking.js`, and a new
  backend test (`tests/memberPortal.test.js`, "rejects a new booking for a brand-new signup that was never
  granted a real membership") added specifically to close the gap the first pass's own test suite missed.

## Decision 43

- **Chose:** Neutralize CSV/formula injection in the attendance export (`domain/csv.js`) — any field
  starting with `=`, `+`, `-`, or `@` gets a leading apostrophe before RFC 4180 escaping is applied.
- **Rejected:** Leaving the export as plain RFC 4180 escaping only (commas/quotes/newlines), on the
  reasoning that `README.md` never mentions this by name.
- **Why:** A session's attendance export includes each booked member's `full_name` — staff-entered free
  text, not a value this application controls the shape of. A name (or, more realistically, a malicious
  one deliberately chosen to look like one) starting with `=`, `+`, `-`, or `@` is exactly what Excel,
  Google Sheets, and LibreOffice treat as the start of a formula, and current versions all still prompt to
  execute it the moment the exported file is opened — a well-known, real class of vulnerability (CSV/
  formula injection, OWASP-documented) independent of whether the brief names it. This surfaced during a
  final submission audit that specifically asked whether "formula-like values" were handled — checking
  found they were not, so this is a genuine, narrowly-scoped security fix, not a reinterpretation of a
  business rule or an invented requirement. The mitigation is the standard one: a leading apostrophe makes
  every spreadsheet application treat the cell as literal text, and is invisible to a plain RFC 4180
  reader (it is simply one more leading character in the field's own text content, never a CSV control
  character). Covered by a new test (`tests/attendanceCsv.test.js`) verified to actually fail against the
  pre-fix code before being trusted as a real regression guard.
