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
| Frontend | React 18 + Vite, plain JavaScript, hand-written CSS (no component library, no TypeScript) | Built after every server-side goal was done, tested, and audited — see `docs/architecture.md` |
| Backend | Node.js, Express, Knex (query builder + migrations) over `pg` | See `docs/decisions.md` |
| Database | PostgreSQL 17 (Docker locally; not yet deployed) | See `docs/schema.md` |
| Hosting | Not deployed yet | Frontend and backend are both complete; deployment itself hasn't happened yet |

## Goal checklist

Mark each honestly. Partial is fine — say what is partial.

| # | Goal | Status | Notes |
|---|------|--------|-------|
| 1 | Accounts and roles | Done | Server-enforced staff/instructor split throughout; staff-only `POST`/`PATCH /api/members` for adding members and setting membership expiry (added during the final audit — see `docs/architecture.md` and `docs/decisions.md`) |
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
Stack table). None of the optional stretch ideas listed in `README.md` have been started — per
`CLAUDE.md`'s own rule, they were never going to be attempted before all ten mandatory goals were done.

## Verification

What was actually run, most recently: backend `npm test --test-concurrency=1` — 391 tests, 390 passing,
1 skipped (an `APP_DB_URL`-gated schema test, skipped whenever that optional role isn't configured, same
as every earlier run) — run twice, then again after a fresh `npm run db:reset`; `npm run lint` clean on
both `backend/` and `frontend/`; `npm run build` clean on `frontend/`. Full detail, including every
session's exact commands and results, is in `docs/plan.md`.

**End-to-end frontend verification was performed with real Playwright browser automation** — Chromium,
via `@playwright/test`, actually launching a browser and driving the real running frontend against the
real running backend and PostgreSQL database (no mocked responses, nothing simulated with `curl`). 32
tests across `frontend/e2e/{auth,staff-flow,instructor-flow,responsive}.spec.js` cover the full staff
journey (dashboard, member CRUD, alerts, class CRUD/archive/restore, session CRUD, co-instructor add/
remove, recurring generation with both created and skipped results rendered, booking search/filter/
sort/pagination, booking create/cancel, booking history, and the attendance CSV downloaded and read back
through Playwright's own download API — not `curl`), an instructor-authorization-boundary suite (what
the UI hides and, separately, what the backend itself rejects on a direct URL to a session the
instructor has no relationship to), the full auth lifecycle (unauthenticated redirect, login, logout,
no client-side token), and basic responsive sanity at two viewports. The suite ran twice consecutively,
both times clean (32/32), satisfying the determinism requirement. Full detail — including the exact
commands, and the two genuine application bugs this real-browser testing found and fixed that no earlier
`curl`-based check had been able to see (a broken pagination "Next" button, and a responsive layout that
let a wide table drag the whole page into horizontal scroll) — is in `docs/plan.md`'s Session 10 and
`docs/ai-prompts.md`'s Playwright entry.

## How much time did you actually spend?

## What would you do next, with another 12 hours?

## What are you least happy with in this codebase, and why?
