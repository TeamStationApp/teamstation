import { deviceStorage } from '../platform/deviceStorage'
import type { PreferenceStorage } from '../scoring/scoringPreferenceStore'

/** Where this install's id is kept. */
export const DEVICE_ID_KEY = 'phoneStream.deviceId'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

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

/**
 * This install's id, which the server keys its live-stream slots by: a
 * random UUID made the first time it is asked for and kept in the device's
 * storage after. It is never shown. Concurrent first calls share one id.
 */
export function deviceIdStore(
  storage: PreferenceStorage,
  makeId: () => string = randomUuid
): () => Promise<string> {
  let pending: Promise<string> | undefined
  return async () => {
    pending ??= (async () => {
      try {
        const kept = await storage.getItem(DEVICE_ID_KEY)
        if (kept != null && UUID.test(kept)) return kept
      } catch {
        // Unreadable storage: a fresh id, written below if it can be.
      }
      const id = makeId()
      try {
        await storage.setItem(DEVICE_ID_KEY, id)
      } catch {
        // Kept for this run only.
      }
      return id
    })()
    return await pending
  }
}

export const deviceId = deviceIdStore(deviceStorage)
