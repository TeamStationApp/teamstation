import type { Kysely } from 'kysely'

import { onePerson } from '../admin/people'
import type { Database } from '../db/database'
import type { CreditedOutcome } from '../highlights'
import { gumboIdsOfUsers } from '../scoring/gumboIds'

/** The `eventCredits` columns a credit is read back from. */
const CREDIT_COLUMNS = [
  'eventId',
  'eventType',
  'label',
  'teamId',
  'creditGumboId as creditUserId',
  'name',
  'role',
  'position'
] as const

function asCredit(row: {
  eventType: string
  label: string
  teamId: string | null
  creditUserId: number | null
  name: string
  role: string | null
  position: string | null
}): CreditedOutcome {
  return {
    eventType: row.eventType,
    label: row.label,
    teamId: row.teamId,
    creditUserId: row.creditUserId,
    credit: {
      name: row.name,
      role: row.role ?? '',
      position: row.position
    }
  }
}

/**
 * Every credit on each play that credits this person, keyed by play. The
 * player page passes the array to `withDropped`.
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

  const rows = await db
    .selectFrom('eventCredits')
    .select(CREDIT_COLUMNS)
    .where('eventId', 'in', eventIds)
    .execute()
  for (const row of rows) {
    const list = out.get(row.eventId) ?? []
    list.push(asCredit(row))
    out.set(row.eventId, list)
  }
  return out
}

/**
 * Credits for a highlight list. A play no post at its index has carried a
 * `credits` key for, or a row from before 031 (`creditsLookedAt` false), is
 * `undefined`, and kept. A re-post without the key keeps the list already
 * stored (`withKeptCredits`). A play whose stored list is empty is `[]`, and
 * omitted. Otherwise its `eventCredits` rows are the array.
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

  const rows = await db
    .selectFrom('eventCredits')
    .select(CREDIT_COLUMNS)
    .where('eventId', 'in', eventIds)
    .execute()
  for (const row of rows) {
    const credits = out.get(row.eventId) ?? []
    credits.push(asCredit(row))
    out.set(row.eventId, credits)
  }
  return out
}
