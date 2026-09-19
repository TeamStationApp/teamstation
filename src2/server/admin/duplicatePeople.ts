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

/**
 * One child on five teams, which an import makes five people out of.
 *
 * A player id there names a roster spot, not a person: Jensen Puey on the
 * Hawks and Jensen Puey on Trosky Force are two ids, two imports and two
 * users, and each of his pages knew about a fifth of him.
 *
 * The evidence is the name and nothing else. The import sends a `person_id`
 * beside each player and it is the player's own id every time — measured over
 * every roster we hold — so it links nothing. Two children really can share a
 * first and a last name, so **this never applies itself**: it lists what it
 * found with the teams beside each row, and a person decides.
 */
export interface SamePersonGroup {
  /** The row to keep: the one with the most plays behind it. */
  keepUserId: string
  name: string
  members: Array<{
    userId: string
    plays: number
    /** The teams this row appears on, which is what makes it recognisable. */
    teams: string[]
  }>
}

export async function findSamePersonAcrossTeams(
  db: Kysely<Database>
): Promise<SamePersonGroup[]> {
  const rows = await db
    .selectFrom('users')
    .leftJoin('event_players', 'event_players.user_id', 'users.id')
    .select([
      'users.id as userId',
      'users.first_name as firstName',
      'users.last_name as lastName'
    ])
    .select(eb =>
      eb.fn.count<number>('event_players.id').distinct().as('plays')
    )
    .where('users.merged_into', 'is', null)
    .where('users.first_name', 'is not', null)
    .where('users.last_name', 'is not', null)
    .groupBy(['users.id', 'users.first_name', 'users.last_name'])
    .execute()

  // Every team each row is on, not one of them: the whole design rests on a
  // person reading this list and recognising a child, and "Bandits" beside a
  // row that is also on the Hawks is not enough to recognise anybody by.
  const teamsByUser = new Map<string, string[]>()
  for (const row of await db
    .selectFrom('memberships')
    .innerJoin('teams', 'teams.id', 'memberships.team_id')
    .select(['memberships.user_id as userId', 'teams.name as teamName'])
    .where('teams.merged_into', 'is', null)
    .execute()) {
    const held = teamsByUser.get(row.userId) ?? []
    if (!held.includes(row.teamName)) held.push(row.teamName)
    teamsByUser.set(row.userId, held)
  }

  const byName = new Map<string, typeof rows>()
  for (const row of rows) {
    const first = (row.firstName ?? '').trim().toLowerCase()
    const last = (row.lastName ?? '').trim().toLowerCase()
    // Both halves, or it is not evidence: half the league is called Jensen.
    if (first === '' || last === '') continue
    const key = `${first} ${last}`
    const held = byName.get(key)
    if (held == null) byName.set(key, [row])
    else held.push(row)
  }

  const groups: SamePersonGroup[] = []
  for (const people of byName.values()) {
    if (people.length < 2) continue
    const sorted = [...people].sort((a, b) => Number(b.plays) - Number(a.plays))
    groups.push({
      keepUserId: sorted[0].userId,
      name: `${sorted[0].firstName ?? ''} ${sorted[0].lastName ?? ''}`.trim(),
      members: sorted.map(row => ({
        userId: row.userId,
        plays: Number(row.plays),
        teams: teamsByUser.get(row.userId) ?? []
      }))
    })
  }
  return groups.sort((a, b) => a.name.localeCompare(b.name))
}
