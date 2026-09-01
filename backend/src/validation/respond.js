/**
 * A Zod failure turned into a useful, single-message JSON body — "field: what
 * was wrong with it" — rather than the raw issues array. Shared by every
 * route that validates a body or query with Zod, so the same request problem
 * reads the same way regardless of which endpoint rejected it.
 */
export function zodErrorResponse(error) {
  const [first] = error.issues;
  const path = first.path.join('.');
  return { error: path ? `${path}: ${first.message}` : first.message };
}
