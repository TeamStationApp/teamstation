import type { Cleaner } from 'cleaners'

export type UserId = string
export type GumboId = number

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const FORMAT = /^usr_[1-9A-HJ-NP-Za-km-z]{22}$/
const LIMIT = 1n << 128n
const GUMBO_LIMIT = 1n << 53n

function valueOf(id: string): bigint {
  let value = 0n
  for (const digit of id.slice(4)) {
    value = value * 58n + BigInt(ALPHABET.indexOf(digit))
  }
  return value
}

/** The complete account value, validated before decoding; never a JS number. */
export function valueOfUserId(id: UserId): bigint {
  return valueOf(asUserId(id))
}

/** A canonical positive 128-bit identity. No coercion or case folding. */
export const asUserId: Cleaner<UserId> = raw => {
  if (typeof raw !== 'string' || raw.length !== 26 || !FORMAT.test(raw)) {
    throw new TypeError('Expected a canonical user id')
  }
  const value = valueOf(raw)
  if (value === 0n || value >= LIMIT) {
    throw new TypeError('Expected a positive 128-bit user id')
  }
  return raw
}

/** Encode a value without losing precision through a JavaScript number. */
export function userIdOfValue(value: bigint): UserId {
  if (typeof value !== 'bigint' || value <= 0n || value >= LIMIT) {
    throw new TypeError('Expected a positive 128-bit user id value')
  }
  let digits = ''
  while (value > 0n) {
    digits = ALPHABET[Number(value % 58n)] + digits
    value /= 58n
  }
  return 'usr_' + digits.padStart(22, '1')
}

/** Gumbo documents carry positive safe integers, never strings. */
export const asGumboId: Cleaner<GumboId> = raw => {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw <= 0) {
    throw new TypeError('Expected a positive safe-integer gumbo id')
  }
  return raw
}

export function userIdOfGumbo(id: GumboId): UserId {
  return userIdOfValue(BigInt(asGumboId(id)))
}

/** Only pre-migration identities encode their gumbo id in the user id. */
export function gumboOfUserId(id: UserId): GumboId | null {
  const value = valueOf(asUserId(id))
  return value < GUMBO_LIMIT ? Number(value) : null
}
