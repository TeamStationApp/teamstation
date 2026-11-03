import * as gameChanges from '../server/socket/gameChanges'

/**
 * The games whose plays `act` told the game socket to read again
 * (`notifyPlaysChanged`), in order, and what it gave. The writers reach the
 * function through the module's exports, so it is wrapped there while `act`
 * runs.
 */
export async function playsReadAgainDuring<T>(
  act: () => Promise<T>
): Promise<{ result: T; games: string[] }> {
  const module = gameChanges as unknown as Record<
    'notifyPlaysChanged',
    typeof gameChanges.notifyPlaysChanged
  >
  const real = module.notifyPlaysChanged
  const games: string[] = []
  module.notifyPlaysChanged = async (db, gameId) => {
    games.push(gameId)
    await real(db, gameId)
  }
  try {
    return { result: await act(), games }
  } finally {
    module.notifyPlaysChanged = real
  }
}
