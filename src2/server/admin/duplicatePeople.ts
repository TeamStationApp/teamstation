import type { Kysely } from 'kysely'

import type { Database } from '../db/database'

/**
 * Two rows for one child.
 *
 * A roster shows `Adrian` and `Adrian Hardy`, `Cassius` and `Cassius
 * Hutchins`. The bare first name came from a video title or a schedule, where
 * somebody typed a name by hand; the full one came from an imported roster,
 * with a jersey, a person id and a face. A parent sees a team with twice as
 * many children as it has.
 *
 * Paul's rule:
 *
 * - one of the pair has **no plays** → it is not kept. There is nothing on it
 *   to lose, and merging an empty row onto a real one only risks moving
 *   fields the wrong way.
 * - **both** have plays → they are merged, because the history of both belongs
 *   to one child.
 *
 * "No plays" is the honest test rather than "no jersey" or "no picture": a
 * child who batted has an `event_players` row, and a row invented from a title
 * has none.
 */

/**
 * What to do with a pair, from how much each side has on it.
 *
 * A row with no plays has nothing to lose, so it is not kept at all. When both
 * have plays the history of both belongs to one child, so neither can be
 * thrown away and they are merged.
 */
export function actionFor(
  onePlays: number,
  otherPlays: number
): 'drop' | 'merge' {
  return onePlays === 0 || otherPlays === 0 ? 'drop' : 'merge'
}

export interface DuplicatePair {
  teamId: string
  /** The row with the fuller name. */
  keepUserId: string
  keepName: string
  keepPlays: number
  /** The row whose name is a prefix of the other's. */
  otherUserId: string
  otherName: string
  otherPlays: number
  /** `drop` when only one has plays, `merge` when both do. */
  action: 'drop' | 'merge'
}

/**
 * Pairs where one person's whole name is the *first word* of another's, on the
 * same team.
 *
 * Deliberately narrow. Two real children can share a first name, and one of
 * them may simply not have batted yet, so a name that is a prefix of **more
 * than one** full name on the team is not a duplicate of either — it is
 * ambiguous, and it is listed rather than guessed at.
 */
export async function findDuplicatePeople(
  db: Kysely<Database>
): Promise<{ pairs: DuplicatePair[]; ambiguous: string[] }> {
  const rows = await db
    .selectFrom('memberships')
    .innerJoin('users', 'users.id', 'memberships.user_id')
    .leftJoin('event_players', 'event_players.user_id', 'users.id')
    .select([
      'memberships.team_id as teamId',
      'users.id as userId',
      'users.display_name as displayName'
    ])
    .select(eb => eb.fn.count<number>('event_players.id').as('plays'))
    .where('users.merged_into', 'is', null)
    .groupBy(['memberships.team_id', 'users.id', 'users.display_name'])
    .execute()

  const byTeam = new Map<string, typeof rows>()
  for (const row of rows) {
    const held = byTeam.get(row.teamId)
    if (held == null) byTeam.set(row.teamId, [row])
    else held.push(row)
  }

  const pairs: DuplicatePair[] = []
  const ambiguous: string[] = []

  for (const [teamId, people] of byTeam) {
    const single = people.filter(p => !p.displayName.trim().includes(' '))
    const full = people.filter(p => p.displayName.trim().includes(' '))

    for (const one of single) {
      const name = one.displayName.trim().toLowerCase()
      if (name === '') continue
      const matches = full.filter(
        other => other.displayName.trim().toLowerCase().split(/\s+/)[0] === name
      )
      if (matches.length === 0) continue
      if (matches.length > 1) {
        // Two children called Jensen, one of whom has not batted. Nothing here
        // can say which the bare row belongs to, so neither is touched.
        ambiguous.push(`${one.displayName} on ${teamId}`)
        continue
      }
      const match = matches[0]
      if (match == null) continue
      const onePlays = Number(one.plays)
      const matchPlays = Number(match.plays)
      pairs.push({
        teamId,
        keepUserId: match.userId,
        keepName: match.displayName,
        keepPlays: matchPlays,
        otherUserId: one.userId,
        otherName: one.displayName,
        otherPlays: onePlays,
        action: actionFor(onePlays, matchPlays)
      })
    }
  }

  return { pairs, ambiguous }
}
