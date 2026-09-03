function initialsOf(fullName) {
  const parts = fullName.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase();
}

/** A small initials avatar — no image upload exists anywhere in this
 * project, so this is the only avatar representation there will ever be. */
export function Avatar({ fullName, size = 32 }) {
  return (
    <span
      className="avatar"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}
      aria-hidden="true"
    >
      {initialsOf(fullName)}
    </span>
  );
}
