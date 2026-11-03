import type {
  BoardTimelineWindow,
  LineScoreStep,
  TeamStationClient
} from '../../common/api'
import type { ReplayBoxScore } from '../../common/replay/replayBoxScore'
import type { BoardLine } from '../../common/scoring/boardLineTypes'
import { boardAt } from '../player/scoreboardOverlay/boardAt'

export { startingBox } from '../../common/replay/startingBox'

export interface ReplayStatistics {
  boxes: Array<{
    at: number
    box: ReplayBoxScore | null
    message?: string | null
  }>
  lines?: LineScoreStep[]
  board?: BoardTimelineWindow | null
  message: string | null
}

/** Missing early records are a playhead state, not a failed data request. */
export function statisticsAt(
  statistics: ReplayStatistics,
  wall: number | null
): { box: ReplayBoxScore | undefined; message: string | null } {
  const step = boardAt(statistics.boxes, wall)
  const box = step?.box ?? undefined
  return {
    box,
    message:
      box !== undefined
        ? null
        : (step?.message ??
          statistics.message ??
          (statistics.boxes.length > 0
            ? 'Statistics begin with the first recorded play.'
            : null))
  }
}

export async function readTvStatistics(
  client: TeamStationClient,
  gameId: string
): Promise<ReplayStatistics> {
  try {
    const data = await client.gameStatistics(gameId)
    return {
      boxes: [
        ...(data.initial === null
          ? []
          : [{ at: -Infinity, box: data.initial }]),
        ...data.boxes
      ],
      lines: data.line.steps,
      board: data.board,
      message:
        data.boxes.length === 0 && data.initial === null
          ? 'Statistics are not available in the recorded plays.'
          : null
    }
  } catch (error) {
    const status = (error as { status?: number }).status
    return {
      boxes: [],
      lines: [],
      board: null,
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
