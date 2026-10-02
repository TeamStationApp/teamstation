import { base32 } from 'rfc4648'

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
