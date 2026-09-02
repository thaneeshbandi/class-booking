import { BookingError } from './bookingErrors.js';

/**
 * Timing preconditions for the three booking mutations. Each function takes
 * the already-computed boolean rather than a timestamp and never calls
 * `Date.now()` — the boolean is always sourced from one PostgreSQL query
 * (`bookingTransaction.js#lockSessionForBooking`: `now() >= starts_at` /
 * `now() >= starts_at + make_interval(mins => duration_minutes)`), which is
 * what keeps every real timing decision on Postgres time rather than the
 * Node process clock, per the approved design. Keeping the *decision* here
 * as a pure function of a boolean is what makes it unit-testable without a
 * database.
 *
 * There is a deliberate gap: once a session has started but before it has
 * finished, a booked booking is neither cancellable nor settleable. That is
 * not a bug to close — it is the approved design for the running-class
 * window.
 */

/** A booking cannot be created once the session has started. */
export function assertCanCreate({ hasStarted }) {
  if (hasStarted) {
    throw new BookingError(409, 'Cannot create a booking: this session has already started.');
  }
}

/** Cancellation (booked or waitlisted) is allowed only before the session starts. */
export function assertCanCancel({ hasStarted }) {
  if (hasStarted) {
    throw new BookingError(409, 'Cannot cancel this booking: this session has already started.');
  }
}

/** Settlement is allowed only once the session has finished. */
export function assertCanSettle({ hasFinished }) {
  if (!hasFinished) {
    throw new BookingError(
      409,
      'Cannot settle this booking: this session has not finished yet.',
    );
  }
}
