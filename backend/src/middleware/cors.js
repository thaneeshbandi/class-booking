import { env } from '../config/env.js';

/**
 * Hand-rolled rather than the `cors` package, matching this codebase's
 * existing preference for a few lines of plain code over a dependency for
 * something this small (`auth/cookies.js` parses the `Cookie` header itself
 * for the same reason).
 *
 * `Access-Control-Allow-Origin` is always the single configured
 * `FRONTEND_ORIGIN`, never `*`: a wildcard cannot be combined with
 * `Access-Control-Allow-Credentials: true`, and credentials (the httpOnly
 * auth cookie) are exactly what cross-origin requests here need to carry.
 * `Vary: Origin` tells any intermediate cache that the response depends on
 * the request's origin, so a cached response for one origin is never served
 * to another.
 */
export function cors(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', env.FRONTEND_ORIGIN);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Vary', 'Origin');
  // `Content-Disposition` is not one of the CORS-safelisted response headers
  // browsers expose to cross-origin `fetch` JavaScript by default (only
  // Cache-Control/Content-Language/Content-Length/Content-Type/Expires/
  // Last-Modified/Pragma are) — without this, the frontend's attendance-CSV
  // download would silently fail to read the backend's real filename and
  // fall back to a generic one, a bug `curl` cannot reveal since it never
  // enforces this restriction the way an actual browser does.
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
    return res.status(204).end();
  }

  next();
}
