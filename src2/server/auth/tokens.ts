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

/** The name of the one cookie this application sets. */
export const SESSION_COOKIE = 'gs_session'

/**
 * The session token from a request, header first and then the cookie.
 *
 * Two ways in on purpose rather than by accident. The web app is served from
 * the same origin as the API and uses a cookie, which is `HttpOnly` so its own
 * JavaScript cannot read it and a script injected onto the page cannot steal
 * it. A phone has no cookie jar, and neither has GS Distributor nor an AI with
 * a scoped token, so the bearer header is the native path rather than a
 * legacy one.
 *
 * The header wins when both are present: something that went to the trouble of
 * setting one is being explicit about which identity it means.
 */
export function sessionToken(
  authorization: string | undefined,
  cookieHeader: string | undefined
): string | undefined {
  const bearer = bearerToken(authorization)
  if (bearer != null) return bearer
  return cookieValue(cookieHeader, SESSION_COOKIE)
}

/** One cookie out of a `Cookie` header, without pulling in a parser. */
export function cookieValue(
  header: string | undefined,
  name: string
): string | undefined {
  if (header == null || header === '') return undefined
  for (const part of header.split(';')) {
    const at = part.indexOf('=')
    if (at < 0) continue
    if (part.slice(0, at).trim() !== name) continue
    const raw = part.slice(at + 1).trim()
    if (raw === '') return undefined
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw
    }
  }
  return undefined
}
