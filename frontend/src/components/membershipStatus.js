/**
 * The three membership-status UI states the member home page shows —
 * display-only, mirroring `backend/src/domain/membership.js#isMembershipExpired`
 * (`expires_on < today`) without re-deciding anything: whether a *new*
 * booking is actually allowed is still enforced server-side, by that same
 * function, every time (see `docs/decisions.md`).
 */
export function membershipStatus(expiresOn) {
  const today = new Date().toISOString().slice(0, 10);
  const diffDays = Math.round(
    (new Date(`${expiresOn}T00:00:00`) - new Date(`${today}T00:00:00`)) / 86_400_000,
  );

  if (diffDays < 0) {
    return { tone: 'tone-red', label: 'Expired', detail: 'Membership expired.', expired: true };
  }
  if (diffDays <= 7) {
    const formatted = new Date(`${expiresOn}T00:00:00`).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
    return { tone: 'tone-amber', label: 'Expiring soon', detail: `Expires on ${formatted}`, expired: false };
  }
  return {
    tone: 'tone-green',
    label: 'Active',
    detail: `Expires in ${diffDays} day${diffDays === 1 ? '' : 's'}`,
    expired: false,
  };
}
