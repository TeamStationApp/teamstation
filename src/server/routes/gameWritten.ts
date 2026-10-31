/**
 * Tells the scoreboard that a committed write changed this game. Fire and
 * forget: whatever the hook throws is logged and never fails the request.
 */
export function tellGameWritten(
  onGameWritten: ((gameId: string) => void) | undefined,
  gameId: string
): void {
  try {
    onGameWritten?.(gameId)
  } catch (error) {
    console.error('onGameWritten %s', gameId, error)
  }
}
