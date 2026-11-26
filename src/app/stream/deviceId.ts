import { deviceStorage } from '../platform/deviceStorage'
import type { PreferenceStorage } from '../scoring/scoringPreferenceStore'
import { randomUuid } from './randomUuid'

export { randomUuid }

/** Where this install's id is kept. */
export const DEVICE_ID_KEY = 'phoneStream.deviceId'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** How many times a read of the stored id is tried before giving up on it. */
const READ_ATTEMPTS = 3

/**
 * This install's id, which the server keys its live-stream slots by: a
 * random UUID made the first time it is asked for and kept in the device's
 * storage after. It is never shown. Concurrent first calls share one id.
 *
 * Storage that will not answer is not storage that is empty. The read is
 * tried again, and if it never answers this run gets an id of its own that
 * is not written: writing it would put a new identity over the stored one for
 * good, and the server would no longer know this phone's streams as its own —
 * an interrupted take's redial would be refused its own camera's name.
 */
export function deviceIdStore(
  storage: PreferenceStorage,
  makeId: () => string = randomUuid
): () => Promise<string> {
  let pending: Promise<string> | undefined
  return async () => {
    pending ??= (async () => {
      let read = false
      for (let attempt = 0; attempt < READ_ATTEMPTS && !read; attempt++) {
        try {
          const kept = await storage.getItem(DEVICE_ID_KEY)
          if (kept != null && UUID.test(kept)) return kept
          read = true
        } catch {
          // Asked again: a busy store usually answers the next time.
        }
      }
      const id = makeId()
      if (!read) return id
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
