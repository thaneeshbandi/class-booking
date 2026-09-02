/** Small, consistent placeholders for the three states every data view can
 * be in besides "here's the data" — used instead of each page inventing its
 * own loading/error/empty markup. */

export function LoadingState({ label = 'Loading…' }) {
  return (
    <div className="state-block state-loading" role="status">
      {label}
    </div>
  );
}

export function EmptyState({ label = 'Nothing here yet.' }) {
  return <div className="state-block state-empty">{label}</div>;
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
      <span>
        {status ? <strong>{status}: </strong> : null}
        {message}
      </span>
      {onRetry ? (
        <button type="button" className="btn btn-secondary btn-small" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}
