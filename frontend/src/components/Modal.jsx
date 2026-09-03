import { useEffect } from 'react';

/** A minimal, dependency-free modal — a fixed overlay plus a centered panel.
 * No focus trap or animation library; correctness and keyboard-dismiss
 * (Escape) are what matter here, not polish. */
export function Modal({ title, subtitle, onClose, children, width }) {
  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        style={width ? { maxWidth: width } : undefined}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <h2 id="modal-title">{title}</h2>
            {subtitle ? <p className="modal-subtitle">{subtitle}</p> : null}
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

/** A confirmation prompt for a destructive action — every cancel/delete
 * action in the app routes through this rather than firing immediately. */
export function ConfirmDialog({ title, message, confirmLabel = 'Confirm', danger, onConfirm, onClose }) {
  return (
    <Modal title={title} onClose={onClose} width="420px">
      <p>{message}</p>
      <div className="form-actions">
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className={danger ? 'btn btn-danger' : 'btn btn-primary'}
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
