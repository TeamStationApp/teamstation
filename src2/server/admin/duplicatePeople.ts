import type { Kysely } from 'kysely'

import type { Database } from '../db/database'
import { bothPlayedTogether, onePerson } from './people'

/**
 * Two rows for one child.
 *
 * A roster shows `Adrian` and `Adrian Houser`, `Cecil` and `Cecil
 * Fielder`. The bare first name came from a video title or a schedule, where
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
/** Every row of every person these rows belong to, closed ones included. */
async function everyRowOf(
  db: Kysely<Database>,
  rows: Array<{ userId: string }>
): Promise<string[]> {
  const ids = new Set<string>()
  for (const row of rows) {
    for (const id of (await onePerson(db, row.userId)).userIds) ids.add(id)
  }
  return [...ids]
}

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
 * Pairs on one team whose names are the same name written to different
 * lengths: `Adrian` and `Adrian Houser`, `Anthony R` and `Anthony Rizzo`, `Dom`
 * and `Domingo Santana`, `aaron` and `aaron sanchez`.
 *
 * The short one came from a video title or a schedule, where somebody typed a
 * name by hand and stopped; the long one came from an imported roster, with
 * a jersey, a person id and a face. One rule covers every shape, because a
 * missing surname, a surname cut to its initial and a first name stopped early
 * are the same thing happening.
 *
 * Deliberately narrow all the same. Two real children can share a first name —
 * the Bay Stars have two boys called Ben, in shirts 2 and 5 — so a row that is
 * no shorter than the other never pairs with it, and a short first name must
 * have no surname of its own to claim.
 *
 * Ambiguity is refused in **both** directions. A short name that fits more than
 * one longer one cannot say which child it is; and a longer name that more than
 * one short row fits is the same problem seen from the other end, which is how
 * both boys called Ben came to be offered to `Benito Santiago` at once.
 *
 * A nickname is not a truncation, and this cannot see one: `Ned` is not the
 * start of `Edward`, and inventing a table of nicknames would be guessing at
 * children by their names, which is the one thing this must not do.
 */
export function isShortFormOf(
  short: { firstName: string; lastName: string },
  long: { firstName: string; lastName: string }
): boolean {
  const tidy = (a: string): string => a.trim().toLowerCase()
  const firstShort = tidy(short.firstName)
  const firstLong = tidy(long.firstName)
  if (firstShort === '') return false

  // Either half can be the one that was cut short, and only one of them.
  const sameFirst = firstShort === firstLong
  const shorterFirst =
    firstShort.length < firstLong.length && firstLong.startsWith(firstShort)
  if (!sameFirst && !shorterFirst) return false

  const a = tidy(short.lastName)
  const b = tidy(long.lastName)
  if (!b.startsWith(a)) return false
  // A first name stopped early has to have stopped there: `Dom DiMaggio` is not a
  // short way of writing `Domingo Santana`.
  return sameFirst ? a.length < b.length : a === ''
}

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
      'users.display_name as displayName',
      'users.first_name as firstName',
      'users.last_name as lastName'
    ])
    .select(eb => eb.fn.count<number>('event_players.id').as('plays'))
    .where('users.merged_into', 'is', null)
    .groupBy([
      'memberships.team_id',
      'users.id',
      'users.display_name',
      'users.first_name',
      'users.last_name'
    ])
    .execute()

  /**
   * The two halves of a name, whichever way the row was made. A row invented
   * from a video title has the whole thing in `display_name` and nothing else.
   */
  const named = (row: {
    displayName: string
    firstName: string | null
    lastName: string | null
  }): { firstName: string; lastName: string } => {
    if (row.firstName != null && row.firstName.trim() !== '') {
      return { firstName: row.firstName, lastName: row.lastName ?? '' }
    }
    const words = row.displayName.trim().split(/\s+/)
    return { firstName: words[0] ?? '', lastName: words.slice(1).join(' ') }
  }

  const byTeam = new Map<string, typeof rows>()
  for (const row of rows) {
    const held = byTeam.get(row.teamId)
    if (held == null) byTeam.set(row.teamId, [row])
    else held.push(row)
  }

  // Who has ever been in a game beside whom — asked of **every** row each of
  // these people holds, not just the open ones. The row that played beside
  // `Casey` on 11 April had since been closed into `Casey Mize`, so a set
  // built from open rows alone knew nothing about it and offered the merge
  // straight back.
  const together = await bothPlayedTogether(db, await everyRowOf(db, rows))

  const pairs: DuplicatePair[] = []
  const ambiguous: string[] = []

  for (const [teamId, people] of byTeam) {
    // How many short rows each longer name would take. Two boys called Ben and
    // one `Benito Santiago` is not one child written twice, and neither of them
    // can be told from the other.
    const claimed = new Map<string, number>()
    for (const one of people) {
      for (const other of people) {
        if (!isShortFormOf(named(one), named(other))) continue
        claimed.set(other.userId, (claimed.get(other.userId) ?? 0) + 1)
      }
    }

    for (const one of people) {
      const matches = people.filter(other =>
        isShortFormOf(named(one), named(other))
      )
      if (matches.length === 0) continue
      if (matches.length > 1) {
        // Two children called Jordan, one of whom has not batted. Nothing here
        // can say which the bare row belongs to, so neither is touched.
        ambiguous.push(
          `${one.displayName} on ${teamId}: more than one name it could be`
        )
        continue
      }
      const match = matches[0]
      if (match == null) continue
      if ((claimed.get(match.userId) ?? 0) > 1) {
        ambiguous.push(
          `${match.displayName} on ${teamId}: more than one short name fits it`
        )
        continue
      }
      // Everybody either of them has already been merged with, because the
      // question is whether the *people* ever batted in one game and a row is
      // only the part of a person that was open at the time.
      const ours = [
        ...(await onePerson(db, one.userId)).userIds,
        ...(await onePerson(db, match.userId)).userIds
      ]
      const clash = ours.some(a => ours.some(b => together.has(`${a}|${b}`)))
      if (clash) {
        // Both of them batted in one game, so they are two children who share
        // a first name — not one child written down twice.
        ambiguous.push(
          `${one.displayName} and ${match.displayName} on ${teamId}: both played in one game`
        )
        continue
      }
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
 * A player id there names a roster spot, not a person: Jordan Pujols on the
 * Hawks and Jordan Pujols on Titan Force are two ids, two imports and two
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
  // person reading this list and recognising a child, and "Badgers" beside a
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
    // Both halves, or it is not evidence: half the league is called Jordan.
    if (first === '' || last === '') continue
    const key = `${first} ${last}`
    const held = byName.get(key)
    if (held == null) byName.set(key, [row])
    else held.push(row)
  }

  const together = await bothPlayedTogether(db, await everyRowOf(db, rows))

  const groups: SamePersonGroup[] = []
  for (const people of byName.values()) {
    if (people.length < 2) continue
    // One child cannot play for both sides of a game — asked of every row the
    // group already holds, not just the two in front of us.
    const everyRow: string[] = []
    for (const one of people) {
      everyRow.push(...(await onePerson(db, one.userId)).userIds)
    }
    const split = everyRow.some(a =>
      everyRow.some(b => together.has(`${a}|${b}`))
    )
    if (split) continue
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
