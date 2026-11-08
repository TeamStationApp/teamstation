import type { ScoringAction } from './actions'
import { applyAction } from './apply'
import {
  copyGame,
  type GameState,
  lineupSideKey,
  setupOf,
  type Side
} from './state'

const SIDES: readonly Side[] = ['away', 'home']

/**
 * The sides each action of `log` changes the lineup of, or null for an
 * action that is not a lineup change: each side whose players, batting
 * order or defense differ after the action from the game just before it,
 * replayed from `base` (the game before the log). Every kind of lineup
 * action counts, a substitution or a position change as much as a roster.
 * From an action the game refuses on, a lineup action changes the side it
 * names, or both.
 */
export function lineupSides(
  base: GameState,
  log: readonly ScoringAction[]
): Array<readonly Side[] | null> {
  let game = base
  let broken = false
  return log.map(action => {
    const before = game
    if (!broken) {
      const applied = applyAction(copyGame(game), action, {
        inPlace: true,
        replay: true
      })
      if (applied.problems.length > 0) broken = true
      else game = applied.state
    }
    if (action.type !== 'lineup') return null
    if (action.effectiveSides != null) return action.effectiveSides
    if (action.kind === 'roster' && action.side != null) return [action.side]
    if (broken) return action.side != null ? [action.side] : SIDES
    const was = setupOf(before)
    const now = setupOf(game)
    return SIDES.filter(
      side => lineupSideKey(was, side) !== lineupSideKey(now, side)
    )
  })
}

/** The time of an ISO stamp, or none for a stamp missing or unreadable. */
export function stampTime(stamp: string | undefined): number | undefined {
  if (stamp == null) return undefined
  const time = Date.parse(stamp)
  return Number.isNaN(time) ? undefined : time
}

/**
 * The latest time each side's lineup was changed by `log[from…]`, from
 * `times` (the action times kept beside the log), in epoch milliseconds.
 * `sides` are `lineupSides` of the whole log.
 */
export function latestLineupChanges(
  sides: ReadonlyArray<readonly Side[] | null>,
  times: ReadonlyArray<string | undefined>,
  from = 0
): Partial<Record<Side, number>> {
  const latest: Partial<Record<Side, number>> = {}
  for (let index = from; index < sides.length; index++) {
    const time = stampTime(times[index])
    if (time == null) continue
    for (const side of sides[index] ?? [])
      if ((latest[side] ?? -Infinity) < time) latest[side] = time
  }
  return latest
}

/**
 * Whether a lineup change of `sides` made at `stamp` is older than one of
 * `latest` (another device's), so that one stands: the latest creation
 * time wins. A change with no readable time is never older.
 */
export function olderThan(
  sides: readonly Side[],
  stamp: string | undefined,
  latest: Partial<Record<Side, number>>
): boolean {
  const time = stampTime(stamp)
  if (time == null) return false
  return sides.some(side => (latest[side] ?? -Infinity) > time)
}
