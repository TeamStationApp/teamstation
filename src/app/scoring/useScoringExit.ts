import { useCallback, useEffect, useLayoutEffect } from 'react'

import type { Route } from '../navigation/routes'
import { setNavigationGuard } from '../navigation/useAddressBar'

/**
 * Leaving the game first saves it; only a save that could not finish holds the
 * scorer back, and the page warns before unloading while one is outstanding.
 *
 * The browser's Back returns to `returnTo`: by default the game's scoring
 * choices page, which is where the scorer is opened from.
 */
export function useScoringExit(
  gameId: string,
  saveFailed: boolean,
  onExit: () => void,
  flush?: () => Promise<boolean>,
  active = true,
  allow?: (route: Route) => boolean,
  onNavigationApproved?: () => void,
  returnTo?: Route
): () => void {
  const save = useCallback(
    async () => flush == null || (await flush()),
    [flush]
  )
  useLayoutEffect(
    () =>
      active
        ? setNavigationGuard(
            save,
            returnTo ?? { name: 'scoreOptions', gameId },
            allow,
            onNavigationApproved
          )
        : undefined,
    [save, gameId, active, allow, onNavigationApproved, returnTo]
  )
  useEffect(() => {
    const pagehide = (): void => {
      save().catch(() => undefined)
    }
    const unload = (event: BeforeUnloadEvent): void => {
      if (!saveFailed) return
      event.preventDefault()
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      event.returnValue = ''
    }
    window.addEventListener('pagehide', pagehide)
    window.addEventListener('beforeunload', unload)
    return () => {
      window.removeEventListener('pagehide', pagehide)
      window.removeEventListener('beforeunload', unload)
    }
  }, [save, saveFailed])
  return useCallback(() => {
    save()
      .then(saved => {
        if (saved) onExit()
      })
      .catch(() => undefined)
  }, [save, onExit])
}
