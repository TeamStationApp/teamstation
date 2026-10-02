import { asCurrentPlay } from './gumboPlay'

/** Who is at the plate, as DJ Game draws it. Top of an inning is the away side. */
export interface DjAtBat {
  side: 'away' | 'home'
  /** Null for a batter this game named without an account, such as a guest. */
  userId: number | null
}

/**
 * The plate appearance still in progress, or null when the game has none.
 * A document that is not a current play is treated as none, so a bad row
 * does not take the lineup list down with it.
 */
export function atBatFromCurrentPlay(raw: unknown): DjAtBat | null {
  if (raw == null) return null
  let play
  try {
    play = asCurrentPlay(raw)
  } catch {
    return null
  }
  const half = play.about.halfInning
  if (half !== 'top' && half !== 'bottom') return null
  return {
    side: half === 'top' ? 'away' : 'home',
    userId: batterId(play.matchup)
  }
}

function batterId(matchup: unknown): number | null {
  if (matchup == null || typeof matchup !== 'object' || !('batter' in matchup))
    return null
  const batter = matchup.batter
  if (batter == null || typeof batter !== 'object' || !('id' in batter))
    return null
  return typeof batter.id === 'number' ? batter.id : null
}
