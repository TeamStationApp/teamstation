import type { Route } from '../navigation/routes'

export function useScoringExit(
  _gameId: string,
  _saveFailed: boolean,
  onExit: () => void,
  flush?: () => Promise<boolean>,
  _active = true,
  _allow?: (route: Route) => boolean,
  _onNavigationApproved?: () => void
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
