import { createPrivateKey, type KeyObject, sign } from 'node:crypto'

/**
 * A compact JWT signed with `key`: ES256 (P-256, the signature as the raw
 * r ‖ s JWS wants) or RS256. APNs takes the first as its provider token, and
 * Google's OAuth the second as the grant a service account sends.
 */
export function signJwt(
  alg: 'ES256' | 'RS256',
  header: Record<string, string>,
  claims: Record<string, unknown>,
  key: KeyObject
): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  const input = `${encode({ alg, ...header })}.${encode(claims)}`
  const signature = sign(
    'sha256',
    Buffer.from(input),
    alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key
  )
  return `${input}.${signature.toString('base64url')}`
}

/** A PEM private key, read once; a configured key may keep `\n` escaped. */
export function privateKeyOf(pem: string): KeyObject {
  return createPrivateKey(pem.replace(/\\n/g, '\n'))
}
