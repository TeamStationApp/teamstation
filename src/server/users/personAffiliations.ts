import type { Kysely } from 'kysely'

import { DEFAULT_PLAYER_NAME_PRIVACY } from '../../common/playerNamePrivacy'
import { canSeePerson, canSeeTeam, type VisibleScopes } from '../access'
import { onePeople } from '../admin/people'
import type { Database } from '../db/database'
import { currentFormats, formatForReader } from '../groups/playerNamePrivacy'
import { openAddsOf } from '../openAdds'
import { fullNamesFor, isSpoken, type Reader } from './readerNames'

/**
 * The same affiliation wording on every list that names a person: the
 * players they guard, their guardians, the players they are family of
 * (a `family` link, such as a grandparent's), their family, then their teams.
 */
export function affiliationText(
  teams: string[],
  children: string[],
  guardians: string[],
  relativeOf: string[] = [],
  relatives: string[] = []
): string {
  const part = (label: string, names: string[]): string =>
    names.length === 0 ? '' : `${label}${[...new Set(names)].join(', ')}`
  return [
    part('Guardian of ', children),
    part('Guardians: ', guardians),
    part('Family of ', relativeOf),
    part('Family: ', relatives),
    [...new Set(teams)].join(', ')
  ]
    .filter(Boolean)
    .join(' · ')
}

/** Whom an affiliation line is for, and where it is drawn. */
export interface AffiliationOptions {
  /** Who reads the line: the people they may read in full are named so. */
  reader?: Reader
  /**
   * What the reader may see (`visibleScopes`). With none, nothing private is
   * listed, so every line is empty, as it is for a read whose names go to a
   * model (`isSpoken`).
   */
  scopes?: VisibleScopes
  /**
   * The team whose own list the line is drawn on: no team is listed, and
   * only the guardians of somebody on it, or the guarded players on it.
   */
  onTeam?: string
  /** Only these teams are ever listed, such as a league's for its umpires. */
  teams?: ReadonlySet<string>
  /**
   * Whom of `ids` the caller has already found `reader` reads in full (its
   * own `fullNamesFor`, such as `readerNaming`'s `readsFull`), taken as the
   * answer for them. Their guardians, players and family are asked here.
   */
  readsFull?: ReadonlySet<string>
}

/**
 * Each person's affiliation line, by id, as `affiliationText` words it:
 * `Guardian of <players>`, `Guardians: <names>`, `Family of <players>`,
 * `Family: <names>`, then their teams (a guardian's or relative's own and
 * their players').
 *
 * Only what the reader may see is listed. A team is listed when the reader
 * may see it (`canSeeTeam`), and only an open one that holds the person by
 * more than an open add. A guarded player is
 * listed when the reader may see that player (`canSeePerson`). A guardian is
 * listed when the reader may see the player the line is about: a guardian
 * usually belongs to no level, and reaches the list through their player.
 * A relative by a `family` link, and the player they are family of, are
 * listed by the same rules.
 * Names are in full for whoever may read them so (`fullNamesFor`), and in
 * the public format otherwise.
 *
 * Merged rows answer for the person they were closed into. A fixed number of
 * queries however long the list.
 */
export async function personAffiliations(
  db: Kysely<Database>,
  ids: string[],
  options: AffiliationOptions = {}
): Promise<Map<string, string>> {
  const { reader, scopes, onTeam, teams, readsFull } = options
  if (ids.length === 0) return new Map()
  // A machine, Tess and anything stored or sent on read no line at all.
  if (scopes == null || isSpoken()) return new Map(ids.map(id => [id, '']))
  const people = await onePeople(db, ids)
  const aliases = [...new Set([...people.values()].flatMap(p => p.userIds))]
  const links = await db
    .selectFrom('user_links')
    .selectAll()
    .where('kind', 'in', ['guardian', 'family'])
    .where(eb =>
      eb.or([
        eb('user_id', 'in', aliases),
        eb('related_user_id', 'in', aliases)
      ])
    )
    .execute()
  const related = await onePeople(db, [
    ...new Set([...ids, ...links.flatMap(l => [l.user_id, l.related_user_id])])
  ])
  const canonical = new Map<string, string>()
  const rowsOf = new Map<string, string[]>()
  for (const person of related.values()) {
    rowsOf.set(person.userId, person.userIds)
    for (const alias of person.userIds) canonical.set(alias, person.userId)
  }
  const canon = (id: string): string => canonical.get(id) ?? id
  const held = await db
    .selectFrom('memberships as m')
    .innerJoin('teams as t', 't.id', 'm.team_id')
    .select(['m.user_id', 'm.team_id', 'm.is_player', 't.name'])
    .where('m.user_id', 'in', [...canonical.keys()])
    .where('t.merged_into', 'is', null)
    .orderBy('t.name')
    .execute()
  // A team holding somebody only by an add their side may yet reject is not
  // theirs: it neither names them nor shows them to its people.
  const open = await openAddsOf(db, [...new Set(held.map(m => m.team_id))])
  const memberships = held.filter(m => {
    const holds = open.get(m.team_id)
    return (
      holds?.has(m.user_id) !== true && holds?.has(canon(m.user_id)) !== true
    )
  })
  const users = await db
    .selectFrom('users')
    .select([
      'id',
      'first_name as firstName',
      'last_name as lastName',
      'display_name as displayName'
    ])
    .where('id', 'in', [...new Set(canonical.values())])
    .execute()
  const players = new Set([
    ...links.map(l => canon(l.related_user_id)),
    ...memberships.filter(m => m.is_player).map(m => canon(m.user_id))
  ])
  const formats = await currentFormats(
    db,
    [...canonical.keys()].filter(id => players.has(canon(id))),
    canonical
  )
  // The people asked about, as asked, answer from `readsFull` when there is
  // one; everybody else is asked.
  const answered = new Set(
    readsFull == null ? [] : ids.filter(id => canon(id) === id)
  )
  const full = new Set([
    ...users.flatMap(person =>
      answered.has(person.id) && readsFull?.has(person.id) === true
        ? [person.id]
        : []
    ),
    ...(await fullNamesFor(
      db,
      reader,
      users.flatMap(person => (answered.has(person.id) ? [] : [person.id]))
    ))
  ])
  const names = formatForReader(
    users.map(person => ({
      person,
      format: full.has(person.id)
        ? 'full'
        : (formats.get(person.id) ?? DEFAULT_PLAYER_NAME_PRIVACY)
    }))
  )
  // Whether the reader may see this player: themselves, a player they
  // guard, or one on a team they can see.
  const visible = (personId: string): boolean => {
    const rows = rowsOf.get(personId) ?? [personId]
    return (
      canSeePerson(
        scopes,
        reader != null && rows.includes(reader.userId),
        memberships
          .filter(m => m.is_player && canon(m.user_id) === personId)
          .map(m => ({ teamId: m.team_id, seasonId: null }))
      ) || rows.some(row => scopes.guardedIds?.has(row) === true)
    )
  }
  const onThatTeam = (personId: string): boolean =>
    memberships.some(m => m.team_id === onTeam && canon(m.user_id) === personId)
  const named = (values: string[]): string[] =>
    [...new Set(values)].flatMap(value => {
      const name = names.get(value)
      return name == null ? [] : [name]
    })
  // The players a person is linked to by `kind`, as the reader may see them.
  const playersOf = (id: string, kind: 'guardian' | 'family'): string[] =>
    links
      .filter(l => l.kind === kind && canon(l.user_id) === id)
      .map(l => canon(l.related_user_id))
      .filter(child => visible(child))
      .filter(child => onTeam == null || onThatTeam(child))
  // The people linked to a player by `kind`, when the reader may see them.
  const adultsOf = (id: string, kind: 'guardian' | 'family'): string[] =>
    visible(id) && (onTeam == null || onThatTeam(id))
      ? links
          .filter(l => l.kind === kind && canon(l.related_user_id) === id)
          .map(l => canon(l.user_id))
      : []
  return new Map(
    ids.map(asked => {
      const id = canon(asked)
      const children = playersOf(id, 'guardian')
      const relativeOf = playersOf(id, 'family')
      const family = new Set([id, ...children, ...relativeOf])
      const teamNames =
        onTeam != null
          ? []
          : memberships
              .filter(
                m =>
                  family.has(canon(m.user_id)) &&
                  canSeeTeam(scopes, m.team_id) &&
                  (teams == null || teams.has(m.team_id))
              )
              .map(m => m.name)
      return [
        asked,
        affiliationText(
          teamNames,
          named(children),
          named(adultsOf(id, 'guardian')),
          named(relativeOf),
          named(adultsOf(id, 'family'))
        )
      ]
    })
  )
}
