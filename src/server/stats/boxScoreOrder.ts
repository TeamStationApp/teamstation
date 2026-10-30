import type { Kysely } from 'kysely'

import type { GumboPlay } from '../../common/gumboPlay'
import type { Database } from '../db/database'
import { withdrawnKey, withdrawnPlayers } from '../games/withdrawn'
import { scoringUsers } from '../scoring/gumboIds'
import type { BattingLine, PitchingLine } from '../stats'
import { survivorsOf } from '../users/survivors'
import { eventTypeCounts } from './gumboStats'

type Doc = Record<string, unknown>
const doc = (value: unknown): Doc =>
  value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Doc)
    : {}
const idOf = (value: unknown): number | null => {
  const id = doc(value).id
  return typeof id === 'number' ? id : null
}

async function gamePlays(
  db: Kysely<Database>,
  gameId: string
): Promise<GumboPlay[]> {
  const events = await db
    .selectFrom('events')
    .select('gumbo')
    .where('gameId', '=', gameId)
    .orderBy('atBatIndex', 'asc')
    .execute()
  return events.map(row => row.gumbo as GumboPlay)
}

/**
 * Fixed-width Base58 sorts by code point. Locale collation reorders
 * upper/lowercase digits and changes the historical numeric tiebreak.
 */
const byUserId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Who each withdrawn line of a game stands for, by its key: the plays name
 * that person, and the line keeps the place they took in the order.
 */
async function standsFor(
  db: Kysely<Database>,
  gameId: string
): Promise<Map<string, string>> {
  const rows = await withdrawnPlayers(db, [gameId])
  if (rows.length === 0) return new Map()
  const survivors = await survivorsOf(
    db,
    rows.map(row => row.userId)
  )
  return new Map(
    rows.map(row => [
      withdrawnKey(row.requestId, gameId),
      survivors.get(row.userId)!
    ])
  )
}

/** Stored first appearances, with a play fallback while old rows rebuild. */
export async function boxScoreOrder(
  db: Kysely<Database>,
  gameId: string,
  lines: BattingLine[]
): Promise<BattingLine[]> {
  const first = new Map<string, number>()
  for (const line of lines)
    if (line.firstPa != null) first.set(line.userId, line.firstPa)
  if (lines.some(line => line.firstPa == null)) {
    const plays = (await gamePlays(db, gameId)).filter(
      play => eventTypeCounts(play.result.eventType)?.pa === true
    )
    const ids = plays.flatMap(play =>
      typeof play.matchup?.batter?.id === 'number'
        ? [play.matchup.batter.id]
        : []
    )
    const survivors = await scoringUsers(db, ids)
    for (const play of plays) {
      const id = play.matchup?.batter?.id
      if (typeof id !== 'number') continue
      const survivor = survivors.get(id)!
      first.set(
        survivor,
        Math.min(first.get(survivor) ?? Infinity, play.about.atBatIndex)
      )
    }
  }
  const people = await standsFor(db, gameId)
  const place = (line: BattingLine): number =>
    first.get(line.userId) ??
    first.get(people.get(line.userId) ?? '') ??
    Infinity
  return [...lines].sort((a, b) => {
    const delta = place(a) - place(b)
    return Number.isNaN(delta) || delta === 0
      ? byUserId(a.userId, b.userId)
      : delta
  })
}

/**
 * A game's pitchers in the order they took the mound, by their scoring ids.
 * Each play gives the pitcher it began with, then whoever came in during it,
 * then whoever finished it, so a reliever follows the pitcher they replaced
 * even when the change came in the middle of an at-bat.
 */
export function pitchersInOrder(plays: GumboPlay[]): number[] {
  const order: number[] = []
  const add = (id: number | null): void => {
    if (id != null && !order.includes(id)) order.push(id)
  }
  for (const play of plays) {
    const events = (Array.isArray(play.playEvents) ? play.playEvents : [])
      .map(doc)
      .sort((a, b) => Number(a.index) - Number(b.index))
    const changes = events.filter(
      event => doc(event.details).eventType === 'pitching_substitution'
    )
    const opening = events.find(
      event =>
        event.isPitch === true &&
        (changes.length === 0 || Number(event.index) < Number(changes[0].index))
    )
    add(changes.length === 0 ? null : idOf(changes[0].replacedPlayer))
    add(idOf(opening?.player))
    for (const change of changes) add(idOf(change.player))
    add(idOf(play.matchup?.pitcher))
  }
  return order
}

/**
 * Pitchers in the order they pitched, first pitcher at the top. A pitcher the
 * plays never put on the mound keeps the old order after them: most outs
 * first.
 */
export async function pitchingOrder(
  db: Kysely<Database>,
  gameId: string,
  lines: PitchingLine[]
): Promise<PitchingLine[]> {
  const appeared = pitchersInOrder(await gamePlays(db, gameId))
  const users = await scoringUsers(db, appeared)
  const rank = new Map<string, number>()
  appeared.forEach((id, index) => {
    const user = users.get(id)
    if (user != null && !rank.has(user)) rank.set(user, index)
  })
  const people = await standsFor(db, gameId)
  const place = (line: PitchingLine): number =>
    rank.get(people.get(line.userId) ?? line.userId) ?? Infinity
  return [...lines].sort((a, b) => {
    const delta = place(a) - place(b)
    if (!Number.isNaN(delta) && delta !== 0) return delta
    return b.outs !== a.outs ? b.outs - a.outs : byUserId(a.userId, b.userId)
  })
}
