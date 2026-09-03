import { useEffect, useState } from 'react';

import { archiveClass, createClass, fetchClasses, restoreClass, updateClass } from '../api/classes.js';
import { Badge } from '../components/Badge.jsx';
import { Modal } from '../components/Modal.jsx';
import { EmptyState, ErrorBanner, LoadingState } from '../components/States.jsx';

function ClassForm({ initial, onCancel, onSaved }) {
  const isEdit = Boolean(initial);
  const [title, setTitle] = useState(initial?.title ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [discipline, setDiscipline] = useState(initial?.discipline ?? '');
  const [defaultDurationMinutes, setDefaultDurationMinutes] = useState(
    initial?.defaultDurationMinutes ?? 60,
  );
  const [defaultCapacity, setDefaultCapacity] = useState(initial?.defaultCapacity ?? 10);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const body = {
        title,
        description,
        discipline,
        defaultDurationMinutes: Number(defaultDurationMinutes),
        defaultCapacity: Number(defaultCapacity),
      };
      const result = isEdit ? await updateClass(initial.id, body) : await createClass(body);
      onSaved(result.class);
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <ErrorBanner error={error} />

      <label className="form-label" htmlFor="class-title">
        Title
      </label>
      <input
        id="class-title"
        className="form-input"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="e.g. Vinyasa Flow"
        required
        autoFocus
      />

      <label className="form-label" htmlFor="class-discipline">
        Discipline
      </label>
      <input
        id="class-discipline"
        className="form-input"
        value={discipline}
        onChange={(event) => setDiscipline(event.target.value)}
        placeholder="e.g. Yoga, Pilates, Strength"
        required
      />

      <label className="form-label" htmlFor="class-description">
        Description
      </label>
      <textarea
        id="class-description"
        className="form-input"
        rows={3}
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        placeholder="A short description members and staff will see"
      />

      <div className="form-row">
        <div>
          <label className="form-label" htmlFor="class-duration">
            Default duration (minutes)
          </label>
          <input
            id="class-duration"
            type="number"
            min="1"
            className="form-input"
            value={defaultDurationMinutes}
            onChange={(event) => setDefaultDurationMinutes(event.target.value)}
            required
          />
          <p className="form-help">Used for new sessions unless overridden per session.</p>
        </div>
        <div>
          <label className="form-label" htmlFor="class-capacity">
            Default capacity
          </label>
          <input
            id="class-capacity"
            type="number"
            min="1"
            className="form-input"
            value={defaultCapacity}
            onChange={(event) => setDefaultCapacity(event.target.value)}
            required
          />
          <p className="form-help">Maximum members per session before waitlisting.</p>
        </div>
      </div>

      <div className="form-actions">
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting ? 'Saving…' : isEdit ? 'Save changes' : 'Create class'}
        </button>
      </div>
    </form>
  );
}

export function ClassesPage() {
  const [classes, setClasses] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [modal, setModal] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [notice, setNotice] = useState(null);

  function load() {
    setLoading(true);
    setError(null);
    fetchClasses(includeArchived)
      .then((data) => setClasses(data.classes))
      .catch(setError)
      .finally(() => setLoading(false));
  }

  useEffect(load, [includeArchived]);

  function handleSaved(klass) {
    const wasCreate = modal === 'create';
    setModal(null);
    setNotice(wasCreate ? `"${klass.title}" was created.` : `"${klass.title}" was updated.`);
    load();
  }

  async function handleArchiveToggle(klass) {
    setActionError(null);
    setNotice(null);
    try {
      if (klass.archivedAt) {
        await restoreClass(klass.id);
        setNotice(`"${klass.title}" was restored.`);
      } else {
        await archiveClass(klass.id);
        setNotice(`"${klass.title}" was archived.`);
      }
      load();
    } catch (err) {
      setActionError(err);
    }
  }

  return (
    <div>
      <div className="page-header">
        <div className="page-header-text">
          <h1>Classes</h1>
          <p className="page-subtitle">
            The catalog of classes the studio offers. Create a class here, then schedule sessions for
            it from the Sessions page.
          </p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setModal('create')}>
          Create class
        </button>
      </div>

      {notice ? <div className="state-block state-success">{notice}</div> : null}

      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={includeArchived}
          onChange={(event) => setIncludeArchived(event.target.checked)}
        />
        Show archived classes
      </label>

      {loading ? <LoadingState label="Loading classes…" /> : null}
      {error ? <ErrorBanner error={error} onRetry={load} /> : null}
      {actionError ? <ErrorBanner error={actionError} /> : null}
      {!loading && !error && classes?.length === 0 ? <EmptyState label="No classes yet." /> : null}

      {!loading && !error && classes?.length > 0 ? (
        <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Discipline</th>
              <th className="numeric">Duration</th>
              <th className="numeric">Capacity</th>
              <th>Status</th>
              <th className="col-actions">Actions</th>
            </tr>
          </thead>
          <tbody>
            {classes.map((klass) => (
              <tr key={klass.id}>
                <td>{klass.title}</td>
                <td>{klass.discipline}</td>
                <td className="numeric">{klass.defaultDurationMinutes} min</td>
                <td className="numeric">{klass.defaultCapacity}</td>
                <td>
                  {klass.archivedAt ? (
                    <Badge tone="tone-gray">Archived</Badge>
                  ) : (
                    <Badge tone="tone-green">Active</Badge>
                  )}
                </td>
                <td className="col-actions">
                <div className="table-actions">
                  <button
                    type="button"
                    className="btn btn-secondary btn-small"
                    onClick={() => setModal(klass)}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-small"
                    onClick={() => handleArchiveToggle(klass)}
                  >
                    {klass.archivedAt ? 'Restore' : 'Archive'}
                  </button>
                </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      ) : null}

      {modal ? (
        <Modal title={modal === 'create' ? 'Create class' : 'Edit class'} onClose={() => setModal(null)}>
          <ClassForm
            initial={modal === 'create' ? null : modal}
            onCancel={() => setModal(null)}
            onSaved={handleSaved}
          />
        </Modal>
      ) : null}
    </div>
  );
}
