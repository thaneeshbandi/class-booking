import { Link } from 'react-router-dom';

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
 * Renders the backend's own explanation whenever it gave one — a 409
 * conflict/business-rule message, a 400 validation message — rather than a
 * generic "something went wrong". `error` is expected to be an `ApiError`
 * (see `api/client.js`), but a plain `Error`/string is handled too so this
 * never itself throws while trying to display a failure.
 */
export function ErrorBanner({ error, onRetry }) {
  if (!error) return null;
  const message = typeof error === 'string' ? error : error.message || 'Something went wrong.';
  const status = error?.status;
  return (
    <div className="state-block state-error" role="alert">
      <span className="state-error-content">
        <Icon name="warning" size={16} className="state-error-icon" />
        <span>
          {status ? <strong>{status}: </strong> : null}
          {message}
        </span>
      </span>
      {onRetry ? (
        <button type="button" className="btn btn-secondary btn-small" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}
