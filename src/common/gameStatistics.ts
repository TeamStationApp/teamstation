import type { BoardTimelineWindow, LineScoreTimeline } from './api'
import type { ReplayBoxScore } from './replay/replayBoxScore'
import type { StoredGame } from './scoring/session'

/** A native action's stable position, independent of its playback timestamp. */
export interface ScoringPosition {
  atBatIndex: number
  actionIndex: number
}

export interface StatisticsStep {
  at: number
  position: ScoringPosition | null
  box: ReplayBoxScore | null
  message: string | null
}

/** The historical view of the game's box-score resource. */
export interface GameStatistics {
  version: string
  board: BoardTimelineWindow
  line: LineScoreTimeline
  initial: ReplayBoxScore | null
  boxes: StatisticsStep[]
  /** The replay documents, named as the public reads them. */
  source: StoredGame
  /**
   * The players of `source` its reader reads in full, by gumbo id: the
   * client names them so (`withReaderNames`). Absent for nobody.
   */
  readerNames?: Record<string, string>
}

export interface StatisticsQuery {
  at?: number
  fromMs?: number
  toMs?: number
}

/** Preserve distinct actions at one instant; video uses the last one. */
export function statisticsWindow<T extends { at: number }>(
  steps: readonly T[],
  query: StatisticsQuery
): T[] {
  if (query.at !== undefined) {
    const step = steps.findLast(one => one.at <= query.at!)
    return step === undefined ? [] : [step]
  }
  let first = 0
  if (query.fromMs !== undefined) {
    while (first < steps.length && steps[first].at <= query.fromMs) first++
    first = Math.max(0, first - 1)
  }
  return steps
    .slice(first)
    .filter(one => query.toMs === undefined || one.at <= query.toMs)
}

/** Replay selects by applied action, so equal timestamps never reveal later actions. */
export function statisticsForAction(
  statistics: Pick<GameStatistics, 'initial' | 'boxes'>,
  position: ScoringPosition | null
): ReplayBoxScore | null {
  if (position === null) return statistics.initial
  return (
    statistics.boxes.findLast(
      step =>
        step.position !== null &&
        (step.position.atBatIndex < position.atBatIndex ||
          (step.position.atBatIndex === position.atBatIndex &&
            step.position.actionIndex <= position.actionIndex))
    )?.box ?? statistics.initial
  )
}

/** Replay groups deliveries across play boundaries; count the actions it applied. */
export function statisticsForCount(
  statistics: Pick<GameStatistics, 'initial' | 'boxes'>,
  count: number
): ReplayBoxScore | null {
  const native = statistics.boxes.filter(step => step.position !== null)
  if (count > 0) return native[Math.min(count, native.length) - 1]?.box ?? null
  const first = statistics.boxes.findIndex(step => step.position !== null)
  return first > 0 ? statistics.boxes[first - 1].box : statistics.initial
}
