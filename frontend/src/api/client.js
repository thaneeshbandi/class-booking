/**
 * The one place every HTTP request to the backend passes through. Cookie
 * handling, JSON encoding/decoding, and error normalization all live here so
 * every page/component deals with the same shapes.
 *
 * Auth is a session cookie the backend sets as `httpOnly` — this client
 * never reads or stores a token itself, only sends `credentials: 'include'`
 * so the browser attaches whatever cookie it already holds. There is
 * nothing here that could read the cookie's value even if it wanted to.
 */

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000';

export class ApiError extends Error {
  constructor(status, body) {
    super((body && body.error) || `Request failed with status ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

// A session cookie can go invalid mid-app-session (the 12-hour token
// expires, or staff deactivates the account) — any request can surface that
// as a 401 at any time, not just the initial load. Rather than every page
// separately deciding what a 401 means, the client calls one registered
// handler so `AuthContext` can clear its user state in exactly one place;
// React Router's own route guards then redirect to `/login` because there is
// no authenticated user anymore, not because this module called `navigate`
// itself (fetch clients have no router context to call it with).
let unauthorizedHandler = null;
export function setUnauthorizedHandler(handler) {
  unauthorizedHandler = handler;
}

function buildUrl(path, query) {
  const url = new URL(path, API_BASE_URL);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

async function request(path, { method = 'GET', body, query } = {}) {
  const headers = {};
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  const res = await fetch(buildUrl(path, query), {
    method,
    headers,
    body: payload,
    credentials: 'include',
  });

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    // The login endpoint's own 401 ("Invalid email or password") is a normal
    // form-validation outcome, not a session going invalid mid-app — only
    // every other endpoint's 401 means "the session cookie no longer works".
    if (res.status === 401 && path !== '/api/auth/login' && unauthorizedHandler) {
      unauthorizedHandler();
    }
    throw new ApiError(res.status, data);
  }
  return data;
}

/** For a binary/text response (the attendance CSV) — throws the same
 * `ApiError` on failure, but returns the raw `Response` on success so the
 * caller reads it as a blob rather than JSON. */
async function requestRaw(path, { query } = {}) {
  const res = await fetch(buildUrl(path, query), { credentials: 'include' });
  if (!res.ok) {
    let data = null;
    try {
      data = await res.json();
    } catch {
      // Not JSON — leave data null, the status code still carries the story.
    }
    if (res.status === 401 && unauthorizedHandler) {
      unauthorizedHandler();
    }
    throw new ApiError(res.status, data);
  }
  return res;
}

export const api = {
  get: (path, query) => request(path, { method: 'GET', query }),
  post: (path, body) => request(path, { method: 'POST', body }),
  patch: (path, body) => request(path, { method: 'PATCH', body }),
  del: (path) => request(path, { method: 'DELETE' }),
  getRaw: requestRaw,
};

/**
 * Triggers a browser "Save As" for an already-fetched response's body,
 * reading the filename from `Content-Disposition` when present (the backend
 * always sets one for the CSV) rather than inventing one client-side.
 */
export async function downloadResponse(response, fallbackFilename) {
  const disposition = response.headers.get('Content-Disposition') ?? '';
  const match = /filename="([^"]+)"/.exec(disposition);
  const filename = match ? match[1] : fallbackFilename;

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
