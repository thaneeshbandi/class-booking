/**
 * Deny-by-default role check. Must run after `authenticate`, which is what
 * populates `req.user` from server-side identity — never from anything the
 * client sent (a body field, a header, a query parameter).
 *
 * Every protected route in this application declares its policy explicitly
 * with this (or the resource-level checks in `sessionAccess.js`); there is no
 * route that is reachable without an explicit allow.
 */
export function requireRole(...roles) {
  if (roles.length === 0) {
    throw new Error('requireRole() needs at least one role');
  }
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required.' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden.' });
    }
    next();
  };
}
