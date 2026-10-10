import { createHash } from 'node:crypto'

import { type Kysely, type Selectable, sql, type Transaction } from 'kysely'

import {
  badRequest,
  conflict,
  forbidden,
  HttpError,
  notFound
} from '../../common/errors'
import type {
  GameIntent,
  GameProposal,
  GameRequestTerms
} from '../../common/gameApprovals'
import { asGameTimezone } from '../../common/gameApprovals'
import type { GroupRef } from '../../common/groupCreation'
import { makeId } from '../../common/ids'
import type { Actor } from '../auth/sessions'
import { lockKeys } from '../db/advisoryLocks'
import { atomic } from '../db/atomic'
import type { Database, GamesTable } from '../db/database'
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
  adminRecipients,
  canAdminister,
  currentActor,
  requireGroupAdmin
} from '../groups/rights'
import { snapshotRequestInformation } from '../notifications/requestInformation'
import { notifyGameChange } from '../socket/gameChanges'
import { followMerges } from '../teams/followMerges'

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
    for (const id of [game.homeTeamId, game.awayTeamId])
      sides.set(`team:${id}`, { kind: 'team', id })
  }
  for (const side of sides.values()) {
    if (!(await canAdminister(db, fresh, side)))
      throw forbidden('Additional approval is required; use game proposals')
  }
}
export function materialGame(game: GameRow): GameIntent {
  return {
    homeTeamId: game.home_team_id,
    awayTeamId: game.away_team_id,
    seasonId: game.season_id,
    startAt: game.start_at.toISOString(),
    venue: game.venue,
    outsideTournament: game.outside_tournament,
    exhibition: game.exhibition,
    timezone: game.timezone,
    status: game.status === 'cancelled' ? 'cancelled' : 'scheduled'
  }
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
  const played = await db
    .selectFrom('events')
    .select('id')
    .where('gameId', '=', old.id)
    .executeTakeFirst()
  if (
    played != null ||
    old.currentPlay != null ||
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
  if (id != null) await notifyGameChange(db, { game: id, kind: 'game' })
}
async function validateGame(
  db: Kysely<Database>,
  intent: GameIntent
): Promise<void> {
  if (intent.homeTeamId === intent.awayTeamId)
    throw badRequest('Choose two different teams')
  for (const id of [intent.homeTeamId, intent.awayTeamId]) {
    const team = await db
      .selectFrom('teams')
      .select(['id', 'merged_into', 'kind', 'custodian_type', 'custodian_id'])
      .where('id', '=', id)
      .executeTakeFirst()
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
  if (
    intent.seasonId != null &&
    (await db
      .selectFrom('seasons')
      .select('id')
      .where('id', '=', intent.seasonId)
      .executeTakeFirst()) == null
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
          ref
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
  userId: number,
  ref: GroupRef
): Promise<boolean> {
  try {
    return await canAdminister(db, { userId, isAdmin: false, scopes: [] }, ref)
  } catch (error) {
    if (
      error instanceof HttpError &&
      ['unauthorized', 'forbidden', 'notFound'].includes(error.code)
    )
      return false
    throw error
  }
}
async function originalAdministrator(
  db: Kysely<Database>,
  userId: number,
  game: GameIntent
): Promise<boolean> {
  for (const id of [game.homeTeamId, game.awayTeamId])
    if (
      await currentAdministrator(db, userId, {
        kind: 'team',
        id: await followMerges(db, id)
      })
    )
      return true
  return false
}
async function normalizedIntent(
  db: Kysely<Database>,
  game: GameIntent,
  fallbackTimezone: string
): Promise<GameIntent> {
  return {
    homeTeamId: await followMerges(db, game.homeTeamId),
    awayTeamId: await followMerges(db, game.awayTeamId),
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

/** Publish only after both proposed participants have current consent. */
export async function finishGameRequest(
  trx: Transaction<Database>,
  id: string,
  clock: Clock
): Promise<boolean> {
  const request = await requestById(trx, id)
  if (
    requestStatus(request, clock) !== 'pending' ||
    !(await recordedAuthorities(trx, id))
  )
    return false
  const terms = request.terms as GameRequestTerms
  await validateGame(trx, terms.game)
  let gameId = terms.gameId
  if (gameId == null) {
    if (terms.replacesGameId != null) {
      await replacementAnchor(trx, terms)
      if (
        !(await currentAdministrator(trx, request.sender_id, {
          kind: request.sender_scope_type,
          id: request.sender_scope_id
        }))
      )
        throw conflict(
          'The sending organization permissions changed. Resend with a current administrator.'
        )
    } else if (!(await hostingAuthorized(trx, request, terms)))
      throw conflict(
        'The hosting season authorization changed. A current host administrator must send a new proposal.'
      )
    gameId = terms.proposedGameId ?? makeId('game')
    await trx
      .insertInto('games')
      .values({
        id: gameId,
        home_team_id: terms.game.homeTeamId,
        away_team_id: terms.game.awayTeamId,
        season_id: terms.game.seasonId,
        start_at: new Date(terms.game.startAt),
        venue: terms.game.venue,
        outside_tournament: terms.game.outsideTournament,
        exhibition: terms.game.exhibition ?? false,
        timezone:
          terms.game.timezone ?? (await gameTimezone(trx, terms.game.seasonId)),
        status: terms.game.status
      })
      .execute()
  } else {
    const current = await trx
      .selectFrom('games')
      .selectAll()
      .where('id', '=', gameId)
      .forUpdate()
      .executeTakeFirst()
    if (current == null) throw notFound()
    if (current.season_id !== terms.game.seasonId)
      throw conflict('Game settings keep the hosting season unchanged')
    if (
      !(await originalAdministrator(
        trx,
        request.sender_id,
        materialGame(current)
      ))
    )
      throw conflict(
        'An original team administrator must authorize changes to this game'
      )
    if (
      current.cancellation_reason === 'withdrawal' ||
      current.cancellation_reason === 'replacement'
    )
      throw conflict(
        'A withdrawn game cannot be restored by a scheduling proposal'
      )
    if (!(await matchesVersion(trx, current, terms.expected)))
      throw conflict('This game changed. Propose a fresh revision.')
    const removed = [current.home_team_id, current.away_team_id].filter(
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
              async id => await canAdminister(trx, sender, { kind: 'team', id })
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
    await trx
      .updateTable('games')
      .set({
        home_team_id: terms.game.homeTeamId,
        away_team_id: terms.game.awayTeamId,
        season_id: terms.game.seasonId,
        start_at: new Date(terms.game.startAt),
        venue: terms.game.venue,
        outside_tournament: terms.game.outsideTournament,
        exhibition: terms.game.exhibition ?? current.exhibition,
        timezone: terms.game.timezone ?? current.timezone,
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
  await notifyGameChange(trx, { game: gameId, kind: 'game' })
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

export async function proposeGame(
  db: Kysely<Database>,
  actor: Actor,
  body: GameProposal,
  clock: Clock = realClock,
  resumingRequestId?: string
): Promise<StoredRequest> {
  return await atomic(db, async trx => {
    await lockKeys(trx, [
      'creation:parent-graph',
      `creation:game:${actor.userId}:${body.idempotencyKey}`,
      ...(body.gameId == null ? [] : [`game:${body.gameId}`])
    ])
    const fresh = await currentActor(trx, actor)
    const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex')
    const held = await trx
      .selectFrom('creation_idempotency')
      .select(['body_hash', 'response'])
      .where('user_id', '=', fresh.userId)
      .where('key', '=', body.idempotencyKey)
      .executeTakeFirst()
    if (held != null) {
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
    await requireGroupAdmin(trx, fresh, body.sender)
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
    const game = {
      ...body.game,
      homeTeamId: await followMerges(trx, body.game.homeTeamId),
      awayTeamId: await followMerges(trx, body.game.awayTeamId),
      timezone: asGameTimezone(
        body.game.timezone ??
          old?.timezone ??
          (await gameTimezone(trx, body.game.seasonId))
      ),
      exhibition: body.game.exhibition ?? old?.exhibition ?? false
    }
    await validateGame(trx, game)
    if (body.sender.kind === 'season' && body.sender.id !== game.seasonId)
      throw forbidden('Send this game from its hosting season')
    if (body.gameId != null && old == null) throw notFound()
    if (
      old?.cancellation_reason === 'withdrawal' ||
      old?.cancellation_reason === 'replacement'
    )
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
      !(await canAdminister(trx, fresh, { kind: 'season', id: game.seasonId }))
    )
      throw forbidden(
        'A hosting season administrator must authorize season placement'
      )
    const prior =
      old == null ? (resumedTerms?.previous ?? null) : materialGame(old)
    const originalIds =
      prior == null ? [] : [prior.homeTeamId, prior.awayTeamId]
    const proposedIds = [game.homeTeamId, game.awayTeamId]
    const affectedTeamIds = [
      ...new Set([...proposedIds, ...originalIds])
    ].sort()
    const administered: string[] = []
    for (const teamId of affectedTeamIds)
      if (await canAdminister(trx, fresh, { kind: 'team', id: teamId }))
        administered.push(teamId)
    const hostOnlyCreation = old == null && body.sender.kind === 'season'
    if (administered.length === 0 && !hostOnlyCreation)
      throw forbidden('A participating team administrator must send this game')
    if (
      body.sender.kind === 'team' &&
      !affectedTeamIds.includes(body.sender.id)
    )
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
        !(await canAdminister(trx, fresh, {
          kind: 'team',
          id: initiatingTeamId
        })))
    )
      throw forbidden(
        'Only a team administrator can represent the inviting team'
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
          [game.seasonId, old?.season_id].filter(
            (id): id is string => id != null
          )
        )
      ].sort(),
      ...(old == null && resumedTerms == null && game.seasonId != null
        ? {
            hostingAuthorizerUserId: fresh.userId,
            hostingAuthorizationSource: 'initiator' as const
          }
        : {})
    }
    const id = makeId('invite')
    const sent = clock.now()
    if (replacement) {
      const recipients = await adminRecipients(
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
      await notifyGameChange(trx, { game: old.id, kind: 'game' })
    }
    await trx
      .insertInto('group_requests')
      .values({
        id,
        kind: 'game',
        sender_id: fresh.userId,
        sender_scope_type: body.sender.kind,
        sender_scope_id: body.sender.id,
        terms,
        sent_at: sent,
        expires_at: new Date(sent.getTime() + 7 * 24 * 3600 * 1000),
        game_id: terms.gameId,
        initiating_team_id: initiatingTeamId
      })
      .execute()
    for (const side of relationshipSides(terms)) {
      const approved = await approvesSide(trx, fresh, side)
      await trx
        .insertInto('group_request_sides')
        .values({
          request_id: id,
          scope_type: side.kind,
          scope_id: side.id,
          approved_by: approved ? fresh.userId : null,
          approved_at: approved ? sent : null
        })
        .execute()
    }
    const sender = await trx
      .selectFrom('users')
      .select('display_name')
      .where('id', '=', fresh.userId)
      .executeTakeFirstOrThrow()
    const organization = await trx
      .selectFrom(body.sender.kind === 'team' ? 'teams' : 'seasons')
      .select('name')
      .where('id', '=', body.sender.id)
      .executeTakeFirstOrThrow()
    await trx
      .insertInto('notification_events')
      .values({
        id: makeId('audit'),
        source_type: 'groupRequest',
        source_id: id,
        revision: 1,
        actor_id: fresh.userId,
        metadata: {
          senderName: sender.display_name,
          senderGroupName: organization.name
        },
        recorded_recipients: [fresh.userId],
        created_at: sent
      })
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
    await finishGameRequest(trx, id, clock)
    await notifyGameChange(trx, { game: terms.proposedGameId!, kind: 'game' })
    return await requestById(trx, id)
  })
}

export async function decideGameRequest(
  db: Kysely<Database>,
  actor: Actor,
  id: string,
  decision: 'accept' | 'decline',
  clock: Clock = realClock
): Promise<StoredRequest> {
  return await atomic(db, async trx => {
    await lockKeys(trx, ['creation:parent-graph', `request:${id}`])
    const fresh = await currentActor(trx, actor)
    const request = await requestById(trx, id)
    const terms = request.terms as GameRequestTerms
    const permitted = []
    for (const side of relationshipSides(terms))
      if (await approvesSide(trx, fresh, side)) permitted.push(side)
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
    if (decision === 'decline')
      await trx
        .updateTable('group_requests')
        .set({
          status: 'declined',
          resolved_at: clock.now(),
          resolved_by: fresh.userId
        })
        .where('id', '=', id)
        .execute()
    else {
      for (const side of permitted)
        await trx
          .updateTable('group_request_sides')
          .set({ approved_by: fresh.userId, approved_at: clock.now() })
          .where('request_id', '=', id)
          .where('scope_type', '=', side.kind)
          .where('scope_id', '=', side.id)
          .execute()
      await finishGameRequest(trx, id, clock)
    }
    await notifyProposalChange(trx, terms)
    return await requestById(trx, id)
  })
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
    await requireGroupAdmin(trx, fresh, { kind: 'team', id: teamId })
    if (
      game.cancellation_reason === 'withdrawal' ||
      game.cancellation_reason === 'replacement'
    )
      return game
    const refs: GroupRef[] = [
      { kind: 'team', id: game.home_team_id },
      { kind: 'team', id: game.away_team_id },
      ...(game.season_id == null
        ? []
        : [{ kind: 'season' as const, id: game.season_id }])
    ]
    const recipients = await adminRecipients(trx, refs)
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
    await notifyGameChange(trx, { game: gameId, kind: 'game' })
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
      kind: request.sender_scope_type,
      id: request.sender_scope_id
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
  clock: Clock = realClock
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
                await canAdminister(trx, fresh, {
                  kind: 'team',
                  id: side.scope_id
                })
            )
        )
      ).some(Boolean)
    if (
      request.sender_id !== fresh.userId &&
      !representedConsent &&
      !(await canAdminister(trx, fresh, {
        kind: request.sender_scope_type,
        id: request.sender_scope_id
      }))
    )
      throw forbidden()
    if (request.status === 'accepted')
      throw conflict(
        'This game is already published. A team administrator can withdraw from the game.'
      )
    if (request.status === 'pending')
      await trx
        .updateTable('group_requests')
        .set({
          status: 'cancelled',
          resolved_at: clock.now(),
          resolved_by: fresh.userId
        })
        .where('id', '=', id)
        .execute()
    await notifyProposalChange(trx, request.terms as GameRequestTerms)
    return await requestById(trx, id)
  })
}

export async function resendGameRequest(
  db: Kysely<Database>,
  actor: Actor,
  id: string,
  idempotencyKey: string,
  clock: Clock = realClock
): Promise<StoredRequest> {
  return await atomic(db, async trx => {
    await lockKeys(trx, [
      'creation:parent-graph',
      `request:${id}`,
      `creation:game:${actor.userId}:${idempotencyKey}`
    ])
    const fresh = await currentActor(trx, actor)
    const original = await requestById(trx, id)
    await requireGroupAdmin(trx, fresh, {
      kind: original.sender_scope_type,
      id: original.sender_scope_id
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
    await withdrawGameRequest(trx, fresh, id, clock)
    const terms = original.terms as GameRequestTerms
    const proposal: GameProposal = {
      sender: {
        kind: original.sender_scope_type,
        id: original.sender_scope_id
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
      terms.replacesGameId == null ? undefined : original.id
    )
    await trx
      .updateTable('group_requests')
      .set({ supersedes_id: id })
      .where('id', '=', next.id)
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
  await requireGroupAdmin(db, fresh, ref)
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
    if (status === 'pending' && !(await canAdminister(db, fresh, ref))) continue
    result.push({
      requestId: request.id,
      gameId: request.game_id,
      game: terms.game,
      previous: terms.previous,
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
}> {
  const fresh = await currentActor(db, actor)
  const row = await db
    .selectFrom('games')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst()
  if (row == null) throw notFound()
  const teamIds = []
  for (const teamId of [row.home_team_id, row.away_team_id])
    if (await canAdminister(db, fresh, { kind: 'team', id: teamId }))
      teamIds.push(teamId)
  if (teamIds.length === 0) throw forbidden()
  return {
    game: materialGame(row),
    version: gameVersion(materialGame(row)),
    canPropose:
      row.cancellation_reason !== 'withdrawal' &&
      row.cancellation_reason !== 'replacement',
    withdrawTeamIds: teamIds,
    administeredTeamIds: teamIds
  }
}
