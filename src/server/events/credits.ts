import type { Kysely } from 'kysely'

import { onePerson } from '../admin/people'
import type { CreditAssistRow, Database } from '../db/database'
import type { CreditedOutcome } from '../highlights'
import { gumboIdsOfUsers } from '../scoring/gumboIds'

/** The `eventCredits` columns a credit is read back from. */
const CREDIT_COLUMNS = [
  'eventId',
  'eventType',
  'head',
  'suffix',
  'assists',
  'assistWord',
  'teamId',
  'creditGumboId as creditUserId',
  'name',
  'role',
  'position'
] as const

/** A play's credit, structured, with the game it was credited in. */
export interface CreditRow extends CreditedOutcome {
  gameId: string
}

function asCredit(row: {
  gameId: string
  eventType: string
  head: string
  suffix: string | null
  assists: CreditAssistRow[]
  assistWord: 'from' | 'to' | null
  teamId: string | null
  creditUserId: number | null
  name: string
  role: string | null
  position: string | null
}): CreditRow {
  return {
    gameId: row.gameId,
    eventType: row.eventType,
    head: row.head,
    suffix: row.suffix,
    assists: row.assists.map(assist => ({
      creditUserId: assist.gumboId,
      position: assist.position,
      ...(assist.gumboId == null && assist.name != null
        ? { name: assist.name }
        : {})
    })),
    assistWord: row.assistWord,
    teamId: row.teamId,
    creditUserId: row.creditUserId,
    credit: {
      // Only a person with no id is named here: an id's name is read from
      // users when the credit is shown.
      ...(row.creditUserId == null ? { name: row.name } : {}),
      role: row.role ?? '',
      position: row.position
    }
  }
}

/**
 * Every credit of these plays, structured, each with its play's game. The
 * games are read on their own, so the credits are read as they always were.
 */
async function creditsOf(
  db: Kysely<Database>,
  eventIds: string[]
): Promise<Array<{ eventId: string; credit: CreditRow }>> {
  const games = await db
    .selectFrom('events')
    .select(['id', 'gameId'])
    .where('id', 'in', eventIds)
    .execute()
  const gameOf = new Map(games.map(row => [row.id, row.gameId]))
  const rows = await db
    .selectFrom('eventCredits')
    .select(CREDIT_COLUMNS)
    .where('eventId', 'in', eventIds)
    .execute()
  return rows.map(row => ({
    eventId: row.eventId,
    credit: asCredit({ ...row, gameId: gameOf.get(row.eventId) ?? '' })
  }))
}

/**
 * Every credit on each play that credits this person, keyed by play, each
 * with its game, so the player page names them from one book for the games
 * of its page (`gameNames`).
 *
 * A credit names its person by `creditUserId` alone. A merge closes a row
 * without moving the credits written under it, so every row that is this
 * person is searched, not only the one asked about.
 */
export async function creditsForPlayer(
  db: Kysely<Database>,
  userId: string
): Promise<Map<string, CreditRow[]>> {
  const out = new Map<string, CreditRow[]>()
  const person = await onePerson(db, userId)
  const gumboIds = await gumboIdsOfUsers(db, person.userIds)
  if (gumboIds.length === 0) return out
  const matched = await db
    .selectFrom('eventCredits')
    .select('eventId')
    .where('creditGumboId', 'in', gumboIds)
    .execute()
  const eventIds = [...new Set(matched.map(row => row.eventId))]
  if (eventIds.length === 0) return out

  for (const { eventId, credit } of await creditsOf(db, eventIds)) {
    const list = out.get(eventId) ?? []
    list.push(credit)
    out.set(eventId, list)
  }
  return out
}

/**
 * Credits for a highlight list. A play no post at its index has carried a
 * `credits` key for, or a row from before 031 (`creditsLookedAt` false), is
 * `undefined`, and kept. A re-post without the key keeps the list already
 * stored (`withKeptCredits`). A play whose stored list is empty is `[]`, and
 * omitted. Otherwise its `eventCredits` rows are the array, structured, each
 * with its game.
 */
export async function creditsForHighlight(
  db: Kysely<Database>,
  eventIds: string[]
): Promise<Map<string, CreditRow[] | undefined>> {
  const out = new Map<string, CreditRow[] | undefined>()
  if (eventIds.length === 0) return out

  const flags = await db
    .selectFrom('events')
    .select(['id', 'creditsLookedAt'])
    .where('id', 'in', eventIds)
    .execute()
  for (const row of flags) {
    out.set(row.id, row.creditsLookedAt ? [] : undefined)
  }

  for (const { eventId, credit } of await creditsOf(db, eventIds)) {
    const credits = out.get(eventId) ?? []
    credits.push(credit)
    out.set(eventId, credits)
  }
  return out
}
