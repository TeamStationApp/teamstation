import { createHash, createHmac } from 'node:crypto'

import { asUserId } from '../../common/userId'

/**
 * The key a signed-in device uses to prove, on its own network, that another
 * device belongs to the same TeamStation account.
 *
 * Devices near each other (a Director and the phones beside it) agree on which
 * game they publish to without ever handing one another a login. Each fetches
 * this key with its **own** session; two sessions of the same person on the
 * same server get the same key, anybody else gets a different one, and the key
 * is good for nothing but the local event-control protocol. It is not a bearer
 * token and no route accepts it as one.
 *
 * Every input is length-prefixed — a two-byte big-endian byte count before the
 * bytes — so no two different inputs can concatenate to the same message. The
 * exact bytes are pinned by the shared fixtures in
 * `mobile/apps/common/EventControl/Tests/Fixtures/keys.json`.
 */

/** Names the protocol and its version inside every derivation. */
export const DEVICE_EVENT_CONTROL_DOMAIN = 'device-event-control:v2'
const KEY_ID_DOMAIN = 'device-event-control:v2:keyid'
const ACCOUNT_TAG_DOMAIN = 'device-event-control:v2:account-tag'

/** What `GET /device-event-control/key` answers. */
export interface DeviceEventControlGrant {
  version: 2
  /** The server's canonical public origin, `https://host[:port]`. */
  issuer: string
  /** The caller's user ID as a canonical string. */
  userId: string
  /** Opaque, equal for every device of the same account: 32 hex characters. */
  accountTag: string
  /** Names the server secret the key came from: 16 hex characters. */
  keyId: string
  /** The HMAC-SHA256 key itself: 64 hex characters. */
  key: string
}

/**
 * The fewest bytes a secret may have. The key ID is an unkeyed hash of the
 * secret and goes to every signed-in device, so a short secret could be found
 * from it offline, and with it every account's key. 32 random bytes as hex (64
 * characters) is what the configuration asks for.
 */
export const DEVICE_EVENT_CONTROL_MIN_SECRET_BYTES = 32

/** Why `secret` cannot be used, or undefined when it can. */
export function deviceEventControlSecretProblem(
  secret: string
): string | undefined {
  if (secret === '') return 'deviceEventControlSecret is not set'
  if (
    Buffer.byteLength(secret, 'utf8') < DEVICE_EVENT_CONTROL_MIN_SECRET_BYTES
  ) {
    return `deviceEventControlSecret is shorter than ${DEVICE_EVENT_CONTROL_MIN_SECRET_BYTES} bytes`
  }
  return undefined
}

/** `u16be(byteLength) || bytes` for each part, one after another. */
export function lengthPrefixed(...parts: Array<string | Buffer>): Buffer {
  const out: Buffer[] = []
  for (const part of parts) {
    const bytes = typeof part === 'string' ? Buffer.from(part, 'utf8') : part
    if (bytes.length > 0xffff) throw new Error('A field is over 65535 bytes')
    const length = Buffer.alloc(2)
    length.writeUInt16BE(bytes.length)
    out.push(length, bytes)
  }
  return Buffer.concat(out)
}

/** HMAC-SHA256(secret, lp(domain) || lp(issuer) || lp(userId)). */
export function deviceEventControlKey(
  secret: string,
  issuer: string,
  userId: string
): Buffer {
  return createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(
      lengthPrefixed(DEVICE_EVENT_CONTROL_DOMAIN, issuer, asUserId(userId))
    )
    .digest()
}

/**
 * The first 16 hex characters of SHA-256(lp(keyid domain) || lp(secret)).
 *
 * A rotated secret changes it, which is how a device learns that the key it
 * cached and the key its neighbour holds no longer come from the same secret.
 */
export function deviceEventControlKeyId(secret: string): string {
  return createHash('sha256')
    .update(lengthPrefixed(KEY_ID_DOMAIN, secret))
    .digest('hex')
    .slice(0, 16)
}

/** The first 32 hex characters of HMAC-SHA256(key, lp(tag domain)). */
export function deviceEventControlAccountTag(key: Buffer): string {
  return createHmac('sha256', key)
    .update(lengthPrefixed(ACCOUNT_TAG_DOMAIN))
    .digest('hex')
    .slice(0, 32)
}

/** Everything a device needs, for the caller `userId` on `issuer`. */
export function deviceEventControlGrant(
  secret: string,
  issuer: string,
  userId: string
): DeviceEventControlGrant {
  const problem = deviceEventControlSecretProblem(secret)
  if (problem != null) throw new Error(problem)
  const id = asUserId(userId)
  const key = deviceEventControlKey(secret, issuer, id)
  return {
    version: 2,
    issuer,
    userId: id,
    accountTag: deviceEventControlAccountTag(key),
    keyId: deviceEventControlKeyId(secret),
    key: key.toString('hex')
  }
}
