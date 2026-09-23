import { useCallback, useEffect, useLayoutEffect } from 'react'

import { setNavigationGuard } from '../navigation/useAddressBar'

export function useScoringExit(
  gameId: string,
  dirty: boolean,
  onExit: () => void,
  requestConfirmation?: () => Promise<boolean>
): () => void {
  const confirm = useCallback(
    async () =>
      !dirty ||
      (requestConfirmation != null
        ? await requestConfirmation()
        : window.confirm(
            'Exit Current Game? Your local development scoring will be discarded.'
          )),
    [dirty, requestConfirmation]
  )
  useLayoutEffect(
    () =>
      setNavigationGuard(async () => await confirm(), { name: 'game', gameId }),
    [confirm, gameId]
  )
  useEffect(() => {
    if (!dirty) return
    const unload = (event: BeforeUnloadEvent): void => {
      event.preventDefault()
      // Older browser versions require returnValue as well as preventDefault.
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', unload)
    return () => {
      window.removeEventListener('beforeunload', unload)
    }
  }, [dirty])
  return useCallback(() => {
    confirm()
      .then(accepted => {
        if (accepted) onExit()
      })
      .catch(() => undefined)
  }, [confirm, onExit])
}
