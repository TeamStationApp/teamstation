import type { Kysely } from 'kysely'

import type { GroupRef } from '../../common/groupCreation'
import { formatNames, type NamedPerson } from '../../common/names'
import {
  asStoredPlayerNamePrivacy,
  DEFAULT_PLAYER_NAME_PRIVACY,
  mostRestrictive,
  type PlayerNamePrivacy,
  type PlayerNamePrivacySource,
  type ResolvedPlayerNamePrivacy,
  resolvePlayerNamePrivacy,
  spokenFormat
} from '../../common/playerNamePrivacy'
import { openAddsOf } from '../access'
import type { Database } from '../db/database'
import { isWithdrawnKey } from '../games/withdrawn'
import { followMerges } from '../teams/followMerges'
import { rowsOfPeople, survivors } from '../teams/teamStaff'
import { isSpoken } from '../users/readerNames'

/**
 * A level's player name privacy, read from what manages it. Inheritance
 * follows management only: a team's managing seasons are its
 * `season_team_parents` rows, and its managing leagues its own league and
 * theirs. `season_teams` is competition, never read here, so a season a team
 * only competes in contributes nothing.
 */

type Db = Kysely<Database>

const sourceOf = (
  kind: PlayerNamePrivacySource['kind'],
  row: { id: string; name: string; player_name_privacy: string | null }
): PlayerNamePrivacySource => ({
  kind,
  id: row.id,
  name: row.name,
  value: asStoredPlayerNamePrivacy(row.player_name_privacy)
})

async function leagueSources(
  db: Db,
  leagueIds: Iterable<string | null>
): Promise<Map<string, PlayerNamePrivacySource>> {
  const ids = [...new Set(leagueIds)].filter(id => id != null)
  if (ids.length === 0) return new Map()
  const rows = await db
    .selectFrom('leagues')
    .select(['id', 'name', 'player_name_privacy'])
    .where('id', 'in', ids)
    .execute()
  return new Map(rows.map(row => [row.id, sourceOf('league', row)]))
}

/** Each of these teams resolved, in a fixed number of queries. */
async function resolveTeams(
  db: Db,
  teamIds: readonly string[]
): Promise<Map<string, ResolvedPlayerNamePrivacy>> {
  if (teamIds.length === 0) return new Map()
  const teams = await db
    .selectFrom('teams')
    .select(['id', 'name', 'league_id', 'player_name_privacy'])
    .where('id', 'in', teamIds)
    .execute()
  const parents = await db
    .selectFrom('season_team_parents')
    .innerJoin('seasons', 'seasons.id', 'season_team_parents.season_id')
    .select([
      'season_team_parents.team_id as teamId',
      'seasons.id as id',
      'seasons.name as name',
      'seasons.league_id as leagueId',
      'seasons.player_name_privacy as player_name_privacy'
    ])
    .where('season_team_parents.team_id', 'in', teamIds)
    .execute()
  const leagues = await leagueSources(db, [
    ...teams.map(team => team.league_id),
    ...parents.map(parent => parent.leagueId)
  ])
  return new Map(
    teams.map(team => {
      const seasons = parents.filter(parent => parent.teamId === team.id)
      const managing = new Set([
        team.league_id,
        ...seasons.map(season => season.leagueId)
      ])
      return [
        team.id,
        resolvePlayerNamePrivacy({
          self: sourceOf('team', team),
          managingSeasons: seasons.map(season => sourceOf('season', season)),
          managingLeagues: [...leagues.values()].filter(league =>
            managing.has(league.id)
          )
        })
      ]
    })
  )
}

/** One level, with the sources that decided it: what its settings show. */
export async function loadPlayerNamePrivacy(
  db: Db,
  ref: GroupRef
): Promise<ResolvedPlayerNamePrivacy> {
  if (ref.kind === 'team') {
    const id = await followMerges(db, ref.id)
    return (await resolveTeams(db, [id])).get(id)!
  }
  if (ref.kind === 'league') {
    const league = (await leagueSources(db, [ref.id])).get(ref.id)!
    return resolvePlayerNamePrivacy({
      self: league,
      managingSeasons: [],
      managingLeagues: []
    })
  }
  const season = await db
    .selectFrom('seasons')
    .select(['id', 'name', 'league_id', 'player_name_privacy'])
    .where('id', '=', ref.id)
    .executeTakeFirstOrThrow()
  const leagues = await leagueSources(db, [season.league_id])
  return resolvePlayerNamePrivacy({
    self: sourceOf('season', season),
    managingSeasons: [],
    managingLeagues: [...leagues.values()]
  })
}

/** Every team whose format a change at this level can move. */
export async function teamsFormattedBy(
  db: Db,
  ref: GroupRef
): Promise<string[]> {
  if (ref.kind === 'team') return [ref.id]
  const seasons =
    ref.kind === 'season'
      ? [ref.id]
      : (
          await db
            .selectFrom('seasons')
            .select('id')
            .where('league_id', '=', ref.id)
            .execute()
        ).map(row => row.id)
  const parented =
    seasons.length === 0
      ? []
      : await db
          .selectFrom('season_team_parents')
          .select('team_id')
          .where('season_id', 'in', seasons)
          .execute()
  const direct =
    ref.kind !== 'league'
      ? []
      : await db
          .selectFrom('teams')
          .select('id')
          .where('league_id', '=', ref.id)
          .execute()
  return [
    ...new Set([
      ...parented.map(row => row.team_id),
      ...direct.map(row => row.id)
    ])
  ]
}

/**
 * Each team's public format, keyed by the id asked for. A merged team reads
 * as its survivor, because a stored game document keeps the old id: a fixed
 * number of queries, and one more per merge hop. An id no team has is absent.
 * A read whose names go to a model takes the spoken format (`isSpoken`).
 */
export async function teamFormats(
  db: Db,
  teamIds: Iterable<string>
): Promise<Map<string, PlayerNamePrivacy>> {
  const wanted = [...new Set(teamIds)]
  if (wanted.length === 0) return new Map()
  const merged = await db
    .selectFrom('teams')
    .select('id')
    .where('id', 'in', wanted)
    .where('merged_into', 'is not', null)
    .execute()
  const survivors = new Map<string, string>()
  for (const { id } of merged) survivors.set(id, await followMerges(db, id))
  const resolved = await resolveTeams(db, [
    ...new Set(wanted.map(id => survivors.get(id) ?? id))
  ])
  const formats = new Map<string, PlayerNamePrivacy>()
  for (const id of wanted) {
    const team = resolved.get(survivors.get(id) ?? id)
    if (team != null)
      formats.set(id, isSpoken() ? spokenFormat(team.format) : team.format)
  }
  return formats
}

/**
 * Who appears for a team that does not have them, as `teamId userId` keys:
 * held by its open add, or a pool guest of one of its games. Its format is for
 * its own players, and may only restrict these (`lentFormat`): a team cannot
 * read a whole name by asking to show whole names.
 */
export async function lentPlayers(
  db: Db,
  pairs: ReadonlyArray<{ userId: string; teamId: string }>
): Promise<Set<string>> {
  if (pairs.length === 0) return new Set()
  const lent = new Set<string>()
  const open = await openAddsOf(
    db,
    pairs.map(pair => pair.teamId)
  )
  for (const pair of pairs)
    if (open.get(pair.teamId)?.has(pair.userId) === true)
      lent.add(`${pair.teamId} ${pair.userId}`)
  const rows = await rowsOfPeople(
    db,
    pairs.map(pair => pair.userId)
  )
  const pool =
    rows.length === 0
      ? []
      : await db
          .selectFrom('game_guest_details')
          .innerJoin('games', 'games.id', 'game_guest_details.game_id')
          .select([
            'game_guest_details.user_id as userId',
            'games.home_team_id as home',
            'games.away_team_id as away'
          ])
          .where('game_guest_details.pool', '=', true)
          .where('game_guest_details.user_id', 'in', rows)
          .execute()
  const current = await survivors(
    db,
    pool.map(row => row.userId)
  )
  for (const row of pool) {
    const userId = current.get(row.userId) ?? row.userId
    lent.add(`${row.home} ${userId}`)
    lent.add(`${row.away} ${userId}`)
  }
  return lent
}

/** A lent player's format: their team's, only where it says less. */
export const lentFormat = (
  team: PlayerNamePrivacy,
  own: PlayerNamePrivacy | undefined
): PlayerNamePrivacy =>
  mostRestrictive([team, own ?? DEFAULT_PLAYER_NAME_PRIVACY])

/**
 * Each user's format when they are shown with no single team: the most
 * restrictive among the teams they play for now, as `teamsPlayedOnNow` reads
 * it, or the built-in format for somebody who plays for none. A team holding
 * them only by an open add is not theirs yet, and has no say.
 */
export async function currentFormats(
  db: Db,
  userIds: Iterable<string>
): Promise<Map<string, PlayerNamePrivacy>> {
  const wanted = [...new Set(userIds)]
  if (wanted.length === 0) return new Map()
  const plays = await db
    .selectFrom('memberships')
    .innerJoin('teams', 'teams.id', 'memberships.team_id')
    .select(['memberships.user_id as userId', 'memberships.team_id as teamId'])
    .where('memberships.user_id', 'in', wanted)
    .where('memberships.is_player', '=', true)
    .where('teams.merged_into', 'is', null)
    .execute()
  const formats = await teamFormats(
    db,
    plays.map(play => play.teamId)
  )
  const open = await openAddsOf(
    db,
    plays.map(play => play.teamId)
  )
  const byUser = new Map<string, PlayerNamePrivacy[]>()
  for (const play of plays) {
    const format = formats.get(play.teamId)
    if (format != null && open.get(play.teamId)?.has(play.userId) !== true)
      byUser.set(play.userId, [...(byUser.get(play.userId) ?? []), format])
  }
  return new Map(
    wanted.map(userId => {
      const held = byUser.get(userId) ?? []
      return [
        userId,
        held.length === 0 ? DEFAULT_PLAYER_NAME_PRIVACY : mostRestrictive(held)
      ]
    })
  )
}

/**
 * `formatNames` for this read: collisions broken, unless its names go to a
 * model, which never gets a letter past first name and last initial.
 */
export function formatForReader(
  entries: Parameters<typeof formatNames>[0],
  spoken = isSpoken()
): ReturnType<typeof formatNames> {
  return formatNames(entries, { lengthen: !spoken })
}

/** Somebody a surface names outside a game. */
export interface PublicPerson {
  person: NamedPerson
  /** The team they are shown on, when there is one. */
  teamId?: string | null
  /** Somebody shown as anything but a player keeps the built-in format. */
  player?: boolean
  /** Shown for a team they are not on, as a candidate for it. */
  candidate?: boolean
}

/**
 * The format each of these people is shown in: their team's, or with no
 * single team the teams they play for now (`currentFormats`). Staff names are
 * not this setting's: anyone shown as something else stays the built-in format.
 */
export async function publicFormats(
  db: Db,
  people: readonly PublicPerson[]
): Promise<Map<string | number, PlayerNamePrivacy>> {
  // A withdrawn player's line reads as its placeholder, which is no name.
  const named = (entry: PublicPerson): boolean =>
    entry.player !== false && !isWithdrawnKey(String(entry.person.id))
  const players = people.filter(named)
  const teams = await teamFormats(
    db,
    players.flatMap(entry => entry.teamId ?? [])
  )
  const held = (entry: PublicPerson): PlayerNamePrivacy | undefined =>
    entry.teamId == null ? undefined : teams.get(entry.teamId)
  const lent = await lentPlayers(
    db,
    players.flatMap(entry =>
      entry.teamId == null
        ? []
        : [{ userId: String(entry.person.id), teamId: entry.teamId }]
    )
  )
  const borrowed = (entry: PublicPerson): boolean =>
    entry.candidate === true ||
    lent.has(`${entry.teamId} ${String(entry.person.id)}`)
  const current = await currentFormats(
    db,
    players.flatMap(entry =>
      held(entry) == null || borrowed(entry) ? [String(entry.person.id)] : []
    )
  )
  const formats = new Map<string | number, PlayerNamePrivacy>()
  for (const entry of people) {
    const team = held(entry)
    const own = current.get(String(entry.person.id))
    const format = !named(entry)
      ? DEFAULT_PLAYER_NAME_PRIVACY
      : team != null && borrowed(entry)
        ? lentFormat(team, own)
        : (team ?? own ?? DEFAULT_PLAYER_NAME_PRIVACY)
    const earlier = formats.get(entry.person.id)
    formats.set(
      entry.person.id,
      earlier == null ? format : mostRestrictive([earlier, format])
    )
  }
  return formats
}

/** Public names for these people, with collisions broken across them. */
export async function publicNames(
  db: Db,
  people: readonly PublicPerson[]
): Promise<Map<string | number, string>> {
  const formats = await publicFormats(db, people)
  return formatForReader(
    people.map(({ person }) => ({ person, format: formats.get(person.id)! }))
  )
}
