// Imports nothing, so a bundle that needs a random id (the TV's analytics)
// does not reach the device storage `deviceId.ts` keeps its id in.

/** A random version 4 UUID, from `crypto` where the runtime has it. */
export function randomUuid(
  random: (bytes: Uint8Array) => Uint8Array = fillRandom
): string {
  const bytes = random(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0'))
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join('')
  ].join('-')
}

function fillRandom(bytes: Uint8Array): Uint8Array {
  const crypto = (
    globalThis as {
      crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array }
    }
  ).crypto
  if (crypto?.getRandomValues != null) return crypto.getRandomValues(bytes)
  // Hermes without a crypto polyfill. The id only tells this install's
  // streams apart from another device's; it guards nothing.
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = Math.floor(Math.random() * 256)
  return bytes
}
