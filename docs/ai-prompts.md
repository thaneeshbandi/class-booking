# AI prompts

Claude Code was used for the entire codebase, including this document. A gap, stated plainly rather
than papered over: goals 1–5 (authentication, classes, sessions, co-instructors, and the database
foundation) were built in an earlier session whose actual prompts were not recorded anywhere this
document can honestly draw from — `git log -- docs/ai-prompts.md` shows this file was never touched
before this session. Inventing that history now would violate the one rule this file has to follow, so
it isn't attempted. What follows is complete and accurate for the session that built goal 4, which is
the one this document's author actually has a record of.

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
