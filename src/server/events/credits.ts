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
  'typedName',
  'role',
  'position',
  'positionShown'
] as const

/** A play's credit, structured. */
function asCredit(row: {
  eventType: string
  head: string
  suffix: string | null
  assists: CreditAssistRow[]
  assistWord: 'from' | 'to' | null
  teamId: string | null
  creditUserId: number | null
  typedName: string | null
  role: string | null
  position: string | null
  positionShown: boolean
}): CreditedOutcome {
  return {
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
    positionShown: row.positionShown,
    teamId: row.teamId,
    creditUserId: row.creditUserId,
    credit: {
      // Only a person with no id is named here: an id's name is read from
      // users when the credit is shown.
      ...(row.creditUserId == null ? { name: row.typedName ?? '' } : {}),
      role: row.role ?? '',
      position: row.position
    }
  }
}

/** Every credit of these plays, structured. */
async function creditsOf(
  db: Kysely<Database>,
  eventIds: string[]
): Promise<Array<{ eventId: string; credit: CreditedOutcome }>> {
  const rows = await db
    .selectFrom('eventCredits')
    .select(CREDIT_COLUMNS)
    .where('eventId', 'in', eventIds)
    .execute()
  return rows.map(row => ({ eventId: row.eventId, credit: asCredit(row) }))
}

/**
 * Every credit on each play that credits this person, keyed by play. The
 * player page names them from one book for the games of its page
 * (`gameNames`).
 *
 * A credit names its person by `creditUserId` alone. A merge closes a row
 * without moving the credits written under it, so every row that is this
 * person is searched, not only the one asked about.
 */
export async function creditsForPlayer(
  db: Kysely<Database>,
  userId: string
): Promise<Map<string, CreditedOutcome[]>> {
  const out = new Map<string, CreditedOutcome[]>()
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
 * omitted. Otherwise its `eventCredits` rows are the array, structured.
 */
export async function creditsForHighlight(
  db: Kysely<Database>,
  eventIds: string[]
): Promise<Map<string, CreditedOutcome[] | undefined>> {
  const out = new Map<string, CreditedOutcome[] | undefined>()
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
