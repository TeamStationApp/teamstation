import { FINAL_INDEX, storedRecordOf } from './gumbo'

/**
 * What a reset of a game's plays deletes, as the scorer is told it before
 * confirming: the at-bats and the innings they were in. The scoring screen
 * counts its stored game, and the server the stored plays and at-bat in
 * progress, with this one function, so both name the same numbers.
 */
export interface PlaysLost {
  atBats: number
  innings: number
}

interface PlayLike {
  about?: { atBatIndex?: unknown; inning?: unknown }
  playEvents?: unknown
}

/**
 * The completed plate appearances, the game's final entry left out, and the
 * at-bat in progress when it holds anything but lineup changes and game
 * flow (a substitution between at-bats, the third out's `closePlay`).
 */
export function playsLost(stored: {
  plays: readonly unknown[]
  currentPlay: unknown
}): PlaysLost {
  // A play an undo reopened keeps its row beside the at-bat in progress of
  // the same index: it is counted once, as the at-bat, as a replay reads it.
  const reopened = indexOf(stored.currentPlay)
  const counted = stored.plays.filter(
    play =>
      (indexOf(play) ?? 0) < FINAL_INDEX &&
      (reopened == null || indexOf(play) !== reopened)
  )
  if (atBatBegun(stored.currentPlay)) counted.push(stored.currentPlay)
  const innings = new Set(
    counted.map(play => (play as PlayLike).about?.inning).filter(isInning)
  )
  return { atBats: counted.length, innings: innings.size }
}

/**
 * Whether swapping home and away resets the game, as the server decides it:
 * any play stored, the game's final entry included, or an at-bat in progress
 * holding anything but lineup changes (a pitch, a play, an override, or
 * pitch events on its document). A reset
 * can delete no at-bat at all, so this, not `playsLost`, says whether to warn.
 */
export function resetsPlays(stored: {
  plays: readonly unknown[]
  currentPlay: unknown
}): boolean {
  if (stored.plays.length > 0) return true
  const play = stored.currentPlay
  if (play == null || typeof play !== 'object') return false
  const events = (play as PlayLike).playEvents
  if (Array.isArray(events) && events.length > 0) return true
  // As `pregameRecord` reads it, so a plain swap is one `maySwapSides` takes.
  return (
    storedRecordOf(play)?.actions.some(action => action.type !== 'lineup') ===
    true
  )
}

/**
 * What swapping home and away does to a game, decided once for the server
 * and every screen:
 *
 * - `withdrawn`: a game a team withdrew from is not changed at all.
 * - `scoredElsewhere`: a play or at-bat TeamStation did not score, or a game
 *   marked under way or final with nothing TeamStation scored. It cannot be
 *   swapped here, since a reset could not score it again.
 * - `reset`: plays or an at-bat TeamStation scored (`resetsPlays`): the swap
 *   deletes them first.
 * - `swap`: only lineups, before the first pitch: the sides change.
 */
export type SwapEffect = 'swap' | 'reset' | 'scoredElsewhere' | 'withdrawn'

/** What the screens say of a swap a game scored elsewhere refuses. */
export const SWAP_SCORED_ELSEWHERE =
  'This game was scored outside TeamStation, so home and away cannot be swapped here.'
/** What the server and the screens say of a withdrawn game. */
export const WITHDRAWN_GAME = 'This canceled game cannot be changed.'

const SWAP_EFFECTS: readonly SwapEffect[] = [
  'swap',
  'reset',
  'scoredElsewhere',
  'withdrawn'
]

export function swapEffect(
  stored: { plays: readonly unknown[]; currentPlay: unknown },
  game: { status: string; withdrawn: boolean }
): SwapEffect {
  if (game.withdrawn) return 'withdrawn'
  if (
    stored.plays.some(play => storedRecordOf(play) == null) ||
    (stored.currentPlay != null && storedRecordOf(stored.currentPlay) == null)
  )
    return 'scoredElsewhere'
  if (resetsPlays(stored)) return 'reset'
  return game.status === 'inProgress' || game.status === 'final'
    ? 'scoredElsewhere'
    : 'swap'
}

/**
 * A swap effect as a server sent it: one this app does not know is none,
 * as from a server that sends none.
 */
export function asSwapEffect(raw: unknown): SwapEffect | undefined {
  return SWAP_EFFECTS.find(effect => effect === raw)
}

/**
 * The warning a swap that resets gives: what it deletes, when that is any
 * at-bat at all.
 */
export function resetWarning(lost: PlaysLost): string {
  return lost.atBats > 0
    ? `Resets all game plays: ${playsLostText(lost)} will be lost.`
    : 'Resets all game plays.'
}

/** "5 at-bats in 2 innings", in the singular for one. */
export function playsLostText(lost: PlaysLost): string {
  const atBats = lost.atBats === 1 ? '1 at-bat' : `${lost.atBats} at-bats`
  const innings = lost.innings === 1 ? '1 inning' : `${lost.innings} innings`
  return `${atBats} in ${innings}`
}

function indexOf(play: unknown): number | undefined {
  const index = (play as PlayLike | null)?.about?.atBatIndex
  return typeof index === 'number' ? index : undefined
}

function isInning(inning: unknown): inning is number {
  return typeof inning === 'number'
}

/** Whether the at-bat in progress holds a pitch, a play or a runner. */
function atBatBegun(play: unknown): boolean {
  if (play == null || typeof play !== 'object') return false
  const record = storedRecordOf(play)
  if (record != null)
    return record.actions.some(
      action => action.type !== 'lineup' && action.type !== 'gameFlow'
    )
  const events = (play as PlayLike).playEvents
  return Array.isArray(events) && events.length > 0
}
