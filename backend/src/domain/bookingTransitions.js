import { BookingError } from './bookingErrors.js';

/**
 * The booking status state machine. There is no manual endpoint that sets an
 * arbitrary status — only the two intents below (cancel, settle) — so this is
 * the complete set of transitions the application can ever request, and the
 * complete set of ways a request can be invalid:
 *
 *   booked     -> cancelled   (assertCancellable)
 *   waitlisted -> cancelled   (assertCancellable)
 *   waitlisted -> booked      (automatic only; never reaches here — see
 *                              `bookingTransaction.js#promoteWaitlistFIFO`)
 *   booked     -> attended    (assertSettleable)
 *   booked     -> no_show     (assertSettleable)
 *
 * Every other combination — including booked -> waitlisted, waitlisted ->
 * attended/no_show, and any move out of cancelled/attended/no_show — is
 * rejected here with a message naming the booking's actual current status,
 * never a generic "invalid transition".
 */

const CANCELLABLE_STATUSES = new Set(['booked', 'waitlisted']);
const SETTLEMENT_TARGET_STATUSES = new Set(['attended', 'no_show']);

/** Throws unless `status` is `booked` or `waitlisted`. */
export function assertCancellable(status) {
  if (!CANCELLABLE_STATUSES.has(status)) {
    throw new BookingError(
      409,
      `Cannot cancel this booking: it is currently ${status}, not booked or waitlisted.`,
    );
  }
}

/** Throws unless `status` is `booked` and `targetStatus` is a valid settlement outcome. */
export function assertSettleable(status, targetStatus) {
  if (!SETTLEMENT_TARGET_STATUSES.has(targetStatus)) {
    throw new BookingError(
      400,
      `Invalid settlement status "${targetStatus}": must be "attended" or "no_show".`,
    );
  }
  if (status !== 'booked') {
    throw new BookingError(
      409,
      `Cannot settle this booking: it is currently ${status}, not booked.`,
    );
  }
}
