import { compare, hash } from 'bcryptjs'

/**
 * PeerTube stores bcrypt hashes, and the import copies them verbatim, so a
 * migrated user signs in with the password they already had. New passwords
 * are hashed the same way, which keeps one code path for both.
 */
const COST = 11

export async function hashPassword(password: string): Promise<string> {
  return await hash(password, COST)
}

/**
 * False for a user with no password at all — a kid with no login, or an
 * account that only signs in by e-mail code. It never throws on a malformed
 * stored hash; that is a wrong password as far as a caller is concerned.
 */
export async function passwordMatches(
  password: string,
  storedHash: string | null
): Promise<boolean> {
  if (storedHash == null || storedHash === '') return false
  try {
    return await compare(password, storedHash)
  } catch {
    return false
  }
}
