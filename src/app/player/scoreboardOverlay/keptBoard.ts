import type { BoardStep, TeamStationClient } from '../../../common/api'
import { zeroedStep } from './boardAt'

/**
 * The last board each game showed this session, by client: once a game's
 * board has shown, every player on that game keeps one.
 */
const kept = new WeakMap<TeamStationClient, Map<string, BoardStep>>()

/**
 * The board to draw for a game, given the one its video's time frame calls
 * for (`framed`, null when the frame has none of the game's events, or while
 * anything it needs is loading).
 *
 * Once a game has shown a board it never goes away, so it cannot blink out
 * and back between videos, angles, seeks, reloads and loading gaps: without a
 * framed board it shows the game's board at the frame on screen; before the
 * game's first event, the zeroed board; while the frame's wall time or the
 * steps are unknown, the board it last showed. Another game starts afresh,
 * and so does one the server then says shows no board (an administrator moved
 * the start date past it).
 */
export function keptBoard(options: {
  client: TeamStationClient
  gameId: string | null | undefined
  /**
   * The server has said the game's board does not show (its overlay answer's
   * `show` is false): nothing is drawn, and the board it kept is forgotten.
   */
  hidden?: boolean
  framed: BoardStep | null
  /** The game's board at the frame on screen, or null. */
  step: BoardStep | null
  steps: readonly BoardStep[] | null
  /** The wall time of the frame on screen, or null while unknown. */
  wallMs: number | null
}): BoardStep | null {
  const { client, gameId, framed, step, steps, wallMs } = options
  if (gameId == null) return framed
  let games = kept.get(client)
  if (games == null) {
    games = new Map()
    kept.set(client, games)
  }
  if (options.hidden === true) {
    games.delete(gameId)
    return null
  }
  if (framed != null) {
    games.set(gameId, framed)
    return framed
  }
  const last = games.get(gameId)
  if (last == null) return null
  if (step != null) return step
  if (steps != null && wallMs != null) return zeroedStep(steps, wallMs) ?? last
  return last
}
