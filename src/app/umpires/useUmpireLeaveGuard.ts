import { useCallback, useRef } from 'react'

export interface UmpireLeaveGuard {
  /** The schedule's leave check, held while it is on show. */
  register: (check: () => Promise<boolean>) => () => void
  /** Asks the check, or says leaving is fine when none is held. */
  check: () => Promise<boolean>
  /** Whether a check is still deciding: a drag's pop waits on it, run out. */
  pending: () => boolean
  /**
   * Holds `move` until the check accepts, then runs it, or calls `rejected`.
   * True when the move is the guard's to settle; false when it may go ahead.
   */
  guard: (move: () => void, rejected?: () => void) => boolean
}

/**
 * The umpire schedule's leave check, as the shell asks it before any move: an
 * open note is saved first, and a save that fails keeps the schedule.
 */
export function useUmpireLeaveGuard(): UmpireLeaveGuard {
  const held = useRef<(() => Promise<boolean>) | undefined>(undefined)
  const approved = useRef(false)
  const deciding = useRef(0)
  const register = useCallback((check: () => Promise<boolean>) => {
    held.current = check
    return () => {
      if (held.current === check) held.current = undefined
    }
  }, [])
  const check = useCallback(
    async () => held.current == null || (await held.current()),
    []
  )
  const pending = useCallback(() => deciding.current > 0, [])
  const guard = useCallback(
    (move: () => void, rejected?: () => void): boolean => {
      const asked = held.current
      if (asked == null || approved.current) return false
      // A second move while the check is still deciding (Back again, once
      // a drag has sprung back past its wait) is refused: both moving would
      // leave two steps. Its caller hears so, and a history step it rode in
      // on is put back.
      if (deciding.current > 0) {
        rejected?.()
        return true
      }
      deciding.current++
      asked()
        .finally(() => {
          deciding.current--
        })
        .then(accepted => {
          if (!accepted || held.current !== asked) {
            rejected?.()
            return
          }
          approved.current = true
          try {
            move()
          } finally {
            approved.current = false
          }
        })
        .catch(() => rejected?.())
      return true
    },
    []
  )
  return { register, check, pending, guard }
}
