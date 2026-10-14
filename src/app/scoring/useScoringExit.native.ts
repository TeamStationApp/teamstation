import type { Route } from '../navigation/routes'

/**
 * Leaving the game first saves it; only a save that could not finish holds
 * the scorer back. A phone has no address to return to, so `returnTo` is
 * the web's alone.
 */
export function useScoringExit(
  _gameId: string,
  _saveFailed: boolean,
  onExit: () => void,
  flush?: () => Promise<boolean>,
  _active = true,
  _allow?: (route: Route) => boolean,
  _onNavigationApproved?: () => void,
  _returnTo?: Route
): () => void {
  return () => {
    if (flush == null) onExit()
    else
      flush()
        .then(saved => {
          if (saved) onExit()
        })
        .catch(() => undefined)
  }
}
