import { useEffect, useState } from 'react'

import type { SponsorStore } from './sponsorStore'
import type { SponsorState } from './sponsorTypes'

/**
 * The store's latest state, read once and then kept up to date from its
 * notices; `null` until the first read has come back.
 */
export function useSponsorState(store: SponsorStore): SponsorState | null {
  const [state, setState] = useState<SponsorState | null>(null)
  useEffect(() => {
    let live = true
    // A notice that came before the first read is newer than it.
    let heard = false
    const unsubscribe = store.subscribe(next => {
      heard = true
      if (live) setState(next)
    })
    store
      .read()
      .then(next => {
        if (live && !heard) setState(next)
      })
      .catch(() => undefined)
    return () => {
      live = false
      unsubscribe()
    }
  }, [store])
  return state
}
