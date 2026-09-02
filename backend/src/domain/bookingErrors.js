/**
 * The one error type every booking domain/route layer throws for a rule
 * violation — an invalid transition, a timing violation, an authorization
 * failure re-checked inside a transaction, a translated Postgres error. Each
 * route catches `BookingError` once and maps it straight to `status`/
 * `message`, so the HTTP status a rule violation produces lives next to the
 * rule itself instead of being decided again at the route.
 */
export class BookingError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'BookingError';
    this.status = status;
  }
}
