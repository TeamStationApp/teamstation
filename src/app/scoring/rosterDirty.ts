import type { StagedRunner } from '../../common/scoring/rosterCommands'
import { setupOf } from '../../common/scoring/state'
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
 * Whether Save Rosters is lit: the draft validates, and it holds a change or
 * a lineup the game has not accepted yet. A lineup the game does not hold is
 * a pending change, so saving it as it stands is how it is accepted; once it
 * is, Save waits for a change again.
 */
export function rosterSavable(
  dirty: boolean,
  unaccepted: boolean,
  problem: string | undefined
): boolean {
  return problem == null && (dirty || unaccepted)
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
