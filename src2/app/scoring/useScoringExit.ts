import { useCallback, useEffect, useLayoutEffect } from 'react'

import { setNavigationGuard } from '../navigation/useAddressBar'

/**
 * Leaving the game first saves it; only a save that could not finish holds the
 * scorer back, and the page warns before unloading while one is outstanding.
 *
 * The browser's Back returns to the game's Score Game section, which is
 * where the scorer is opened from.
 */
export function useScoringExit(
  gameId: string,
  saveFailed: boolean,
  onExit: () => void,
  flush?: () => Promise<boolean>
): () => void {
  const save = useCallback(
    async () => flush == null || (await flush()),
    [flush]
  )
  useLayoutEffect(
    () => setNavigationGuard(save, { name: 'game', gameId, tab: 'score' }),
    [save, gameId]
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
