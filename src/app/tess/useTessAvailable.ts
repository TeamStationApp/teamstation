import { useEffect, useState } from 'react'

import type { Health } from '../../common/api'

/** How soon a failed health check is asked again while someone is signed in. */
export const TESS_HEALTH_RETRY_MS = 5000

/**
 * Whether this server offers Tess to the person signed in: its health says
 * `tess: true`. An older server, which says nothing, does not. A failed check
 * is asked again until one answers; signing out forgets the answer.
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
    let timer: ReturnType<typeof setTimeout> | undefined
    const ask = (): void => {
      health().then(
        reply => {
          if (live) setAvailable(reply.tess === true)
        },
        () => {
          if (live) timer = setTimeout(ask, TESS_HEALTH_RETRY_MS)
        }
      )
    }
    ask()
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [health, signedInAs])
  return available
}
