# Submission

Fill this in and commit it. This is the first file we open.

## Links

- **GitHub repository:** <public repo URL>
- **Live application:** <deployed URL>

## Notes for the reviewer

<Anything we should know before opening the link — e.g. your host sleeps when idle and the first
request can take up to a minute.>

## Demo credentials

| Role | Email | Password |
|------|-------|----------|
| <role 1> | | |
| <role 2> | | |

## Stack

| Layer | What you used | Why |
|-------|---------------|-----|
| Frontend | React 18 + Vite, plain JavaScript, hand-written CSS design system (tokens, shared component classes), ~25 hand-rolled inline SVG icons (no icon library, no component framework, no TypeScript) | Built after every server-side goal was done, tested, and audited; visually redesigned in a later milestone — see `docs/architecture.md` and `docs/decisions.md`, Decision 29 |
| Backend | Node.js, Express, Knex (query builder + migrations) over `pg` | See `docs/decisions.md` |
| Database | PostgreSQL 17 (Docker locally; not yet deployed) | See `docs/schema.md` |
| Email (password-reset OTPs) | A small hand-rolled provider abstraction (`backend/src/email/emailService.js`) — a dev/console provider by default, a generic swappable webhook provider for a real deployment; no third-party email SDK | No existing email infrastructure in this codebase before this milestone, and no real provider account to integrate against — see `docs/decisions.md`, Decision 39 |
| Hosting | Not deployed yet | Frontend and backend are both complete; deployment itself hasn't happened yet |

## Goal checklist

Mark each honestly. Partial is fine — say what is partial.

| # | Goal | Status | Notes |
|---|------|--------|-------|
| 1 | Accounts and roles | Done | Server-enforced staff/instructor/member split throughout; staff-only `POST`/`PATCH /api/members` for adding members and setting membership expiry (added during the final audit); public signup now links to (or creates) a real `members` record via a database foreign key, never email alone (see `docs/architecture.md` and `docs/decisions.md`, Decisions 32–34) |
| 2 | Classes | Done | Create/edit/archive/restore |
| 3 | Sessions inside classes | Done | Create/edit/delete with server-side room/instructor conflict detection |
| 4 | Booking lifecycle | Done | Full state machine, session-lock concurrency protocol, FIFO waitlist promotion, immutable history; see `docs/decisions.md` and `docs/architecture.md` |
| 5 | Co-instructors | Done | Staff-only add/remove; instructor sees own-sessions list (primary + co-instructor) |
| 6 | Booking search/filter/sort/pagination | Done | `GET /api/bookings` — text search (name/email), class/session/status filters, a whitelisted sort, page/pageSize pagination, and a total count, all in one authorized SQL query; see `docs/architecture.md` and `docs/decisions.md` |
| 7 | Recurring schedule + CSV export | Done | `POST /api/sessions/recurring` (staff-only, weekly local-time pattern, reports created/skipped with machine-readable reasons) and `GET /api/sessions/:sessionId/attendance.csv` (read-only, same authorization as `GET /:sessionId/bookings`); see `docs/architecture.md` and `docs/decisions.md` |
| 8 | Dashboard | Done | `GET /api/dashboard` (staff-only) — sessions today, bookings made today, no-shows this week, members currently waitlisted, a bookings-by-status and bookings-by-class breakdown, and an eight-week attendance chart, all computed as SQL aggregates; see `docs/architecture.md` and `docs/decisions.md` |
| 9 | Immutable booking history | Done | Delivered as part of goal 4 — append-only `booking_events`, enforced by trigger and (optionally) revoked grants |
| 10 | Expiring membership alerts | Done | `GET /api/members/alerts/expiring` and `POST /api/members/:memberId/alerts/membership-expiry/dismiss` (staff-only) — expiry `<= studio-local today + 7 days`, a dismissal keyed to the exact expiry date it was dismissed at (`member_alert_dismissals`, unchanged from the original schema design), so a later expiry change automatically brings the alert back; see `docs/architecture.md` and `docs/decisions.md` |

All ten mandatory goals above are complete, and a frontend covering every one of them is built (see the
Stack table). A later, explicitly-requested milestone (after all ten goals and two rounds of frontend
polish/redesign) turned the public signup flow from Decision 26 into a real product: a staff-created
member can now claim their existing record by signing up with the same email (linked via a new
`members.user_id` foreign key, never a duplicate row — see `docs/decisions.md`, Decisions 32–34), and
every `member` account gets a real self-service portal — browse sessions, book, view and cancel their own
bookings, all reusing the exact same booking domain logic the staff routes use, never a second
implementation. Every authenticated role also gets a profile page (edit name, change password) and
forgot-password by email OTP. This is genuinely the "online self-service booking for members" stretch
idea from `README.md`, not merely infrastructure toward it — see `docs/architecture.md`'s "Account/member
linking, the member portal, profile, and forgot-password" section for the full detail. No other stretch
idea is complete.

## Verification

What was actually run, most recently: backend `npm test --test-concurrency=1` — 450 tests, 449 passing,
1 skipped (an `APP_DB_URL`-gated schema test, skipped whenever that optional role isn't configured, same
as every earlier run) — run twice, then again after a fresh `npm run db:reset` (now applying all 13
migrations); `npm run lint` clean on both `backend/` and `frontend/`; `npm run build` clean on
`frontend/`. Full detail, including every session's exact commands and results, is in `docs/plan.md`.

**The frontend was fully visually redesigned in a later milestone**, on top of the same backend and the
same 41 Playwright tests (28 needed no changes at all; a handful were updated to match intentional
behavior changes — a real off-canvas mobile nav drawer and a dashboard greeting heading — not to paper
over regressions; full detail in `docs/plan.md`'s Session 12 and `docs/ai-prompts.md`). Design tokens, a
hand-rolled icon set, a redesigned app shell (icon-led sidebar, topbar avatar, real mobile drawer
navigation), split-screen Login/Signup pages, and every other page rebuilt on the new shared component
classes. One small, genuine backend addition — `bookedCount` on `GET /api/sessions`, a single batched
aggregate query, not a per-row loop (see `docs/decisions.md`, Decision 31) — was the only backend change
this milestone made. Verification included an actual visual audit: the real running app launched with
Playwright and its screenshots inspected (not assumed) at 375px, 768px, 1024px, and 1440px across every
page this milestone's own instructions listed, which is what caught five real issues (a missing
`text-decoration` on the shared button class, a locator collision between a new dashboard link and the
existing "Members" nav link, two Playwright assertions that needed updating for intentional UI changes,
and a test-fixture cleanup bug in the new backend test) before any of them shipped.

**End-to-end frontend verification was performed with real Playwright browser automation** — Chromium,
via `@playwright/test`, actually launching a browser and driving the real running frontend against the
real running backend and PostgreSQL database (no mocked responses, nothing simulated with `curl`). 41
tests across `frontend/e2e/{auth,staff-flow,instructor-flow,responsive,polish}.spec.js` cover the full
staff journey (dashboard, member CRUD, alerts, class CRUD/archive/restore, session CRUD, co-instructor
add/remove, recurring generation with both created and skipped results rendered, booking search/filter/
sort/pagination, booking create/cancel, booking history, and the attendance CSV downloaded and read back
through Playwright's own download API — not `curl`), an instructor-authorization-boundary suite (what
the UI hides and, separately, what the backend itself rejects on a direct URL to a session the
instructor has no relationship to), the full auth lifecycle, basic responsive sanity at two viewports,
and (added in the frontend-polish milestone, `polish.spec.js`) fixed-action-column table alignment,
four recurring-generation UX scenarios (a matching single day, a non-matching single day, a multi-day/
multi-weekday range, and a genuine room/instructor conflict), and four signup scenarios (the login page's
signup link and the absence of any role selector, a full signup-to-authenticated-landing flow, a
password-confirmation mismatch, and a duplicate-email rejection). The suite ran twice consecutively,
both times clean (41/41), satisfying the determinism requirement, and once more after the fresh
`db:reset` above (also clean). Full detail — including the exact commands, the two genuine application
bugs the original Playwright milestone found and fixed that no earlier `curl`-based check had been able
to see (a broken pagination "Next" button, and a responsive layout that let a wide table drag the whole
page into horizontal scroll), and the fixed-action-column bug this polish milestone found and fixed (a
present-vs-absent Cancel button changing the Actions column's own width) — is in `docs/plan.md`'s
Sessions 10–11 and `docs/ai-prompts.md`'s Playwright and polish-milestone entries.

Twelve concrete flows this milestone's own instructions asked to be verified with the real browser, all
covered above: staff can create a class (`staff-flow.spec.js`); an instructor cannot (nav hidden in
`instructor-flow.spec.js`, and direct URL access is redirected — the backend's own `requireRole('staff')`
is the authoritative enforcement, covered separately in `backend/tests/classes.test.js`); booking rows
stay aligned with and without a Cancel button, a valid recurring generation works, an invalid one is
caught in the UI before any request, login and signup both work, public signup cannot create a
staff/instructor account (no role selector exists, and the account's own topbar badge reads `member`),
and every existing staff/instructor login and booking/session/class workflow still works unchanged
(`staff-flow.spec.js`, `instructor-flow.spec.js`, `auth.spec.js`, all passing with zero locator changes
needed after the visual redesign).

**The account-linking/member-portal/profile/forgot-password/error-system milestone** added 44 backend
tests (`memberLinking`, `profile`, `forgotPassword`, `memberPortal` test files, plus updates to
`schema.test.js` for the new table and columns) and 22 Playwright tests across two new spec files
(`member-portal.spec.js`, `account-security.spec.js`) plus one new test added to `responsive.spec.js`'s
existing viewport loop — 63 Playwright tests total, run twice consecutively (both clean) and once more
after a fresh `db:reset` (also clean). Real coverage includes: a staff-created member claiming their
account via signup with the same email (membership expiry and identity preserved, not duplicated); a
brand-new signup's own member portal end to end (browse, book, appear in "My bookings," cancel, reflected
on the member home page); own-bookings-only isolation between two independent members; the
expired-membership rule genuinely blocking a new booking with a clean message (this is the flow whose
first implementation had a real bug — see below); profile editing and password change for a member, a
staff account, and an instructor account; the full forgot-password OTP flow (request → verify → reset →
login with the new password) using a dev-only OTP-retrieval endpoint that exists only outside production;
an incorrect OTP rejected with a polished error; and the redesigned error copy itself (the exact
"401: Invalid email or password." → "We couldn't sign you in..." replacement the milestone's brief called
out by name, plus the equivalent for a 403). A genuine screenshot-based visual QA pass (375/768/1024/
1440px, every new and changed page) caught one real bug before it shipped: a brand-new signup's starting
membership expiry was set to *today*, which — because the expired-membership check is a strict
less-than comparison — left it bookable for the rest of that civil day, a real if short-lived free
membership. Fixed to yesterday's date, with a new backend test added specifically to close the gap the
original test suite had missed; documented in full, including why it wasn't caught the first time, as a
reversed decision in `docs/decisions.md`, Decision 42, and in `docs/ai-prompts.md`.

## How much time did you actually spend?

## What would you do next, with another 12 hours?

## What are you least happy with in this codebase, and why?
