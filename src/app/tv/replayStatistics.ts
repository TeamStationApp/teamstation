import type { GameDetail, TeamStationClient } from '../../common/api'
import type { ReplayBoxScore } from '../../common/replay/replayBoxScore'
import { readReplaySource } from '../../common/replay/replaySource'
import { startingBox } from '../../common/replay/startingBox'
import type { BoardLine } from '../../common/scoring/boardLineTypes'
import type { StoredGame } from '../../common/scoring/session'
import { boardAt } from '../player/scoreboardOverlay/boardAt'
import { type BoxStep, boxTimeline } from './playbackTimeline'

export { startingBox } from '../../common/replay/startingBox'

export interface ReplayStatistics {
  boxes: BoxStep[]
  message: string | null
}

/** Missing early records are a playhead state, not a failed data request. */
export function statisticsAt(
  statistics: ReplayStatistics,
  wall: number | null
): { box: ReplayBoxScore | undefined; message: string | null } {
  const box = boardAt(statistics.boxes, wall)?.box
  return {
    box,
    message:
      box !== undefined
        ? null
        : (statistics.message ??
          (statistics.boxes.length > 0
            ? 'Statistics begin with the first recorded play.'
            : null))
  }
}

/** Only a game without any plays can use a present-day lineup supplement. */
export function canSupplement(game: GameDetail, stored: StoredGame): boolean {
  return (
    (game.status === 'scheduled' || game.status === 'inProgress') &&
    stored.plays.length === 0 &&
    stored.currentPlay === null
  )
}

export async function readTvStatistics(
  client: TeamStationClient,
  gameId: string
): Promise<ReplayStatistics> {
  try {
    const { game, stored } = await readReplaySource(client, gameId)
    const boxes = boxTimeline(game, stored)
    if (boxes.length > 0) return { boxes, message: null }
    if (!canSupplement(game, stored))
      return {
        boxes: [],
        message: 'Replay statistics are not available for this game.'
      }
    const lineups = await client.gameLineups(gameId)
    if (
      lineups.generation !== undefined &&
      stored.generation !== undefined &&
      lineups.generation !== stored.generation
    )
      return { boxes: [], message: 'The game changed. Retry statistics.' }
    const box = startingBox(game, lineups)
    return box === null
      ? { boxes: [], message: 'Starting lineups are not available yet.' }
      : { boxes: [{ at: -Infinity, box }], message: null }
  } catch (error) {
    const status = (error as { status?: number }).status
    return {
      boxes: [],
      message:
        status === 401 || status === 403
          ? 'You do not have access to these statistics.'
          : 'Statistics could not load. Retry statistics.'
    }
  }
}

/** Both static and slide-up scores are projections of the very same replay box. */
export function lineOf(box: ReplayBoxScore): BoardLine {
  const side = (which: 'away' | 'home'): BoardLine['away'] => ({
    innings: box[which].innings,
    r: box[which].runs,
    h: box[which].hits,
    e: box[which].errors
  })
  return { away: side('away'), home: side('home') }
}
