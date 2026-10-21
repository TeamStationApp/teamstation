import type { Kysely, Selectable } from 'kysely'

import { badRequest, forbidden, notFound } from '../../common/errors'
import { calendarDateText } from '../../common/groupCreation'
import { umpireSlots } from '../../common/umpires'
import type {
  UmpireGameRow,
  UmpireLeague,
  UmpireSchedule
} from '../../common/umpireSchedule'
import {
  hardUmpireConflict,
  softUmpireConflict,
  umpireCloseness,
  umpireDate,
  umpireEnd,
  umpireFilterError,
  type UmpireFilters,
  umpireTimeMatches,
  umpireWindowsOverlap
} from '../../common/umpireTime'
import { type OnePerson, onePerson } from '../admin/people'
import type { Actor } from '../auth/sessions'
import { now } from '../clock'
import type { Database, SeasonsTable } from '../db/database'
import { canAdminister, requireGroupAdmin } from '../groups/rights'
import { imageUrl } from '../media/imageUrls'
import type { MediaContext } from '../media/mediaContext'
import { levels } from './admin'
import {
  umpireFamily,
  type UmpireIdentity,
  umpireIdentity,
  umpireInterval,
  umpireIsPlaying
} from './context'

export async function umpireLeagues(
  db: Kysely<Database>,
  actor: Actor,
  media?: MediaContext
): Promise<UmpireLeague[]> {
  const person = await onePerson(db, actor.userId)
  const rows = await db
    .selectFrom('leagues')
    .innerJoin('league_umpires as u', 'u.league_id', 'leagues.id')
    .select(['leagues.id', 'leagues.name', 'leagues.logo_path'])
    .where('u.user_id', 'in', person.userIds)
    .where('umpire_management', '=', true)
    .distinct()
    .orderBy('leagues.name')
    .execute()
  return rows.map(l => ({
    id: l.id,
    name: l.name,
    logoUrl: media == null ? null : imageUrl(media.space, l.logo_path)
  }))
}
export async function umpireAccess(
  db: Kysely<Database>,
  actor: Actor,
  leagueId: string,
  view: string
): Promise<boolean> {
  const league = await db
    .selectFrom('leagues')
    .select('umpire_management')
    .where('id', '=', leagueId)
    .executeTakeFirst()
  if (league == null) throw notFound('No league')
  if (!league.umpire_management) throw forbidden('Umpire management is off')
  if (view === 'league') {
    await requireGroupAdmin(db, actor, { kind: 'league', id: leagueId })
    return true
  }
  if (view !== 'umpire') throw badRequest('Choose umpire or league view')
  const person = await onePerson(db, actor.userId)
  const role = await db
    .selectFrom('league_umpires')
    .select('user_id')
    .where('league_id', '=', leagueId)
    .where('user_id', 'in', person.userIds)
    .executeTakeFirst()
  if (role == null) throw forbidden('Not an umpire for this league')
  return await canAdminister(db, actor, { kind: 'league', id: leagueId })
}
export async function involvedSeasons(
  db: Kysely<Database>,
  leagueId: string,
  family: UmpireIdentity[]
): Promise<Array<Selectable<SeasonsTable>>> {
  const teams = [...new Set(family.flatMap(p => p.teamIds))]
  if (teams.length === 0) return []
  return await db
    .selectFrom('seasons')
    .innerJoin('season_teams as st', 'st.season_id', 'seasons.id')
    .selectAll('seasons')
    .where('seasons.league_id', '=', leagueId)
    .where('st.team_id', 'in', teams)
    .distinct()
    .execute()
}
export async function schedule(
  db: Kysely<Database>,
  actor: Actor,
  leagueId: string,
  view: 'umpire' | 'league',
  filters: UmpireFilters
): Promise<UmpireSchedule> {
  const isAdmin = await umpireAccess(db, actor, leagueId, view)
  const error = umpireFilterError(filters)
  if (error != null) throw badRequest(error)
  const family = await umpireFamily(db, actor.userId)
  const involved = await involvedSeasons(db, leagueId, family)
  const windows = involved.map(s => ({
    start: calendarDateText(s.starts_on)!,
    end: calendarDateText(s.ends_on)!
  }))
  const seasons = await db
    .selectFrom('seasons')
    .innerJoin('season_umpire_requirements as r', 'r.season_id', 'seasons.id')
    .innerJoin('umpire_levels as l', 'l.id', 'r.level_id')
    .select([
      'seasons.id',
      'seasons.name',
      'seasons.starts_on',
      'seasons.ends_on',
      'seasons.timezone',
      'r.plate',
      'r.field_count',
      'r.level_id',
      'l.name as level_name'
    ])
    .where('seasons.league_id', '=', leagueId)
    .execute()
  const league = await db
    .selectFrom('leagues')
    .select(['umpire_management', 'umpire_credits'])
    .where('id', '=', leagueId)
    .executeTakeFirstOrThrow()
  const games = await db
    .selectFrom('games')
    .selectAll()
    .where('status', '!=', 'cancelled')
    .where('withdrawn_at', 'is', null)
    .orderBy('start_at')
    .orderBy('id')
    .execute()
  const assignments = await db
    .selectFrom('umpire_assignments')
    .selectAll()
    .execute()
  const byGame = new Map<string, typeof assignments>()
  const byPerson = new Map<string, Set<string>>()
  for (const assignment of assignments) {
    const held = byGame.get(assignment.game_id) ?? []
    held.push(assignment)
    byGame.set(assignment.game_id, held)
    const games = byPerson.get(assignment.user_id) ?? new Set<string>()
    games.add(assignment.game_id)
    byPerson.set(assignment.user_id, games)
  }
  const intervals = new Map(
    games.map(g => {
      const interval = umpireInterval(g)
      return [
        g.id,
        {
          interval,
          start: Date.parse(interval.startAt),
          end: umpireEnd(interval)
        }
      ]
    })
  )
  const commitments = new Map(
    family.map(p => {
      const umpiring = new Set(
        p.userIds.flatMap(id => [...(byPerson.get(id) ?? [])])
      )
      return [
        p.userId,
        games.flatMap(g => {
          const playing = umpireIsPlaying(p, g)
          return playing || umpiring.has(g.id)
            ? [{ game: g, playing, ...intervals.get(g.id)! }]
            : []
        })
      ]
    })
  )
  const dates = new Map<string, string>()
  const gameDate = (g: (typeof games)[number]): string => {
    let date = dates.get(g.id)
    if (date == null) {
      date = umpireDate(intervals.get(g.id)!.interval.startAt, g.timezone)
      dates.set(g.id, date)
    }
    return date
  }
  const roles = await db
    .selectFrom('league_umpires')
    .select('user_id')
    .where('league_id', '=', leagueId)
    .execute()
  const certifications = await db
    .selectFrom('umpire_certifications')
    .selectAll()
    .execute()
  const allPeople = new Map(family.map(p => [p.userId, p]))
  const identity = async (id: string): Promise<UmpireIdentity> => {
    const held = allPeople.get(id)
    if (held != null) return held
    const p = await umpireIdentity(db, id)
    allPeople.set(id, p)
    return p
  }
  const authors = new Map<string, OnePerson>(
    family.flatMap(p => p.userIds.map(id => [id, p]))
  )
  const authorIdentity = async (id: string): Promise<OnePerson> => {
    const held = authors.get(id)
    if (held != null) return held
    const p = await onePerson(db, id)
    for (const alias of p.userIds) authors.set(alias, p)
    return p
  }
  const rows: UmpireGameRow[] = []
  const instant = now()
  const current = await db
    .selectFrom('seasons')
    .innerJoin('season_teams as st', 'st.season_id', 'seasons.id')
    .innerJoin('teams', 'teams.id', 'st.team_id')
    .select(['seasons.ends_on', 'seasons.timezone', 'teams.id', 'teams.name'])
    .where('seasons.league_id', '=', leagueId)
    .execute()
  const liveTeams = current.filter(
    s =>
      calendarDateText(s.ends_on)! >=
      new Intl.DateTimeFormat('en-CA', {
        timeZone: s.timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).format(instant)
  )
  const eligible = family.filter(
    (p, i) =>
      p.active && (i === 0 || liveTeams.some(t => p.teamIds.includes(t.id)))
  )
  const creditTeams = [
    ...new Map(
      liveTeams
        .filter(t => family.some(p => p.teamIds.includes(t.id)))
        .map(t => [t.id, { id: t.id, name: t.name }])
    ).values()
  ]
  const teams = await db.selectFrom('teams').select(['id', 'name']).execute()
  for (const game of games) {
    const season = seasons.find(s => s.id === game.season_id)
    if (season == null || (!season.plate && season.field_count === 0)) continue
    const past =
      new Date(game.start_at).getTime() < instant &&
      game.status !== 'inProgress'
    if (
      view === 'umpire' &&
      (past
        ? !involved.some(s => s.id === season.id)
        : !windows.some(w =>
            umpireWindowsOverlap(w, {
              start: calendarDateText(season.starts_on)!,
              end: calendarDateText(season.ends_on)!
            })
          ))
    )
      continue
    const { interval, start, end } = intervals.get(game.id)!
    if (!umpireTimeMatches(interval.startAt, game.timezone, filters)) continue
    const slots = umpireSlots(season.plate, season.field_count)
    const held = byGame.get(game.id) ?? []
    if (
      filters.levels != null &&
      filters.levels.length > 0 &&
      (!filters.levels.includes(season.level_id) ||
        slots.every(slot => held.some(a => a.slot === slot)))
    )
      continue
    const row: UmpireGameRow = {
      id: game.id,
      seasonId: season.id,
      seasonName: season.name,
      levelId: season.level_id,
      levelName: season.level_name,
      ...interval,
      timezone: game.timezone,
      date: gameDate(game),
      status: game.status,
      home: teams.find(t => t.id === game.home_team_id)!.name,
      away: teams.find(t => t.id === game.away_team_id)!.name,
      venue: game.venue ?? '',
      notes: game.notes ?? '',
      plate: season.plate,
      fieldCount: season.field_count,
      assignments: {},
      conflicts: [],
      choices: {}
    }
    for (const a of held) {
      const p = await identity(a.user_id)
      const author = await authorIdentity(a.assigned_by)
      row.assignments[a.slot] = {
        userId: p.userId,
        name: p.name,
        assignedBy: author.userId,
        canRemove:
          isAdmin ||
          ((family[0].userId === p.userId ||
            family[0].userId === author.userId) &&
            instant < new Date(game.start_at).getTime() - 15 * 60000)
      }
    }
    const availability = new Map(
      family.map(p => {
        let playing = false
        let umpiring = held.some(a => p.userIds.includes(a.user_id))
        for (const other of commitments.get(p.userId)!) {
          // These bounds contain every hard and soft conflict. Far-away history
          // never needs repeated date parsing or roster/assignment scans.
          if (other.end < start - 45 * 60000 || other.start > end + 45 * 60000)
            continue
          const hard = hardUmpireConflict(interval, other.interval)
          if (other.playing && hard) playing = true
          if (!other.playing && other.game.id !== game.id && hard)
            umpiring = true
          if (!other.playing && other.game.id === game.id) continue
          if (!softUmpireConflict(interval, other.interval)) continue
          row.conflicts.push({
            userId: p.userId,
            name: p.name,
            activity: other.playing ? 'playing' : 'already umpiring',
            gameId: other.game.id,
            time: gameDate(other.game),
            closeness: umpireCloseness(interval, other.interval)
          })
        }
        return [p.userId, { playing, umpiring }]
      })
    )
    for (const slot of slots)
      row.choices[slot] = eligible.map(p => {
        const certs = certifications.filter(
          c => p.userIds.includes(c.user_id) && c.level_id === season.level_id
        )
        const { playing, umpiring } = availability.get(p.userId)!
        const reason = playing
          ? 'already playing then'
          : umpiring
            ? 'already umpiring then'
            : !roles.some(r => p.userIds.includes(r.user_id))
              ? 'not an umpire for this league'
              : certs.length === 0 || !certs.some(c => c.plate || c.field)
                ? `not certified for ${season.level_name}`
                : !certs.some(c => (slot === 'plate' ? c.plate : c.field))
                  ? `not certified for ${slot === 'plate' ? 'plate ump' : 'field ump'}`
                  : null
        return { userId: p.userId, name: p.name, reason }
      })
    rows.push(row)
  }
  return {
    settings: {
      management: league.umpire_management,
      credits: league.umpire_credits
    },
    levels: await levels(db, leagueId),
    games: rows,
    creditTeams,
    viewerId: family[0].userId,
    isAdmin,
    view
  }
}
export function parseUmpireFilters(
  query: Record<string, unknown>
): UmpireFilters {
  const list = (key: string): string[] => {
    const value = query[key]
    if (value == null || value === '') return []
    const values = Array.isArray(value) ? value : [value]
    if (values.some(v => typeof v !== 'string'))
      throw badRequest(`Supply ${key} filter strings`)
    return (values as string[]).flatMap(v => v.split(','))
  }
  const time = (key: string): string | undefined => {
    const value = query[key]
    if (value == null || value === '') return undefined
    if (typeof value !== 'string') throw badRequest('Supply one time')
    return value
  }
  return {
    levels: list('levels'),
    days: list('days').map(Number),
    from: time('from'),
    to: time('to')
  }
}
