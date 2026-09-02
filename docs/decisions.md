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
