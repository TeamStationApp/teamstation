import type { LineupPlayer } from '../../common/api'
import {
  alignPlan,
  type GamePlan,
  type GamePlanRow,
  planPlayerKey
} from '../../common/gamePlan'
import type { StagedRunner } from '../../common/scoring/rosterCommands'
import { setupOf, type Side } from '../../common/scoring/state'
import type { ScoringSessionState } from './scoringTypes'

/**
 * Whether the roster screen holds anything Save Rosters would save: the
 * draft's players, lineups and defences differ from the game it was opened
 * over, a pinch runner is staged, or a next batter other than the base's is
 * chosen. Objects compare by their keys, not their keys' order, as an edit
 * can add a key the base lists elsewhere; a change undone by hand is clean.
 */
export function rosterDirty(
  base: ScoringSessionState,
  draft: ScoringSessionState,
  runners: readonly StagedRunner[] = [],
  nextBatter?: number,
  baseNextBatter?: number
): boolean {
  return (
    runners.length > 0 ||
    nextBatter !== baseNextBatter ||
    !sameValue(setupOf(base), setupOf(draft))
  )
}

/**
 * Whether Save Rosters is lit: the draft validates, and it holds a change, a
 * lineup the game has not accepted yet, or a coach's changed game plan. A
 * lineup the game does not hold is a pending change, so saving it as it
 * stands is how it is accepted; once it is, Save waits for a change again.
 */
export function rosterSavable(
  dirty: boolean,
  unaccepted: boolean,
  problem: string | undefined,
  planChanged = false
): boolean {
  return problem == null && (dirty || unaccepted || planChanged)
}

/** A side's batting order as the game plan names its rows. */
export function planLineup(
  draft: ScoringSessionState,
  side: Side
): LineupPlayer[] {
  return draft.liveData.boxscore.teams[side].battingOrder.flatMap(id => {
    const player = draft.gameData.players[id]
    return player == null
      ? []
      : [
          {
            gumboId: player.local ? null : player.id,
            fullName: player.fullName,
            jersey: player.jersey
          }
        ]
  })
}

/**
 * Whether the coach's game plan differs from the one saved, read against the
 * lineup as it stands: its cells, innings and toggle, a cell changed back
 * being clean. The order its rows are in is the lineup's, not the plan's, so
 * a lineup reordered on another device leaves an opened plan clean.
 */
export function planDirty(
  plan: GamePlan | undefined,
  saved: GamePlan | undefined,
  lineup: readonly LineupPlayer[]
): boolean {
  if (plan == null || saved == null) return false
  return !sameValue(alignPlan(plan, lineup), alignPlan(saved, lineup))
}

/**
 * Whether a saved plan's rows bat in another order than the lineup being
 * saved, so saving the lineup saves the plan again in its order: the next
 * game's Rotate Leadoff reads its first row. Only the order of players both
 * hold counts, so a batter added or replaced at the field is no reason.
 */
export function planOrderStale(
  saved: GamePlan | undefined,
  lineup: readonly LineupPlayer[]
): boolean {
  if (saved == null) return false
  return !sameValue(...sharedOrder(saved.rows, alignPlan(saved, lineup).rows))
}

/** Two plans' rows as player keys, each kept to the players both hold. */
function sharedOrder(
  left: readonly GamePlanRow[],
  right: readonly GamePlanRow[]
): [string[], string[]] {
  const keys = (rows: readonly GamePlanRow[]): string[] =>
    rows.map(row => planPlayerKey(row.player))
  const [leftKeys, rightKeys] = [keys(left), keys(right)]
  return [
    leftKeys.filter(key => rightKeys.includes(key)),
    rightKeys.filter(key => leftKeys.includes(key))
  ]
}

/** Deep equality of plain data, ignoring key order and keys set to undefined. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a == null || b == null)
    return false
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => sameValue(item, b[index]))
    )
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = (value: Record<string, unknown>): string[] =>
    Object.keys(value).filter(key => value[key] !== undefined)
  const leftKeys = keys(left)
  return (
    leftKeys.length === keys(right).length &&
    leftKeys.every(
      key =>
        Object.prototype.hasOwnProperty.call(right, key) &&
        sameValue(left[key], right[key])
    )
  )
}
