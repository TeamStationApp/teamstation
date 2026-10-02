import { base32, base64url } from 'rfc4648'

import { randomBytes } from './random'

/**
 * Message ids, made by the sending device.
 *
 * `msg_` and 26 lowercase base32 characters of 16 random bytes. Made on the
 * client so a post can be retried without becoming two, and here rather than
 * with `makeId` in `common/ids.ts`, which imports Node's `crypto` and so
 * cannot run on a phone. The server accepts nothing else.
 */
export const MESSAGE_ID_PATTERN = /^msg_[a-z2-7]{26}$/

export function newMessageId(): string {
  return `msg_${base32.stringify(randomBytes(16), { pad: false }).toLowerCase()}`
}

export function isMessageId(value: unknown): value is string {
  return typeof value === 'string' && MESSAGE_ID_PATTERN.test(value)
}

/**
 * Identity ids, made by the enrolling (or resetting) device, because the
 * PUK box it sends with the identity binds the id in its AAD. `cid_` and 16
 * base64url characters of 12 random bytes, the shape `makeId` gives every
 * other row.
 */
export const IDENTITY_ID_PATTERN = /^cid_[A-Za-z0-9_-]{16}$/

export function newIdentityId(): string {
  return `cid_${base64url.stringify(randomBytes(12), { pad: false })}`
}

export function isIdentityId(value: unknown): value is string {
  return typeof value === 'string' && IDENTITY_ID_PATTERN.test(value)
}
