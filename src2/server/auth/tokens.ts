import { createHash, randomBytes, timingSafeEqual } from 'crypto'

/**
 * Session and API tokens are random secrets that the server never stores. It
 * keeps only a SHA-256 of each, so a stolen database cannot be used to sign
 * in. The token itself is shown once, when it is created.
 *
 * SHA-256 is right here and bcrypt is not: these are 256-bit random strings,
 * not passwords, so there is nothing to brute-force and no reason to pay a
 * work factor on every request.
 */
export function makeToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Compares two hex digests without leaking where they differ. */
export function tokensMatch(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, 'hex')
  const b = Buffer.from(bHex, 'hex')
  if (a.length !== b.length || a.length === 0) return false
  return timingSafeEqual(a, b)
}

/** A six-digit e-mail code, zero-padded, from a uniform draw. */
export function makeEmailCode(): string {
  let value = 0
  do {
    value = randomBytes(4).readUInt32BE(0)
    // Reject the tail that would bias the modulo, then take six digits.
  } while (value >= 4294000000)
  return String(value % 1000000).padStart(6, '0')
}

export const hashEmailCode = hashToken

/**
 * Pulls a bearer token out of an Authorization header. Returns undefined for
 * anything that is not exactly `Bearer <token>`.
 */
export function bearerToken(header: string | undefined): string | undefined {
  if (header == null) return undefined
  const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(header.trim())
  return match?.[1]
}
