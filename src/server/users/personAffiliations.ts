import type { Kysely } from 'kysely'

import { DEFAULT_PLAYER_NAME_PRIVACY } from '../../common/playerNamePrivacy'
import { onePeople } from '../admin/people'
import type { Database } from '../db/database'
import { currentFormats, formatForReader } from '../groups/playerNamePrivacy'

/** The same affiliation wording for account and umpire search identities. */
export function affiliationText(
  teams: string[],
  children: string[],
  guardians: string[]
): string {
  return [
    children.length === 0
      ? ''
      : `Guardian of ${[...new Set(children)].join(', ')}`,
    guardians.length === 0
      ? ''
      : `Guardians: ${[...new Set(guardians)].join(', ')}`,
    [...new Set(teams)].join(', ')
  ]
    .filter(Boolean)
    .join(' · ')
}

/** Enrich only the limited search results, including relationships on aliases. */
export async function personAffiliations(
  db: Kysely<Database>,
  ids: string[]
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const people = await onePeople(db, ids)
  const aliases = [...new Set([...people.values()].flatMap(p => p.userIds))]
  const links = await db
    .selectFrom('user_links')
    .selectAll()
    .where('kind', '=', 'guardian')
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
  for (const person of related.values()) {
    for (const alias of person.userIds) canonical.set(alias, person.userId)
  }
  const canon = (id: string): string => canonical.get(id) ?? id
  const memberships = await db
    .selectFrom('memberships as m')
    .innerJoin('teams as t', 't.id', 'm.team_id')
    .select(['m.user_id', 'm.is_player', 't.name'])
    .where('m.user_id', 'in', [...canonical.keys()])
    .orderBy('t.name')
    .execute()
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
  const names = formatForReader(
    users.map(person => ({
      person,
      format: formats.get(person.id) ?? DEFAULT_PLAYER_NAME_PRIVACY
    }))
  )
  return new Map(
    ids.map(id => {
      const children = links
        .filter(l => canon(l.user_id) === id)
        .map(l => canon(l.related_user_id))
      const guardians = links
        .filter(l => canon(l.related_user_id) === id)
        .map(l => canon(l.user_id))
      const family = new Set([id, ...children])
      const named = (values: string[]): string[] =>
        values.flatMap(value => {
          const name = names.get(value)
          return name == null ? [] : [name]
        })
      return [
        id,
        affiliationText(
          memberships
            .filter(m => family.has(canon(m.user_id)))
            .map(m => m.name),
          named(children),
          named(guardians)
        )
      ]
    })
  )
}
