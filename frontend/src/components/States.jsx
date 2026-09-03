import { Link } from 'react-router-dom';

import { describeError } from './errorCopy.js';
import { Icon } from './Icon.jsx';

/** Small, consistent placeholders for the three states every data view can
 * be in besides "here's the data" — used instead of each page inventing its
 * own loading/error/empty markup. */

export function LoadingState({ label = 'Loading…' }) {
  return (
    <div className="state-block state-loading" role="status">
      <span className="spinner" aria-hidden="true" />
      {label}
    </div>
  );
}

/** `icon` names a shape from `Icon`; `action` is an optional `{ label, to }`
 * or `{ label, onClick }` rendered as a small CTA beneath the message, for
 * the cases where there's somewhere useful to send an empty page. */
export function EmptyState({ label = 'Nothing here yet.', icon = 'inbox', action }) {
  return (
    <div className="state-block state-empty state-empty-block">
      <span className="state-empty-icon" aria-hidden="true">
        <Icon name={icon} size={22} />
      </span>
      <p>{label}</p>
      {action ? (
        action.to ? (
          <Link to={action.to} className="btn btn-secondary btn-small">
            {action.label}
          </Link>
        ) : (
          <button type="button" className="btn btn-secondary btn-small" onClick={action.onClick}>
            {action.label}
          </button>
        )
      ) : null}
    </div>
  );
}

/**
 * The reusable error-presentation system. `error` is expected to be an
 * `ApiError` (see `api/client.js`), but a plain `Error`/string is handled
 * too so this never itself throws while trying to display a failure. Every
 * status/message is translated through `describeError` — nothing here ever
 * renders a raw HTTP status prefix, a database error, or a stack trace; see
 * `docs/decisions.md` for why that translation is centralized rather than
 * left to each page.
 *
 * `ErrorBanner` is the form-level and action-level surface: a fixed banner
 * near the top of a form or list, used identically for a failed submit and
 * for a failed data load. It is the one error component every page in this
 * app already imports, so redesigning it here — icon, friendly title,
 * friendly message, optional Retry, optional Dismiss, `role="alert"` — is
 * what makes every one of those call sites polished without editing them
 * individually.
 */
export function ErrorBanner({ error, onRetry, onDismiss, context }) {
  const described = describeError(error, context);
  if (!described) return null;
  return (
    <div className="state-block state-error" role="alert">
      <span className="state-error-content">
        <Icon name="warning" size={16} className="state-error-icon" />
        <span>
          <strong>{described.title}.</strong> {described.message}
        </span>
      </span>
      <span className="state-error-actions">
        {onRetry ? (
          <button type="button" className="btn btn-secondary btn-small" onClick={onRetry}>
            <Icon name="refresh" size={14} />
            Retry
          </button>
        ) : null}
        {onDismiss ? (
          <button type="button" className="state-error-dismiss" aria-label="Dismiss" onClick={onDismiss}>
            <Icon name="close" size={14} />
          </button>
        ) : null}
      </span>
    </div>
  );
}

/**
 * The page-level surface: a whole page (or a whole page section) failed to
 * load its data — centered icon, a short headline, the same translated
 * explanation `ErrorBanner` uses, and a prominent Retry. Used where a page's
 * *entire* content depends on one request that just failed, as opposed to a
 * form or list that still has something else to show alongside the error.
 */
export function PageError({ error, onRetry, context }) {
  const described = describeError(error, context) ?? {
    title: 'Something went wrong',
    message: 'Please try again.',
  };
  return (
    <div className="state-block state-page-error" role="alert">
      <span className="state-page-error-icon" aria-hidden="true">
        <Icon name="warning" size={26} />
      </span>
      <h2>{described.title}</h2>
      <p>{described.message}</p>
      {onRetry ? (
        <button type="button" className="btn btn-primary btn-small" onClick={onRetry}>
          <Icon name="refresh" size={14} />
          Retry
        </button>
      ) : null}
    </div>
  );
}

/** A small, inline field-level error — the text directly under one form
 * field, used by the newer forms (profile, forgot password) that validate
 * more than one field at a time. Renders nothing for a falsy message, so a
 * call site can pass a per-field message straight through unconditionally. */
export function FieldError({ message }) {
  if (!message) return null;
  return (
    <p className="field-error" role="alert">
      {message}
    </p>
  );
}
