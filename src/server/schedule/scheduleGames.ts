import { type Kysely, sql, type Transaction } from 'kysely'

import { HttpError } from '../../common/errors'
import type { GameIntent } from '../../common/gameApprovals'
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
import type { Actor } from '../auth/sessions'
import { lockKeys } from '../db/advisoryLocks'
import { atomic } from '../db/atomic'
import type { Database } from '../db/database'
import {
  type ExternalIdKey,
  externalIdLockKey,
  recordExternalId
} from '../db/externalIds'
import { gameHasPlays } from '../games/fenceDistance'
import { scoredInTeamStation } from '../games/opponentFixed'
import { currentActor, requireGroupAdmin } from '../groups/rights'
import { notifyGameChange } from '../socket/gameChanges'
import { noteGameFigures, noteScopeChange } from '../socket/syncRevision'
import { requestGameStats } from '../statsBuilder/request'
import { followMerges } from '../teams/followMerges'
import { resolveOpponent } from '../teams/resolveOpponent'
import { isUndeterminedName, teamNameKey } from '../teams/teamNames'
import { recheckUmpireAssignments } from '../umpires/assignments'
import { refreshFieldWarnings } from '../venues/fieldWarnings'
import { materialGame, requireImmediateGameConsent } from './gameApprovals'

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
  userId: string,
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
  exhibition: boolean
  timezone: string
}

interface Context {
  teamId: string
  teamName: string
  seasons: TeamSeason[]
  rights: ScheduleRights
  actor: Actor
  previous?: GameIntent
  withdrawn?: boolean
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
  options: {
    teamId: string
    rows: unknown[]
    actor?: Actor
    rights?: ScheduleRights
  }
): Promise<ScheduleGamesResponse> {
  const { teamId } = options
  const team = await db
    .selectFrom('teams')
    .select(['id', 'name'])
    .where('id', '=', teamId)
    .executeTakeFirstOrThrow()
  const context: Omit<Context, 'actor'> = {
    teamId,
    teamName: team.name,
    seasons: [],
    rights: { siteAdmin: false, teamAdminIds: new Set(), seasonIds: new Set() }
  }

  // Opponent name key to team id, for the whole call. A team a row
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
      // The row's game, and a renamed opponent, are announced as this
      // transaction's last statements.
      const applied = await atomic(db, async trx => {
        // This is also the service boundary for importers. Precomputed rights
        // cannot authorize publication or outlive an unlink or role revocation.
        await lockKeys(trx, ['creation:parent-graph'])
        if (options.actor == null)
          throw new RowError('forbidden', 'Sign in to schedule games')
        const actor = await currentActor(trx, options.actor)
        await requireGroupAdmin(trx, actor, { kind: 'team', id: teamId })
        const scopes = await adminScopes(trx, actor.userId, actor.isAdmin)
        const fresh: Context = {
          ...context,
          actor,
          seasons: await trx
            .selectFrom('season_teams')
            .innerJoin('seasons', 'seasons.id', 'season_teams.season_id')
            .select([
              'seasons.id as id',
              'seasons.name as name',
              'seasons.year as year',
              sql<string | null>`to_char(seasons.starts_on, 'YYYY-MM-DD')`.as(
                'startsOn'
              ),
              sql<string | null>`to_char(seasons.ends_on, 'YYYY-MM-DD')`.as(
                'endsOn'
              )
            ])
            .where('season_teams.team_id', '=', teamId)
            .where('season_teams.active', '=', true)
            .execute(),
          rights: {
            siteAdmin: scopes.isAdmin,
            teamAdminIds: scopes.teamIds,
            seasonIds: scopes.seasonIds
          }
        }
        if (
          row.seasonId != null &&
          !fresh.seasons.some(s => s.id === row.seasonId)
        ) {
          const named = await trx
            .selectFrom('seasons')
            .select([
              'id',
              'name',
              'year',
              sql<string | null>`to_char(starts_on, 'YYYY-MM-DD')`.as(
                'startsOn'
              ),
              sql<string | null>`to_char(ends_on, 'YYYY-MM-DD')`.as('endsOn')
            ])
            .where('id', '=', row.seasonId)
            .executeTakeFirst()
          if (named != null) fresh.seasons = [...fresh.seasons, named]
        }
        const applied = await applyRow(trx, fresh, row, rowKnown)
        if (applied.result !== 'unchanged') {
          await requirePublicationReady(trx)
          if (fresh.withdrawn === true)
            throw new RowError('conflict', 'A withdrawn game cannot be revised')
          const game = await trx
            .selectFrom('games')
            .selectAll()
            .where('id', '=', applied.gameId)
            .executeTakeFirstOrThrow()
          await requireImmediateGameConsent(
            trx,
            actor,
            fresh.previous == null
              ? [materialGame(game)]
              : [fresh.previous, materialGame(game)]
          )
          await recheckUmpireAssignments(trx, applied.gameId)
          await trx
            .insertInto('audit_log')
            .values({
              id: makeId('audit'),
              actor_user_id: actor.userId,
              api_token_id: null,
              method: 'BATCH',
              path: '/teams/:teamId/games',
              entity_type: 'game',
              entity_id: game.id,
              before: fresh.previous == null ? null : { ...fresh.previous },
              after: {
                ...materialGame(game),
                approval: 'Both participants approved by current administrator'
              }
            })
            .execute()
        }
        return applied
      })
      for (const [name, id] of rowKnown) known.set(name, id)
      results.push({ index, ...applied })
      counts[applied.result] += 1
    } catch (error) {
      results.push(
        error instanceof RowError
          ? errorResult(index, error.code, error.message)
          : error instanceof HttpError
            ? errorResult(
                index,
                error.code === 'forbidden' || error.code === 'unauthorized'
                  ? 'forbidden'
                  : error.code === 'conflict'
                    ? 'conflict'
                    : 'invalid',
                error.message
              )
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

async function requirePublicationReady(db: Kysely<Database>): Promise<void> {
  const ready = await db
    .selectFrom('system_settings')
    .select('value')
    .where('key', '=', 'creation.hierarchyReady')
    .executeTakeFirst()
  if (ready?.value !== true)
    throw new RowError(
      'forbidden',
      'Finish organization setup before publishing schedule changes'
    )
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
      .select([
        'games.outside_tournament',
        'games.cancellation_reason',
        'games.exhibition',
        'games.timezone'
      ])
      .where('external_ids.entity_type', '=', 'game')
      .where('external_ids.system', '=', externalId.system)
      .where('external_ids.external_id', '=', externalId.id)
      .executeTakeFirst()
    if (held != null) {
      context.withdrawn =
        held.cancellation_reason === 'withdrawal' ||
        held.cancellation_reason === 'replacement'
      context.previous = {
        homeTeamId: held.home_team_id,
        awayTeamId: held.away_team_id,
        seasonId: held.season_id,
        startAt: held.start_at.toISOString(),
        venue: held.venue,
        outsideTournament: held.outside_tournament,
        exhibition: held.exhibition,
        timezone: held.timezone,
        status: held.status === 'cancelled' ? 'cancelled' : 'scheduled'
      }
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
        !('name' in row.opponent && isUndeterminedName(row.opponent.name))
      ) {
        // Only when the row finds the game's own opponent — by its id, or by
        // a name that finds it: a game held against a placeholder or a
        // since-corrected opponent must not hand that team the real
        // opponent's id. Asked before the opponent can change, so a game
        // TeamStation scored records it too.
        const holder = await idHolder(trx, opponentKey)
        const opponent = await followMerges(
          trx,
          held.home_team_id === teamId ? held.away_team_id : held.home_team_id
        )
        if (
          holder.free &&
          (await isExternal(trx, opponent)) &&
          ('name' in row.opponent
            ? await nameFinds(trx, row.opponent.name, held.season_id, opponent)
            : row.opponent.teamId === opponent &&
              !(await isPlaceholderTeam(trx, opponent)))
        ) {
          // Opponent ID enrichment can leave the game itself unchanged, but
          // still writes identity data and cannot use pre-cutover authority.
          await requirePublicationReady(trx)
          await requireImmediateGameConsent(trx, context.actor, [
            context.previous
          ])
          await takeId(trx, opponent, opponentKey, holder, context.actor)
        }
      }
      // Whatever its status: a game imported against a placeholder gets its
      // real opponent once the schedule knows it, plays and score and all.
      const opponentChanged = await changeOpponent(
        trx,
        context,
        held,
        row,
        startAt,
        known
      )
      if (held.status === 'inProgress' || held.status === 'final') {
        return {
          result: opponentChanged ? 'updated' : 'unchanged',
          gameId: held.id,
          status: held.status
        }
      }
      const idWritten = await recordExternalId(trx, 'game', held.id, externalId)
      return await updateHeld(
        trx,
        held,
        row,
        startAt,
        idWritten || opponentChanged,
        teamId
      )
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
        'fence_distance_ft',
        'exhibition',
        'timezone'
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
      const original = await trx
        .selectFrom('games')
        .selectAll()
        .where('id', '=', twin.id)
        .executeTakeFirstOrThrow()
      context.previous = materialGame(original)
      context.withdrawn =
        original.cancellation_reason === 'withdrawal' ||
        original.cancellation_reason === 'replacement'
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
      fence_distance_ft: row.fenceDistanceFt ?? null,
      exhibition: row.exhibition ?? false,
      timezone:
        row.timezone ??
        (
          await trx
            .selectFrom('seasons')
            .select('timezone')
            .where('id', '=', season.id)
            .executeTakeFirst()
        )?.timezone ??
        'UTC'
    })
    .execute()
  if (externalId != null)
    await recordExternalId(trx, 'game', gameId, externalId)
  // A new game on its season's row and its teams' lists.
  await noteGameFigures(trx, gameId)
  return { result: 'created', gameId, status }
}

function mustMaySchedule(
  context: Context,
  seasonId: string | null,
  seasonName?: string
): void {
  if (
    context.rights.siteAdmin ||
    context.rights.teamAdminIds.has(context.teamId)
  )
    return
  const name =
    seasonName ??
    context.seasons.find(season => season.id === seasonId)?.name ??
    'its season'
  throw new RowError(
    'forbidden',
    `Only an admin of ${name} may add games to its schedule`
  )
}

/**
 * Moves, cancels or restores a scheduled or cancelled game, or resizes its
 * field while it has no plays. A venue or fence the row does not give is
 * kept, and its season never changes.
 *
 * `sidesFor` is the team whose row the game's own id matched: when the row
 * puts that team on the other side, the other team is external and the game
 * has no plays — none stored and none under way — its home and away teams,
 * and their scores, swap. Between two full teams each schedules the game
 * under its own id and may claim the same side, so neither row moves it.
 * Otherwise its teams and scores are never touched.
 */
async function updateHeld(
  trx: Transaction<Database>,
  held: HeldGame,
  row: ScheduleGameRow,
  startAt: Date,
  alreadyWritten: boolean,
  sidesFor?: string
): Promise<Applied> {
  // A post may be storing the game's first plays: wait for it, read the game
  // as it left it, then its plays in a statement of their own.
  const locked = await trx
    .selectFrom('games')
    .select([
      'home_team_id',
      'away_team_id',
      'home_score',
      'away_score',
      'currentPlay',
      'start_at',
      'end_at',
      'venue',
      'status',
      'cancellation_reason',
      'fence_distance_ft',
      'exhibition',
      'timezone',
      'field_id'
    ])
    .where('id', '=', held.id)
    .forUpdate()
    .executeTakeFirstOrThrow()
  const game = { ...held, ...locked }
  if (
    (game.cancellation_reason === 'withdrawal' ||
      game.cancellation_reason === 'replacement') &&
    row.status === 'scheduled'
  )
    throw new RowError('conflict', 'A withdrawn game cannot be restored')
  if (game.status === 'inProgress' || game.status === 'final') {
    return {
      result: alreadyWritten ? 'updated' : 'unchanged',
      gameId: held.id,
      status: game.status
    }
  }
  const played = await gameHasPlays(trx, held.id)
  const changes: {
    home_team_id?: string
    away_team_id?: string
    home_score?: number | null
    away_score?: number | null
    start_at?: Date
    end_at?: Date
    venue?: string
    status?: 'scheduled' | 'cancelled'
    fence_distance_ft?: number
    exhibition?: boolean
    timezone?: string
  } = {}
  if (
    sidesFor != null &&
    row.side != null &&
    (game.home_team_id === sidesFor) !== (row.side === 'home') &&
    !played &&
    game.currentPlay == null &&
    (await isExternal(
      trx,
      game.home_team_id === sidesFor ? game.away_team_id : game.home_team_id
    ))
  ) {
    changes.home_team_id = game.away_team_id
    changes.away_team_id = game.home_team_id
    changes.home_score = game.away_score
    changes.away_score = game.home_score
  }
  if (new Date(game.start_at).getTime() !== startAt.getTime()) {
    changes.start_at = startAt
    if (game.end_at != null)
      changes.end_at = new Date(
        game.end_at.getTime() + startAt.getTime() - game.start_at.getTime()
      )
  }
  if (row.venue != null && row.venue !== game.venue) {
    // A game on a registry field takes its venue from the field.
    if (game.field_id != null)
      throw new RowError(
        'conflict',
        "Clear the field in the game's settings to change the venue"
      )
    changes.venue = row.venue
  }
  if (row.exhibition != null && row.exhibition !== game.exhibition)
    changes.exhibition = row.exhibition
  if (row.timezone != null && row.timezone !== game.timezone)
    changes.timezone = row.timezone
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
    if (
      game.field_id != null &&
      (changes.start_at != null || changes.status != null)
    )
      await refreshFieldWarnings(trx, [game.field_id], undefined, [held.id])
    // A screen holding the game open, a scorer's among them, learns of it
    // when this commits: above all of a swap, or it credits the wrong side.
    await notifyGameChange(trx, { game: held.id, kind: 'game' })
    // A score, a status or a side changed moves its teams' records.
    await noteGameFigures(trx, held.id)
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
 * dates hold the game's day, else its season of that year. Inference requires
 * exactly one eligible season; an overlap is resolved explicitly by the caller.
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
  const holding = context.seasons
    .filter(
      season =>
        season.startsOn != null &&
        season.endsOn != null &&
        season.startsOn <= day &&
        day <= season.endsOn
    )
    .filter(
      season =>
        context.rights.siteAdmin ||
        context.rights.teamAdminIds.has(context.teamId)
    )
  if (holding.length === 1) return holding[0]
  if (holding.length > 1)
    throw new RowError(
      'noSeason',
      'Several seasons match this date: send seasonId'
    )

  const year = Number(day.slice(0, 4))
  const ofYear = context.seasons.filter(
    season =>
      season.year === year &&
      (context.rights.siteAdmin ||
        context.rights.teamAdminIds.has(context.teamId))
  )
  if (ofYear.length === 1) return ofYear[0]
  if (ofYear.length > 1)
    throw new RowError(
      'noSeason',
      'Several seasons match this year: send seasonId'
    )
  throw new RowError(
    'noSeason',
    `${context.teamName} has no season in ${year}: send seasonId`
  )
}

/**
 * Gives a held game the opponent its row now names, and says whether it
 * wrote anything. Only an external opponent changes: a full team's game
 * belongs to an organisation, and the row is answered by its other fields.
 * So is a row whose name says the opponent is not known yet
 * (`isUndeterminedName`): it never moves or renames the game's opponent.
 *
 * The row's opponent is found by its id, then by its name, exactly
 * (`resolveRowOpponent`). When that is the game's own opponent nothing
 * moves, except that an id the opponent holds renames it to a name that
 * reads differently: the same team under its real name, in every game it
 * plays. It is not renamed when its
 * id does not stand for the row's name (`idStandsForName`); the game moves
 * to the team the name finds instead. A name that is the scheduling team's
 * own leaves the opponent as it is, and so does a game TeamStation scored,
 * whose plays replay against the teams they were scored between: the row
 * is answered by its other fields. Any other team takes the game's place
 * for the opponent (`repointOpponent`), unless it is a full team that
 * already has the game; a team found by the row's id also takes its name.
 */
async function changeOpponent(
  trx: Transaction<Database>,
  context: Context,
  held: HeldGame,
  row: ScheduleGameRow,
  startAt: Date,
  known: Map<string, string>
): Promise<boolean> {
  const { teamId } = context
  const opponent = row.opponent
  if (opponent == null) return false
  if ('name' in opponent && isUndeterminedName(opponent.name)) return false
  if (
    'name' in opponent &&
    teamNameKey(opponent.name) === teamNameKey(context.teamName)
  ) {
    return false
  }
  // A play being posted, a swap or a merge waits for this row, and this
  // row for them; the game's teams are read as they leave them.
  const game = await trx
    .selectFrom('games')
    .select(['id', 'home_team_id', 'away_team_id', 'start_at'])
    .where('id', '=', held.id)
    .forUpdate()
    .executeTakeFirstOrThrow()
  const storedOpponent =
    game.home_team_id === teamId ? game.away_team_id : game.home_team_id
  const opponentId = await followMerges(trx, storedOpponent)
  const current = await trx
    .selectFrom('teams')
    .select(['name', 'kind'])
    .where('id', '=', opponentId)
    .executeTakeFirstOrThrow()
  if (current.kind !== 'external') return false

  let byName = false
  let holderTeam: string | undefined
  if ('name' in opponent) {
    const key = opponent.externalId
    const holder = key == null ? undefined : await idHolder(trx, key)
    holderTeam =
      holder?.free === false && holder.teamId != null
        ? await followMerges(trx, holder.teamId)
        : undefined
    const sameName = teamNameKey(opponent.name) === teamNameKey(current.name)
    if (holderTeam === opponentId) {
      if (sameName) return false
      if (
        await idStandsForName(trx, opponentId, opponent.name, {
          teamId,
          seasonId: held.season_id
        })
      ) {
        await renameExternal(trx, opponentId, opponent.name, context.actor)
        return true
      }
      byName = true
    } else if (sameName) {
      // The same name is the same opponent, whichever team of that name a
      // search would come to first, and whichever team holds the row's id:
      // a game moved off a shared team keeps the team its name found.
      return false
    }
  }

  // Its plays replay against the teams they were scored between: the
  // opponent stays, and the row is answered by its other fields. Asked
  // before the row's opponent is found, so no team is made for nothing.
  if ((await scoredInTeamStation(trx, [game.id])).has(game.id)) return false
  const named = await resolveRowOpponent(
    trx,
    context,
    held.season_id,
    row,
    known,
    { byName }
  )
  if (named === opponentId) return false
  // This legacy identity correction is atomic and audited by the batch
  // bridge only when the actor represents every old/new team and host.
  if (!(await isExternal(trx, named))) {
    await mustHaveNoTwin(trx, context, held.season_id, named, game.id, [
      new Date(game.start_at),
      startAt
    ])
  }
  await repointOpponent(trx, game, storedOpponent, named)
  // The team holding the row's id stood for its name: it takes the name now,
  // as it would have had the game been on it already.
  if (
    'name' in opponent &&
    named === holderTeam &&
    !(await isNamed(trx, named, opponent.name))
  ) {
    await renameExternal(trx, named, opponent.name, context.actor)
  }
  return true
}

/** Whether a team's name is this one, by `teamNameKey`. */
async function isNamed(
  trx: Transaction<Database>,
  teamId: string,
  name: string
): Promise<boolean> {
  const team = await trx
    .selectFrom('teams')
    .select('name')
    .where('id', '=', teamId)
    .executeTakeFirstOrThrow()
  return teamNameKey(team.name) === teamNameKey(name)
}

/**
 * Whether a team plays any game the scheduling team does not: then other
 * schedules share it, and one schedule's name for it is not everybody's.
 */
async function playsOthers(
  trx: Transaction<Database>,
  externalTeamId: string,
  teamId: string
): Promise<boolean> {
  const other = await trx
    .selectFrom('games')
    .select('id')
    .where(eb =>
      eb.and([
        eb.or([
          eb('home_team_id', '=', externalTeamId),
          eb('away_team_id', '=', externalTeamId)
        ]),
        eb('home_team_id', '!=', teamId),
        eb('away_team_id', '!=', teamId)
      ])
    )
    .limit(1)
    .executeTakeFirst()
  return other != null
}

/**
 * Whether the external team holding a row's opponent id is the opponent the
 * row names. A full team always is, and so is any team of the same name. Otherwise not a placeholder, which an id should never
 * have been given, nor a team other teams' games share, for which one
 * schedule's id and name are not everybody's, nor one whose new name
 * already finds another team: it takes that name, in every game it plays,
 * only when no second team of that name would follow. A held game and a
 * new one ask the same, so a row lands where a second press leaves it.
 */
async function idStandsForName(
  trx: Transaction<Database>,
  holderId: string,
  name: string,
  scheduling: { teamId: string; seasonId: string | null }
): Promise<boolean> {
  const holder = await trx
    .selectFrom('teams')
    .select(['name', 'kind'])
    .where('id', '=', holderId)
    .executeTakeFirstOrThrow()
  if (holder.kind !== 'external') return true
  if (teamNameKey(holder.name) === teamNameKey(name)) return true
  if (isUndeterminedName(holder.name)) return false
  if (await playsOthers(trx, holderId, scheduling.teamId)) return false
  return !(await nameFindsATeam(trx, name, scheduling.seasonId))
}

/**
 * Whether a name finds a team already — a team of the season, or an external
 * team: then a team renamed to it would be a second team of one name.
 */
async function nameFindsATeam(
  trx: Transaction<Database>,
  name: string,
  seasonId: string | null
): Promise<boolean> {
  const resolved = await resolveOpponent(trx, name, {
    seasonTeams: await seasonTeamsOf(trx, seasonId),
    createdFrom: 'api',
    dryRun: true
  })
  return resolved.found !== 'created'
}

/**
 * Renames an external team, and tells every screen holding one of its games,
 * when this commits.
 */
async function renameExternal(
  trx: Transaction<Database>,
  externalTeamId: string,
  name: string,
  actor: Actor
): Promise<void> {
  if (!(await isExternal(trx, externalTeamId))) return
  await requireGroupAdmin(trx, actor, { kind: 'team', id: externalTeamId })
  await trx
    .updateTable('teams')
    .set({ name, updated_at: new Date() })
    .where('id', '=', externalTeamId)
    .execute()
  const games = await trx
    .selectFrom('games')
    .select('id')
    .where(eb =>
      eb.or([
        eb('home_team_id', '=', externalTeamId),
        eb('away_team_id', '=', externalTeamId)
      ])
    )
    .orderBy('id')
    .execute()
  noteScopeChange(trx, { teamId: externalTeamId })
  for (const { id } of games) {
    await notifyGameChange(trx, { game: id, kind: 'game' })
    noteScopeChange(trx, { gameId: id })
  }
}

/**
 * Refuses to move a game onto a full team that already plays the scheduling
 * team in the same season at either moment the game has — its own, or the
 * row's — as the twin a new game would land on: two rows of one game would
 * both count, and a full team's game never moves back.
 */
async function mustHaveNoTwin(
  trx: Transaction<Database>,
  context: Context,
  seasonId: string | null,
  fullTeamId: string,
  gameId: string,
  moments: Date[]
): Promise<void> {
  const { teamId } = context
  const twin = await trx
    .selectFrom('games')
    .select('id')
    .where('id', '!=', gameId)
    .where('season_id', seasonId == null ? 'is' : '=', seasonId)
    .where('start_at', 'in', moments)
    .where(eb =>
      eb.or([
        eb.and([
          eb('home_team_id', '=', teamId),
          eb('away_team_id', '=', fullTeamId)
        ]),
        eb.and([
          eb('home_team_id', '=', fullTeamId),
          eb('away_team_id', '=', teamId)
        ])
      ])
    )
    .limit(1)
    .executeTakeFirst()
  if (twin == null) return
  const team = await trx
    .selectFrom('teams')
    .select('name')
    .where('id', '=', fullTeamId)
    .executeTakeFirstOrThrow()
  throw new RowError('conflict', `${team.name} already has this game`)
}

/**
 * Moves a game from one opponent to another, with everything of that game
 * that names the old one, in the order a team merge moves them: the game
 * first, so the `events` trigger rebuilds each play's batter, runner and
 * pitcher rows against the new teams; then the batting side, the fielder,
 * catcher and scorer rows the trigger leaves alone, the credits in each
 * play's document (and through the trigger `eventCredits`), and a camera
 * key filming that side. The stats builder is asked to rebuild the game's
 * lines, and every screen holding it hears of the change on commit.
 *
 * Scores, sides and the linescore are the game's, keyed by home and away,
 * and stay. A team's record is counted from its games on each read. A
 * video's title keeps the name it was given, and the old team stays, games
 * or none. The caller holds the game row's lock.
 */
async function repointOpponent(
  trx: Transaction<Database>,
  game: { id: string; home_team_id: string; away_team_id: string },
  oldTeamId: string,
  newTeamId: string
): Promise<void> {
  await trx
    .updateTable('games')
    .set(
      game.home_team_id === oldTeamId
        ? { home_team_id: newTeamId, updated_at: new Date() }
        : { away_team_id: newTeamId, updated_at: new Date() }
    )
    .where('id', '=', game.id)
    .execute()
  await trx
    .updateTable('events')
    .set({ battingTeamId: newTeamId })
    .where('gameId', '=', game.id)
    .where('battingTeamId', '=', oldTeamId)
    .execute()
  await trx
    .updateTable('event_players')
    .set({ team_id: newTeamId })
    .where('team_id', '=', oldTeamId)
    .where('event_id', 'in', eb =>
      eb.selectFrom('events').select('id').where('gameId', '=', game.id)
    )
    .execute()
  await sql`
    update events
    set gumbo = jsonb_set(gumbo, '{credits}', (
      select jsonb_agg(
        case when credit ->> 'teamId' = ${oldTeamId}
          then jsonb_set(credit, '{teamId}', to_jsonb(${newTeamId}::text))
          else credit
        end
        order by position
      )
      from jsonb_array_elements(gumbo -> 'credits')
        with ordinality as listed (credit, position)
    ))
    where "gameId" = ${game.id}
      and jsonb_typeof(gumbo -> 'credits') = 'array'
      and exists (
        select 1 from jsonb_array_elements(gumbo -> 'credits') as listed (credit)
        where credit ->> 'teamId' = ${oldTeamId}
      )
  `.execute(trx)
  await trx
    .updateTable('live_streams')
    .set({ team_id: newTeamId })
    .where('game_id', '=', game.id)
    .where('team_id', '=', oldTeamId)
    .execute()
  await requestGameStats(trx, game.id)
  for (const kind of ['game', 'lineups', 'plays'] as const) {
    await notifyGameChange(trx, { game: game.id, kind })
  }
  // The game leaves one team for another: both teams' records move.
  noteScopeChange(trx, { teamId: oldTeamId })
  await noteGameFigures(trx, game.id)
}

/**
 * How a held game's row is resolved. `byName`: the row's id is set aside
 * and the row is found by its name alone.
 */
interface ResolveOptions {
  byName?: boolean
}

async function resolveRowOpponent(
  trx: Transaction<Database>,
  context: Context,
  seasonId: string | null,
  row: ScheduleGameRow,
  known: Map<string, string>,
  options: ResolveOptions = {}
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
    // The opponent's id goes on the team the row names, when nothing holds
    // it; a held id stays where it is.
    // A placeholder names no team, so it takes no team's id.
    const key = opponent.externalId
    if (key != null && !(await isPlaceholderTeam(trx, found.id))) {
      const holder = await idHolder(trx, key)
      if (holder.free)
        await recordOnExternalTeam(trx, found.id, key, holder, context.actor)
    }
    return found.id
  }

  // A team holding the opponent's id is that opponent, whatever the row
  // calls it, unless the id does not stand for the row's name: then the
  // row is found by its name. An id held by anything else is left where
  // it is.
  const key = options.byName === true ? undefined : opponent.externalId
  const holder = key == null ? undefined : await idHolder(trx, key)
  if (key != null && holder?.free === false && holder.teamId != null) {
    const id = await followMerges(trx, holder.teamId)
    if (id === teamId) {
      throw new RowError(
        'conflict',
        `${key.system} ${key.id} is ${context.teamName} itself`
      )
    }
    if (await idStandsForName(trx, id, opponent.name, { teamId, seasonId })) {
      return id
    }
  }

  const resolved = await resolveOpponent(trx, opponent.name, {
    seasonTeams: await seasonTeamsOf(trx, seasonId),
    known,
    createdFrom: 'api'
  })
  const id = await followMerges(trx, resolved.id)
  if (resolved.found === 'created') {
    await trx
      .updateTable('teams')
      .set({
        custodian_type: seasonId == null ? 'team' : 'season',
        custodian_id: seasonId ?? teamId
      })
      .where('id', '=', id)
      .execute()
  }
  if (id === teamId) {
    throw new RowError(
      'conflict',
      `${opponent.name} is ${context.teamName} itself`
    )
  }
  // A placeholder names no team, so it takes no team's id.
  if (
    key != null &&
    holder?.free === true &&
    !isUndeterminedName(opponent.name)
  ) {
    await recordOnExternalTeam(trx, id, key, holder, context.actor)
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
    .where('season_teams.active', '=', true)
    .execute()
}

/**
 * Whether `name` finds `teamId` by the rule a new game's opponent is found
 * by — a team of the season, else an external team, by name — without
 * making a team when it finds none.
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

/** The id a row gives for its opponent, whether it names it or its team. */
function opponentExternalId(row: ScheduleGameRow): ExternalIdKey | undefined {
  return row.opponent?.externalId
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
  holder: { orphanId?: string },
  actor: Actor
): Promise<void> {
  if (await isExternal(trx, teamId))
    await takeId(trx, teamId, key, holder, actor)
}

/** Whether a team's name says the opponent is not known yet. */
async function isPlaceholderTeam(
  trx: Transaction<Database>,
  teamId: string
): Promise<boolean> {
  const team = await trx
    .selectFrom('teams')
    .select('name')
    .where('id', '=', teamId)
    .executeTakeFirstOrThrow()
  return isUndeterminedName(team.name)
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
  holder: { orphanId?: string },
  actor: Actor
): Promise<void> {
  await requireGroupAdmin(trx, actor, { kind: 'team', id: teamId })
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
