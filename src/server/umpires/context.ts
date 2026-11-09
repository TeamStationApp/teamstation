import type { Kysely, Selectable } from 'kysely'

import { storedGuests } from '../../common/guests'
import { formatName, type NamedPerson, shortName } from '../../common/names'
import { teamsOfRow } from '../../common/teamLists'
import { storedUnrostered } from '../../common/unroster'
import { type OnePerson, onePerson } from '../admin/people'
import type { Database, GamesTable } from '../db/database'
import { fullNamesFor, type Reader } from '../users/readerNames'

export type UmpireGame = Selectable<GamesTable>
export interface UmpireIdentity extends OnePerson {
  name: string
  displayName: string
  /** The account's name parts, to write in full for a reader who may. */
  named: NamedPerson
  avatarPath: string | null
  active: boolean
  gumboIds: number[]
  teamIds: string[]
}
export async function umpireIdentity(
  db: Kysely<Database>,
  id: string
): Promise<UmpireIdentity> {
  const person = await onePerson(db, id)
  const user = await db
    .selectFrom('users')
    .select([
      'id',
      'first_name',
      'last_name',
      'display_name',
      'avatar_path',
      'disabled_at'
    ])
    .where('id', '=', person.userId)
    .executeTakeFirstOrThrow()
  const gumbo = await db
    .selectFrom('gumbo_ids')
    .select('gumbo_id')
    .where('user_id', 'in', person.userIds)
    .execute()
  const teams = await db
    .selectFrom('memberships')
    .select('team_id')
    .where('user_id', 'in', person.userIds)
    .where('is_player', '=', true)
    .execute()
  const named: NamedPerson = {
    id: user.id,
    firstName: user.first_name,
    lastName: user.last_name,
    displayName: user.display_name
  }
  return {
    ...person,
    active: user.disabled_at == null,
    name: shortName(named),
    displayName: user.display_name,
    named,
    avatarPath: user.avatar_path,
    gumboIds: gumbo.map(g => Number(g.gumbo_id)),
    teamIds: teams.map(t => t.team_id)
  }
}
/**
 * The full name of each of `people` that `reader` may read in full
 * (`fullNamesFor`), written from the accounts the caller loaded already
 * (`formatName(person, 'full')`, an identity's `named`); anyone else is named
 * by their identity's short `name`. `unloaded` are people with no account
 * loaded: only those the reader reads in full are read, in one query. Only a
 * read passes a reader, so with none this is empty.
 */
export async function readerUmpireNames(
  db: Kysely<Database>,
  reader: Reader | undefined,
  people: Iterable<NamedPerson>,
  unloaded: Iterable<string> = []
): Promise<Map<string, string>> {
  const loaded = new Map<string, NamedPerson>(
    [...people].map(person => [String(person.id), person])
  )
  const full = await fullNamesFor(db, reader, [...loaded.keys(), ...unloaded])
  if (full.size === 0) return new Map()
  const missing = [...full].filter(id => !loaded.has(id))
  if (missing.length > 0)
    for (const u of await db
      .selectFrom('users')
      .select(['id', 'first_name', 'last_name', 'display_name'])
      .where('id', 'in', missing)
      .execute())
      loaded.set(u.id, {
        id: u.id,
        firstName: u.first_name,
        lastName: u.last_name,
        displayName: u.display_name
      })
  return new Map(
    [...full].flatMap(id => {
      const person = loaded.get(id)
      return person == null ? [] : [[id, formatName(person, 'full')] as const]
    })
  )
}
export function umpireIsPlaying(
  person: UmpireIdentity,
  game: UmpireGame
): boolean {
  const guests = storedGuests(game.guests, teamsOfRow(game))
  const excluded = storedUnrostered(game.unrostered, teamsOfRow(game))
  return (['home', 'away'] as const).some(
    side =>
      person.gumboIds.some(id => guests[side].includes(id)) ||
      (person.teamIds.includes(
        side === 'home' ? game.home_team_id : game.away_team_id
      ) &&
        !person.gumboIds.some(id => excluded[side].includes(id)))
  )
}
export function umpireInterval(game: UmpireGame): {
  startAt: string
  endAt: string | null
} {
  return {
    startAt: new Date(game.start_at).toISOString(),
    endAt: game.end_at == null ? null : new Date(game.end_at).toISOString()
  }
}
export async function umpireFamily(
  db: Kysely<Database>,
  viewer: string
): Promise<UmpireIdentity[]> {
  const self = await umpireIdentity(db, viewer)
  const links = await db
    .selectFrom('user_links')
    .select('related_user_id')
    .where('user_id', 'in', self.userIds)
    .where('kind', '=', 'guardian')
    .execute()
  const family = new Map([[self.userId, self]])
  for (const link of links) {
    const child = await umpireIdentity(db, link.related_user_id)
    family.set(child.userId, child)
  }
  return [...family.values()]
}
