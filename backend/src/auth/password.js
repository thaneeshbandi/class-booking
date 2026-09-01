import { Algorithm, hash, hashSync, verify } from '@node-rs/argon2';

/**
 * Argon2id, per the OWASP recommendation: the hybrid mode is the right default
 * absent a specific reason to prefer Argon2i's side-channel resistance or
 * Argon2d's GPU resistance alone. Parameters (memory/time/parallelism cost)
 * are left at the library default and are embedded in the resulting PHC
 * string, so `verify` needs no options and a future policy change needs no
 * migration — it just changes what new hashes look like.
 */
const HASH_OPTIONS = { algorithm: Algorithm.Argon2id };

export async function hashPassword(password) {
  return hash(password, HASH_OPTIONS);
}

export async function verifyPassword(password, passwordHash) {
  return verify(passwordHash, password);
}

/**
 * A hash of a fixed, non-secret password, computed once at import time.
 *
 * The login endpoint runs `verifyPassword` against this when the email does
 * not match any user, so "no such user" and "wrong password" take the same
 * code path and cost roughly the same wall-clock time either way. Without it,
 * an attacker can enumerate valid emails by how much faster the "no such
 * user" response returns.
 */
export const DUMMY_PASSWORD_HASH = hashSync(
  'no-such-user-dummy-password',
  HASH_OPTIONS,
);
