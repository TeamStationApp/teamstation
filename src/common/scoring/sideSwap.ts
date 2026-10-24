import { storedRecordOf } from './gumbo'
import type { Side } from './state'

/**
 * Home and away exchanged on a game nobody has pitched to yet. A record
 * names teams, not sides, so it reads the same after the swap; what a game
 * still keeps by side moves with its team.
 */

/**
 * Whether a game's open at-bat record is still before the first play: no
 * record at all, or a TeamStation record of lineup changes and nothing else.
 * A pitch, a result, a runner, a manual state or an at-bat TeamStation did
 * not score each mean the game has begun.
 */
export function pregameRecord(currentPlay: unknown): boolean {
  if (currentPlay == null) return true
  const record = storedRecordOf(currentPlay)
  if (record == null) return false
  const events = (currentPlay as { playEvents?: unknown }).playEvents
  if (Array.isArray(events) && events.length > 0) return false
  return record.actions.every(action => action.type === 'lineup')
}

/** A side-keyed column, such as a game's guests, with its lists exchanged. */
export function swapSideLists<T extends Record<Side, unknown>>(lists: T): T {
  return { ...lists, home: lists.away, away: lists.home }
}
