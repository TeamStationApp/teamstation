import { type Kysely, sql, type Transaction } from 'kysely'

import { makeId } from '../../common/ids'
import {
  asScheduleGameRow,
  type GameStatus,
  type ScheduleErrorCode,
  type ScheduleGameResult,
  type ScheduleGameRow,
  type ScheduleGamesResponse
} from '../../common/scheduleGames'
import { adminScopes } from '../access'
import { lockKeys } from '../db/advisoryLocks'
import type { Database } from '../db/database'
import {
  type ExternalIdKey,
  externalIdLockKey,
  recordExternalId
} from '../db/externalIds'
import { gameHasPlays } from '../games/fenceDistance'
import { followMerges } from '../teams/followMerges'
import { resolveOpponent } from '../teams/resolveOpponent'

/**
 * Who may write a team's schedule, and into which seasons.
 *
 * `teamAdminIds` are the teams this person administers in their own right —
 * an administrator's `scope_roles` team row, or owning or managing it — and
 * not the ones a season or league right carries down, because that right is
 * judged season by season. `seasonIds` are the seasons they administer, a league's included.
 */
export interface ScheduleRights {
  siteAdmin: boolean
  teamAdminIds: Set<string>
  seasonIds: Set<string>
}

export async function scheduleRights(
  db: Kysely<Database>,
  userId: number,
  isAdmin: boolean
): Promise<ScheduleRights> {
  const scopes = await adminScopes(db, userId, isAdmin)
  const teamRoles = await db
    .selectFrom('scope_roles')
    .select(['scope_id'])
    .where('user_id', '=', userId)
    .where('scope_type', '=', 'team')
    // A flag row is a coach or a scorekeeper, never the right to schedule.
    .where('role', '=', 'admin')
    .execute()
  const owned = await db
    .selectFrom('memberships')
    .select(['team_id'])
    .where('user_id', '=', userId)
    .where('role', 'in', ['owner', 'manager'])
    .execute()
  return {
    siteAdmin: isAdmin,
    teamAdminIds: new Set([
      ...teamRoles.map(row => row.scope_id),
      ...owned.map(row => row.team_id)
    ]),
    seasonIds: scopes.seasonIds
  }
}

/** Whether these rights may schedule `teamId`'s games in `seasonId`. */
export function mayScheduleIn(
  rights: ScheduleRights,
  teamId: string,
  seasonId: string | null
): boolean {
  if (rights.siteAdmin || rights.teamAdminIds.has(teamId)) return true
  return seasonId != null && rights.seasonIds.has(seasonId)
}

/** A season a team plays in, with its dates as `YYYY-MM-DD`. */
interface TeamSeason {
  id: string
  name: string
  year: number
  startsOn: string | null
  endsOn: string | null
}

/** A row refused: rolled back, and answered with this code and message. */
class RowError extends Error {
  constructor(
    readonly code: ScheduleErrorCode,
    message: string
  ) {
    super(message)
  }
}

interface HeldGame {
  id: string
  home_team_id: string
  away_team_id: string
  season_id: string | null
  start_at: Date
  venue: string | null
  status: GameStatus
  fence_distance_ft: number | null
}

interface Context {
  teamId: string
  teamName: string
  seasons: TeamSeason[]
  rights: ScheduleRights
}

type Applied = { result: 'created' | 'updated' | 'unchanged' } & {
  gameId: string
  status: GameStatus
}

/**
 * Schedules games for one team, a row at a time.
 *
 * Each row runs in its own transaction and gets its own answer, in input
 * order, so one refused row neither stops the others nor half-applies. The
 * caller has already settled that `rights` may write this team's schedule at
 * all; each row is judged again against the season it lands in.
 */
export async function scheduleGames(
  db: Kysely<Database>,
  options: { teamId: string; rows: unknown[]; rights: ScheduleRights }
): Promise<ScheduleGamesResponse> {
  const { teamId, rights } = options
  const team = await db
    .selectFrom('teams')
    .select(['id', 'name'])
    .where('id', '=', teamId)
    .executeTakeFirstOrThrow()
  const seasons = await db
    .selectFrom('season_teams')
    .innerJoin('seasons', 'seasons.id', 'season_teams.season_id')
    .select([
      'seasons.id as id',
      'seasons.name as name',
      'seasons.year as year',
      sql<string | null>`to_char(seasons.starts_on, 'YYYY-MM-DD')`.as(
        'startsOn'
      ),
      sql<string | null>`to_char(seasons.ends_on, 'YYYY-MM-DD')`.as('endsOn')
    ])
    .where('season_teams.team_id', '=', teamId)
    .execute()
  const context: Context = {
    teamId,
    teamName: team.name,
    seasons,
    rights
  }

  // Normalised opponent name to team id, for the whole call. A team a row
  // makes joins it only once that row has committed.
  const known = new Map<string, string>()
  const results: ScheduleGameResult[] = []
  const counts = { created: 0, updated: 0, unchanged: 0, error: 0 }

  for (const [index, raw] of options.rows.entries()) {
    let row: ScheduleGameRow
    try {
      row = asScheduleGameRow(raw)
    } catch (error) {
      results.push(errorResult(index, 'invalid', messageOf(error)))
      counts.error += 1
      continue
    }

    const rowKnown = new Map(known)
    try {
      const applied = await db
        .transaction()
        .execute(async trx => await applyRow(trx, context, row, rowKnown))
      for (const [name, id] of rowKnown) known.set(name, id)
      results.push({ index, ...applied })
      counts[applied.result] += 1
    } catch (error) {
      results.push(
        error instanceof RowError
          ? errorResult(index, error.code, error.message)
          : errorResult(index, 'invalid', messageOf(error))
      )
      counts.error += 1
    }
  }
  return { results, counts }
}

function errorResult(
  index: number,
  code: ScheduleErrorCode,
  message: string
): ScheduleGameResult {
  return { index, result: 'error', error: { code, message } }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function applyRow(
  trx: Transaction<Database>,
  context: Context,
  row: ScheduleGameRow,
  known: Map<string, string>
): Promise<Applied> {
  const { teamId } = context
  const startAt = new Date(row.startAt)
  const externalId = row.externalId
  const opponentKey = opponentExternalId(row)

  // Two posts of one new id at once make one game, not two; two rows naming
  // one opponent's id at once record it once, on one team.
  const keys: string[] = []
  if (externalId != null) {
    keys.push(`schedule:${externalId.system}:${externalId.id}`)
  }
  if (opponentKey != null) keys.push(externalIdLockKey(opponentKey))
  await lockKeys(trx, keys)

  if (externalId != null) {
    const held = await trx
      .selectFrom('external_ids')
      .innerJoin('games', 'games.id', 'external_ids.entity_id')
      .select([
        'games.id',
        'games.home_team_id',
        'games.away_team_id',
        'games.season_id',
        'games.start_at',
        'games.venue',
        'games.status',
        'games.fence_distance_ft'
      ])
      .where('external_ids.entity_type', '=', 'game')
      .where('external_ids.system', '=', externalId.system)
      .where('external_ids.external_id', '=', externalId.id)
      .executeTakeFirst()
    if (held != null) {
      if (held.home_team_id !== teamId && held.away_team_id !== teamId) {
        throw new RowError(
          'conflict',
          `${externalId.system} ${externalId.id} is on a game ${context.teamName} does not play in`
        )
      }
      mustMaySchedule(context, held.season_id)
      if (
        opponentKey != null &&
        row.opponent != null &&
        'name' in row.opponent
      ) {
        // Only when the row's name finds the game's own opponent: a game
        // held against a placeholder or a since-corrected opponent must not
        // hand that team the real opponent's id.
        const holder = await idHolder(trx, opponentKey)
        const opponent = await followMerges(
          trx,
          held.home_team_id === teamId ? held.away_team_id : held.home_team_id
        )
        if (
          holder.free &&
          (await isExternal(trx, opponent)) &&
          (await nameFinds(trx, row.opponent.name, held.season_id, opponent))
        ) {
          await takeId(trx, opponent, opponentKey, holder)
        }
      }
      if (held.status === 'inProgress' || held.status === 'final') {
        return { result: 'unchanged', gameId: held.id, status: held.status }
      }
      const idWritten = await recordExternalId(trx, 'game', held.id, externalId)
      return await updateHeld(trx, held, row, startAt, idWritten)
    }
  }

  const season = resolveSeason(context, row, startAt)
  mustMaySchedule(context, season.id, season.name)
  const opponentId =
    row.opponent == null
      ? undefined
      : await resolveRowOpponent(trx, context, season.id, row, known)

  if (externalId != null && opponentId != null) {
    // The other team of the game may have scheduled it already, under its
    // own id: the same two teams, the same season, the same moment.
    const twin = await trx
      .selectFrom('games')
      .select([
        'id',
        'home_team_id',
        'away_team_id',
        'season_id',
        'start_at',
        'venue',
        'status',
        'fence_distance_ft'
      ])
      .where('season_id', '=', season.id)
      .where('start_at', '=', startAt)
      .where(eb =>
        eb.or([
          eb.and([
            eb('home_team_id', '=', teamId),
            eb('away_team_id', '=', opponentId)
          ]),
          eb.and([
            eb('home_team_id', '=', opponentId),
            eb('away_team_id', '=', teamId)
          ])
        ])
      )
      .orderBy('created_at')
      .executeTakeFirst()
    if (twin != null) {
      await recordExternalId(trx, 'game', twin.id, externalId)
      if (twin.status === 'inProgress' || twin.status === 'final') {
        return { result: 'updated', gameId: twin.id, status: twin.status }
      }
      return await updateHeld(trx, twin, row, startAt, true)
    }
  }

  if (opponentId == null || row.side == null) {
    throw new RowError(
      'invalid',
      'opponent and side are needed to create a game'
    )
  }
  const gameId = makeId('game')
  const status = row.status ?? 'scheduled'
  await trx
    .insertInto('games')
    .values({
      id: gameId,
      home_team_id: row.side === 'home' ? teamId : opponentId,
      away_team_id: row.side === 'home' ? opponentId : teamId,
      season_id: season.id,
      start_at: startAt,
      venue: row.venue ?? null,
      status,
      fence_distance_ft: row.fenceDistanceFt ?? null
    })
    .execute()
  if (externalId != null)
    await recordExternalId(trx, 'game', gameId, externalId)
  return { result: 'created', gameId, status }
}

function mustMaySchedule(
  context: Context,
  seasonId: string | null,
  seasonName?: string
): void {
  if (mayScheduleIn(context.rights, context.teamId, seasonId)) return
  const name =
    seasonName ??
    context.seasons.find(season => season.id === seasonId)?.name ??
    'its season'
  throw new RowError(
    'forbidden',
    `Only an admin of this team or of ${name} may schedule games in it`
  )
}

/**
 * Moves, cancels or restores a scheduled or cancelled game, or resizes its
 * field while it has no plays. Its teams, season and scores are never
 * touched, and a venue or fence the row does not give is kept.
 */
async function updateHeld(
  trx: Transaction<Database>,
  held: HeldGame,
  row: ScheduleGameRow,
  startAt: Date,
  alreadyWritten: boolean
): Promise<Applied> {
  // A post may be storing the game's first plays: wait for it, read the game
  // as it left it, then its plays in a statement of their own.
  const locked = await trx
    .selectFrom('games')
    .select(['start_at', 'venue', 'status', 'fence_distance_ft'])
    .where('id', '=', held.id)
    .forUpdate()
    .executeTakeFirstOrThrow()
  const game = { ...held, ...locked }
  if (game.status === 'inProgress' || game.status === 'final') {
    return {
      result: alreadyWritten ? 'updated' : 'unchanged',
      gameId: held.id,
      status: game.status
    }
  }
  const played = await gameHasPlays(trx, held.id)
  const changes: {
    start_at?: Date
    venue?: string
    status?: 'scheduled' | 'cancelled'
    fence_distance_ft?: number
  } = {}
  if (new Date(game.start_at).getTime() !== startAt.getTime()) {
    changes.start_at = startAt
  }
  if (row.venue != null && row.venue !== game.venue) changes.venue = row.venue
  if (row.status != null && row.status !== game.status) {
    changes.status = row.status
  }
  if (
    row.fenceDistanceFt != null &&
    row.fenceDistanceFt !== game.fence_distance_ft &&
    !played
  ) {
    changes.fence_distance_ft = row.fenceDistanceFt
  }
  if (Object.keys(changes).length > 0) {
    await trx
      .updateTable('games')
      .set({ ...changes, updated_at: new Date() })
      .where('id', '=', held.id)
      .execute()
  }
  const written = alreadyWritten || Object.keys(changes).length > 0
  return {
    result: written ? 'updated' : 'unchanged',
    gameId: held.id,
    status: changes.status ?? game.status
  }
}

/**
 * The season a row lands in: the one it names, else the team's season whose
 * dates hold the game's day (the latest to start, when several do), else the
 * team's season of that year. A team is never enrolled in a season here.
 */
function resolveSeason(
  context: Context,
  row: ScheduleGameRow,
  startAt: Date
): TeamSeason {
  if (row.seasonId != null) {
    const named = context.seasons.find(season => season.id === row.seasonId)
    if (named == null) {
      throw new RowError(
        'notFound',
        `${context.teamName} plays in no season ${row.seasonId}`
      )
    }
    return named
  }
  // Wall-clock calendar day from the request (`YYYY-MM-DD…`), not UTC — an
  // evening game on 2026-08-31 in -07:00 must still match a season ending that day.
  const day = row.startAt.slice(0, 10)
  const latestFirst = (a: TeamSeason, b: TeamSeason): number =>
    (b.startsOn ?? '').localeCompare(a.startsOn ?? '')
  const holding = context.seasons
    .filter(
      season =>
        season.startsOn != null &&
        season.endsOn != null &&
        season.startsOn <= day &&
        day <= season.endsOn
    )
    .sort(latestFirst)
  if (holding.length > 0) return holding[0]

  const year = Number(day.slice(0, 4))
  const ofYear = context.seasons
    .filter(season => season.year === year)
    .sort(latestFirst)
  if (ofYear.length > 0) return ofYear[0]
  throw new RowError(
    'noSeason',
    `${context.teamName} has no season in ${year}: send seasonId`
  )
}

async function resolveRowOpponent(
  trx: Transaction<Database>,
  context: Context,
  seasonId: string,
  row: ScheduleGameRow,
  known: Map<string, string>
): Promise<string> {
  const opponent = row.opponent
  if (opponent == null) throw new Error('unreachable: no opponent')
  const { teamId } = context

  if ('teamId' in opponent) {
    const found = await trx
      .selectFrom('teams')
      .select(['id', 'merged_into'])
      .where('id', '=', opponent.teamId)
      .executeTakeFirst()
    if (found == null) {
      throw new RowError('notFound', `No team ${opponent.teamId}`)
    }
    if (found.id === teamId) {
      throw new RowError('conflict', 'A team cannot play itself')
    }
    if (found.merged_into != null) {
      throw new RowError(
        'conflict',
        `Team ${found.id} was merged into ${found.merged_into}`
      )
    }
    return found.id
  }

  // A team holding the opponent's id is that opponent, whatever the row
  // calls it. An id held by anything else is left where it is.
  const key = opponent.externalId
  const holder = key == null ? undefined : await idHolder(trx, key)
  if (key != null && holder?.free === false && holder.teamId != null) {
    const id = await followMerges(trx, holder.teamId)
    if (id === teamId) {
      throw new RowError(
        'conflict',
        `${key.system} ${key.id} is ${context.teamName} itself`
      )
    }
    return id
  }

  const resolved = await resolveOpponent(trx, opponent.name, {
    seasonTeams: await seasonTeamsOf(trx, seasonId),
    known,
    createdFrom: 'api'
  })
  const id = await followMerges(trx, resolved.id)
  if (id === teamId) {
    throw new RowError(
      'conflict',
      `${opponent.name} is ${context.teamName} itself`
    )
  }
  if (key != null && holder?.free === true) {
    await recordOnExternalTeam(trx, id, key, holder)
  }
  return id
}

/** The teams of a season, by id and stored name. */
async function seasonTeamsOf(
  trx: Transaction<Database>,
  seasonId: string | null
): Promise<Array<{ id: string; name: string }>> {
  if (seasonId == null) return []
  return await trx
    .selectFrom('season_teams')
    .innerJoin('teams', 'teams.id', 'season_teams.team_id')
    .select(['teams.id as id', 'teams.name as name'])
    .where('season_teams.season_id', '=', seasonId)
    .execute()
}

/**
 * Whether `name` finds `teamId` by the rule a new game's opponent is found
 * by — a team of the season by name or coach, else an external team by
 * name — without making a team when it finds none.
 */
async function nameFinds(
  trx: Transaction<Database>,
  name: string,
  seasonId: string | null,
  teamId: string
): Promise<boolean> {
  const resolved = await resolveOpponent(trx, name, {
    seasonTeams: await seasonTeamsOf(trx, seasonId),
    createdFrom: 'api',
    dryRun: true
  })
  if (resolved.found === 'created') return false
  return (await followMerges(trx, resolved.id)) === teamId
}

/** The id a row gives for its opponent, when it names one by name. */
function opponentExternalId(row: ScheduleGameRow): ExternalIdKey | undefined {
  const opponent = row.opponent
  if (opponent == null || !('name' in opponent)) return undefined
  return opponent.externalId
}

/**
 * What holds an external id. `free` when nothing does, or when only an
 * orphan does: a row naming a team that no longer exists, which names
 * nothing and so is taken over, as `createTeam` takes one over. Otherwise
 * the team holding it, or, held by something other than a team, nothing
 * more.
 */
type IdHolder =
  { free: true; orphanId?: string } | { free: false; teamId?: string }

async function idHolder(
  trx: Transaction<Database>,
  key: ExternalIdKey
): Promise<IdHolder> {
  const held = await trx
    .selectFrom('external_ids')
    .leftJoin('teams', join =>
      join
        .onRef('teams.id', '=', 'external_ids.entity_id')
        .on('external_ids.entity_type', '=', 'team')
    )
    .select([
      'external_ids.id as rowId',
      'external_ids.entity_type as entityType',
      'teams.id as teamId'
    ])
    .where('external_ids.system', '=', key.system)
    .where('external_ids.kind', '=', key.kind)
    .where('external_ids.external_id', '=', key.id)
    .executeTakeFirst()
  if (held == null) return { free: true }
  if (held.teamId != null) return { free: false, teamId: held.teamId }
  if (held.entityType === 'team') return { free: true, orphanId: held.rowId }
  return { free: false }
}

/**
 * Records an opponent's id on its team when that team is external, taking
 * over an orphaned row of it rather than adding one. A full team's ids are
 * its own admins' to give, never a schedule's. The caller has locked the id
 * and found it free.
 */
async function recordOnExternalTeam(
  trx: Transaction<Database>,
  teamId: string,
  key: ExternalIdKey,
  holder: { orphanId?: string }
): Promise<void> {
  if (await isExternal(trx, teamId)) await takeId(trx, teamId, key, holder)
}

/** Whether a team is an external one, from outside every season. */
async function isExternal(
  trx: Transaction<Database>,
  teamId: string
): Promise<boolean> {
  const team = await trx
    .selectFrom('teams')
    .select(['kind'])
    .where('id', '=', teamId)
    .executeTakeFirst()
  return team?.kind === 'external'
}

/**
 * Records a free id on a team the caller has found external, taking over
 * the orphaned row of it when there is one.
 */
async function takeId(
  trx: Transaction<Database>,
  teamId: string,
  key: ExternalIdKey,
  holder: { orphanId?: string }
): Promise<void> {
  if (holder.orphanId == null) {
    await recordExternalId(trx, 'team', teamId, key)
    return
  }
  await trx
    .updateTable('external_ids')
    .set({ entity_id: teamId })
    .where('id', '=', holder.orphanId)
    .execute()
}
