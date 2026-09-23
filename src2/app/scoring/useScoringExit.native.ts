/** The native renderer is unavailable; no scoring session can be entered. */
export function useScoringExit(
  _gameId: string,
  _dirty: boolean,
  onExit: () => void
): () => void {
  return onExit
}
