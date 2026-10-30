import type { Kysely, Selectable, Transaction } from 'kysely'

import { badRequest, conflict, notFound } from '../../common/errors'
import { calendarDateText } from '../../common/groupCreation'
import { makeId } from '../../common/ids'
import {
  type UmpireCertification,
  type UmpireLevel,
  umpireLevelName,
  type UmpirePerson,
  umpirePositions,
  type UmpireSeason,
  type UmpireTypeCount
} from '../../common/umpires'
import { onePerson } from '../admin/people'
import type { Database, UmpireLevelsTable } from '../db/database'
import { publicNames } from '../groups/playerNamePrivacy'
import { imageUrl } from '../media/imageUrls'
import type { MediaContext } from '../media/mediaContext'
import { requireType, types } from './types'

export async function levels(
  db: Kysely<Database>,
  leagueId: string
): Promise<UmpireLevel[]> {
  return await db
    .selectFrom('umpire_levels')
    .select(['id', 'name', 'position'])
    .select(eb =>
      eb
        .exists(
          eb
            .selectFrom('season_umpire_requirements')
            .select('season_id')
            .whereRef('level_id', '=', 'umpire_levels.id')
        )
        .$castTo<boolean>()
        .as('inUse')
    )
    .where('league_id', '=', leagueId)
    .orderBy('position')
    .orderBy('id')
    .execute()
}
export async function addLevel(
  db: Transaction<Database>,
  leagueId: string,
  raw: unknown
): Promise<UmpireLevel> {
  const held = await levels(db, leagueId)
  let name: string
  try {
    name = umpireLevelName(
      raw,
      held.map(l => l.name)
    )
  } catch (e) {
    throw badRequest((e as Error).message)
  }
  const level = {
    id: makeId('umpireLevel'),
    name,
    position: (held.at(-1)?.position ?? -1) + 1
  }
  await db
    .insertInto('umpire_levels')
    .values({ ...level, league_id: leagueId })
    .execute()
  return { ...level, inUse: false }
}
export async function requireLevel(
  db: Kysely<Database>,
  leagueId: string,
  id: string
): Promise<Selectable<UmpireLevelsTable>> {
  const level = await db
    .selectFrom('umpire_levels')
    .selectAll()
    .where('id', '=', id)
    .where('league_id', '=', leagueId)
    .executeTakeFirst()
  if (level == null) throw notFound('No umpire level in this league')
  return level
}
export async function removeLevel(
  db: Transaction<Database>,
  leagueId: string,
  id: string
): Promise<void> {
  await requireLevel(db, leagueId, id)
  await db
    .deleteFrom('umpire_assignments')
    .where(
      'game_id',
      'in',
      db
        .selectFrom('games')
        .innerJoin(
          'season_umpire_requirements as r',
          'r.season_id',
          'games.season_id'
        )
        .select('games.id')
        .where('r.level_id', '=', id)
    )
    .execute()
  await db.deleteFrom('umpire_levels').where('id', '=', id).execute()
}
export async function requirements(
  db: Kysely<Database>,
  leagueId: string,
  now: number,
  media?: MediaContext
): Promise<UmpireSeason[]> {
  const rows = await db
    .selectFrom('seasons')
    .leftJoin('season_umpire_requirements as r', 'r.season_id', 'seasons.id')
    .leftJoin('umpire_levels as l', 'l.id', 'r.level_id')
    .select([
      'seasons.id',
      'seasons.name',
      'seasons.logo_path',
      'seasons.ends_on',
      'seasons.timezone',
      'r.level_id',
      'l.name as level_name'
    ])
    .where('seasons.league_id', '=', leagueId)
    .orderBy('seasons.starts_on')
    .orderBy('seasons.name')
    .execute()
  const counts = await db
    .selectFrom('season_umpire_type_requirements as c')
    .innerJoin('umpire_types as t', 't.id', 'c.type_id')
    .select([
      'c.season_id',
      'c.type_id',
      'c.required_count',
      'c.optional_count'
    ])
    .where('t.league_id', '=', leagueId)
    .orderBy('t.position')
    .orderBy('t.id')
    .execute()
  return rows
    .filter(
      row =>
        calendarDateText(row.ends_on)! >=
        new Intl.DateTimeFormat('en-CA', {
          timeZone: row.timezone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit'
        }).format(now)
    )
    .map(row => ({
      id: row.id,
      name: row.name,
      logoUrl: media == null ? null : imageUrl(media.space, row.logo_path),
      requirement:
        row.level_id == null
          ? null
          : {
              levelId: row.level_id,
              levelName: row.level_name!,
              types: counts
                .filter(c => c.season_id === row.id)
                .map(c => ({
                  typeId: c.type_id,
                  required: c.required_count,
                  optional: c.optional_count
                }))
            }
    }))
}
export async function applyRequirements(
  db: Transaction<Database>,
  leagueId: string,
  body: { seasonIds?: unknown; levelId?: unknown; types?: unknown },
  now: number
): Promise<void> {
  if (
    !Array.isArray(body?.seasonIds) ||
    body.seasonIds.length === 0 ||
    body.seasonIds.length > 500 ||
    body.seasonIds.some(id => typeof id !== 'string') ||
    typeof body.levelId !== 'string' ||
    !Array.isArray(body.types)
  )
    throw badRequest('Choose seasons, a level and type counts')
  await requireLevel(db, leagueId, body.levelId)
  const catalog = await types(db, leagueId)
  const ids = new Set<string>()
  const counts: UmpireTypeCount[] = body.types.map(c => {
    if (
      c == null ||
      typeof c.typeId !== 'string' ||
      ids.has(c.typeId) ||
      !Number.isInteger(c.required) ||
      c.required < 0 ||
      c.required > 6 ||
      !Number.isInteger(c.optional) ||
      c.optional < 0 ||
      c.optional > 6
    )
      throw badRequest('Choose unique types and counts from 0 through 6')
    ids.add(c.typeId)
    return { typeId: c.typeId, required: c.required, optional: c.optional }
  })
  if (
    catalog.length === 0 ||
    ids.size !== catalog.length ||
    catalog.some(t => !ids.has(t.id))
  )
    throw conflict('Umpire types changed. Reload requirements and try again.')
  const eligible = new Set(
    (await requirements(db, leagueId, now)).map(r => r.id)
  )
  const slots = umpirePositions(catalog, counts).map(p => p.slot)
  for (const seasonId of new Set<string>(body.seasonIds)) {
    if (!eligible.has(seasonId))
      throw badRequest('Choose a current or upcoming season in this league')
    await db
      .insertInto('season_umpire_requirements')
      .values({ season_id: seasonId, level_id: body.levelId })
      .onConflict(oc =>
        oc.column('season_id').doUpdateSet({ level_id: body.levelId as string })
      )
      .execute()
    await db
      .deleteFrom('season_umpire_type_requirements')
      .where('season_id', '=', seasonId)
      .execute()
    await db
      .insertInto('season_umpire_type_requirements')
      .values(
        counts.map(c => ({
          season_id: seasonId,
          type_id: c.typeId,
          required_count: c.required,
          optional_count: c.optional
        }))
      )
      .execute()
    let deletion = db
      .deleteFrom('umpire_assignments')
      .where(
        'game_id',
        'in',
        db.selectFrom('games').select('id').where('season_id', '=', seasonId)
      )
    if (slots.length > 0) deletion = deletion.where('slot', 'not in', slots)
    await deletion.execute()
  }
}
/** Resolve aliases before unioning affiliation and role rows. Names leave here abbreviated. */
export async function people(
  db: Kysely<Database>,
  leagueId: string,
  query?: string,
  media?: MediaContext
): Promise<UmpirePerson[]> {
  if (query?.trim() === '') return []
  const users = await db
    .selectFrom('users')
    .select([
      'id',
      'first_name',
      'last_name',
      'display_name',
      'avatar_path',
      'merged_into',
      'disabled_at'
    ])
    .execute()
  const mergedInto = new Map(users.map(u => [u.id, u.merged_into]))
  const canonical = new Map<string, string>()
  for (const u of users) {
    let survivor = u.id
    const walked = new Set([survivor])
    // Match onePerson's bounded traversal without querying once per account.
    for (let depth = 0; depth < 16; depth += 1) {
      const next = mergedInto.get(survivor)
      if (next == null || walked.has(next)) break
      walked.add(next)
      survivor = next
    }
    canonical.set(u.id, survivor)
  }
  const canon = (id: string): string => canonical.get(id) ?? id
  const teams = await db
    .selectFrom('teams')
    .select(['id', 'name'])
    .where(eb =>
      eb.or([
        eb('league_id', '=', leagueId),
        eb(
          'id',
          'in',
          db
            .selectFrom('season_teams')
            .innerJoin('seasons', 'seasons.id', 'season_teams.season_id')
            .select('team_id')
            .where('seasons.league_id', '=', leagueId)
        )
      ])
    )
    .execute()
  const members =
    teams.length === 0
      ? []
      : await db
          .selectFrom('memberships')
          .select(['user_id', 'team_id', 'is_player'])
          .where(
            'team_id',
            'in',
            teams.map(t => t.id)
          )
          .execute()
  const leagueMembers = await db
    .selectFrom('league_members')
    .select('user_id')
    .where('league_id', '=', leagueId)
    .execute()
  const seasonMembers = await db
    .selectFrom('season_members')
    .innerJoin('seasons', 'seasons.id', 'season_members.season_id')
    .select('user_id')
    .where('seasons.league_id', '=', leagueId)
    .execute()
  const initial = new Set(
    [...members, ...leagueMembers, ...seasonMembers].map(m => canon(m.user_id))
  )
  const links = await db
    .selectFrom('user_links')
    .selectAll()
    .where('kind', 'in', ['guardian', 'family'])
    .execute()
  const population = new Set(initial)
  for (const l of links) {
    if (initial.has(canon(l.user_id))) population.add(canon(l.related_user_id))
    if (initial.has(canon(l.related_user_id))) population.add(canon(l.user_id))
  }
  const roles = new Set(
    (
      await db
        .selectFrom('league_umpires')
        .select('user_id')
        .where('league_id', '=', leagueId)
        .execute()
    ).map(r => canon(r.user_id))
  )
  const rows = users.filter(
    u =>
      u.merged_into == null &&
      u.disabled_at == null &&
      (query == null
        ? roles.has(u.id)
        : population.has(u.id) &&
          !roles.has(u.id) &&
          [u.first_name, u.last_name, u.display_name].some(
            n => n?.toLowerCase().includes(query.trim().toLowerCase()) === true
          ))
  )
  // The list's people and those it names beside them: a player is shown in
  // their format, the adults in the built-in one.
  const listed = new Set(rows.map(u => u.id))
  const named = new Set(listed)
  for (const l of links) {
    if (l.kind !== 'guardian') continue
    if (listed.has(canon(l.user_id))) named.add(canon(l.related_user_id))
    if (listed.has(canon(l.related_user_id))) named.add(canon(l.user_id))
  }
  const players = new Set([
    ...links
      .filter(l => l.kind === 'guardian')
      .map(l => canon(l.related_user_id)),
    ...members.filter(m => m.is_player).map(m => canon(m.user_id))
  ])
  const names = await publicNames(
    db,
    users
      .filter(u => u.merged_into == null && named.has(u.id))
      .map(u => ({
        person: {
          id: u.id,
          firstName: u.first_name,
          lastName: u.last_name,
          displayName: u.display_name
        },
        player: players.has(u.id)
      }))
  )
  const certifications = await db
    .selectFrom('umpire_certifications as c')
    .innerJoin('umpire_levels as l', 'l.id', 'c.level_id')
    .select(['c.user_id', 'c.level_id', 'c.type_id', 'c.enabled'])
    .where('l.league_id', '=', leagueId)
    .execute()
  return rows
    .map(u => {
      const children = links
        .filter(l => l.kind === 'guardian' && canon(l.user_id) === u.id)
        .map(l => canon(l.related_user_id))
      const guardians = links
        .filter(l => l.kind === 'guardian' && canon(l.related_user_id) === u.id)
        .map(l => canon(l.user_id))
      const ids = new Set([u.id, ...children])
      const teamNames = teams
        .filter(t =>
          members.some(m => m.team_id === t.id && ids.has(canon(m.user_id)))
        )
        .map(t => t.name)
        .join(', ')
      const affiliations = [
        teamNames,
        children.length === 0
          ? ''
          : `Guardian of ${[...new Set(children)].map(id => names.get(id)).join(', ')}`,
        guardians.length === 0
          ? ''
          : `Guardians: ${[...new Set(guardians)].map(id => names.get(id)).join(', ')}`
      ]
        .filter(Boolean)
        .join(' · ')
      const certs = new Map<string, UmpireCertification>()
      for (const c of certifications.filter(c => canon(c.user_id) === u.id)) {
        const key = JSON.stringify([c.level_id, c.type_id])
        const held = certs.get(key)
        certs.set(key, {
          levelId: c.level_id,
          typeId: c.type_id,
          enabled: c.enabled || held?.enabled === true
        })
      }
      return {
        id: u.id,
        name: String(names.get(u.id)),
        avatarUrl: media == null ? null : imageUrl(media.space, u.avatar_path),
        affiliations,
        certifications: [...certs.values()]
      }
    })
    .sort((a, b) => {
      const order = a.name.localeCompare(b.name)
      return order === 0 ? a.id.localeCompare(b.id) : order
    })
}
export async function grant(
  db: Transaction<Database>,
  leagueId: string,
  userId: string,
  actorId: string
): Promise<void> {
  const person = await onePerson(db, userId)
  const user = await db
    .selectFrom('users')
    .select(['id', 'display_name'])
    .where('id', '=', person.userId)
    .where('disabled_at', 'is', null)
    .executeTakeFirst()
  if (user == null) throw notFound('No person')
  const held = await db
    .selectFrom('league_umpires')
    .select('user_id')
    .where('league_id', '=', leagueId)
    .where('user_id', 'in', person.userIds)
    .executeTakeFirst()
  if (held != null) return
  if (
    !(await people(db, leagueId, user.display_name)).some(
      p => p.id === person.userId
    )
  )
    throw badRequest('Choose a person affiliated with this league')
  await db
    .insertInto('league_umpires')
    .values({
      league_id: leagueId,
      user_id: person.userId,
      granted_by: actorId
    })
    .onConflict(oc => oc.doNothing())
    .execute()
}
export async function revoke(
  db: Transaction<Database>,
  leagueId: string,
  userId: string
): Promise<void> {
  const person = await onePerson(db, userId)
  await db
    .deleteFrom('league_umpires')
    .where('league_id', '=', leagueId)
    .where('user_id', 'in', person.userIds)
    .execute()
  await db
    .deleteFrom('umpire_assignments')
    .where('user_id', 'in', person.userIds)
    .where(
      'game_id',
      'in',
      db
        .selectFrom('games')
        .innerJoin('seasons', 'seasons.id', 'games.season_id')
        .select('games.id')
        .where('seasons.league_id', '=', leagueId)
        .where('games.status', '!=', 'final')
    )
    .execute()
}
export async function certify(
  db: Transaction<Database>,
  leagueId: string,
  userId: string,
  body: { levelId?: unknown; typeId?: unknown; enabled?: unknown }
): Promise<void> {
  const person = await onePerson(db, userId)
  if (
    typeof body?.levelId !== 'string' ||
    typeof body.typeId !== 'string' ||
    typeof body.enabled !== 'boolean'
  )
    throw badRequest('Choose a level, type and certification')
  await requireLevel(db, leagueId, body.levelId)
  await requireType(db, leagueId, body.typeId)
  const role = await db
    .selectFrom('league_umpires')
    .select('user_id')
    .where('league_id', '=', leagueId)
    .where('user_id', 'in', person.userIds)
    .executeTakeFirst()
  if (role == null) throw badRequest('Not an umpire for this league')
  await db
    .deleteFrom('umpire_certifications')
    .where('user_id', 'in', person.userIds)
    .where('level_id', '=', body.levelId)
    .where('type_id', '=', body.typeId)
    .execute()
  await db
    .insertInto('umpire_certifications')
    .values({
      user_id: person.userId,
      level_id: body.levelId,
      type_id: body.typeId,
      enabled: body.enabled
    })
    .execute()
}
