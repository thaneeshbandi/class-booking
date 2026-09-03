/**
 * The one place an HTTP failure is translated into something a user should
 * actually read. Every error surface in the app (`ErrorBanner`, `PageError`
 * below) goes through this — nothing renders a raw `{status}: {message}`,
 * a database error, or a stack trace anywhere in the product.
 *
 * `context` lets the handful of call sites that need a more specific
 * message for an otherwise-generic status code ask for one (currently just
 * `'login'`, for a 401 that means "wrong credentials" rather than "your
 * session expired").
 */

const STATUS_MESSAGES = {
  403: "You don't have permission to perform this action.",
  404: "We couldn't find that item.",
  409: 'This action conflicts with the current state. Refresh and try again.',
  500: 'Something went wrong on our side. Please try again.',
};

export function describeError(error, context) {
  if (!error) return null;

  if (typeof error === 'string') {
    return { title: 'Something went wrong', message: error };
  }

  const status = error.status;

  // No status at all: `fetch` itself failed before a response — and
  // therefore before `ApiError` could even be constructed with one — which
  // only happens when the request never reached the server at all.
  if (status === undefined) {
    return { title: "We couldn't reach the server", message: 'Check your connection and try again.' };
  }

  if (context === 'login' && status === 401) {
    return { title: "We couldn't sign you in", message: 'Check your email and password and try again.' };
  }
  if (status === 401) {
    return { title: 'Your session has ended', message: 'Please sign in again to continue.' };
  }

  if (status === 400) {
    // The backend's own validation messages are already field-specific and
    // human-readable ("Full name is required.", "New password and
    // confirmation do not match.") — shown as-is, just without a raw status
    // number attached to them.
    return { title: 'Check the form', message: error.message || "Something about this wasn't valid." };
  }

  if (status === 409) {
    // Every 409 this backend raises is already a hand-authored, specific
    // business-rule explanation (BookingError — "This member's membership
    // expired on...", "An account with this email already exists.", "This
    // member already has an active booking for this session.") — never a
    // raw database conflict. Showing it as-is is strictly more useful than
    // the generic fallback below, so the generic text is reserved for the
    // rare 409 with no message at all.
    return { title: 'This didn’t go through', message: error.message || STATUS_MESSAGES[409] };
  }

  if (STATUS_MESSAGES[status]) {
    return { title: 'Something went wrong', message: STATUS_MESSAGES[status] };
  }

  return { title: 'Something went wrong', message: 'Please try again.' };
}
