import type { Kysely } from 'kysely'

import type { GumboPlay } from '../../common/gumboPlay'
import type { Database } from '../db/database'
import { scoringUsers } from '../scoring/gumboIds'
import type { BattingLine } from '../stats'
import { eventTypeCounts } from './gumboStats'

/** Stored first appearances, with a play fallback while old rows rebuild. */
export async function boxScoreOrder(
  db: Kysely<Database>,
  gameId: string,
  lines: BattingLine[]
): Promise<BattingLine[]> {
  const first = new Map<number, number>()
  for (const line of lines)
    if (line.firstPa != null) first.set(line.userId, line.firstPa)
  if (lines.some(line => line.firstPa == null)) {
    const events = await db
      .selectFrom('events')
      .select('gumbo')
      .where('gameId', '=', gameId)
      .orderBy('atBatIndex', 'asc')
      .execute()
    const plays = events
      .map(row => row.gumbo as GumboPlay)
      .filter(play => eventTypeCounts(play.result.eventType)?.pa === true)
    const ids = plays.flatMap(play =>
      typeof play.matchup?.batter?.id === 'number'
        ? [play.matchup.batter.id]
        : []
    )
    const survivors = await scoringUsers(db, ids)
    for (const play of plays) {
      const id = play.matchup?.batter?.id
      if (typeof id !== 'number') continue
      const survivor = survivors.get(id) ?? id
      first.set(
        survivor,
        Math.min(first.get(survivor) ?? Infinity, play.about.atBatIndex)
      )
    }
  }
  return [...lines].sort((a, b) => {
    const delta =
      (first.get(a.userId) ?? Infinity) - (first.get(b.userId) ?? Infinity)
    return Number.isNaN(delta) || delta === 0 ? a.userId - b.userId : delta
  })
}
