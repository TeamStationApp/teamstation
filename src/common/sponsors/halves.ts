import type { GumboPlay } from '../gumboPlay'

/** A half-inning that has ended, and the play that ended it. */
export interface CompleteHalf {
  inning: number
  half: 'top' | 'bottom'
  /** The half's last play. */
  atBatIndex: number
}

/** The order of a half in the game: the top of an inning before its bottom. */
function orderOf(inning: number, half: 'top' | 'bottom'): number {
  return inning * 2 + (half === 'bottom' ? 1 : 0)
}

/** An Inning Ended marker among a play's events, by its type, as `withHalfOuts` reads it. */
function endsInning(play: GumboPlay): boolean {
  if (!Array.isArray(play.playEvents)) return false
  return play.playEvents.some(event => {
    if (event == null || typeof event !== 'object') return false
    const type = (event as Record<string, unknown>).type
    return typeof type === 'string' && /inning[ _]ended/i.test(type)
  })
}

/**
 * The halves of a game that have ended, in game order, from its plays
 * (passed through `withHalfOuts`, so a half's last play carries the outs it
 * ended with). A half is complete when its last play leaves three outs or
 * more, when one of its plays carries an Inning Ended marker, or when a later
 * half has a play. The first two end a half on the post that ends it; the
 * third covers a half closed some other way. The half being played is not
 * complete, and an undo that takes the third out away makes a half
 * incomplete again.
 */
export function completeHalves(plays: GumboPlay[]): CompleteHalf[] {
  const halves = new Map<
    number,
    { inning: number; half: 'top' | 'bottom'; last: GumboPlay; marked: boolean }
  >()
  for (const play of plays) {
    const inning = play.about.inning
    const half = play.about.halfInning
    if (inning == null || (half !== 'top' && half !== 'bottom')) continue
    const order = orderOf(inning, half)
    const seen = halves.get(order)
    const marked = (seen?.marked ?? false) || endsInning(play)
    const last =
      seen == null || play.about.atBatIndex > seen.last.about.atBatIndex
        ? play
        : seen.last
    halves.set(order, { inning, half, last, marked })
  }
  const orders = [...halves.keys()].sort((a, b) => a - b)
  const newest = orders.at(-1)
  return orders.flatMap(order => {
    const { inning, half, last, marked } = halves.get(order)!
    const outs = last.about.halfOuts ?? last.count?.outs ?? 0
    const complete = outs >= 3 || marked || order !== newest
    return complete ? [{ inning, half, atBatIndex: last.about.atBatIndex }] : []
  })
}
