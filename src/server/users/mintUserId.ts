import { randomBytes } from 'node:crypto'

import { type UserId, userIdOfValue } from '../../common/userId'

/** Reserve the low 53-bit range for identities derived from existing users. */
export function mintUserId(
  draw: (size: number) => Uint8Array = randomBytes
): UserId {
  for (;;) {
    const bytes = draw(16)
    if (bytes.length !== 16) throw new Error('Expected 16 random bytes')
    let value = 0n
    for (const byte of bytes) value = (value << 8n) | BigInt(byte)
    if (value >= 1n << 53n) return userIdOfValue(value)
  }
}
