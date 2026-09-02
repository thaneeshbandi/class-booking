const STATUS_TONE = {
  booked: 'tone-blue',
  waitlisted: 'tone-amber',
  cancelled: 'tone-gray',
  attended: 'tone-green',
  no_show: 'tone-red',
};

const STATUS_LABEL = {
  booked: 'Booked',
  waitlisted: 'Waitlisted',
  cancelled: 'Cancelled',
  attended: 'Attended',
  no_show: 'No show',
};

/** Renders the server's exact status vocabulary — never a client-invented
 * label for a status the backend didn't return. */
export function StatusBadge({ status }) {
  const tone = STATUS_TONE[status] ?? 'tone-gray';
  const label = STATUS_LABEL[status] ?? status;
  return <span className={`badge ${tone}`}>{label}</span>;
}

export function Badge({ tone = 'tone-gray', children }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
