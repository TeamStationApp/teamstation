import type { GamePlansResponse, SidePlan } from '../common/api'
import {
  type GamePlan,
  type PlanCell,
  planHasPositions
} from '../common/gamePlan'
import { EMPTY_PLAN_HISTORY, EMPTY_PLAN_SAME_DAY } from '../common/planWarnings'
import type { PlayingTimeRules } from '../common/playingTimeRules'
import type { Position, Side } from '../common/scoring/state'

/**
 * Game plans for the development game of `scoringRoster(1)` away and
 * `scoringRoster(10)` home: each side's players bat in id order and field,
 * in that order, the positions of `PLAN_START`.
 */
export const PLAN_START: Position[] = [
  'P',
  'C',
  '1B',
  '2B',
  'SS',
  '3B',
  'LF',
  'CF',
  'RF'
]

/** A column that swaps the corners and the outfield's ends. */
export const PLAN_SWAPPED: PlanCell[] = [
  'P',
  'C',
  '3B',
  '2B',
  'SS',
  '1B',
  'RF',
  'CF',
  'LF'
]

/** A column that benches every batter: an inning not planned. */
export const PLAN_BLANK: PlanCell[] = PLAN_START.map(() => '')

/**
 * The plan of the side whose first player is `first` (1 away, 10 home):
 * every inning the starting defence, except the columns given, which name a
 * cell per batter. It is on when it holds a position, as the server says.
 */
export function scoringSidePlan(
  first: number,
  columns: Record<number, PlanCell[]>,
  options: {
    innings?: number
    rules?: PlayingTimeRules
  } = {}
): SidePlan {
  const innings = options.innings ?? 6
  const rows: GamePlan['rows'] = PLAN_START.map((position, at) => ({
    player: {
      gumboId: first + at,
      fullName: `Player ${at + 1}`,
      jersey: String(at + 1)
    },
    cells: Array.from(
      { length: innings },
      (_, inning) => columns[inning + 1]?.[at] ?? position
    )
  }))
  const plan: GamePlan = {
    enabled: planHasPositions({ rows }),
    innings,
    rows
  }
  return {
    teamId: first === 1 ? 'away' : 'home',
    plan,
    rules: options.rules ?? null,
    history: EMPTY_PLAN_HISTORY,
    sameDay: EMPTY_PLAN_SAME_DAY
  }
}

/** Both sides' plans as the server answers them: a side not given is null. */
export function scoringPlans(
  given: Partial<Record<Side, SidePlan>>
): GamePlansResponse {
  return { away: given.away ?? null, home: given.home ?? null }
}
