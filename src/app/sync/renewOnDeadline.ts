import { REQUEST_DEADLINE_MS } from '../../common/api'

/** How long the phone watches a session before it decides (`STALL_CHECK_MS` in `RCTConnections.mm`). */
export const STALL_CHECK_MS = 2000

/**
 * A client's `onDeadlineMissed` that asks for a new connection (`renew`): on
 * a stalled link every request misses its deadline, and one new connection
 * for the next is enough. `renew` answers whether it renewed (it may find the
 * link slow, not stalled); after a renewal none is asked for again within
 * `deadlineMs` (the request deadline: `REQUEST_DEADLINE_MS`, the app
 * client's), and none while one is still deciding. A `renew` that throws,
 * fails, or has not answered within `waitMs` is passed over, as one that did
 * not renew.
 */
export function renewOnDeadline(
  renew: () => Promise<boolean> | boolean,
  // A monotonic clock: a wall clock set back would hold off every renewal
  // until it caught up.
  now: () => number = () => performance.now(),
  deadlineMs: number = REQUEST_DEADLINE_MS,
  waitMs: number = deadlineMs + STALL_CHECK_MS
): () => void {
  let renewedAt = -Infinity
  let deciding = false
  return () => {
    if (deciding || now() - renewedAt < deadlineMs) return
    deciding = true
    let asked: Promise<boolean | undefined>
    try {
      asked = Promise.resolve(renew())
    } catch {
      asked = Promise.resolve(false)
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<boolean>(resolve => {
      timer = setTimeout(() => {
        resolve(false)
      }, waitMs)
    })
    Promise.race([asked, late])
      .then(renewed => {
        if (renewed === true) renewedAt = now()
      })
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timer)
        deciding = false
      })
  }
}
