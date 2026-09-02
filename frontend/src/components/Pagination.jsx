/** Purely a control surface over the server's own pagination result
 * (`{ page, pageSize, total, totalPages }` from `GET /api/bookings`) — it
 * never recomputes `totalPages` or slices data itself. */
export function Pagination({ page, totalPages, total, onPageChange }) {
  if (total === 0) return null;

  return (
    <div className="pagination">
      <span className="pagination-summary">
        Page {page} of {totalPages} · {total} total
      </span>
      <div className="pagination-controls">
        <button
          type="button"
          className="btn btn-secondary btn-small"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          Previous
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-small"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
        >
          Next
        </button>
      </div>
    </div>
  );
}
