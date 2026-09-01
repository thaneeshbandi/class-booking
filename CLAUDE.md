# Class Booking Assignment — Claude Code Instructions

## Project purpose

This repository implements Assignment 13 — Class Booking.

README.md is the authoritative specification.

This is a hiring assignment. The goal is not merely to produce a functioning application. The implementation must be understandable, defensible, tested, documented, and supported by meaningful Git history.

## Absolute rules

1. Never violate or weaken a mandatory requirement from README.md.
2. Never invent requirements that contradict README.md.
3. Do not implement stretch goals until all 10 mandatory goals are complete and verified.
4. Never use mock data for required application functionality.
5. Never implement authorization only in the frontend.
6. All authorization must be enforced on the server.
7. All booking state transitions must be validated on the server.
8. Booking capacity must remain correct under concurrent booking attempts.
9. Waitlist promotion must be handled correctly and atomically.
10. Booking history must be append-only and immutable.
11. Booking search, filtering, sorting, pagination, and total count must be performed server-side.
12. Recurring session generation must report both created sessions and skipped sessions with reasons.
13. Secrets must never be committed.
14. Environment variables must be used for credentials and environment-specific configuration.
15. Do not rewrite unrelated parts of the project.
16. Do not claim that code works without actually testing it.
17. Preserve existing functionality when implementing new features.
18. Prefer simple, explainable architecture over unnecessary complexity.
19. Maintain incremental Git history.
20. Documentation must reflect what actually happened, not an invented development story.

## AI documentation

docs/ai-prompts.md must contain the actual significant prompts used during development.

For significant prompts, record:

- what was requested
- what Claude produced
- what was correct
- what was wrong
- what was changed

At least one prompt must document an incorrect result and its correction.

Do not fabricate AI interactions.

## Engineering decisions

docs/decisions.md must contain at least five real technical/product decisions.

Each decision must explain:

- what was chosen
- what alternative was rejected
- why

At least one decision must later be reversed and documented with a "Later reversed:" explanation.

Do not invent decisions that did not happen.

## Architecture documentation

docs/architecture.md must describe the actual implemented architecture.

It must explain:

- moving pieces
- communication between them
- where each runs
- one representative request path end-to-end
- what was deliberately not built and why

## Schema documentation

docs/schema.md must describe the actual database.

It must explain:

- tables
- columns and types
- relationships
- database constraints
- application constraints
- denormalization
- likely bottlenecks at 100x data

## Planning documentation

docs/plan.md must reflect actual development.

It must explain:

- work sessions
- implementation order
- why that order was chosen
- estimated versus actual time
- what was cut when time became constrained

## Implementation workflow

For any non-trivial task:

1. Inspect the existing implementation.
2. Identify the relevant requirements.
3. Explain the proposed approach.
4. List files that will change.
5. Identify edge cases.
6. Implement the feature.
7. Run relevant tests/type checks/build.
8. Fix failures.
9. Review the resulting diff.
10. Explain what changed.

Do not make large changes without first presenting a plan.

## Requirement interpretation

If a requirement is ambiguous:

- identify the ambiguity
- choose the most defensible interpretation
- explain the reasoning
- record the decision in docs/decisions.md

Do not silently reinterpret the assignment.

## Interview readiness

Implementation choices must be explainable by the candidate.

When making an important architectural or business-logic decision, explain the reasoning rather than merely producing code.

## Scope

The 10 mandatory goals are the priority.

The mandatory goals are:

1. Accounts and roles
2. Classes
3. Sessions
4. Booking lifecycle
5. Co-instructors
6. Booking search/filter/sort/pagination
7. Recurring schedule generation and CSV attendance
8. Dashboard
9. Immutable booking history
10. Expiring membership alerts

Do not prioritize visual polish or stretch features over these requirements.
