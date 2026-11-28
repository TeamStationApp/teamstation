import { createHash } from 'node:crypto'

import {
  type Insertable,
  type Kysely,
  type Selectable,
  sql,
  type Transaction
} from 'kysely'

import {
  badRequest,
  conflict,
  forbidden,
  HttpError,
  notFound
} from '../../common/errors'
import {
  asEventLocationFields,
  type EventLocationFields
} from '../../common/eventInfo'
import {
  asGameTimezone,
  type GameFieldSummary,
  type GameIntent,
  type GameProposal,
  type GameRequestTerms,
  systemCancelled
} from '../../common/gameApprovals'
import type { GroupRef } from '../../common/groupCreation'
import { makeId } from '../../common/ids'
import { namedTeamIds, openSidesOf, wireSideId } from '../../common/openSides'
import {
  type PlaysLost,
  playsLost,
  type SwapEffect
} from '../../common/scoring/playsLost'
import { canScore, roleScopes } from '../access'
import { lockPlayerEdits } from '../admin/people'
import type { Actor } from '../auth/sessions'
import {
  gameNeedsAttention,
  requestNeedsAttention
} from '../autoScheduler/attention'
import { lockKeys } from '../db/advisoryLocks'
import { atomic } from '../db/atomic'
import type {
  Database,
  GamesTable,
  GroupRequestSidesTable,
  GroupRequestsTable,
  NotificationEventsTable
} from '../db/database'
import { nameOnce, readOnce, withRolesRead } from '../db/readOnce'
import { runsOf } from '../db/runs'
import { atBatOf } from '../events/atBatInProgress'
import { playsDigest, readPlays } from '../events/postPlays'
import { hasNamedSides } from '../games/namedSides'
import { gameSwapEffect } from '../games/swapEffect'
import { maySwapSides, SWAP_REFUSED, swapGameSides } from '../games/swapSides'
import {
  approvesSide,
  type Clock,
  realClock,
  recordRequestRecipient,
  relationshipSides,
  requestStatus,
  type StoredRequest
} from '../groups/requests'
import {
  canAdminister,
  canScheduleFor,
  currentActor,
  requireGroupAdmin,
  requireScheduler,
  schedulingRecipients
} from '../groups/rights'
import {
  frozenNamesOf,
  snapshotRequestInformation
} from '../notifications/requestInformation'
import {
  type GameChangePayload,
  notifyGameChange,
  notifyGameChanges
} from '../socket/gameChanges'
import {
  type GameFigureIds,
  noteGameFigures,
  noteScopeChange
} from '../socket/syncRevision'
import { followMerges } from '../teams/followMerges'
import { teamFacts } from '../teams/teamFacts'
import {
  recheckUmpireAssignments,
  umpireRechecker
} from '../umpires/assignments'
import { refreshFieldWarnings } from '../venues/fieldWarnings'
import { seasonGameConsent } from './seasonGameConsent'

type GameRow = Selectable<GamesTable>
/** The batch API cannot represent pending proposals: every affected side must approve now. */
export async function requireImmediateGameConsent(
  db: Kysely<Database>,
  actor: Actor,
  games: GameIntent[]
): Promise<void> {
  const fresh = await currentActor(db, actor)
  const sides = new Map<string, GroupRef>()
  for (const game of games) {
    if (
      game.seasonId != null &&
      !(await canAdminister(db, fresh, { kind: 'season', id: game.seasonId }))
    ) {
      // Name the season, so a batch row says which placement was refused.
      const season = await db
        .selectFrom('seasons')
        .select('name')
        .where('id', '=', game.seasonId)
        .executeTakeFirst()
      throw forbidden(
        `A hosting season administrator of ${season?.name ?? 'its season'} must authorize season placement`
      )
    }
    // An open side has no team to ask.
    if (!(await seasonGameConsent(db, fresh, game)))
      for (const id of namedTeamIds(game.homeTeamId, game.awayTeamId))
        sides.set(`team:${id}`, { kind: 'team', id })
  }
  for (const side of sides.values()) {
    if (!(await canAdminister(db, fresh, side)))
      throw forbidden('Additional approval is required; use game proposals')
  }
}
export function materialGame(game: GameRow): GameIntent {
  return {
    ...storedEventFields(game),
    // `null` for an open side, so the version covers it.
    homeTeamId: game.home_team_id,
    awayTeamId: game.away_team_id,
    seasonId: game.season_id,
    startAt: game.start_at.toISOString(),
    venue: game.venue,
    outsideTournament: game.outside_tournament,
    exhibition: game.exhibition,
    timezone: game.timezone,
    status: game.status === 'cancelled' ? 'cancelled' : 'scheduled',
    // Only a game on a field carries one, so a game without keeps the
    // version it always had.
    ...(game.field_id == null
      ? {}
      : { fieldId: game.field_id, fieldSize: game.field_size })
  }
}
/** A game as an answer gives it: an open side's id is `''` (`wireSideId`). */
export function wireGame(game: GameIntent): GameIntent {
  return {
    ...game,
    homeTeamId: wireSideId(game.homeTeamId),
    awayTeamId: wireSideId(game.awayTeamId)
  }
}
/** A side's team followed through merges; an open side stays open. */
async function followSide(
  db: Kysely<Database>,
  teamId: string | null
): Promise<string | null> {
  return teamId == null ? null : await followMerges(db, teamId)
}
export function gameVersion(game: GameIntent): string {
  return createHash('sha256').update(JSON.stringify(game)).digest('hex')
}
async function gameTimezone(
  db: Kysely<Database>,
  seasonId: string | null
): Promise<string> {
  return seasonId == null
    ? 'UTC'
    : ((
        await db
          .selectFrom('seasons')
          .select('timezone')
          .where('id', '=', seasonId)
          .executeTakeFirst()
      )?.timezone ?? 'UTC')
}
/** Legacy clients did not hash the fields migration 052 initialized. */
async function matchesVersion(
  db: Kysely<Database>,
  current: GameRow,
  expected: string | null | undefined
): Promise<boolean> {
  const material = materialGame(current)
  if (gameVersion(material) === expected) return true
  if (
    current.exhibition ||
    current.timezone !== (await gameTimezone(db, current.season_id))
  )
    return false
  const { exhibition, timezone, ...legacy } = material
  return gameVersion(legacy) === expected
}
/**
 * Takes the shared player-edit lock, before any games row lock as every
 * roster writer does, when these terms exchange an existing game's two
 * teams: the swap rewrites its lineups. The teams are read unlocked; a
 * change to them meanwhile changes the game's version, which refuses the
 * request under the row lock.
 */
async function lockForSwap(
  trx: Transaction<Database>,
  gameId: string | null | undefined,
  game: GameIntent
): Promise<void> {
  if (gameId == null) return
  const teams = await trx
    .selectFrom('games')
    .select(['home_team_id', 'away_team_id'])
    .where('id', '=', gameId)
    .executeTakeFirst()
  if (teams == null) return
  // Compared as the request will be, a merged-away team named as the one it
  // became.
  if (
    teams.home_team_id !== teams.away_team_id &&
    teams.home_team_id === (await followSide(trx, game.awayTeamId)) &&
    teams.away_team_id === (await followSide(trx, game.homeTeamId))
  )
    await lockPlayerEdits(trx)
}
/**
 * Whether a change keeps the game's two teams and exchanges their sides. An
 * open side is a side: a swap exchanges it with the named team. A game with
 * both sides open has nothing to exchange.
 */
function swapsSides(old: GameRow, game: GameIntent): boolean {
  return (
    old.home_team_id !== old.away_team_id &&
    old.home_team_id === game.awayTeamId &&
    old.away_team_id === game.homeTeamId
  )
}

/** The refusal of an edit that would leave a named side open. */
export const SIDE_CLEARED =
  'A side’s team cannot be cleared; withdraw from the game instead'

/** The refusal of a scorekeeper's swap from Game Settings once play began. */
export const SCORER_SWAP_BEGUN =
  'This game has plays. Swap it from the scoring menu, which resets them.'

/**
 * Whether `game` is the stored game with home and away exchanged and
 * nothing else changed: its time, place, field and notes all as they are.
 */
async function onlySidesSwapped(
  db: Kysely<Database>,
  old: GameRow,
  game: GameIntent
): Promise<boolean> {
  if (!swapsSides(old, game)) return false
  const kept: GameIntent = {
    ...materialGame(old),
    homeTeamId: old.away_team_id,
    awayTeamId: old.home_team_id
  }
  const canonical = async (intent: GameIntent): Promise<GameIntent> => ({
    ...(await normalizedIntent(db, intent, old.timezone)),
    fieldId: intent.fieldId ?? null,
    fieldSize: intent.fieldId == null ? null : (intent.fieldSize ?? null)
  })
  return (
    gameVersion(await canonical(game)) === gameVersion(await canonical(kept))
  )
}

/**
 * A proposal that only exchanges an existing game's home and away, sent
 * by a scorekeeper of either team, as an app not yet updated sends Game
 * Settings' swap: applied at once, before any scheduling authority is
 * asked for, and recorded as an accepted request (`scorerSwap`). Refused
 * once the game has begun, whose swap resets its plays from the scoring
 * menu. Undefined for anything else, which is proposed as before.
 */
async function scorerSwap(
  trx: Transaction<Database>,
  fresh: Actor,
  body: GameProposal,
  hash: string,
  clock: Clock
): Promise<StoredRequest | undefined> {
  if (body.gameId == null) return undefined
  const old = await trx
    .selectFrom('games')
    .selectAll()
    .where('id', '=', body.gameId)
    .forUpdate()
    .executeTakeFirst()
  if (old == null || systemCancelled(old.cancellation_reason)) return undefined
  // The game's own time zone: a form sends its device's, which a swap
  // does not change.
  const game: GameIntent = {
    ...body.game,
    ...preservedEventFields(body.game, old),
    homeTeamId: await followSide(trx, body.game.homeTeamId),
    awayTeamId: await followSide(trx, body.game.awayTeamId),
    timezone: old.timezone,
    exhibition: body.game.exhibition ?? old.exhibition,
    ...preservedField(body.game, old)
  }
  if (!(await onlySidesSwapped(trx, old, game))) return undefined
  const roles = await roleScopes(trx, fresh.userId, fresh.isAdmin)
  // Sent for the team the scorekeeper keeps the score of, whatever the body
  // names: nobody else speaks for it here.
  const scoredTeam = namedTeamIds(old.home_team_id, old.away_team_id).find(
    teamId => canScore(roles, teamId)
  )
  if (scoredTeam == null) return undefined
  if (!(await matchesVersion(trx, old, body.expected)))
    throw conflict('Review the current game before changing its schedule')
  if (!(await maySwapSides(trx, old))) throw conflict(SCORER_SWAP_BEGUN)
  const teamIds = namedTeamIds(old.home_team_id, old.away_team_id)
  const terms: GameRequestTerms = {
    kind: 'game',
    game,
    gameId: old.id,
    proposedGameId: old.id,
    replacesGameId: null,
    consentTeamIds: namedTeamIds(game.homeTeamId, game.awayTeamId),
    expected: gameVersion(materialGame(old)),
    previous: materialGame(old),
    affectedTeamIds: [...teamIds].sort(),
    hostSeasonIds: old.season_id == null ? [] : [old.season_id],
    scorerSwap: true
  }
  const id = makeId('invite')
  const sent = clock.now()
  await trx
    .insertInto('group_requests')
    .values({
      id,
      kind: 'game',
      sender_id: fresh.userId,
      sender_scope_type: 'team',
      sender_scope_id: scoredTeam,
      terms,
      sent_at: sent,
      expires_at: new Date(sent.getTime() + 7 * 24 * 3600 * 1000),
      game_id: old.id,
      initiating_team_id: null
    })
    .execute()
  await trx
    .insertInto('creation_idempotency')
    .values({
      user_id: fresh.userId,
      key: body.idempotencyKey,
      body_hash: hash,
      response: { id, gameProposalVersion: 2 }
    })
    .execute()
  await finishGameRequest(trx, id, clock)
  return await requestById(trx, id)
}
/**
 * Home and away may swap until the first pitch. Another team may replace
 * one, or be given an open side, only while nothing has been scored: no
 * play, no at-bat open, not under way. A named side never becomes open.
 */
async function requireEditableTeams(
  db: Kysely<Database>,
  old: GameRow,
  game: GameIntent
): Promise<void> {
  if (
    old.home_team_id === game.homeTeamId &&
    old.away_team_id === game.awayTeamId
  )
    return
  if (swapsSides(old, game)) {
    if (!(await maySwapSides(db, old))) throw conflict(SWAP_REFUSED)
    return
  }
  if (
    (old.home_team_id != null && game.homeTeamId == null) ||
    (old.away_team_id != null && game.awayTeamId == null)
  )
    throw conflict(SIDE_CLEARED)
  const played = await db
    .selectFrom('events')
    .select('id')
    .where('gameId', '=', old.id)
    .executeTakeFirst()
  if (
    played != null ||
    old.currentPlay != null ||
    old.pregame != null ||
    old.status === 'inProgress' ||
    old.status === 'final'
  )
    throw conflict(
      'Keep played games on their original teams; use an administrative identity correction when necessary'
    )
}
async function requestById(
  db: Kysely<Database>,
  id: string
): Promise<StoredRequest> {
  let query = db
    .selectFrom('group_requests')
    .selectAll()
    .where('id', '=', id)
    .where('kind', '=', 'game')
  if (db.isTransaction) query = query.forUpdate()
  const request = await query.executeTakeFirst()
  if (request == null) throw notFound()
  return request
}
async function notifyProposalChange(
  db: Kysely<Database>,
  terms: GameRequestTerms
): Promise<void> {
  const id = terms.gameId ?? terms.proposedGameId
  if (id == null) return
  await notifyGameChange(db, { game: id, kind: 'game' })
  noteScopeChange(db, { gameId: id })
  noteProposedGame(db, terms)
}

/**
 * A proposed new game has no `games` row, so a notice naming its id reaches
 * nobody's Home or Schedule, which list it all the same: its teams and
 * seasons are told instead.
 */
function noteProposedGame(db: Kysely<Database>, terms: GameRequestTerms): void {
  if (terms.gameId != null) return
  const teams = new Set([
    ...namedTeamIds(terms.game.homeTeamId, terms.game.awayTeamId),
    ...terms.affectedTeamIds
  ])
  for (const teamId of teams) noteScopeChange(db, { teamId })
  const seasons = new Set([
    ...(terms.game.seasonId == null ? [] : [terms.game.seasonId]),
    ...terms.hostSeasonIds
  ])
  for (const seasonId of seasons) noteScopeChange(db, { seasonId })
}
/**
 * The field a proposal leaves the game on. Left out of the proposal, the
 * game keeps its field; `null` clears it.
 */
function preservedField(
  game: GameIntent,
  old: GameRow | null | undefined
): { fieldId?: string | null; fieldSize?: string | null } {
  if (game.fieldId === undefined)
    return old?.field_id == null
      ? {}
      : { fieldId: old.field_id, fieldSize: old.field_size }
  if (game.fieldId === null) return { fieldId: null, fieldSize: null }
  return { fieldId: game.fieldId, fieldSize: game.fieldSize ?? null }
}

interface FieldPlace {
  sizes: string[]
  deleted: boolean
  venue: string
  address: string
  latitude: number
  longitude: number
}

/** Where a field is: its venue's name and address, and its pin. */
async function fieldPlace(
  db: Kysely<Database>,
  fieldId: string
): Promise<FieldPlace | null> {
  const field = await readOnce(
    db,
    `venue_fields:${fieldId}:place`,
    async () =>
      await db
        .selectFrom('venue_fields')
        .innerJoin('venues', 'venues.id', 'venue_fields.venue_id')
        .select([
          'venue_fields.sizes',
          'venue_fields.deleted_at',
          'venue_fields.pin_latitude',
          'venue_fields.pin_longitude',
          'venues.name',
          'venues.address',
          'venues.latitude',
          'venues.longitude'
        ])
        .where('venue_fields.id', '=', fieldId)
        .executeTakeFirst()
  )
  return field == null
    ? null
    : {
        sizes: field.sizes,
        deleted: field.deleted_at != null,
        venue: field.name,
        address: field.address,
        latitude: field.pin_latitude ?? field.latitude,
        longitude: field.pin_longitude ?? field.longitude
      }
}

/**
 * Checks a field a proposal sets or changes, and what the game takes from
 * it: the size it is set up in (its only one when not chosen), the venue's
 * name and address, and where the pin is.
 */
async function placeOnField(
  db: Kysely<Database>,
  fieldId: string,
  fieldSize: string | null | undefined
): Promise<{
  fieldSize: string
  venue: string
  address: string
  latitude: number
  longitude: number
}> {
  const field = await fieldPlace(db, fieldId)
  if (field == null || field.deleted)
    throw badRequest('Choose a field that is still in the registry')
  const size =
    fieldSize ?? (field.sizes.length === 1 ? field.sizes[0] : undefined)
  if (size == null)
    throw badRequest('Choose the size the field is set up in for this game')
  if (!field.sizes.includes(size))
    throw badRequest(`That field cannot be set up as ${size}`)
  return {
    fieldSize: size,
    venue: field.venue,
    address: field.address,
    latitude: field.latitude,
    longitude: field.longitude
  }
}

/** Refreshes the warnings around a game: its field's, and its own. */
async function refreshAroundGame(
  trx: Transaction<Database>,
  gameId: string,
  clock: Clock,
  otherFieldIds: Array<string | null | undefined> = []
): Promise<void> {
  const game = await trx
    .selectFrom('games')
    .select('field_id')
    .where('id', '=', gameId)
    .executeTakeFirst()
  await refreshFieldWarnings(
    trx,
    [game?.field_id, ...otherFieldIds],
    clock,
    game == null ? [] : [gameId]
  )
}

async function validateGame(
  db: Kysely<Database>,
  intent: GameIntent
): Promise<void> {
  if (intent.homeTeamId != null && intent.homeTeamId === intent.awayTeamId)
    throw badRequest('Choose two different teams')
  // Only the named sides: an open side has no team to check.
  for (const id of namedTeamIds(intent.homeTeamId, intent.awayTeamId)) {
    const team = await teamFacts(db, id)
    if (team == null || team.merged_into != null)
      throw notFound('Choose a current team')
    if (
      team.kind === 'external' &&
      (team.custodian_type == null || team.custodian_id == null)
    )
      throw conflict(
        'Assign this placeholder team a custodian before scheduling it'
      )
  }
  const seasonId = intent.seasonId
  if (
    seasonId != null &&
    (await readOnce(
      db,
      `seasons:${seasonId}:exists`,
      async () =>
        await db
          .selectFrom('seasons')
          .select('id')
          .where('id', '=', seasonId)
          .executeTakeFirst()
    )) == null
  )
    throw notFound('Choose a current season')
}
async function recordedAuthorities(
  db: Kysely<Database>,
  requestId: string
): Promise<boolean> {
  const request = await requestById(db, requestId)
  const sides = await db
    .selectFrom('group_request_sides')
    .selectAll()
    .where('request_id', '=', requestId)
    .execute()
  return await authoritiesRecorded(db, request, sides)
}

/**
 * Whether each side of a game request was approved, by somebody who may
 * still approve it: the sides as stored with the request.
 */
async function authoritiesRecorded(
  db: Kysely<Database>,
  request: StoredRequest,
  sides: Array<Selectable<GroupRequestSidesTable>>
): Promise<boolean> {
  for (const ref of relationshipSides(request.terms as GameRequestTerms)) {
    const side = sides.find(
      side => side.scope_type === ref.kind && side.scope_id === ref.id
    )
    if (side?.approved_by == null) return false
    try {
      if (
        !(await approvesSide(
          db,
          { userId: side.approved_by, isAdmin: false, scopes: [] },
          ref,
          request
        ))
      )
        return false
    } catch {
      return false
    }
  }
  return true
}

async function currentAdministrator(
  db: Kysely<Database>,
  userId: string,
  ref: GroupRef
): Promise<boolean> {
  try {
    return await canScheduleFor(db, { userId, isAdmin: false, scopes: [] }, ref)
  } catch (error) {
    if (
      error instanceof HttpError &&
      ['unauthorized', 'forbidden', 'notFound'].includes(error.code)
    )
      return false
    throw error
  }
}
/**
 * Whether a person may change a game as one of its original administrators:
 * an administrator of a named team, or, for a game with an open side, of
 * its hosting season, so a season's game with both sides open has somebody
 * who may change it.
 */
async function originalAdministrator(
  db: Kysely<Database>,
  userId: string,
  game: GameIntent
): Promise<boolean> {
  for (const id of namedTeamIds(game.homeTeamId, game.awayTeamId))
    if (
      await currentAdministrator(db, userId, {
        kind: 'team',
        id: await followMerges(db, id)
      })
    )
      return true
  return (
    openSidesOf(game).length > 0 &&
    game.seasonId != null &&
    (await currentAdministrator(db, userId, {
      kind: 'season',
      id: game.seasonId
    }))
  )
}
async function normalizedIntent(
  db: Kysely<Database>,
  game: GameIntent,
  fallbackTimezone: string
): Promise<GameIntent> {
  return {
    ...asEventLocationFields({ ...game }, game.startAt),
    homeTeamId: await followSide(db, game.homeTeamId),
    awayTeamId: await followSide(db, game.awayTeamId),
    seasonId: game.seasonId,
    startAt: new Date(game.startAt).toISOString(),
    venue: game.venue ?? null,
    outsideTournament: game.outsideTournament ?? null,
    exhibition: game.exhibition ?? false,
    timezone: game.timezone ?? fallbackTimezone,
    status: game.status
  }
}
async function replacementAnchor(
  db: Kysely<Database>,
  terms: GameRequestTerms
): Promise<void> {
  const anchor =
    terms.replacesGameId == null
      ? null
      : await db
          .selectFrom('games')
          .selectAll()
          .where('id', '=', terms.replacesGameId)
          .forUpdate()
          .executeTakeFirst()
  if (
    anchor?.status !== 'cancelled' ||
    anchor.cancellation_reason !== 'replacement' ||
    terms.previous == null ||
    terms.proposedGameId == null ||
    terms.proposedGameId === anchor.id ||
    anchor.season_id !== terms.previous.seasonId ||
    anchor.season_id !== terms.game.seasonId
  )
    throw conflict(
      'The replacement must keep its original canceled game and hosting season'
    )
  const actual = await normalizedIntent(
    db,
    materialGame(anchor),
    anchor.timezone
  )
  actual.status = terms.previous.status
  const previous = await normalizedIntent(db, terms.previous, anchor.timezone)
  if (gameVersion(actual) !== gameVersion(previous))
    throw conflict(
      'The original canceled game changed. Send a new authorized proposal.'
    )
}
async function hostingAuthorized(
  db: Kysely<Database>,
  request: StoredRequest,
  terms: GameRequestTerms
): Promise<boolean> {
  if (terms.game.seasonId == null) return true
  const ref = { kind: 'season' as const, id: terms.game.seasonId }
  if (
    terms.hostingAuthorizerUserId != null &&
    (await currentAdministrator(db, terms.hostingAuthorizerUserId, ref))
  )
    return true
  return (
    terms.hostingAuthorizationSource !== 'initiator' &&
    (await currentAdministrator(db, request.sender_id, ref))
  )
}

/** The refusal of a new game whose hosting season's authority has gone. */
async function requireHosting(
  db: Kysely<Database>,
  request: StoredRequest,
  terms: GameRequestTerms
): Promise<void> {
  if (!(await hostingAuthorized(db, request, terms)))
    throw conflict(
      'The hosting season authorization changed. A current host administrator must send a new proposal.'
    )
}

/**
 * Whether a request is ready to publish: still pending, and every side's
 * authority `recorded`, except a scorekeeper's swap, which asks for no
 * scheduling authority (`scorerSwap`).
 */
async function finishable(
  request: StoredRequest,
  clock: Clock,
  recorded: () => Promise<boolean>
): Promise<boolean> {
  const scorer = (request.terms as GameRequestTerms).scorerSwap === true
  return (
    requestStatus(request, clock) === 'pending' &&
    (scorer || (await recorded()))
  )
}

/** The `games` row a request for a new game publishes. */
async function newGameRow(
  db: Kysely<Database>,
  terms: GameRequestTerms,
  gameId: string
): Promise<Insertable<GamesTable>> {
  return {
    id: gameId,
    home_team_id: terms.game.homeTeamId,
    away_team_id: terms.game.awayTeamId,
    season_id: terms.game.seasonId,
    start_at: new Date(terms.game.startAt),
    ...eventColumns(terms.game),
    venue: terms.game.venue,
    outside_tournament: terms.game.outsideTournament,
    exhibition: terms.game.exhibition ?? false,
    timezone:
      terms.game.timezone ?? (await gameTimezone(db, terms.game.seasonId)),
    status: terms.game.status,
    field_id: terms.game.fieldId ?? null,
    field_size: terms.game.fieldId == null ? null : terms.game.fieldSize,
    schedule_preview_id: terms.schedulePreviewId ?? null
  }
}

/** Publish only after both proposed participants have current consent. */
export async function finishGameRequest(
  trx: Transaction<Database>,
  id: string,
  clock: Clock
): Promise<boolean> {
  const request = await requestById(trx, id)
  const terms = request.terms as GameRequestTerms
  const scorer = terms.scorerSwap === true
  if (
    !(await finishable(
      request,
      clock,
      async () => await recordedAuthorities(trx, id)
    ))
  )
    return false
  await validateGame(trx, terms.game)
  // The game's teams and season before a change moved it, to tell both.
  let before: GameFigureIds | undefined
  let previousFieldId: string | null = null
  let cancelsSchedulerGame = false
  let gameId = terms.gameId
  if (gameId == null) {
    if (terms.replacesGameId != null) {
      await replacementAnchor(trx, terms)
      if (
        !(await currentAdministrator(trx, request.sender_id, {
          kind: request.sender_scope_type!,
          id: request.sender_scope_id!
        }))
      )
        throw conflict(
          'The sending organization permissions changed. Resend with a current administrator.'
        )
    } else await requireHosting(trx, request, terms)
    gameId = terms.proposedGameId ?? makeId('game')
    await trx
      .insertInto('games')
      .values(await newGameRow(trx, terms, gameId))
      .execute()
  } else {
    const current = await trx
      .selectFrom('games')
      .selectAll()
      .where('id', '=', gameId)
      .forUpdate()
      .executeTakeFirst()
    if (current == null) throw notFound()
    before = current
    if (current.season_id !== terms.game.seasonId)
      throw conflict('Game settings keep the hosting season unchanged')
    if (
      !scorer &&
      !(await originalAdministrator(
        trx,
        request.sender_id,
        materialGame(current)
      ))
    )
      throw conflict(
        'An original team administrator must authorize changes to this game'
      )
    if (systemCancelled(current.cancellation_reason))
      throw conflict(
        'A withdrawn game cannot be restored by a scheduling proposal'
      )
    if (!(await matchesVersion(trx, current, terms.expected)))
      throw conflict('This game changed. Propose a fresh revision.')
    const removed = namedTeamIds(
      current.home_team_id,
      current.away_team_id
    ).filter(
      teamId => ![terms.game.homeTeamId, terms.game.awayTeamId].includes(teamId)
    )
    if (removed.length > 0) {
      // Keeping an event ID relies on the sender's authority to remove its old teams.
      // Parent unlinking can revoke that authority while replacement consent waits.
      let stillAuthorized = false
      try {
        const sender = await currentActor(trx, {
          userId: request.sender_id,
          isAdmin: false,
          scopes: []
        })
        stillAuthorized = (
          await Promise.all(
            removed.map(
              async id =>
                await canScheduleFor(trx, sender, { kind: 'team', id })
            )
          )
        ).every(Boolean)
      } catch (error) {
        if (
          !(error instanceof HttpError) ||
          !['unauthorized', 'forbidden', 'notFound'].includes(error.code)
        )
          throw error
        stillAuthorized = false
      }
      if (!stillAuthorized)
        throw conflict(
          'A team’s management permissions changed. Send a new game proposal.'
        )
    }
    await requireEditableTeams(trx, current, terms.game)
    // Everything naming a side follows its team; the update below then
    // finds the team ids already in place. A game with an open side has
    // nothing keyed by its teams yet: the update alone exchanges them.
    if (swapsSides(current, terms.game) && hasNamedSides(current))
      await swapGameSides(trx, gameId)
    previousFieldId = current.field_id
    cancelsSchedulerGame =
      current.schedule_preview_id != null &&
      current.status !== 'cancelled' &&
      terms.game.status === 'cancelled'
    await trx
      .updateTable('games')
      .set({
        home_team_id: terms.game.homeTeamId,
        away_team_id: terms.game.awayTeamId,
        season_id: terms.game.seasonId,
        start_at: new Date(terms.game.startAt),
        ...eventColumns(terms.game),
        venue: terms.game.venue,
        outside_tournament: terms.game.outsideTournament,
        exhibition: terms.game.exhibition ?? current.exhibition,
        timezone: terms.game.timezone ?? current.timezone,
        ...(terms.game.fieldId === undefined
          ? {}
          : {
              field_id: terms.game.fieldId,
              field_size:
                terms.game.fieldId == null ? null : terms.game.fieldSize
            }),
        status:
          terms.game.status === 'cancelled'
            ? 'cancelled'
            : current.status === 'inProgress' || current.status === 'final'
              ? current.status
              : 'scheduled',
        updated_at: clock.now()
      })
      .where('id', '=', gameId)
      .execute()
  }
  await recheckUmpireAssignments(trx, gameId)
  await trx
    .updateTable('group_requests')
    .set({ status: 'accepted', game_id: gameId, resolved_at: clock.now() })
    .where('id', '=', id)
    .execute()
  if (terms.gameId != null)
    await trx
      .updateTable('group_requests')
      .set({ status: 'superseded', resolved_at: clock.now() })
      .where('kind', '=', 'game')
      .where('status', '=', 'pending')
      .where('game_id', '=', gameId)
      .where('id', '!=', id)
      .execute()
  // A scheduler game's row is known once it exists.
  await trx
    .updateTable('schedule_preview_games')
    .set({ game_id: gameId })
    .where('request_id', '=', id)
    .execute()
  await refreshAroundGame(trx, gameId, clock, [previousFieldId])
  await notifyGameChange(trx, { game: gameId, kind: 'game' })
  // Published or changed: its season's row and its teams' lists.
  await noteGameFigures(trx, gameId, before)
  // A rainout entered in Game Settings.
  if (cancelsSchedulerGame)
    await gameNeedsAttention(trx, gameId, 'cancelled', request.sender_id)
  return true
}

/** The old cleaner omitted these fields; every other normalized field stays exact. */
function matchesHistoricalProposalHash(
  body: GameProposal,
  expected: string,
  request: StoredRequest
): boolean {
  if ((request.terms as GameRequestTerms).game.exhibition === true) return false
  const hash = (game: GameIntent): string =>
    createHash('sha256')
      .update(JSON.stringify({ ...body, game }))
      .digest('hex')
  if (body.game.exhibition !== true && body.game.timezone === undefined) {
    const game = { ...body.game }
    delete game.exhibition
    delete game.timezone
    if (hash(game) === expected) return true
  }
  // The first upgraded cleaner inserted false for an omitted field. Keep those
  // old keys replayable, without weakening newly presence-aware request hashes.
  if (body.game.exhibition === undefined) {
    const game = { ...body.game }
    delete game.timezone
    return (
      hash({
        ...game,
        exhibition: false,
        ...(body.game.timezone === undefined
          ? {}
          : { timezone: body.game.timezone })
      }) === expected
    )
  }
  return false
}

/** What a proposal's idempotency record holds of its body. */
function proposalHash(body: GameProposal): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex')
}

/** A proposal's body sent before: its request, or a refusal. */
async function replayProposal(
  trx: Transaction<Database>,
  held: { body_hash: string; response: unknown },
  body: GameProposal,
  hash: string
): Promise<StoredRequest> {
  const cached = held.response as {
    id: string
    gameProposalVersion?: number
  }
  if (held.body_hash === hash) return await requestById(trx, cached.id)
  const repeated = await trx
    .selectFrom('group_requests')
    .selectAll()
    .where('id', '=', cached.id)
    .where('kind', '=', 'game')
    .forUpdate()
    .executeTakeFirst()
  if (
    repeated == null ||
    cached.gameProposalVersion !== undefined ||
    !matchesHistoricalProposalHash(body, held.body_hash, repeated)
  )
    throw conflict(
      'This action was already submitted with different game details'
    )
  return repeated
}

/** What a proposal asks for, once the rules have let it through. */
interface ProposalTerms {
  game: GameIntent
  terms: GameRequestTerms
  initiatingTeamId: string | null
  /** An existing game whose team changes need a replacement game instead. */
  replacement: boolean
  /** The teams of the game before the change, when it changes one. */
  originalIds: string[]
}

/**
 * The terms of a proposal by the rules every proposal keeps: the game as
 * proposed, its teams followed through merges, its zone, field and place;
 * whether the sender may send it; and the teams it touches. `old` is the
 * game it changes, and `resumedTerms` those of a replacement it resends.
 * Reads only, and throws the rule's refusal.
 */
async function proposalTerms(
  trx: Transaction<Database>,
  fresh: Actor,
  body: GameProposal,
  old: GameRow | null | undefined,
  resumedTerms: GameRequestTerms | undefined,
  options: { schedulePreviewId?: string }
): Promise<ProposalTerms> {
  const game = {
    ...body.game,
    ...preservedEventFields(body.game, old),
    homeTeamId: await followSide(trx, body.game.homeTeamId),
    awayTeamId: await followSide(trx, body.game.awayTeamId),
    timezone: asGameTimezone(
      body.game.timezone ??
        old?.timezone ??
        (await gameTimezone(trx, body.game.seasonId))
    ),
    exhibition: body.game.exhibition ?? old?.exhibition ?? false,
    ...preservedField(body.game, old)
  }
  // A field set or changed is checked, and the game takes its venue and
  // place. A field kept from the stored game is not checked again, but
  // the game still takes its place from it: a field-linked game's venue
  // and address are the field's.
  if (game.fieldId != null) {
    if (old?.field_id !== game.fieldId || old.field_size !== game.fieldSize)
      Object.assign(game, await placeOnField(trx, game.fieldId, game.fieldSize))
    else {
      const kept = await fieldPlace(trx, game.fieldId)
      if (kept != null)
        Object.assign(game, {
          venue: kept.venue,
          address: kept.address,
          latitude: kept.latitude,
          longitude: kept.longitude
        })
    }
  }
  await validateGame(trx, game)
  if (body.sender.kind === 'season' && body.sender.id !== game.seasonId)
    throw forbidden('Send this game from its hosting season')
  if (body.gameId != null && old == null) throw notFound()
  if (systemCancelled(old?.cancellation_reason))
    throw conflict('A canceled withdrawal or replacement cannot be restored')
  if (old != null && !(await matchesVersion(trx, old, body.expected)))
    throw conflict('Review the current game before changing its schedule')
  if (old != null && old.season_id !== game.seasonId)
    throw badRequest('Game settings keep the hosting season unchanged')
  if (
    old != null &&
    !(await originalAdministrator(trx, fresh.userId, materialGame(old)))
  )
    throw forbidden(
      'Only an original participating team administrator can change this game'
    )
  if (old != null) await requireEditableTeams(trx, old, game)
  if (
    old == null &&
    resumedTerms == null &&
    game.seasonId != null &&
    !(await canScheduleFor(trx, fresh, { kind: 'season', id: game.seasonId }))
  )
    throw forbidden(
      'A hosting season administrator must authorize season placement'
    )
  const prior =
    old == null ? (resumedTerms?.previous ?? null) : materialGame(old)
  // The named teams only: an open side is no participant, and giving it a
  // team removes nobody, so it is never a replacement.
  const originalIds =
    prior == null ? [] : namedTeamIds(prior.homeTeamId, prior.awayTeamId)
  const proposedIds = namedTeamIds(game.homeTeamId, game.awayTeamId)
  const affectedTeamIds = [...new Set([...proposedIds, ...originalIds])].sort()
  const administered: string[] = []
  for (const teamId of affectedTeamIds)
    if (await canScheduleFor(trx, fresh, { kind: 'team', id: teamId }))
      administered.push(teamId)
  // A season sends a new game, or changes its own game with an open side.
  const hostOnlyCreation =
    body.sender.kind === 'season' &&
    (old == null || openSidesOf(materialGame(old)).length > 0)
  if (administered.length === 0 && !hostOnlyCreation)
    throw forbidden(
      'A participating team administrator, coach or assistant must send this game'
    )
  if (body.sender.kind === 'team' && !affectedTeamIds.includes(body.sender.id))
    throw forbidden(
      'The sending team must be an original or proposed participant'
    )
  const replacement =
    old != null &&
    originalIds.some(
      id => !proposedIds.includes(id) && !administered.includes(id)
    )
  const initiatingTeamId =
    body.sender.kind === 'team'
      ? body.sender.id
      : (body.initiatingTeamId ?? null)
  if (
    initiatingTeamId != null &&
    (!affectedTeamIds.includes(initiatingTeamId) ||
      !(await canScheduleFor(trx, fresh, {
        kind: 'team',
        id: initiatingTeamId
      })))
  )
    throw forbidden(
      'Only a team administrator, coach or assistant can represent the inviting team'
    )
  const terms: GameRequestTerms = {
    kind: 'game',
    game,
    gameId: replacement ? null : (old?.id ?? null),
    proposedGameId:
      replacement || old == null
        ? (resumedTerms?.proposedGameId ?? makeId('game'))
        : old.id,
    replacesGameId: replacement
      ? old.id
      : (resumedTerms?.replacesGameId ?? null),
    consentTeamIds: proposedIds,
    expected:
      replacement || old == null ? null : gameVersion(materialGame(old)),
    previous: prior,
    affectedTeamIds,
    hostSeasonIds: [
      ...new Set(
        [game.seasonId, old?.season_id].filter((id): id is string => id != null)
      )
    ].sort(),
    ...(old == null && resumedTerms == null && game.seasonId != null
      ? {
          hostingAuthorizerUserId: fresh.userId,
          hostingAuthorizationSource: 'initiator' as const
        }
      : {}),
    ...(options.schedulePreviewId == null
      ? {}
      : { schedulePreviewId: options.schedulePreviewId })
  }
  return { game, terms, initiatingTeamId, replacement, originalIds }
}

/** A proposal's `group_requests` row, as it is sent. */
function requestRow(
  fresh: Actor,
  body: GameProposal,
  proposal: ProposalTerms,
  id: string,
  sent: Date
): Insertable<GroupRequestsTable> {
  return {
    id,
    kind: 'game',
    sender_id: fresh.userId,
    sender_scope_type: body.sender.kind,
    sender_scope_id: body.sender.id,
    terms: proposal.terms,
    sent_at: sent,
    expires_at: new Date(sent.getTime() + 7 * 24 * 3600 * 1000),
    game_id: proposal.terms.gameId,
    initiating_team_id: proposal.initiatingTeamId
  }
}

/**
 * A proposal's sides, each approved at once when the sender may approve
 * it: the sender's own approval of a side it speaks for.
 */
async function sideRows(
  trx: Transaction<Database>,
  fresh: Actor,
  terms: GameRequestTerms,
  id: string,
  sent: Date
): Promise<Array<Insertable<GroupRequestSidesTable>>> {
  const rows: Array<Insertable<GroupRequestSidesTable>> = []
  for (const side of relationshipSides(terms)) {
    const approved = await approvesSide(trx, fresh, side, {
      kind: 'game',
      terms
    })
    rows.push({
      request_id: id,
      scope_type: side.kind,
      scope_id: side.id,
      approved_by: approved ? fresh.userId : null,
      approved_at: approved ? sent : null
    })
  }
  return rows
}

/** The name of the team or season a proposal is sent from. */
export async function senderName(
  trx: Transaction<Database>,
  sender: GameProposal['sender']
): Promise<string> {
  const name = await nameOnce(trx, sender.kind, sender.id)
  if (name == null) throw new Error(`No ${sender.kind} ${sender.id}`)
  return name
}

/** The sender's own notice of a request it sent. */
function sentNotice(
  fresh: Actor,
  id: string,
  organization: string,
  sent: Date
): Insertable<NotificationEventsTable> {
  return {
    id: makeId('audit'),
    source_type: 'groupRequest',
    source_id: id,
    revision: 1,
    actor_id: fresh.userId,
    metadata: { senderGroupName: organization },
    recorded_recipients: [fresh.userId],
    created_at: sent
  }
}

export async function proposeGame(
  db: Kysely<Database>,
  actor: Actor,
  body: GameProposal,
  clock: Clock = realClock,
  resumingRequestId?: string,
  options: {
    /** Server-only: the Auto-Scheduler preview publishing this game. */
    schedulePreviewId?: string
    /**
     * Told, once its transaction commits, of an existing game this call's
     * own acceptance changed; never for a replay or a pending request.
     */
    onAccepted?: (gameId: string) => void
  } = {}
): Promise<StoredRequest> {
  let acceptedGame: string | undefined
  const request = await atomic(db, async trx => {
    await lockKeys(trx, [
      'creation:parent-graph',
      `creation:game:${actor.userId}:${body.idempotencyKey}`,
      ...(body.gameId == null ? [] : [`game:${body.gameId}`])
    ])
    await lockForSwap(trx, body.gameId, body.game)
    const fresh = await currentActor(trx, actor)
    const hash = proposalHash(body)
    const held = await trx
      .selectFrom('creation_idempotency')
      .select(['body_hash', 'response'])
      .where('user_id', '=', fresh.userId)
      .where('key', '=', body.idempotencyKey)
      .executeTakeFirst()
    if (held != null) return await replayProposal(trx, held, body, hash)
    if (resumingRequestId == null) {
      const swapped = await scorerSwap(trx, fresh, body, hash, clock)
      if (swapped != null) {
        acceptedGame = body.gameId
        return swapped
      }
    }
    await requireScheduler(trx, fresh, body.sender)
    let resumedTerms: GameRequestTerms | undefined
    if (resumingRequestId != null) {
      if (typeof resumingRequestId !== 'string')
        throw forbidden('Replacement resends require their stored invitation')
      const original = await requestById(trx, resumingRequestId)
      if (
        original.sender_scope_type !== body.sender.kind ||
        original.sender_scope_id !== body.sender.id ||
        original.status === 'accepted' ||
        body.gameId != null
      )
        throw forbidden(
          'Replacement resends must keep their sending organization'
        )
      resumedTerms = original.terms as GameRequestTerms
      await replacementAnchor(trx, resumedTerms)
      const zone =
        resumedTerms.game.timezone ??
        (await gameTimezone(trx, resumedTerms.game.seasonId))
      if (
        gameVersion(await normalizedIntent(trx, body.game, zone)) !==
        gameVersion(await normalizedIntent(trx, resumedTerms.game, zone))
      )
        throw forbidden(
          'A replacement resend must keep the stored game details'
        )
    }
    const old =
      body.gameId == null
        ? null
        : await trx
            .selectFrom('games')
            .selectAll()
            .where('id', '=', body.gameId)
            .forUpdate()
            .executeTakeFirst()
    const proposal = await proposalTerms(
      trx,
      fresh,
      body,
      old,
      resumedTerms,
      options
    )
    const { game, terms, replacement, originalIds } = proposal
    const id = makeId('invite')
    const sent = clock.now()
    if (replacement && old != null) {
      const recipients = await schedulingRecipients(
        trx,
        originalIds.map(id => ({ kind: 'team' as const, id }))
      )
      await trx
        .updateTable('games')
        .set({
          status: 'cancelled',
          cancellation_reason: 'replacement',
          updated_at: sent
        })
        .where('id', '=', old.id)
        .execute()
      await trx
        .updateTable('group_requests')
        .set({
          status: 'superseded',
          resolved_at: sent,
          resolved_by: fresh.userId
        })
        .where('kind', '=', 'game')
        .where('game_id', '=', old.id)
        .where('status', '=', 'pending')
        .execute()
      await trx
        .insertInto('notification_events')
        .values({
          id: makeId('audit'),
          source_type: 'gameReplacement',
          source_id: old.id,
          revision: 1,
          actor_id: fresh.userId,
          metadata: {
            title: 'Game canceled after an opponent change',
            description:
              'The original game remains canceled on its schedules. A separate replacement game has been proposed.',
            originalGameId: old.id,
            replacementGameId: terms.proposedGameId,
            requestId: id
          },
          recorded_recipients: recipients,
          created_at: sent
        })
        .execute()
      await refreshAroundGame(trx, old.id, clock)
      await notifyGameChange(trx, { game: old.id, kind: 'game' })
      // Cancelled, it leaves its teams' records.
      await noteGameFigures(trx, old.id)
      await gameNeedsAttention(trx, old.id, 'replaced', fresh.userId)
    }
    await trx
      .insertInto('group_requests')
      .values(requestRow(fresh, body, proposal, id, sent))
      .execute()
    for (const side of await sideRows(trx, fresh, terms, id, sent))
      await trx.insertInto('group_request_sides').values(side).execute()
    await trx
      .insertInto('notification_events')
      .values(sentNotice(fresh, id, await senderName(trx, body.sender), sent))
      .execute()
    await snapshotRequestInformation(trx, id)
    await trx
      .insertInto('creation_idempotency')
      .values({
        user_id: fresh.userId,
        key: body.idempotencyKey,
        body_hash: hash,
        response: { id, gameProposalVersion: 2 }
      })
      .execute()
    if ((await finishGameRequest(trx, id, clock)) && terms.gameId != null)
      acceptedGame = terms.gameId
    // A proposal left pending holds its field too.
    await refreshFieldWarnings(trx, [game.fieldId, old?.field_id], clock)
    await notifyGameChange(trx, { game: terms.proposedGameId!, kind: 'game' })
    noteScopeChange(trx, { gameId: terms.proposedGameId! })
    noteProposedGame(trx, terms)
    return await requestById(trx, id)
  })
  if (acceptedGame != null) options.onAccepted?.(acceptedGame)
  return request
}

/** One new game's proposal, as `proposeGames` sends it. */
interface Sending {
  body: GameProposal
  hash: string
  proposal: ProposalTerms
  id: string
  sides: Array<Insertable<GroupRequestSidesTable>>
  organization: string
  sent: Date
  /** Its request as stored, and then once it is published. */
  request?: StoredRequest
  gameId?: string
}

/**
 * `proposeGame` of each of these new games, in order, as though each were
 * proposed alone in turn, in one transaction: the same rules decide each
 * game (`proposalTerms`, `sideRows`, `finishable`, `requireHosting`), the
 * same rows are written and the same changes told, and the answer is each
 * game's request. What every game reads alike (its sender's rights, its
 * teams, season and field) is read once (`withRolesRead`); the rows are
 * written a statement for many at a time. The field warnings of every
 * field and game touched are brought up to date once, after them all,
 * which leaves what one refresh after each game leaves: games only ever
 * join the fields here, so no warning told on the way is taken back.
 *
 * Only for new games: a body naming a game, or two with one idempotency
 * key, is proposed one at a time by `proposeGame`.
 */
export async function proposeGames(
  db: Kysely<Database>,
  actor: Actor,
  bodies: GameProposal[],
  clock: Clock = realClock,
  options: { schedulePreviewId?: string } = {}
): Promise<StoredRequest[]> {
  if (
    bodies.some(body => body.gameId != null) ||
    new Set(bodies.map(body => body.idempotencyKey)).size !== bodies.length
  ) {
    const requests: StoredRequest[] = []
    for (const body of bodies)
      requests.push(
        await proposeGame(db, actor, body, clock, undefined, options)
      )
    return requests
  }
  if (bodies.length === 0) return []
  return await atomic(
    db,
    async trx =>
      await withRolesRead(
        trx,
        async () => await sendProposals(trx, actor, bodies, clock, options)
      )
  )
}

async function sendProposals(
  trx: Transaction<Database>,
  actor: Actor,
  bodies: GameProposal[],
  clock: Clock,
  options: { schedulePreviewId?: string }
): Promise<StoredRequest[]> {
  await lockKeys(trx, [
    'creation:parent-graph',
    ...bodies.map(
      body => `creation:game:${actor.userId}:${body.idempotencyKey}`
    )
  ])
  const fresh = await currentActor(trx, actor)
  const held = new Map<string, { body_hash: string; response: unknown }>()
  for (const run of runsOf(bodies))
    for (const row of await trx
      .selectFrom('creation_idempotency')
      .select(['key', 'body_hash', 'response'])
      .where('user_id', '=', fresh.userId)
      .where(
        'key',
        'in',
        run.map(body => body.idempotencyKey)
      )
      .execute())
      held.set(row.key, row)
  // Each game by the rules, in order, as `proposeGame` would decide it.
  const answers: Array<StoredRequest | Sending> = []
  for (const body of bodies) {
    const hash = proposalHash(body)
    const before = held.get(body.idempotencyKey)
    if (before != null) {
      answers.push(await replayProposal(trx, before, body, hash))
      continue
    }
    await requireScheduler(trx, fresh, body.sender)
    const proposal = await proposalTerms(
      trx,
      fresh,
      body,
      null,
      undefined,
      options
    )
    const id = makeId('invite')
    const sent = clock.now()
    answers.push({
      body,
      hash,
      proposal,
      id,
      sides: await sideRows(trx, fresh, proposal.terms, id, sent),
      organization: await senderName(trx, body.sender),
      sent
    })
  }
  const sending = answers.filter(
    (answer): answer is Sending => 'proposal' in answer
  )
  if (sending.length > 0) await sendAll(trx, fresh, sending, clock)
  return answers.map(answer =>
    'proposal' in answer ? answer.request! : answer
  )
}

/** Writes and publishes the proposals `sendProposals` decided. */
async function sendAll(
  trx: Transaction<Database>,
  fresh: Actor,
  sending: Sending[],
  clock: Clock
): Promise<void> {
  const byId = new Map(sending.map(each => [each.id, each]))
  for (const run of runsOf(sending))
    for (const row of await trx
      .insertInto('group_requests')
      .values(
        run.map(each =>
          requestRow(fresh, each.body, each.proposal, each.id, each.sent)
        )
      )
      .returningAll()
      .execute())
      byId.get(row.id)!.request = row
  const sides = new Map<string, Array<Selectable<GroupRequestSidesTable>>>()
  for (const run of runsOf(sending.flatMap(each => each.sides)))
    for (const row of await trx
      .insertInto('group_request_sides')
      .values(run)
      .returningAll()
      .execute())
      sides.set(row.request_id, [...(sides.get(row.request_id) ?? []), row])
  // Each sender's notice, with the names its text reads frozen as
  // `snapshotRequestInformation` freezes them.
  const notices: Array<Insertable<NotificationEventsTable>> = []
  for (const each of sending) {
    const notice = sentNotice(fresh, each.id, each.organization, each.sent)
    notices.push({
      ...notice,
      metadata: {
        ...(notice.metadata as object),
        frozen: await frozenNamesOf(trx, each.request!)
      }
    })
  }
  for (const run of runsOf(notices))
    await trx.insertInto('notification_events').values(run).execute()
  for (const run of runsOf(sending))
    await trx
      .insertInto('creation_idempotency')
      .values(
        run.map(each => ({
          user_id: fresh.userId,
          key: each.body.idempotencyKey,
          body_hash: each.hash,
          response: { id: each.id, gameProposalVersion: 2 }
        }))
      )
      .execute()
  // Published once every side has approved, as `finishGameRequest` does.
  const games: Array<Insertable<GamesTable>> = []
  for (const each of sending) {
    const request = each.request!
    const { terms } = each.proposal
    if (
      !(await finishable(
        request,
        clock,
        async () =>
          await authoritiesRecorded(trx, request, sides.get(each.id) ?? [])
      ))
    )
      continue
    await validateGame(trx, terms.game)
    await requireHosting(trx, request, terms)
    // A new game's terms always propose its id (`proposalTerms`).
    each.gameId = terms.proposedGameId!
    games.push(await newGameRow(trx, terms, each.gameId))
  }
  for (const run of runsOf(games))
    await trx.insertInto('games').values(run).execute()
  const published = sending.filter(each => each.gameId != null)
  for (const run of runsOf(published)) {
    const resolved = clock.now()
    for (const row of await trx
      .updateTable('group_requests')
      .set({
        status: 'accepted',
        // Each game's id is its request's proposed one (`gameId` above).
        game_id: sql<string>`terms->>'proposedGameId'`,
        resolved_at: resolved
      })
      .where(
        'id',
        'in',
        run.map(each => each.id)
      )
      .returningAll()
      .execute())
      byId.get(row.id)!.request = row
  }
  // A proposal left pending holds its field too.
  await refreshFieldWarnings(
    trx,
    sending.map(each => each.proposal.game.fieldId),
    clock,
    published.map(each => each.gameId!)
  )
  // Each published game's umpire recheck, as `finishGameRequest` makes it,
  // from one read of the assignments and the games they could touch.
  const recheck = await umpireRechecker(
    trx,
    published.map(each => each.gameId!)
  )
  const told: GameChangePayload[] = []
  for (const each of sending) {
    const { terms } = each.proposal
    if (each.gameId != null) {
      await recheck(each.gameId)
      told.push({ game: each.gameId, kind: 'game' })
      // Published: its season's row and its teams' lists.
      noteScopeChange(trx, { gameId: each.gameId })
      for (const teamId of namedTeamIds(
        terms.game.homeTeamId,
        terms.game.awayTeamId
      ))
        noteScopeChange(trx, { teamId })
      if (terms.game.seasonId != null)
        noteScopeChange(trx, { seasonId: terms.game.seasonId })
    }
    told.push({ game: terms.proposedGameId!, kind: 'game' })
    noteScopeChange(trx, { gameId: terms.proposedGameId! })
    noteProposedGame(trx, terms)
  }
  await notifyGameChanges(trx, told)
}

export async function decideGameRequest(
  db: Kysely<Database>,
  actor: Actor,
  id: string,
  decision: 'accept' | 'decline',
  clock: Clock = realClock,
  /** Told, once committed, of an existing game this acceptance changed. */
  options: { onAccepted?: (gameId: string) => void } = {}
): Promise<StoredRequest> {
  let acceptedGame: string | undefined
  const request = await atomic(db, async trx => {
    await lockKeys(trx, ['creation:parent-graph', `request:${id}`])
    const fresh = await currentActor(trx, actor)
    const request = await requestById(trx, id)
    const terms = request.terms as GameRequestTerms
    if (decision === 'accept') await lockForSwap(trx, terms.gameId, terms.game)
    const permitted = []
    for (const side of relationshipSides(terms))
      if (await approvesSide(trx, fresh, side, request)) permitted.push(side)
    if (permitted.length === 0) throw forbidden()
    const status = requestStatus(request, clock)
    if (status !== 'pending') {
      if (request.status === 'pending')
        await trx
          .updateTable('group_requests')
          .set({ status: 'expired', resolved_at: clock.now() })
          .where('id', '=', id)
          .execute()
      await notifyProposalChange(trx, terms)
      return await requestById(trx, id)
    }
    await recordRequestRecipient(trx, id, fresh.userId)
    if (decision === 'decline') {
      await trx
        .updateTable('group_requests')
        .set({
          status: 'declined',
          resolved_at: clock.now(),
          resolved_by: fresh.userId
        })
        .where('id', '=', id)
        .execute()
      await refreshFieldWarnings(trx, [terms.game.fieldId], clock)
      await requestNeedsAttention(trx, request, 'declined', fresh.userId)
    } else {
      for (const side of permitted)
        await trx
          .updateTable('group_request_sides')
          .set({ approved_by: fresh.userId, approved_at: clock.now() })
          .where('request_id', '=', id)
          .where('scope_type', '=', side.kind)
          .where('scope_id', '=', side.id)
          .execute()
      if ((await finishGameRequest(trx, id, clock)) && terms.gameId != null)
        acceptedGame = terms.gameId
    }
    await notifyProposalChange(trx, terms)
    return await requestById(trx, id)
  })
  if (acceptedGame != null) options.onAccepted?.(acceptedGame)
  return request
}

/** First committing team withdrawal wins, even after a final result or loss of parent/competition links. */
export async function withdrawFromGame(
  db: Kysely<Database>,
  actor: Actor,
  gameId: string,
  teamId: string,
  clock: Clock = realClock
): Promise<GameRow> {
  return await atomic(db, async trx => {
    await lockKeys(trx, ['creation:parent-graph', `game:${gameId}`])
    const fresh = await currentActor(trx, actor)
    const game = await trx
      .selectFrom('games')
      .selectAll()
      .where('id', '=', gameId)
      .forUpdate()
      .executeTakeFirst()
    if (game == null) throw notFound()
    if (![game.home_team_id, game.away_team_id].includes(teamId))
      throw forbidden('Only a participating team can withdraw')
    await requireScheduler(trx, fresh, { kind: 'team', id: teamId })
    if (systemCancelled(game.cancellation_reason)) return game
    const refs: GroupRef[] = [
      ...namedTeamIds(game.home_team_id, game.away_team_id).map(
        id => ({ kind: 'team', id }) as const
      ),
      ...(game.season_id == null
        ? []
        : [{ kind: 'season' as const, id: game.season_id }])
    ]
    const recipients = await schedulingRecipients(trx, refs)
    const withdrawn = await trx
      .updateTable('games')
      .set({
        status: 'cancelled',
        cancellation_reason: 'withdrawal',
        withdrawn_by_team_id: teamId,
        withdrawn_by_user_id: fresh.userId,
        withdrawn_at: clock.now(),
        updated_at: clock.now()
      })
      .where('id', '=', gameId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await trx
      .updateTable('group_requests')
      .set({
        status: 'cancelled',
        resolved_at: clock.now(),
        resolved_by: fresh.userId
      })
      .where('kind', '=', 'game')
      .where('game_id', '=', gameId)
      .where('status', '=', 'pending')
      .execute()
    const team = await trx
      .selectFrom('teams')
      .select('name')
      .where('id', '=', teamId)
      .executeTakeFirstOrThrow()
    await trx
      .insertInto('notification_events')
      .values({
        id: makeId('audit'),
        source_type: 'gameWithdrawal',
        source_id: gameId,
        revision: 1,
        actor_id: fresh.userId,
        metadata: {
          title: `${team.name} withdrew from a game`,
          description: `The game remains on both teams' schedules as canceled due to withdrawal. Scores, results and history are preserved.`
        },
        recorded_recipients: recipients
      })
      .onConflict(oc =>
        oc.columns(['source_type', 'source_id', 'revision']).doNothing()
      )
      .execute()
    await refreshAroundGame(trx, gameId, clock)
    await notifyGameChange(trx, { game: gameId, kind: 'game' })
    // Cancelled by a withdrawal, it leaves its teams' records.
    await noteGameFigures(trx, gameId)
    if (game.status !== 'cancelled')
      await gameNeedsAttention(trx, gameId, 'teamWithdrew', fresh.userId)
    return withdrawn
  })
}

export async function hideDeclinedGame(
  db: Kysely<Database>,
  actor: Actor,
  id: string,
  projection?: GroupRef
): Promise<void> {
  await atomic(db, async trx => {
    await lockKeys(trx, ['creation:parent-graph', `request:${id}`])
    const request = await requestById(trx, id)
    const sender: GroupRef = {
      kind: request.sender_scope_type!,
      id: request.sender_scope_id!
    }
    const scope = projection ?? sender
    const sendingScope = scope.kind === sender.kind && scope.id === sender.id
    if (
      !sendingScope &&
      !(scope.kind === 'team' && scope.id === request.initiating_team_id)
    )
      throw forbidden('Only an inviting schedule can hide this declined entry')
    await requireGroupAdmin(trx, actor, scope)
    if (request.status !== 'declined')
      throw conflict(
        'Only a declined proposal can be removed from the sending schedule'
      )
    if (sendingScope)
      await trx
        .updateTable('group_requests')
        .set({ sender_hidden: true })
        .where('id', '=', id)
        .execute()
    const key = `${scope.kind}:${scope.id}`
    await trx
      .updateTable('notification_events')
      .set({
        metadata: sql`jsonb_set(metadata, '{scheduleHiddenScopes}', coalesce(metadata->'scheduleHiddenScopes', '[]'::jsonb) || jsonb_build_array(${key}::text), true)`
      })
      .where('source_type', '=', 'groupRequest')
      .where('source_id', '=', id)
      .where(
        sql<boolean>`not (coalesce(metadata->'scheduleHiddenScopes', '[]'::jsonb) @> jsonb_build_array(${key}::text))`
      )
      .execute()
  })
}

export async function withdrawGameRequest(
  db: Kysely<Database>,
  actor: Actor,
  id: string,
  clock: Clock = realClock,
  /** Set by `resendGameRequest`: the game stays proposed, as a new request. */
  options: { resending?: boolean } = {}
): Promise<StoredRequest> {
  return await atomic(db, async trx => {
    await lockKeys(trx, ['creation:parent-graph', `request:${id}`])
    const fresh = await currentActor(trx, actor)
    const request = await requestById(trx, id)
    const sides = await trx
      .selectFrom('group_request_sides')
      .selectAll()
      .where('request_id', '=', id)
      .where('scope_type', '=', 'team')
      .execute()
    const representedConsent =
      (request.kind === 'game' || request.kind === 'gameChange') &&
      (
        await Promise.all(
          sides
            .filter(side => side.approved_by != null)
            .map(
              async side =>
                await canScheduleFor(trx, fresh, {
                  kind: 'team',
                  id: side.scope_id
                })
            )
        )
      ).some(Boolean)
    if (
      request.sender_id !== fresh.userId &&
      !representedConsent &&
      !(await canScheduleFor(trx, fresh, {
        kind: request.sender_scope_type!,
        id: request.sender_scope_id!
      }))
    )
      throw forbidden()
    if (request.status === 'accepted')
      throw conflict(
        'This game is already published. A team administrator can withdraw from the game.'
      )
    if (request.status === 'pending') {
      await trx
        .updateTable('group_requests')
        .set({
          status: 'cancelled',
          resolved_at: clock.now(),
          resolved_by: fresh.userId
        })
        .where('id', '=', id)
        .execute()
      // The Auto-Scheduler's own withdrawal of a game its admin rejected
      // needs no word to that admin.
      const rejected = await trx
        .selectFrom('schedule_preview_games')
        .select('preview_id')
        .where('request_id', '=', id)
        .where('rejected_at', 'is not', null)
        .executeTakeFirst()
      if (options.resending !== true && rejected == null)
        await requestNeedsAttention(trx, request, 'withdrawn', fresh.userId)
    }
    await refreshFieldWarnings(
      trx,
      [(request.terms as GameRequestTerms).game.fieldId],
      clock
    )
    await notifyProposalChange(trx, request.terms as GameRequestTerms)
    return await requestById(trx, id)
  })
}

export async function resendGameRequest(
  db: Kysely<Database>,
  actor: Actor,
  id: string,
  idempotencyKey: string,
  clock: Clock = realClock,
  /** Told, once committed, of an existing game the resent request changed. */
  options: { onAccepted?: (gameId: string) => void } = {}
): Promise<StoredRequest> {
  let acceptedGame: string | undefined
  const request = await atomic(db, async trx => {
    await lockKeys(trx, [
      'creation:parent-graph',
      `request:${id}`,
      `creation:game:${actor.userId}:${idempotencyKey}`
    ])
    const fresh = await currentActor(trx, actor)
    const original = await requestById(trx, id)
    await requireScheduler(trx, fresh, {
      kind: original.sender_scope_type!,
      id: original.sender_scope_id!
    })
    const held = await trx
      .selectFrom('creation_idempotency')
      .select('response')
      .where('user_id', '=', fresh.userId)
      .where('key', '=', idempotencyKey)
      .executeTakeFirst()
    if (held != null) {
      const repeated = await requestById(
        trx,
        (held.response as { id: string }).id
      )
      if (repeated.supersedes_id !== id)
        throw conflict('This action belongs to a different invitation')
      return repeated
    }
    const successor = await trx
      .selectFrom('group_requests')
      .select('id')
      .where('supersedes_id', '=', id)
      .executeTakeFirst()
    if (successor != null)
      throw conflict(
        'A newer invitation exists. Open the latest invitation to resend it.'
      )
    await withdrawGameRequest(trx, fresh, id, clock, { resending: true })
    const terms = original.terms as GameRequestTerms
    const proposal: GameProposal = {
      sender: {
        kind: original.sender_scope_type!,
        id: original.sender_scope_id!
      },
      game: terms.game,
      idempotencyKey,
      ...(original.initiating_team_id == null
        ? {}
        : { initiatingTeamId: original.initiating_team_id })
    }
    if (terms.gameId != null) {
      const current = await trx
        .selectFrom('games')
        .selectAll()
        .where('id', '=', terms.gameId)
        .executeTakeFirst()
      if (current == null) throw notFound()
      proposal.gameId = current.id
      proposal.expected = gameVersion(materialGame(current))
    }
    const next = await proposeGame(
      trx,
      fresh,
      proposal,
      clock,
      terms.replacesGameId == null ? undefined : original.id,
      {
        ...(terms.schedulePreviewId == null
          ? {}
          : { schedulePreviewId: terms.schedulePreviewId }),
        // Told only once this outer transaction commits.
        onAccepted: gameId => {
          acceptedGame = gameId
        }
      }
    )
    await trx
      .updateTable('group_requests')
      .set({ supersedes_id: id })
      .where('id', '=', next.id)
      .execute()
    // A scheduler game's row follows its proposal to the resent one.
    await trx
      .updateTable('schedule_preview_games')
      .set({
        request_id: next.id,
        ...(next.status === 'accepted' ? { game_id: next.game_id } : {})
      })
      .where('request_id', '=', id)
      .execute()
    await trx
      .updateTable('group_requests')
      .set({ sender_hidden: true })
      .where('id', '=', id)
      .execute()
    if (original.initiating_team_id != null) {
      const key = `team:${original.initiating_team_id}`
      await trx
        .updateTable('notification_events')
        .set({
          metadata: sql`jsonb_set(metadata, '{scheduleHiddenScopes}', coalesce(metadata->'scheduleHiddenScopes', '[]'::jsonb) || jsonb_build_array(${key}::text), true)`
        })
        .where('source_id', '=', id)
        .where('revision', '=', original.revision)
        .execute()
    }
    return await requestById(trx, next.id)
  })
  if (acceptedGame != null) options.onAccepted?.(acceptedGame)
  return request
}

/** Private schedule proposals; only the sending scope keeps a declined entry. */
export async function scheduleProposals(
  db: Kysely<Database>,
  actor: Actor,
  ref: GroupRef,
  clock: Clock = realClock
): Promise<
  Array<{
    requestId: string
    gameId: string | null
    game: GameIntent
    previous: GameIntent | null
    status: string
    sentAt: string
    canDelete: boolean
    version: string | null
  }>
> {
  const fresh = await currentActor(db, actor)
  await requireScheduler(db, fresh, ref)
  const requests = await db
    .selectFrom('group_requests')
    .leftJoin('notification_events as event', join =>
      join
        .onRef('event.source_id', '=', 'group_requests.id')
        .on('event.source_type', '=', 'groupRequest')
    )
    .selectAll('group_requests')
    .select(
      sql<
        string[]
      >`coalesce(event.metadata->'scheduleHiddenScopes', '[]'::jsonb)`.as(
        'hiddenScopes'
      )
    )
    .where('group_requests.kind', '=', 'game')
    .where('group_requests.status', 'in', [
      'pending',
      'declined',
      'expired',
      'cancelled',
      'superseded'
    ])
    .orderBy('group_requests.sent_at', 'asc')
    .orderBy('group_requests.id')
    .execute()
  const result = []
  for (const request of requests) {
    const terms = request.terms as GameRequestTerms
    const sendingScope =
      request.sender_scope_type === ref.kind &&
      request.sender_scope_id === ref.id
    const sender =
      sendingScope ||
      (ref.kind === 'team' && request.initiating_team_id === ref.id)
    const relevant =
      ref.kind === 'season'
        ? terms.hostSeasonIds.includes(ref.id)
        : ref.kind === 'team'
          ? terms.affectedTeamIds.includes(ref.id)
          : false
    const status = requestStatus(request, clock)
    if (
      status === 'pending'
        ? !relevant && !sender
        : status !== 'declined' ||
          !sender ||
          (sendingScope && request.sender_hidden) ||
          request.hiddenScopes.includes(`${ref.kind}:${ref.id}`)
    )
      continue
    if (status === 'pending' && !(await canScheduleFor(db, fresh, ref)))
      continue
    result.push({
      requestId: request.id,
      gameId: request.game_id,
      game: wireGame(terms.game),
      previous: terms.previous == null ? null : wireGame(terms.previous),
      status,
      sentAt: request.sent_at.toISOString(),
      canDelete: status === 'declined' && (await canAdminister(db, fresh, ref)),
      version: terms.expected
    })
  }
  return result
}

export async function schedulingGame(
  db: Kysely<Database>,
  actor: Actor,
  id: string
): Promise<{
  game: GameIntent
  version: string
  canPropose: boolean
  withdrawTeamIds: string[]
  administeredTeamIds: string[]
  canSwap: boolean
  plays: PlaysLost & {
    playsDigest: string
    generation: number
    resets: boolean
    swap: SwapEffect
  }
  field: GameFieldSummary | null
}> {
  const fresh = await currentActor(db, actor)
  // The game and its plays as of one moment, so the digest the form
  // confirms is of plays the game held.
  const { row, stored } = await db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async trx => {
      const row = await trx
        .selectFrom('games')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst()
      return { row, stored: row == null ? [] : await readPlays(trx, id) }
    })
  if (row == null) throw notFound()
  const teamIds = []
  const sideTeams = namedTeamIds(row.home_team_id, row.away_team_id)
  for (const teamId of sideTeams)
    if (await canScheduleFor(db, fresh, { kind: 'team', id: teamId }))
      teamIds.push(teamId)
  // A scorekeeper of either team may swap home and away, and nothing else.
  const roles = await roleScopes(db, fresh.userId, fresh.isAdmin)
  const scorer = sideTeams.some(teamId => canScore(roles, teamId))
  // A game with an open side is its season's to change as well
  // (`originalAdministrator`), whoever administers its named teams.
  const seasonHost =
    openSidesOf(materialGame(row)).length > 0 &&
    row.season_id != null &&
    (await canScheduleFor(db, fresh, { kind: 'season', id: row.season_id }))
  if (teamIds.length === 0 && !scorer && !seasonHost) throw forbidden()
  const withdrawn = systemCancelled(row.cancellation_reason)
  const current = atBatOf(row, stored.length > 0)
  // What a swap would do, as the swap route decides it.
  const effect = gameSwapEffect(
    row,
    stored.map(play => play.gumbo)
  )
  return {
    game: wireGame(materialGame(row)),
    version: gameVersion(materialGame(row)),
    canPropose: (teamIds.length > 0 || seasonHost) && !withdrawn,
    withdrawTeamIds: teamIds,
    administeredTeamIds: teamIds,
    canSwap: scorer && (effect === 'swap' || effect === 'reset'),
    plays: {
      ...playsLost({
        plays: stored.map(play => play.gumbo),
        currentPlay: current
      }),
      playsDigest: playsDigest(stored, current),
      generation: row.play_generation,
      resets: effect === 'reset',
      swap: effect
    },
    field: await fieldSummary(db, row.field_id, row.field_size)
  }
}

/** A game's field as the game form names it. */
async function fieldSummary(
  db: Kysely<Database>,
  fieldId: string | null,
  size: string | null
): Promise<GameFieldSummary | null> {
  if (fieldId == null || size == null) return null
  const field = await db
    .selectFrom('venue_fields')
    .innerJoin('venues', 'venues.id', 'venue_fields.venue_id')
    .select([
      'venues.id as venue_id',
      'venues.name as venue_name',
      'venues.address',
      'venue_fields.name as field_name'
    ])
    .where('venue_fields.id', '=', fieldId)
    .executeTakeFirst()
  return field == null
    ? null
    : {
        venueId: field.venue_id,
        venueName: field.venue_name,
        fieldId,
        fieldName: field.field_name,
        size,
        address: field.address
      }
}

function storedEventFields(game: {
  notes: string | null
  arrival_time_delta: number | null
  address: string | null
  end_at: Date | null
  latitude: number | null
  longitude: number | null
}): EventLocationFields {
  return {
    ...(game.notes == null ? {} : { notes: game.notes }),
    ...(game.arrival_time_delta == null
      ? {}
      : { arrivalTimeDelta: game.arrival_time_delta }),
    ...(game.address == null ? {} : { address: game.address }),
    ...(game.end_at == null ? {} : { endAt: game.end_at.toISOString() }),
    ...(game.latitude == null
      ? {}
      : { latitude: game.latitude, longitude: game.longitude })
  }
}
function preservedEventFields(
  game: GameIntent,
  old: GameRow | null | undefined
): EventLocationFields {
  if (old == null) return asEventLocationFields({ ...game }, game.startAt)
  const stored = storedEventFields(old)
  if (game.endAt === undefined && old.end_at != null)
    stored.endAt = new Date(
      old.end_at.getTime() + Date.parse(game.startAt) - old.start_at.getTime()
    ).toISOString()
  if (
    game.address !== undefined &&
    game.address !== old.address &&
    game.latitude === undefined
  )
    return {
      ...stored,
      ...asEventLocationFields({ ...game }, game.startAt),
      latitude: null,
      longitude: null
    }
  return { ...stored, ...asEventLocationFields({ ...game }, game.startAt) }
}
function eventColumns(game: EventLocationFields): {
  notes?: string | null
  arrival_time_delta?: number | null
  address?: string | null
  end_at?: Date | null
  latitude?: number | null
  longitude?: number | null
} {
  return {
    ...(game.notes === undefined ? {} : { notes: game.notes }),
    ...(game.arrivalTimeDelta === undefined
      ? {}
      : { arrival_time_delta: game.arrivalTimeDelta }),
    ...(game.address === undefined ? {} : { address: game.address }),
    ...(game.endAt === undefined
      ? {}
      : { end_at: game.endAt == null ? null : new Date(game.endAt) }),
    ...(game.latitude === undefined
      ? {}
      : { latitude: game.latitude, longitude: game.longitude ?? null })
  }
}
