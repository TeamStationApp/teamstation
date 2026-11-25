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

/**
 * One hook from several, each told in turn, as `tellGameWritten` tells one:
 * a hook that throws is logged, and the ones after it are still told.
 */
export function eachGameWritten(
  ...hooks: Array<(gameId: string) => void>
): (gameId: string) => void {
  return gameId => {
    for (const hook of hooks) tellGameWritten(hook, gameId)
  }
}
