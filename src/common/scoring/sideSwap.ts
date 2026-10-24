import type { ScoringAction } from './actions'
import { recordOf, type TeamStationRecord } from './gumbo'
import type { GameSetup, Side } from './state'

/**
 * Home and away exchanged on a game nobody has pitched to yet. Everything
 * that names a side moves with its team; players, who name their team and no
 * side, stay as they are.
 */

/**
 * Whether a game's open at-bat record is still before the first play: no
 * record at all, or a TeamStation record of lineup changes and nothing else.
 * A pitch, a result, a runner, a manual state or an at-bat TeamStation did
 * not score each mean the game has begun.
 */
export function pregameRecord(currentPlay: unknown): boolean {
  if (currentPlay == null) return true
  const record = recordOf(currentPlay)
  if (record == null) return false
  const events = (currentPlay as { playEvents?: unknown }).playEvents
  if (Array.isArray(events) && events.length > 0) return false
  return record.actions.every(action => action.type === 'lineup')
}

const OTHER: Record<Side, Side> = { home: 'away', away: 'home' }

function swapSides<T extends Pick<GameSetup, 'sides'>>(setup: T): T {
  return { ...setup, sides: { home: setup.sides.away, away: setup.sides.home } }
}

function swapAction(action: ScoringAction): ScoringAction {
  if (action.type !== 'lineup') return action
  const swapped = { ...action }
  if (action.side != null) swapped.side = OTHER[action.side]
  if (action.setup != null) swapped.setup = swapSides(action.setup)
  if (action.confirmed != null)
    swapped.confirmed = action.confirmed.map(side => OTHER[side])
  if (action.unseen != null)
    swapped.unseen = action.unseen.map(side => OTHER[side])
  return swapped
}

/**
 * The record with every side moved to the other team: each lineup action's
 * side, setup and confirmed and unseen sides, and the setup before the play.
 * Swapping it again gives the record back.
 */
export function swapRecordSides(record: TeamStationRecord): TeamStationRecord {
  return {
    ...record,
    setupBefore: swapSides(record.setupBefore),
    actions: record.actions.map(swapAction)
  }
}

/** A side-keyed column, such as a game's guests, with its lists exchanged. */
export function swapSideLists<T extends Record<Side, unknown>>(lists: T): T {
  return { ...lists, home: lists.away, away: lists.home }
}
