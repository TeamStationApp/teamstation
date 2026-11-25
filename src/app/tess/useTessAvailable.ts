import { useEffect, useState } from 'react'

import type { Health } from '../../common/api'
import { whenBack } from '../sync/whenBack'

/**
 * Whether this server offers Tess to the person signed in: its health says
 * `tess: true`. An older server, which says nothing, does not. A failed check
 * is asked again once the network or the app comes back (`whenBack`), never
 * on a timer; signing out forgets the answer.
 */
export function useTessAvailable(
  health: () => Promise<Health>,
  signedInAs: string | undefined
): boolean {
  const [available, setAvailable] = useState(false)
  useEffect(() => {
    setAvailable(false)
    if (signedInAs == null) return
    let live = true
    let waiting: (() => void) | undefined
    const ask = (): void => {
      health().then(
        reply => {
          if (live) setAvailable(reply.tess === true)
        },
        () => {
          if (live) waiting = whenBack(ask)
        }
      )
    }
    ask()
    return () => {
      live = false
      waiting?.()
    }
  }, [health, signedInAs])
  return available
}
