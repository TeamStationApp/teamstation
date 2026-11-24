import { watchForeground } from './foreground'
import { watchReachableAgain } from './reachability'

/**
 * Runs `again` once, the next time the network comes back or the app comes
 * to the front, whichever is first: what a read that failed waits for
 * instead of a timer. Returns the way to stop waiting. Neither watch
 * answers for the state it begins in.
 */
export function whenBack(again: () => void): () => void {
  let waiting = true
  let unwatch = (): void => undefined
  let unfront = (): void => undefined
  const stop = (): void => {
    waiting = false
    unwatch()
    unfront()
  }
  const fire = (): void => {
    if (!waiting) return
    stop()
    again()
  }
  unwatch = watchReachableAgain(fire)
  unfront = watchForeground(fire)
  return stop
}
