# Schema

Ten tables, three enums, one owner-only append-only table, one composite foreign key doing real work.
Migrations live in `backend/migrations/001`–`014`; this describes what they actually built, verified
live against PostgreSQL by `backend/tests/schema.test.js`. Migrations `012` (a `user_id` link on
`members`) and `013` (`password_reset_otps`) were added in the account-linking/member-portal/
forgot-password milestone — see `docs/decisions.md`, Decisions 32 and 37–38. Migration `014` later added
a `UNIQUE (email)` constraint on `members`, reversing that table's original non-unique design — see
Decision 47 and the `members` table entry below.

## Enums

`user_role` (`staff`, `instructor`, `member`), `booking_status` (`booked`, `waitlisted`, `cancelled`,
`attended`, `no_show`), `booking_event_type` (`created`, `status_changed`, `note`) — native Postgres
enums rather than `text` + `CHECK`, chosen specifically because enum values sort in declaration order:
sorting bookings by status (goal 6) yields lifecycle order, not alphabetical order, with no `CASE`
expression needed. `user_role`'s third value, `member`, was added in migration `011` for public
self-service signup, added during the frontend-polish milestone, after the ten mandatory goals — see
`docs/decisions.md`, Decision 26. It carries no elevated access anywhere in the API: every existing
authorization check is either an explicit allowlist (`requireRole('staff')`) or scopes a non-staff
caller to sessions they are the primary or a co-instructor of, which a `member` account can never be.

## Tables

### `users` — staff, instructor, and self-service member logins

| column | type | notes |
|---|---|---|
| id | bigint identity | PK |
| email | text | `UNIQUE`, lower-cased and trimmed by a `CHECK` |
| password_hash | text | Argon2id PHC string; `CHECK (password_hash LIKE '$%')` |
| full_name | text | non-empty by `CHECK` |
| role | user_role | `staff`, `instructor`, or (migration 011) `member` |
| is_active | boolean | default `true` |
| created_at, updated_at | timestamptz | |

The only case-insensitive-unique email in the schema — see `members` below for why the *other* kind of
member (the studio's own booking-eligible members, a separate table, never a login) is different.
A `role = 'member'` row here is an authenticated *account* created through `POST /api/auth/signup`; as
of migration `012` it *can* have a relationship to one `members` row (see `members.user_id` below), but
still never a merged identity — see Decision 32.

### `members` — people who book

| column | type | notes |
|---|---|---|
| id | bigint identity | PK |
| full_name | text | non-empty |
| email | text | shaped, lower-cased, `CHECK`-normalised, and (migration 014) `UNIQUE` |
| membership_expires_on | date | drives goal 4's eligibility rule and goal 10's alerts |
| user_id | bigint, nullable | (migration 012) FK → users, `UNIQUE`, `ON DELETE SET NULL` |
| created_at, updated_at | timestamptz | |

`email` was originally deliberately non-unique — a parent's email on two children's memberships was
treated as ordinary, and members never log in, so there was no authentication reason to force
uniqueness. Migration `014` reversed that: `members_email_unique` now enforces one row per email at the
database level, translated by `routes/members.js` into a plain `409` on conflict. See Decision 47 for
the full reasoning and why the original design (documented above until this correction) was rejected.

`user_id` is the account/member-linking milestone's addition (migration `012`): nullable because most
`members` rows are staff-created and have no login at all, and that stays true after this migration —
nothing back-fills a value. `UNIQUE` because the relationship is at most one-to-one in both directions —
one login can claim at most one member, one member can be claimed by at most one login — enforced by the
database (`members_user_id_unique`), not application code. Set once, at signup, by
`domain/memberLinking.js`; nothing in the application ever changes it afterward. `ON DELETE SET NULL`
rather than `CASCADE`: there is no user-deletion feature in this application, but if a `users` row were
ever removed, the member's booking history and membership data must survive — the member simply becomes
unclaimed again. See `docs/decisions.md`, Decisions 32–34.

### `rooms`

`id`, `name` (case-insensitive unique — `UNIQUE INDEX ON (lower(name))`, preserving display casing),
`archived_at`, `created_at`. No `capacity` column: session capacity is the sole seat authority,
deliberately not constrained against a room's physical size, which the brief never asks for.

### `classes`

`id`, `title`, `description`, `discipline`, `default_duration_minutes`, `default_capacity`,
`archived_at` (nullable timestamptz — carries *when*, and doubles as the archived/active flag),
`created_at`, `updated_at`. No upper bound on duration.

### `sessions`

| column | type | notes |
|---|---|---|
| id | bigint identity | PK |
| class_id | bigint | FK → classes, `RESTRICT` |
| primary_instructor_id | bigint | FK → users, `RESTRICT` |
| room_id | bigint | FK → rooms, `RESTRICT` |
| starts_at | timestamptz | an instant, never a local (date, time) pair |
| duration_minutes | integer | copied from the class at creation, never re-read |
| capacity | integer | copied from the class at creation, never re-read |
| created_at, updated_at | timestamptz | |

Plus `UNIQUE (id, primary_instructor_id)` — redundant as uniqueness on its own (`id` is already the
PK), but it exists solely as the target of `session_co_instructors`' composite foreign key below.
`duration_minutes`/`capacity` are copy-on-create: editing a class's defaults later never reaches back
and silently changes a past session's attendance record. There is no `ends_at` column — it is always
computed as `starts_at + make_interval(mins => duration_minutes)`, because `timestamptz + interval` is
STABLE, not IMMUTABLE (it consults the session `TimeZone`), which rules out both a generated column and
an expression index.

### `session_co_instructors` — the schema's only many-to-many

`session_id`, `user_id` (FK → users, `RESTRICT`), `session_primary_instructor_id`,
`added_at`. `PRIMARY KEY (session_id, user_id)` — the pair is the natural key, no surrogate id.

The interesting piece is `session_primary_instructor_id`, denormalized into this join row and bound by
`FOREIGN KEY (session_id, session_primary_instructor_id) REFERENCES sessions (id,
primary_instructor_id) ON UPDATE CASCADE`, alongside `CHECK (user_id <> session_primary_instructor_id)`.
Together these make "the primary instructor is never also a co-instructor" a database-enforced
invariant rather than an application-checked one: inserting the primary as a co-instructor fails the
`CHECK` immediately, and re-pointing a session's primary instructor at a current co-instructor cascades
into this row and fails the same `CHECK` — the whole update transaction aborts rather than landing a
violating state. A pair of triggers (one per table, each reading the other) was the rejected
alternative: under `READ COMMITTED`, two concurrent transactions — one adding a co-instructor, one
changing the primary — could each pass their own trigger's read and both commit a violating state. The
foreign key has no such window because it takes a row lock on the referenced `sessions` row.

### `bookings`

| column | type | notes |
|---|---|---|
| id | bigint identity | PK |
| session_id | bigint | FK → sessions, `RESTRICT` |
| member_id | bigint | FK → members, `RESTRICT` |
| status | booking_status | |
| created_at, updated_at | timestamptz | |

No `booked_count` anywhere — occupancy is always counted live under the session lock (see
`architecture.md`). Goal 6's search/filter/sort/pagination query (`GET /api/bookings`) was reviewed
against this table's existing indexes and needed no new migration: `bookings_created_at` serves the
default sort, `bookings_session_status` serves the session and status filters, and `bookings_member`
serves the join to `members` the text search runs against — see `architecture.md`'s goal 6 section for
the full review, including why plain `ILIKE` was kept over adding `pg_trgm`.

`UNIQUE INDEX ... (session_id, member_id) WHERE status IN ('booked',
'waitlisted')` is the database backstop for "at most one *active* claim per member per session" — a
narrower predicate than `status <> 'cancelled'` on purpose, so it states exactly the *live-claim* rule
and never smuggles in a separate "at most one non-cancelled booking ever" restriction that would block
legitimate re-booking after a settled visit.

### `booking_events` — the append-only history behind goal 9

| column | type | notes |
|---|---|---|
| id | bigint identity | PK |
| booking_id | bigint | FK → bookings, `RESTRICT` |
| event_type | booking_event_type | |
| from_status, to_status | booking_status, nullable | shape depends on `event_type` |
| note | text, nullable | |
| actor_user_id | bigint, nullable | FK → users, `RESTRICT`; **NULL means no human acted** |
| is_automatic | boolean | default `false` |
| caused_by_booking_id | bigint, nullable | FK → bookings, `RESTRICT` |
| occurred_at | timestamptz | |

`CHECK` constraints (`booking_events_well_formed`) enforce the three legal shapes: `created` rows have
`from_status IS NULL` and `to_status IN ('booked','waitlisted')`; `status_changed` rows have both
statuses set and different; `note` rows have both statuses null and a non-blank note. Three more
constraints tie `is_automatic` to reality: an automatic event must be a `status_changed` event, must
carry a real `actor_user_id` (an automatic promotion always has an accountable triggering human — never
a bare system event), and `caused_by_booking_id` may only be set on an automatic event, never pointing
at itself.

Immutability is two independent layers: `BEFORE UPDATE OR DELETE` and `BEFORE TRUNCATE` triggers reject
every mutation for any role that isn't the table owner, and (when `APP_DB_ROLE` is configured) the
application's own database role has `UPDATE`/`DELETE`/`TRUNCATE` revoked outright, so it never holds
those verbs to begin with. Neither layer stops the table owner or a superuser — Postgres has no
constraint that binds its own owner — which is the honest limit of what "cannot be edited or deleted
through the application" can mean.

### `member_alert_dismissals` — the append-free dismissal table behind goal 10

`id`, `member_id` (FK → members, `CASCADE` — the only cascading delete in the schema, and correct: a
dismissal is meaningless without its member), `dismissed_expiry_date`, `dismissed_by_user_id`,
`dismissed_at`. `UNIQUE (member_id, dismissed_expiry_date)` records a dismissal against one *specific*
expiry date rather than as a boolean flag on the member — so if staff later set a new, later expiry
date that itself falls back within the seven-day window, the alert reappears automatically: the
anti-join against this table simply stops matching, with no reset logic anywhere. Read by
`GET /api/members/alerts/expiring` and written by
`POST /api/members/:memberId/alerts/membership-expiry/dismiss` (`domain/membershipAlerts.js`,
`routes/members.js`) — see `docs/architecture.md`'s goal 10 section.

### `password_reset_otps` — the forgot-password OTP store (migration 013)

| column | type | notes |
|---|---|---|
| id | bigint identity | PK |
| user_id | bigint | FK → users, `CASCADE` |
| otp_hash | text | a keyed HMAC-SHA256 of the 6-digit code — **never the plaintext code** |
| attempts | int | default `0`; bounds brute-forcing one row |
| created_at | timestamptz | default `now()` |
| expires_at | timestamptz | `CHECK (expires_at > created_at)` |
| verified_at | timestamptz, nullable | set once the code is correctly entered (`/verify`) |
| consumed_at | timestamptz, nullable | set once the password is actually reset (`/reset`) |

Keyed by `user_id`, not a second copy of the email: by the time a row is written here, the requesting
endpoint has already looked the user up by normalized email (see `routes/auth.js`), so storing the id
avoids a second place email normalization could ever drift from the first. `verified_at` and
`consumed_at` are separate on purpose — this application's reset flow is enter-code, *then* set a new
password, as two separate requests (`/verify` then `/reset`), so a code can be "correctly entered" before
it is "spent"; `/reset` is only reachable with the short-lived reset token `/verify` issues, which itself
embeds this row's id (`auth/resetTokens.js`). `ON DELETE CASCADE` — an OTP for a user that no longer
exists is meaningless. Nothing about correctness depends on old rows ever being pruned: every read here
filters on `expires_at`/`consumed_at`/`attempts` itself, so a stale row simply stops being usable rather
than needing active cleanup. `password_reset_otps_user_id_created_at (user_id, created_at DESC)` serves
every query this table gets — "does this user have a live OTP right now" (the request-cooldown check) and
"verify this code" both look up the newest row for a user first. See `docs/decisions.md`, Decisions 37–38.

## Relationships

- One-to-many: `classes → sessions`, `sessions → bookings`, `members → bookings`, `bookings →
  booking_events`, `users → sessions` (as primary instructor), `members → member_alert_dismissals`,
  `users → password_reset_otps`.
- One-to-one (optional): `users ↔ members`, via `members.user_id` — see Decision 32.
- Many-to-many: `sessions ↔ users` via `session_co_instructors` — the schema's only join table.
- Every foreign key in the schema is `ON DELETE RESTRICT` except `member_alert_dismissals.member_id`
  and `password_reset_otps.user_id` (both `CASCADE`) and `members.user_id` (`SET NULL`) — deliberately:
  nothing here is composition except a dismissal's relationship to its member and an OTP's relationship
  to its user, so nothing else should ever silently disappear alongside something else's deletion, and a
  member's own data must survive even if its linked login somehow didn't.

## Data source of truth

`users` and `members` intentionally duplicate nothing that matters: `users` owns everything about the
*login* — email (identity/authentication), password hash, role, full name as the account holder wants it
displayed on their own profile. `members` owns everything about *booking eligibility* — membership
expiry, and (via `bookings.member_id`) the entire booking history. The one field that looks duplicated,
`full_name`, is not read from the same place twice: a linked member's `full_name` stays whatever staff
set it to (the studio's own record of who this person is for attendance/booking purposes) and is **never**
overwritten by the login's own name, even if the signup form submitted a different one — see Decision 32
and `domain/memberLinking.js`'s own comment. A user's profile page (`GET/PATCH /api/profile`) edits only
`users.full_name`; it has no way to touch `members.full_name` at all. If the two ever visibly disagree
(the account holder goes by a nickname; the studio's roster has their legal name), that is accepted as
correct, not a bug to reconcile — each name belongs to a different question.

## Database constraints vs. application constraints

The line is drawn by what a race condition could violate. Anything a *single* correctly-formed request
could get wrong on its own — an empty title, a negative capacity, a malformed email, an out-of-range
enum value — is a `CHECK` or `NOT NULL`, caught the same way regardless of which code path produced the
row. Anything whose correctness depends on *what else is true in the database at the same instant* —
capacity vs. current occupancy, "has this session started yet," membership expiry against today's date,
FIFO waitlist order — is application logic running inside a transaction holding the relevant row lock,
because no `CHECK` constraint can see across rows or consult wall-clock time consistently. The one
partial exception is the active-booking unique index: the *application* re-checks it deterministically
under the session lock first (so the ordinary path never even reaches the constraint), and the
*database* index is the unconditional backstop for anything that reached the table outside that
protocol.

## What was deliberately denormalized

- `sessions.duration_minutes` / `sessions.capacity` — copied from the class at creation, not
  referenced live, so a later class-default edit can never retroactively change a past session's
  attendance record.
- `session_co_instructors.session_primary_instructor_id` — one redundant bigint per join row, spent
  entirely to give the composite foreign key described above something to enforce the primary/
  co-instructor invariant against.
- `bookings.created_at` doubles as "the instant this booking joined the waitlist" — no separate
  `waitlisted_at` column, because no transition ever moves a booking back into `waitlisted` after
  creation, so the one timestamp is unambiguous for FIFO ordering for the entire life of the row.

## What would break first at 100x the data

At roughly seed-scale × 100 (tens of thousands of sessions, low millions of bookings and events), the
first real pressure point is `booking_events`: it is insert-only and grows without bound (by design —
that's the point of goal 9), and every booking mutation writes at least one row to it inside the same
transaction as the session lock, so its insert latency directly extends how long that lock is held.
`booking_events_booking (booking_id, occurred_at, id)` keeps a single booking's timeline cheap, but a
studio-wide history query (an eventual audit or "everything staff member X did" view) would need its
own index this schema doesn't have yet.

Second: the `FOR UPDATE` session lock, the correctness mechanism this entire design rests on, is also
its throughput ceiling — every mutation against one session's bookings is fully serialized, by design.
That's the right trade at any realistic single-session concurrency (a room seats dozens, not
thousands), but it means the design does not scale to a hypothetical single session with extreme write
concurrency without changing the mutex granularity.

Third, `bookings_session_status (session_id, status)` — used for every occupancy count — stays small
per session no matter how large the table gets, since it's always queried through an equality on
`session_id`, so this one is not expected to be a bottleneck; it's named here specifically because it's
the index one might *guess* would degrade and does not.

Fourth, `password_reset_otps` grows unboundedly in the same insert-only shape as `booking_events`, but
without that table's justification for staying that way forever — old, expired/consumed rows have no
audit value once past their `expires_at`. Unlike `booking_events`, this one has no application reason to
be append-only, so at real volume it would need a periodic delete of rows past expiry (a routine
maintenance job, not a design gap the schema itself needs to change to support).
