export function useScoringExit(
  _gameId: string,
  _saveFailed: boolean,
  onExit: () => void,
  flush?: () => Promise<boolean>
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
