import type { Kysely } from 'kysely'

import type { TeamStanding } from '../highlights'
import type { Database } from './database'

/**
 * Team names by id, for a screen that has ids and needs words.
 *
 * A game's teams can be looked up with the game; a list of plays from forty
 * games cannot, so the names are fetched once for the whole page.
 */
export async function teamNames(
  db: Kysely<Database>,
  teamIds: string[]
): Promise<Map<string, string>> {
  const wanted = [...new Set(teamIds)]
  if (wanted.length === 0) return new Map()
  const rows = await db
    .selectFrom('teams')
    .select(['id', 'name'])
    .where('id', 'in', wanted)
    .execute()
  return new Map(rows.map(row => [row.id, row.name]))
}

/**
 * Which teams a highlight may name.
 *
 * An opponent invented from a name typed into somebody else's schedule, which
 * nobody here runs, is not somebody we put on a screen: we have no roster for
 * them, so a highlight credited to one of their players can only say that
 * *somebody* did something.
 */
export async function teamStandings(
  db: Kysely<Database>
): Promise<Map<string, TeamStanding>> {
  const rows = await db
    .selectFrom('teams')
    .leftJoin('memberships', join =>
      join
        .onRef('memberships.team_id', '=', 'teams.id')
        .on('memberships.role', 'in', ['owner', 'manager'])
    )
    .select(['teams.id as id', 'teams.kind as kind'])
    .select(eb => eb.fn.count<number>('memberships.id').as('owners'))
    .groupBy(['teams.id', 'teams.kind'])
    .execute()
  return new Map(
    rows.map(row => [
      row.id,
      {
        isExternal: row.kind === 'external',
        hasOwner: Number(row.owners) > 0
      }
    ])
  )
}
