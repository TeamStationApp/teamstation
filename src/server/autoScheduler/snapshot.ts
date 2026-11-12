import { type Kysely, sql } from 'kysely'

import type {
  EngineBooking,
  EngineInput,
  FixedGame,
  PlannedGame
} from '../../common/autoScheduler/types'
import { conflict } from '../../common/errors'
import { DEFAULT_EVENT_DURATION_MS } from '../../common/eventTime'
import type { GameRequestTerms } from '../../common/gameApprovals'
import type { ExistingGames } from '../../common/schedulePreviews'
import { asFieldSize, type FieldSize } from '../../common/venues'
import type { Database } from '../db/database'
import type { Clock } from '../groups/requests'
import { scheduleSetup } from '../scheduler/setup'
import { rowsOfPeople, survivors } from '../teams/teamStaff'
import { fieldFacts } from '../venues/fieldWarnings'
import { occupancy } from '../venues/occupancy'
import { managerConflict, type RuleContext } from './rules'

type Db = Kysely<Database>

/** A game a published preview proposed that is listed for rescheduling. */
export interface RescheduleRef {
  previewId: string
  gameKey: string
}

/** What a preview stores beside the engine's input. */
export interface Snapshot {
  avoidHeadCoachConflicts?: boolean
  engine: EngineInput
  existing: ExistingGames
  teamIds: string[] | null
  /** The upcoming games publishing replaces. */
  replaceGameIds: string[]
  /**
   * The run's upcoming games when it was built, and the ids its pending
   * proposals reserved, to notice new ones.
   */
  knownGameIds: string[]
  /** Listed games this build places again. */
  reschedules: RescheduleRef[]
  seasons: Array<{ id: string; name: string; timezone: string }>
  fields: Array<{
    id: string
    name: string
    venueName: string
    sizes: FieldSize[]
  }>
  teams: Array<{ id: string; name: string }>
}

/** The teams a league has authority over: its own, and its seasons'. */
export async function leagueTeamIds(
  db: Db,
  leagueId: string
): Promise<Set<string>> {
  const own = await db
    .selectFrom('teams')
    .select('id')
    .where('league_id', '=', leagueId)
    .execute()
  const managed = await db
    .selectFrom('season_team_parents')
    .innerJoin('seasons', 'seasons.id', 'season_team_parents.season_id')
    .select('season_team_parents.team_id as id')
    .where('seasons.league_id', '=', leagueId)
    .execute()
  return new Set([...own, ...managed].map(row => row.id))
}

interface GameRow {
  id: string
  home_team_id: string
  away_team_id: string
  season_id: string | null
  start_at: Date
  end_at: Date | null
  status: string
  exhibition: boolean
  field_id: string | null
  field_size: string | null
}

/** The run seasons' games that are not canceled. */
export async function runGames(
  db: Db,
  seasonIds: string[]
): Promise<GameRow[]> {
  if (seasonIds.length === 0) return []
  return await db
    .selectFrom('games')
    .select([
      'id',
      'home_team_id',
      'away_team_id',
      'season_id',
      'start_at',
      'end_at',
      'status',
      'exhibition',
      'field_id',
      'field_size'
    ])
    .where('season_id', 'in', seasonIds)
    .where('status', '!=', 'cancelled')
    .execute()
}

/** A game still ahead and unplayed: the kind a build may replace. */
export function upcoming(game: GameRow, now: Date): boolean {
  return game.status === 'scheduled' && game.start_at.getTime() > now.getTime()
}

function endOf(start: Date, end: Date | null): number {
  return end == null
    ? start.getTime() + DEFAULT_EVENT_DURATION_MS
    : end.getTime()
}

function sizeOf(raw: string | null | undefined): FieldSize | null {
  if (raw == null) return null
  try {
    return asFieldSize(raw)
  } catch {
    return null
  }
}

/**
 * Pending, unexpired proposals the Auto-Scheduler made for the run's
 * seasons: they keep their slots and count toward their teams' totals.
 */
export async function pendingSchedulerProposals(
  db: Db,
  seasonIds: string[],
  clock: Clock
): Promise<FixedGame[]> {
  if (seasonIds.length === 0) return []
  const rows = await db
    .selectFrom('group_requests')
    .select(['terms'])
    .where('kind', '=', 'game')
    .where('status', '=', 'pending')
    .where('expires_at', '>', clock.now())
    .where(sql<string>`terms->>'schedulePreviewId'`, 'is not', null)
    .where(sql<string>`terms->'game'->>'seasonId'`, 'in', seasonIds)
    .execute()
  const out: FixedGame[] = []
  for (const row of rows) {
    const terms = row.terms as GameRequestTerms
    if (
      terms.schedulePreviewId == null ||
      terms.gameId != null ||
      terms.proposedGameId == null ||
      terms.game.seasonId == null ||
      !seasonIds.includes(terms.game.seasonId)
    )
      continue
    const start = new Date(terms.game.startAt)
    out.push({
      key: terms.proposedGameId,
      seasonId: terms.game.seasonId,
      homeTeamId: terms.game.homeTeamId,
      awayTeamId: terms.game.awayTeamId,
      exhibition: terms.game.exhibition ?? false,
      fieldId: terms.game.fieldId ?? null,
      size: sizeOf(terms.game.fieldSize),
      start: start.getTime(),
      end: endOf(
        start,
        terms.game.endAt == null ? null : new Date(terms.game.endAt)
      )
    })
  }
  return out
}

/** Every team coached by the same person as a team in the run, across all leagues. */
export async function headCoachesOf(
  db: Db,
  teamIds: string[]
): Promise<Record<string, string>> {
  if (teamIds.length === 0) return {}
  const query = db
    .selectFrom('scope_roles')
    .select(['scope_id', 'user_id'])
    .where('is_head_coach', '=', true)
  const own = await query.where('scope_id', 'in', teamIds).execute()
  if (own.length === 0) return {}
  const canonical = await survivors(
    db,
    own.map(row => row.user_id)
  )
  if (canonical.size === 0) return {}
  const eligible = await db
    .selectFrom('users')
    .select('id')
    .where('id', 'in', [...new Set(canonical.values())])
    .where('merged_into', 'is', null)
    .where('disabled_at', 'is', null)
    .where('login_enabled', '=', true)
    .execute()
  const aliases = await rowsOfPeople(
    db,
    eligible.map(coach => coach.id)
  )
  if (aliases.length === 0) return {}
  const related = await query.where('user_id', 'in', aliases).execute()
  const identities = await survivors(
    db,
    related.map(row => row.user_id)
  )
  const managers: Record<string, string> = {}
  for (const row of related) {
    const id = identities.get(row.user_id)
    if (id != null) managers[row.scope_id] = id
  }
  return managers
}

/**
 * Reads everything a build runs on: the league's chosen seasons with their
 * settings and teams, the chosen fields' availability, what already holds
 * those fields and teams, and the games that stay where they are and count.
 * With Replace, the upcoming games of the league's own teams are set aside
 * to be scheduled again: all of them, or in a partial build only those
 * between the listed teams.
 */
export async function snapshot(
  db: Db,
  request: {
    leagueId: string
    existing: ExistingGames
    avoidHeadCoachConflicts?: boolean
    teamIds: string[] | null
    /** Games of an earlier preview's option to keep where they are. */
    keep?: PlannedGame[]
    reschedules: RescheduleRef[]
    /**
     * The matchups to place, and only these: a recalculation's rejected
     * games, or the games listed for rescheduling. A partial build adds the
     * games it replaces.
     */
    required?: NonNullable<EngineInput['required']>
    /** Slots to leave alone: where rejected or listed games were. */
    avoid?: EngineBooking[]
    /**
     * Whether the games Replace takes away join `required`: for Recalculate
     * just these teams, which places them again. A recalculation keeps the
     * option's games that already replaced them, so it doesn't.
     */
    requireReplaced?: boolean
  },
  clock: Clock
): Promise<Snapshot> {
  const now = clock.now()
  const setup = await scheduleSetup(db, request.leagueId, clock)
  const seasons = setup.seasons.filter(season =>
    setup.seasonIds.includes(season.id)
  )
  const selectedFieldIds = [
    ...new Set(seasons.flatMap(season => season.settings.fieldIds ?? []))
  ]
  const facts = await fieldFacts(db, selectedFieldIds)
  const fields = selectedFieldIds
    .map(id => facts.get(id))
    .filter((field): field is NonNullable<typeof field> => field != null)
    .filter(field => !field.deleted)
  if (seasons.length === 0 || fields.length === 0)
    throw conflict('Choose the seasons and fields to schedule first')
  const seasonIds = seasons.map(season => season.id)
  const runTeams = new Set(
    seasons.flatMap(season => season.teams.map(team => team.id))
  )
  const ownTeams = await leagueTeamIds(db, request.leagueId)
  const games = await runGames(db, seasonIds)
  const listed = new Set(request.teamIds ?? [])
  const replaceGameIds =
    request.existing === 'replace'
      ? games
          .filter(
            game =>
              upcoming(game, now) &&
              ownTeams.has(game.home_team_id) &&
              ownTeams.has(game.away_team_id) &&
              (request.teamIds == null ||
                (listed.has(game.home_team_id) &&
                  listed.has(game.away_team_id)))
          )
          .map(game => game.id)
      : []
  const pending = await pendingSchedulerProposals(db, seasonIds, clock)
  const fixed: FixedGame[] = [
    ...games
      .filter(game => !replaceGameIds.includes(game.id))
      .map(game => ({
        key: game.id,
        seasonId: game.season_id!,
        homeTeamId: game.home_team_id,
        awayTeamId: game.away_team_id,
        exhibition: game.exhibition,
        fieldId: game.field_id,
        size: sizeOf(game.field_size),
        start: game.start_at.getTime(),
        end: endOf(game.start_at, game.end_at)
      })),
    ...pending,
    ...(request.keep ?? []).map(game => ({
      key: `kept:${game.key}`,
      seasonId: game.seasonId,
      homeTeamId: game.homeTeamId,
      awayTeamId: game.awayTeamId,
      exhibition: game.exhibition,
      fieldId: game.fieldId,
      size: game.size,
      start: Date.parse(game.startAt),
      end: Date.parse(game.endAt)
    }))
  ]
  const fixedKeys = new Set(fixed.map(game => game.key))
  const fixedGameIds = new Set(
    games.filter(game => !replaceGameIds.includes(game.id)).map(game => game.id)
  )
  const fieldIds = fields.map(field => field.id)
  const required =
    request.required == null
      ? undefined
      : [
          ...request.required,
          ...games
            .filter(
              game =>
                request.requireReplaced === true &&
                replaceGameIds.includes(game.id)
            )
            .map(game => ({
              key: `replaced:${game.id}`,
              seasonId: game.season_id!,
              homeTeamId: game.home_team_id,
              awayTeamId: game.away_team_id,
              exhibition: game.exhibition
            }))
        ]
  const teamIds = [
    ...new Set([
      ...runTeams,
      ...fixed.flatMap(game => [game.homeTeamId, game.awayTeamId]),
      ...(required ?? []).flatMap(game => [game.homeTeamId, game.awayTeamId])
    ])
  ]
  const avoidHeadCoachConflicts =
    request.avoidHeadCoachConflicts ?? setup.avoidHeadCoachConflicts ?? true
  const headCoaches = avoidHeadCoachConflicts
    ? await headCoachesOf(db, teamIds)
    : {}
  const busyTeams = new Set([...teamIds, ...Object.keys(headCoaches)])
  const liveBookings = await occupancy(
    db,
    {
      fieldIds,
      teamIds: [...busyTeams],
      from: new Date(now.getTime() - 8 * 86400000),
      keepScheduledFor: Object.keys(headCoaches)
    },
    clock
  )
  const weeklyGames = [
    ...liveBookings
      .filter(
        booking =>
          booking.managerOnly !== true &&
          booking.seasonId != null &&
          !replaceGameIds.includes(booking.key)
      )
      .map(booking => ({
        seasonId: booking.seasonId!,
        fieldId: booking.fieldId,
        teamIds: [booking.homeTeamId, booking.awayTeamId],
        start: booking.start
      })),
    ...(request.keep ?? []).map(game => ({
      seasonId: game.seasonId,
      fieldId: game.fieldId,
      teamIds: [game.homeTeamId, game.awayTeamId],
      start: Date.parse(game.startAt)
    }))
  ]
  const bookings: EngineBooking[] = liveBookings
    // A pending change to a counted game holds the time it proposes as
    // well as the game's own; the game itself is already counted.
    .filter(
      booking =>
        !replaceGameIds.includes(booking.key) &&
        (!fixedKeys.has(booking.key) ||
          (booking.pending && fixedGameIds.has(booking.key)))
    )
    .map(booking => ({
      managerOnly: booking.managerOnly,
      key: fixedKeys.has(booking.key) ? `pending:${booking.key}` : booking.key,
      fieldId:
        booking.fieldId != null && fieldIds.includes(booking.fieldId)
          ? booking.fieldId
          : null,
      size: sizeOf(booking.size),
      teamIds: [booking.homeTeamId, booking.awayTeamId].filter(id =>
        busyTeams.has(id)
      ),
      start: booking.start,
      end: booking.end
    }))
    .filter(booking => booking.fieldId != null || booking.teamIds.length > 0)
  // A recalculation promises to keep these games. A newly busy manager can
  // make that promise impossible even when the rejected games fit elsewhere.
  if (
    request.keep != null &&
    request.keep.length > 0 &&
    Object.keys(headCoaches).length > 0
  ) {
    const held = [
      ...bookings,
      ...fixed.map(game => ({
        key: game.key,
        start: game.start,
        end: game.end,
        teamIds: [game.homeTeamId, game.awayTeamId]
      }))
    ]
    for (const kept of request.keep) {
      const game = {
        key: `kept:${kept.key}`,
        start: Date.parse(kept.startAt),
        end: Date.parse(kept.endAt),
        teamIds: [kept.homeTeamId, kept.awayTeamId]
      }
      if (held.some(other => managerConflict(game, other, headCoaches)))
        throw conflict(
          'A Manager/Head Coach is now busy during a game this preview keeps. Build a new schedule.'
        )
    }
  }
  bookings.push(...(request.avoid ?? []))
  const teams = await db
    .selectFrom('teams')
    .select(['id', 'name'])
    .where('id', 'in', teamIds.length === 0 ? [''] : teamIds)
    .orderBy('name')
    .orderBy('id')
    .execute()
  return {
    avoidHeadCoachConflicts,
    engine: {
      ...(Object.keys(headCoaches).length === 0 ? {} : { headCoaches }),
      seasons: seasons.map(season => ({
        id: season.id,
        name: season.name,
        settings: season.settings,
        participants: season.teams
          .filter(team => !team.exhibition)
          .map(team => team.id),
        exhibitionTeams: season.teams
          .filter(team => team.exhibition)
          .map(team => team.id)
      })),
      fields: fields.map(field => ({
        id: field.id,
        name: field.name,
        venueName: field.venueName,
        sizes: field.sizes.map(size => asFieldSize(size)),
        availability: field.availability,
        switchMinutes: field.switchMs / 60000
      })),
      bookings,
      fixed,
      weeklyGames,
      teamNames: Object.fromEntries(teams.map(team => [team.id, team.name])),
      ...(request.teamIds == null ? {} : { teamIds: request.teamIds }),
      ...(required == null ? {} : { required }),
      notBefore: now.getTime(),
      seed: 1
    },
    existing: request.existing,
    teamIds: request.teamIds,
    replaceGameIds,
    // A pending proposal's game takes the id it reserved once accepted.
    knownGameIds: [
      ...games.filter(game => upcoming(game, now)).map(game => game.id),
      ...pending.map(game => game.key)
    ],
    reschedules: request.reschedules,
    seasons: seasons.map(season => ({
      id: season.id,
      name: season.name,
      timezone: season.timezone
    })),
    fields: fields.map(field => ({
      id: field.id,
      name: field.name,
      venueName: field.venueName,
      sizes: field.sizes.map(size => asFieldSize(size))
    })),
    teams
  }
}

/** The hard rules' context for a snapshot's fields and seasons. */
export function ruleContext(
  snap: Snapshot,
  others: RuleContext['others'],
  headCoaches?: Record<string, string>
): RuleContext {
  return {
    headCoaches,
    fields: new Map(
      snap.engine.fields.map(field => [
        field.id,
        {
          name: field.name,
          venueName: field.venueName,
          sizes: field.sizes,
          availability: field.availability,
          switchMs: field.switchMinutes * 60000
        }
      ])
    ),
    seasons: new Map(
      snap.engine.seasons.map(season => [
        season.id,
        {
          fieldIds: season.settings.fieldIds ?? [],
          bufferMinutes: season.settings.bufferMinutes,
          doubleheaders: season.settings.doubleheaders,
          maxGamesOnWeekdays: season.settings.maxGamesOnWeekdays,
          maxGamesOnWeekend: season.settings.maxGamesOnWeekend
        }
      ])
    ),
    others
  }
}
