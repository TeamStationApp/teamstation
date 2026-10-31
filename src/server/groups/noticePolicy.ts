import { type Kysely, sql, type SqlBool, type Transaction } from 'kysely'

import { conflict, forbidden, notFound } from '../../common/errors'
import { storedGuests } from '../../common/guests'
import { makeId } from '../../common/ids'
import type { PlayerAddTerms, PlayerAddTold } from '../../common/notifications'
import {
  placeholderSuffix,
  placeholderTeamName
} from '../../common/placeholderNames'
import { recordOf } from '../../common/scoring/gumbo'
import { SUBSTITUTION_TYPES } from '../../common/scoring/lineupHistory'
import { listsByTeam, teamsOfRow } from '../../common/teamLists'
import { storedUnrostered } from '../../common/unroster'
import { guardiansWhoCanAct, openAddTeams } from '../access'
import { onePerson, UnresolvedAccount } from '../admin/people'
import type { Actor } from '../auth/sessions'
import { lockKeys } from '../db/advisoryLocks'
import type { Database } from '../db/database'
import { guestGameOpen, inGameAs } from '../games/guestChecks'
import { hasScoringEventsSql } from '../games/scoringActivity'
import { reconcileUnbegunLineup } from '../games/unroster'
import {
  type PlayerRemovedMetadata,
  type PlayerRemover,
  shortDate
} from '../notifications/requestInformation'
import { noteScopeChange } from '../socket/syncRevision'
import { refuseDeleted } from '../users/deleted'
import { ensureGumboId } from '../users/insertUser'
import { shortNamesOf } from '../users/nameBook'
import {
  type Clock,
  recordRequestRecipient,
  type StoredRequest
} from './requests'

type Db = Kysely<Database>

/**
 * The person an add is about, with every account merged into them, once a
 * transaction: an add asks several times, and merges wait on the player-edit
 * lock the add holds.
 */
const people = new WeakMap<object, Map<string, ReturnType<typeof onePerson>>>()
export async function personOf(
  db: Db,
  userId: string
): ReturnType<typeof onePerson> {
  // Outside a transaction nothing holds merges still: ask every time.
  if (!db.isTransaction) return await onePerson(db, userId)
  let held = people.get(db)
  if (held == null) {
    held = new Map()
    people.set(db, held)
  }
  let person = held.get(userId)
  if (person == null) {
    person = onePerson(db, userId)
    held.set(userId, person)
    // A failed lookup is asked again, not kept.
    person.catch(() => {
      held.delete(userId)
    })
  }
  return await person
}

/** How long a change made with a notice may still be rejected. */
export const NOTICE_DAYS = 90
const DAY = 86_400_000

/**
 * Whether adding this person to this team happens at once with a notice, or
 * waits for approval: one automatic add per player and adding team. Once a
 * guardian has rejected one, every later add of that player by that team asks
 * first, while another team's first add still goes through.
 */
export async function playerAddPolicy(
  db: Db,
  userId: string,
  teamId: string
): Promise<'notice' | 'approval'> {
  const person = await personOf(db, userId)
  const declined = await db
    .selectFrom('group_requests')
    .select('id')
    .where('kind', '=', 'playerAdd')
    .where('status', '=', 'declined')
    .where('initiating_team_id', '=', teamId)
    .where(sql<string>`terms->>'userId'`, 'in', person.userIds)
    .executeTakeFirst()
  return declined == null ? 'notice' : 'approval'
}

/**
 * Who is told about an add, and may reject it: the player's guardians; with
 * none, the player when they can sign in; with neither, the coaches,
 * assistants and administrators of the other teams the player is on, who
 * stand in for a guardian for this request alone. Nobody, when there is none
 * of these, and then the add simply applies.
 */
export async function playerAddApprovers(
  db: Db,
  userId: string,
  teamId: string
): Promise<{
  userIds: string[]
  standIn: boolean
  told: PlayerAddTold | null
}> {
  const person = await personOf(db, userId)
  const guardians = await guardiansWhoCanAct(db, person.userIds)
  if (guardians.length > 0)
    return { userIds: guardians, standIn: false, told: 'guardians' }
  const self = await db
    .selectFrom('users')
    .select('login_enabled')
    .where('id', '=', person.userId)
    .executeTakeFirst()
  if (self?.login_enabled === true)
    return { userIds: [person.userId], standIn: false, told: 'player' }
  const held = await openAddTeams(db, person.userIds)
  const coaches = await db
    .selectFrom('scope_roles')
    .innerJoin('users', 'users.id', 'scope_roles.user_id')
    .select('scope_roles.user_id as userId')
    .distinct()
    .where('scope_roles.scope_type', '=', 'team')
    .where('scope_roles.role', 'in', ['admin', 'coach', 'assistant'])
    .where('users.disabled_at', 'is', null)
    .where('users.merged_into', 'is', null)
    .where('scope_roles.scope_id', 'in', eb =>
      eb
        .selectFrom('memberships')
        .select('team_id')
        .where('user_id', 'in', person.userIds)
        .where('is_player', '=', true)
        .where('team_id', '!=', teamId)
        // A team holding them only by an open add is not their side, for
        // this add or the next.
        .where('team_id', 'not in', ['', ...held])
    )
    .orderBy('scope_roles.user_id')
    .execute()
  const userIds = coaches.map(row => row.userId)
  const standIn = userIds.length > 0
  return { userIds, standIn, told: standIn ? 'coaches' : null }
}

/**
 * Makes the add: the player on the team's roster, or a guest of the game for
 * one side. An explicit jersey and positions replace the ones held; none
 * keeps them. Answers the terms with whether the membership was new.
 */
export async function applyPlayerAdd(
  trx: Db,
  terms: PlayerAddTerms,
  /** The caller refused the other side already, in this transaction. */
  sideChecked = false
): Promise<PlayerAddTerms> {
  const person = await personOf(trx, terms.userId)
  if (terms.mode === 'roster') {
    if (!sideChecked) await refuseOtherSide(trx, person.userIds, terms)
    const membership = await trx
      .selectFrom('memberships')
      .select(['id', 'jersey', 'positions'])
      .where('team_id', '=', terms.teamId)
      .where('user_id', 'in', person.userIds)
      .orderBy(sql`user_id = ${person.userId}`, 'desc')
      .executeTakeFirst()
    const membershipId = membership?.id ?? makeId('membership')
    if (membership == null)
      await trx
        .insertInto('memberships')
        .values({
          id: membershipId,
          user_id: person.userId,
          team_id: terms.teamId,
          role: 'member',
          is_player: true,
          jersey: terms.jersey,
          positions: terms.positions
        })
        .execute()
    else
      await trx
        .updateTable('memberships')
        .set({
          is_player: true,
          jersey: terms.jersey ?? membership.jersey,
          positions:
            terms.positions.length > 0 ? terms.positions : membership.positions
        })
        .where('id', '=', membership.id)
        .execute()
    await ensureGumboId(trx, person.userId)
    noteScopeChange(trx, { teamId: terms.teamId, userId: person.userId })
    return {
      ...terms,
      membershipId,
      createdMembership: membership == null,
      ...(membership == null
        ? {}
        : {
            previous: {
              jersey: membership.jersey,
              positions: membership.positions
            }
          })
    }
  }
  const game = await trx
    .selectFrom('games')
    .select(['id', 'home_team_id', 'away_team_id', 'guests'])
    .where('id', '=', terms.gameId!)
    .forUpdate()
    .executeTakeFirstOrThrow()
  await trx
    .insertInto('game_guest_details')
    .values({
      game_id: game.id,
      user_id: person.userId,
      jersey: terms.jersey,
      positions: terms.positions,
      pool: true
    })
    .onConflict(oc =>
      oc.columns(['game_id', 'user_id']).doUpdateSet({
        jersey: terms.jersey,
        positions: terms.positions,
        pool: true
      })
    )
    .execute()
  const gumboId = await ensureGumboId(trx, person.userId)
  const teams = teamsOfRow(game)
  const guests = storedGuests(game.guests, teams)
  const side = terms.side!
  if (!guests[side].includes(gumboId)) guests[side].push(gumboId)
  await trx
    .updateTable('games')
    .set({ guests: listsByTeam(guests, teams) })
    .where('id', '=', game.id)
    .execute()
  noteScopeChange(trx, { gameId: game.id })
  return terms
}

/**
 * A player who plays for the other side, on its roster or as a pool player,
 * in a game of this team not yet over cannot join this team's roster: one
 * person is never on both sides of a game, and a scoring read of such a game
 * throws. Somebody the other side left out of that game does not count, as
 * they do not for a merge (`assertMergeAvailabilitySafe`).
 */
export async function refuseOtherSide(
  trx: Db,
  userIds: string[],
  terms: PlayerAddTerms
): Promise<void> {
  const games = await trx
    .selectFrom('games')
    .select([
      'id',
      'home_team_id',
      'away_team_id',
      'guests',
      'unrostered',
      'start_at',
      'timezone'
    ])
    .where(eb =>
      eb.or([
        eb('home_team_id', '=', terms.teamId),
        eb('away_team_id', '=', terms.teamId)
      ])
    )
    .where('status', 'not in', ['final', 'cancelled'])
    // Nothing moves a game nobody scored out of `scheduled`: one long past
    // never holds an add up.
    .where(eb =>
      eb.or([
        eb('status', '=', 'inProgress'),
        eb('start_at', '>=', new Date(Date.now() - DAY))
      ])
    )
    .execute()
  if (games.length === 0) return
  const gumbos = (
    await trx
      .selectFrom('gumbo_ids')
      .select('gumbo_id')
      .where('user_id', 'in', userIds)
      .execute()
  ).map(row => row.gumbo_id)
  const rosters = await trx
    .selectFrom('memberships')
    .select('team_id')
    .where('user_id', 'in', userIds)
    .where('is_player', '=', true)
    .where(
      'team_id',
      'in',
      games.map(game =>
        game.home_team_id === terms.teamId
          ? game.away_team_id
          : game.home_team_id
      )
    )
    .execute()
  const onRoster = new Set(rosters.map(row => row.team_id))
  for (const game of games) {
    const teams = teamsOfRow(game)
    const other = game.home_team_id === terms.teamId ? 'away' : 'home'
    const guest = storedGuests(game.guests, teams)[other]
    const left = storedUnrostered(game.unrostered, teams)[other]
    const member =
      onRoster.has(teams[other].id) && !gumbos.some(id => left.includes(id))
    if (member || gumbos.some(id => guest.includes(id))) {
      const name = (await shortNamesOf(trx, [terms.userId])).get(terms.userId)
      throw conflict(
        `${name} plays for the other team in the game on ${shortDate(game.start_at, game.timezone)} against ${terms.teamName}`,
        { gameId: game.id }
      )
    }
  }
}

/**
 * Records an add as a request: `applied` when it was made with a notice, or
 * `pending` when it waits for approval. Each approver gets the notification.
 * Answers the request, or null when nobody is there to tell.
 */
export async function recordPlayerAdd(
  trx: Db,
  actor: Actor,
  terms: PlayerAddTerms,
  status: 'applied' | 'pending',
  clock: Clock
): Promise<string | null> {
  const found = await playerAddApprovers(trx, terms.userId, terms.teamId)
  // Whoever made the add is not told of it, nor asked to approve it: the
  // player's side is the others. With nobody else, the add simply applies.
  const approvers = {
    ...found,
    userIds: found.userIds.filter(userId => userId !== actor.userId)
  }
  if (approvers.userIds.length === 0) return null
  const id = makeId('invite')
  const sent = clock.now()
  const expires = new Date(sent.getTime() + NOTICE_DAYS * DAY)
  await trx
    .insertInto('group_requests')
    .values({
      id,
      kind: 'playerAdd',
      sender_id: actor.userId,
      sender_scope_type: 'team',
      sender_scope_id: terms.teamId,
      terms: JSON.stringify(terms),
      status,
      sent_at: sent,
      expires_at: expires,
      game_id: terms.gameId ?? null,
      initiating_team_id: terms.teamId
    })
    .execute()
  await trx
    .insertInto('group_request_sides')
    .values(
      approvers.userIds.map(userId => ({
        request_id: id,
        scope_type: 'user' as const,
        scope_id: userId
      }))
    )
    .execute()
  await trx
    .insertInto('notification_events')
    .values({
      id: makeId('audit'),
      source_type: 'groupRequest',
      source_id: id,
      revision: 1,
      actor_id: actor.userId,
      // Its words are rendered when the inbox is read, the player's and the
      // sender's names from `users` (`titleAndDescription`).
      metadata: {
        senderGroupName: terms.teamName,
        standIn: approvers.standIn,
        madeAtOnce: status === 'applied'
      },
      recorded_recipients: [...new Set([actor.userId, ...approvers.userIds])],
      created_at: sent
    })
    .execute()
  return id
}

/** Whether the game has begun: a play stored, or one under way. */
async function gameStarted(trx: Db, game: { id: string }): Promise<boolean> {
  const row = await trx
    .selectFrom('games')
    .select(hasScoringEventsSql.as('begun'))
    .where('id', '=', game.id)
    .executeTakeFirst()
  return row?.begun === true
}

/**
 * A stored play with a result of its own: an intentional walk begins no game
 * by `gameStarted`'s reading, and is on the record all the same, with the
 * game's lineup past reconciling. A lineup change stored ahead of a first
 * pitch is neither.
 */
const isRealPlay = sql<SqlBool>`events.gumbo->'result'->>'eventType'
  not in (${sql.join(SUBSTITUTION_TYPES.map(type => sql.lit(type)))})`

async function hasStoredPlay(trx: Db, game: { id: string }): Promise<boolean> {
  const row = await trx
    .selectFrom('events')
    .select('id')
    .where('gameId', '=', game.id)
    .where(isRealPlay)
    .executeTakeFirst()
  return row != null
}

/**
 * The side of a game an add's player is on now: the list that holds them, for
 * sides swap before a first pitch and a game can move to another team; else
 * the team's side, and the side the add joined last.
 */
function sideOf(
  game: { home_team_id: string; away_team_id: string; guests: unknown },
  terms: PlayerAddTerms,
  gumbos: ReadonlySet<number>
): 'away' | 'home' {
  const guests = storedGuests(game.guests, teamsOfRow(game))
  const holding = (['away', 'home'] as const).find(side =>
    guests[side].some(id => gumbos.has(id))
  )
  if (holding != null) return holding
  if (game.home_team_id === terms.teamId) return 'home'
  if (game.away_team_id === terms.teamId) return 'away'
  return terms.side ?? 'away'
}

/**
 * The games this add covers that were played: for a roster add, each game the
 * team played from the day before the add on with a stat line for them, but
 * not one they played as a pool guest, which a pool add of its own covers;
 * for a pool add, that game once it has begun.
 */
async function playedGames(
  trx: Db,
  request: StoredRequest,
  terms: PlayerAddTerms,
  userIds: string[]
): Promise<
  Array<{
    id: string
    side: 'away' | 'home'
    guests: unknown
    home_team_id: string
    away_team_id: string
  }>
> {
  const gumbos = await trx
    .selectFrom('gumbo_ids')
    .select('gumbo_id')
    .where('user_id', 'in', userIds)
    .execute()
  const held = new Set(gumbos.map(row => row.gumbo_id))
  if (terms.mode === 'pool') {
    const game = await trx
      .selectFrom('games')
      .select(['id', 'currentPlay', 'guests', 'home_team_id', 'away_team_id'])
      .where('id', '=', terms.gameId!)
      .executeTakeFirst()
    if (
      game == null ||
      !((await gameStarted(trx, game)) || (await hasStoredPlay(trx, game)))
    )
      return []
    return [{ ...game, side: sideOf(game, terms, held) }]
  }
  if (gumbos.length === 0) return []
  // Games of the team from the day before the add on where they played for
  // it.
  const games = await trx
    .selectFrom('games')
    .select(['id', 'guests', 'home_team_id', 'away_team_id'])
    .where(eb =>
      eb.or([
        eb('home_team_id', '=', terms.teamId),
        eb('away_team_id', '=', terms.teamId)
      ])
    )
    .where('status', '!=', 'cancelled')
    .where('start_at', '>=', new Date(request.sent_at.getTime() - DAY))
    // As a pool guest they played under that add, not this one.
    .where(eb =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('game_guest_details')
            .select('game_guest_details.game_id')
            .whereRef('game_guest_details.game_id', '=', 'games.id')
            .where('game_guest_details.user_id', 'in', userIds)
            .where('game_guest_details.pool', '=', true)
        )
      )
    )
    .where(eb =>
      eb.or([
        eb.exists(
          eb
            .selectFrom('game_player_stats')
            .innerJoin(
              'gumbo_ids',
              'gumbo_ids.gumbo_id',
              'game_player_stats.gumbo_id'
            )
            .select('game_player_stats.game_id')
            .whereRef('game_player_stats.game_id', '=', 'games.id')
            .where('game_player_stats.team_id', '=', terms.teamId)
            .where('gumbo_ids.user_id', 'in', userIds)
        ),
        // A play this team batted in with them at the plate: from the plays,
        // not the stats a builder fills in later, so a game under way counts.
        eb.exists(
          eb
            .selectFrom('events')
            .select('events.id')
            .whereRef('events.gameId', '=', 'games.id')
            .where('events.battingTeamId', '=', terms.teamId)
            .where(
              sql<string>`events.gumbo->'matchup'->'batter'->>'id'`,
              'in',
              gumbos.map(row => String(row.gumbo_id))
            )
        ),
        // In a play in any other role: a pitcher, before any line is built.
        eb.exists(
          eb
            .selectFrom('event_players')
            .innerJoin('events', 'events.id', 'event_players.event_id')
            .select('event_players.id')
            .whereRef('events.gameId', '=', 'games.id')
            .where(
              'event_players.gumbo_id',
              'in',
              gumbos.map(row => row.gumbo_id)
            )
            .where(on =>
              on.or([
                on('event_players.team_id', '=', terms.teamId),
                on('event_players.team_id', 'is', null)
              ])
            )
        )
      ])
    )
    .execute()
  const covered = games.map(game => ({
    ...game,
    side: sideOf(game, terms, new Set())
  }))
  // Under way, and in the order or the field without a play yet: their
  // session would have them bat under their own name.
  const underWay = await trx
    .selectFrom('games')
    .select(['id', 'guests', 'home_team_id', 'away_team_id', 'currentPlay'])
    .where(eb =>
      eb.or([
        eb('home_team_id', '=', terms.teamId),
        eb('away_team_id', '=', terms.teamId)
      ])
    )
    .where('status', 'not in', ['final', 'cancelled'])
    .where(eb =>
      eb.or([
        eb('status', '=', 'inProgress'),
        eb.exists(
          eb
            .selectFrom('events')
            .select('events.id')
            .whereRef('events.gameId', '=', 'games.id')
            .where(isRealPlay)
        )
      ])
    )
    .where('start_at', '>=', new Date(request.sent_at.getTime() - DAY))
    .execute()
  const pool = await trx
    .selectFrom('game_guest_details')
    .select('game_id')
    .where('user_id', 'in', userIds)
    .where('pool', '=', true)
    .execute()
  for (const game of underWay) {
    if (covered.some(row => row.id === game.id)) continue
    if (pool.some(row => row.game_id === game.id)) continue
    const side = sideOf(game, terms, new Set())
    const setup = recordOf(game.currentPlay, teamsOfRow(game))?.setupBefore
      .sides[side]
    const placed = [
      ...(setup?.battingOrder ?? []),
      ...Object.values(setup?.defense ?? {})
    ]
    if (placed.some(id => id != null && held.has(id)))
      covered.push({ ...game, side })
  }
  return covered
}

/**
 * The names a side of a game already holds, in lower case: its guests', and
 * those of lines withdrawn before.
 */
export async function namesOnSide(
  db: Db,
  game: {
    id: string
    guests: unknown
    home_team_id: string
    away_team_id: string
  },
  side: 'away' | 'home'
): Promise<Set<string>> {
  const used = new Set(
    (
      await db
        .selectFrom('game_withdrawn_players')
        .select('label')
        .where('game_id', '=', game.id)
        .where('side', '=', side)
        .execute()
    ).map(row => row.label.toLowerCase())
  )
  const guests = storedGuests(game.guests, teamsOfRow(game))[side]
  if (guests.length > 0)
    for (const row of await db
      .selectFrom('gumbo_ids')
      .innerJoin('users', 'users.id', 'gumbo_ids.user_id')
      .select(['users.display_name', 'users.first_name', 'users.last_name'])
      .where('gumbo_ids.gumbo_id', 'in', guests)
      .execute()) {
      used.add(row.display_name.toLowerCase())
      used.add(
        [row.first_name, row.last_name]
          .filter(part => part != null && part !== '')
          .join(' ')
          .toLowerCase()
      )
    }
  return used
}

/** The first of a team's placeholder names not among these. */
export function freeLabel(teamName: string, used: ReadonlySet<string>): string {
  const prefix = placeholderTeamName(teamName)
  let suffix = 0
  while (used.has(`${prefix} ${placeholderSuffix(suffix)}`.toLowerCase()))
    suffix++
  return `${prefix} ${placeholderSuffix(suffix)}`
}

/**
 * Serializes every add of one person. The merge lock is shared: two adds run
 * together without this, the second meets the first's row or asks twice, and
 * two teams each pass the other side's check. Taken after any game row.
 */
export const playerAddKey = (userId: string): string => `playerAdd:${userId}`

export async function lockPlayerAdds(trx: Db, userId: string): Promise<void> {
  await lockKeys(trx as Transaction<Database>, [playerAddKey(userId)])
}

/**
 * Whether a roster add's person plays for the team by a row it did not land
 * on: they came back another way, or a merge folded theirs into one already
 * there. A rejection must not take that row. Off the roster, it still takes
 * the add's games off their record, and leaves any other place on the team.
 */
export async function rejoinedSince(
  db: Db,
  terms: PlayerAddTerms
): Promise<boolean> {
  if (terms.mode !== 'roster' || terms.membershipId == null) return false
  const person = await personOf(db, terms.userId)
  const row = await db
    .selectFrom('memberships')
    .select('id')
    .where('team_id', '=', terms.teamId)
    .where('user_id', 'in', person.userIds)
    .where('id', '!=', terms.membershipId)
    .where('is_player', '=', true)
    .executeTakeFirst()
  return row != null
}

/**
 * Whether a later add of the same person to the same team (or, for a pool
 * add, the same game) was made since: applied, or accepted after asking.
 * Undoing by team and person would undo that later add with this one's
 * terms, so only the latest add can be rejected.
 */
export async function supersededPlayerAdd(
  db: Db,
  request: StoredRequest
): Promise<boolean> {
  const terms = request.terms as PlayerAddTerms
  let person
  try {
    person = await personOf(db, terms.userId)
  } catch (error) {
    // Nobody to have added again.
    if (error instanceof UnresolvedAccount) return false
    throw error
  }
  const later = await db
    .selectFrom('group_requests')
    .select('id')
    .where('kind', '=', 'playerAdd')
    .where('id', '!=', request.id)
    .where('status', 'in', ['applied', 'accepted'])
    .where('sent_at', '>', request.sent_at)
    .where(sql<string>`terms->>'userId'`, 'in', person.userIds)
    .where(sql<string>`terms->>'teamId'`, '=', terms.teamId)
    .where(sql<string>`terms->>'mode'`, '=', terms.mode)
    .$if(terms.mode === 'pool', qb =>
      qb.where(sql<string>`terms->>'gameId'`, '=', terms.gameId!)
    )
    .executeTakeFirst()
  return later != null
}

/** A team's default lineup without these gumbo ids in it. */
function withoutPlayers(raw: unknown, gumboIds: Set<number>): unknown {
  if (raw == null || typeof raw !== 'object') return raw
  const held = raw as {
    lineup?: { batters?: unknown[]; defense?: Record<string, unknown> }
  }
  if (held.lineup == null) return raw
  const named = (person: unknown): boolean =>
    person != null &&
    typeof person === 'object' &&
    gumboIds.has((person as { gumboId?: number }).gumboId ?? -1)
  return {
    ...held,
    lineup: {
      ...held.lineup,
      batters: (held.lineup.batters ?? []).filter(person => !named(person)),
      defense: Object.fromEntries(
        Object.entries(held.lineup.defense ?? {}).map(([position, person]) => [
          position,
          named(person) ? null : person
        ])
      )
    }
  }
}

/**
 * Undoes a rejected add. The player leaves the roster (and the default
 * lineup), or the game. Every game already played under it keeps its record,
 * under the side's placeholder name in their place, and leaves their own
 * record: a `game_withdrawn_players` row. Answers how many games changed.
 */
export async function undoPlayerAdd(
  trx: Db,
  request: StoredRequest,
  terms: PlayerAddTerms
): Promise<number> {
  const person = await personOf(trx, terms.userId)
  const gumbos = await trx
    .selectFrom('gumbo_ids')
    .select('gumbo_id')
    .where('user_id', 'in', person.userIds)
    .execute()
  const gumboIds = new Set(gumbos.map(row => row.gumbo_id))
  const played = await playedGames(trx, request, terms, person.userIds)
  const team = await trx
    .selectFrom('teams')
    .select(['name', 'default_lineup'])
    .where('id', '=', terms.teamId)
    .executeTakeFirstOrThrow()
  for (const game of played) {
    const used = await namesOnSide(trx, game, game.side)
    const label = freeLabel(team.name, used)
    await trx
      .insertInto('game_withdrawn_players')
      .values({
        game_id: game.id,
        user_id: person.userId,
        side: game.side,
        request_id: request.id,
        label
      })
      .onConflict(oc => oc.columns(['game_id', 'user_id']).doNothing())
      .execute()
    noteScopeChange(trx, { gameId: game.id })
  }
  if (terms.mode === 'roster') {
    // Whatever has come to rest on the row since the add stays: somebody
    // given a role on the team is on it for that, not for the add.
    const staff = await trx
      .selectFrom('scope_roles')
      .select('role')
      .where('scope_type', '=', 'team')
      .where('scope_id', '=', terms.teamId)
      .where('user_id', 'in', person.userIds)
      .executeTakeFirst()
    const held = await trx
      .selectFrom('memberships')
      .select('role')
      .where('team_id', '=', terms.teamId)
      .where('user_id', 'in', person.userIds)
      .where('role', '!=', 'member')
      .executeTakeFirst()
    if (terms.createdMembership === true && staff == null && held == null)
      await trx
        .deleteFrom('memberships')
        .where('team_id', '=', terms.teamId)
        .where('user_id', 'in', person.userIds)
        .$if(terms.membershipId != null, query =>
          query.where('id', '=', terms.membershipId!)
        )
        .execute()
    else
      await trx
        .updateTable('memberships')
        .set({
          is_player: false,
          // As it was before the add: a row it made, kept for a role, had
          // no jersey before it.
          ...(terms.createdMembership === true
            ? { jersey: null, positions: [] }
            : terms.previous == null
              ? {}
              : {
                  jersey: terms.previous.jersey,
                  positions: terms.previous.positions
                })
        })
        .where('team_id', '=', terms.teamId)
        .where('user_id', 'in', person.userIds)
        .$if(terms.membershipId != null, query =>
          query.where('id', '=', terms.membershipId!)
        )
        .execute()
    await trx
      .updateTable('teams')
      .set({
        default_lineup: JSON.stringify(
          withoutPlayers(team.default_lineup, gumboIds)
        )
      })
      .where('id', '=', terms.teamId)
      .where('default_lineup', 'is not', null)
      .execute()
    noteScopeChange(trx, { teamId: terms.teamId, userId: person.userId })
  } else if (played.length === 0) {
    const game = await trx
      .selectFrom('games')
      .select(['id', 'home_team_id', 'away_team_id', 'guests'])
      .where('id', '=', terms.gameId!)
      .forUpdate()
      .executeTakeFirst()
    if (game != null) {
      const teams = teamsOfRow(game)
      const guests = storedGuests(game.guests, teams)
      const side = sideOf(game, terms, gumboIds)
      guests[side] = guests[side].filter(id => !gumboIds.has(id))
      await trx
        .updateTable('games')
        .set({ guests: listsByTeam(guests, teams) })
        .where('id', '=', game.id)
        .execute()
      await trx
        .deleteFrom('game_guest_details')
        .where('game_id', '=', game.id)
        .where('user_id', 'in', person.userIds)
        .execute()
      noteScopeChange(trx, { gameId: game.id })
    }
  }
  // The lineup of every game not begun follows: they are no longer in it.
  const open =
    terms.mode === 'pool'
      ? [{ id: terms.gameId! }]
      : await trx
          .selectFrom('games')
          .select('id')
          .where(eb =>
            eb.or([
              eb('home_team_id', '=', terms.teamId),
              eb('away_team_id', '=', terms.teamId)
            ])
          )
          .where('status', 'not in', ['final', 'cancelled'])
          .execute()
  for (const game of open) await reconcileUnbegunLineup(trx, game.id)
  return played.length
}

/** Who rejected an add, as the roster managers' notice names them. */
async function removerOf(
  trx: Db,
  actor: Actor,
  terms: PlayerAddTerms
): Promise<PlayerRemover> {
  const person = await personOf(trx, terms.userId)
  if (person.userIds.includes(actor.userId)) return 'self'
  const guardian = await trx
    .selectFrom('user_links')
    .select('id')
    .where('user_id', '=', actor.userId)
    .where('related_user_id', 'in', person.userIds)
    .where('kind', '=', 'guardian')
    .executeTakeFirst()
  return guardian != null ? 'guardian' : 'coach'
}

/**
 * Tells the team's roster managers who removed the player: a guardian, the
 * player themself, or a coach of another of their teams standing in.
 */
async function noticeRemoval(
  trx: Db,
  actor: Actor,
  request: StoredRequest,
  terms: PlayerAddTerms,
  games: number,
  clock: Clock
): Promise<void> {
  const managers = await trx
    .selectFrom('scope_roles')
    .select('user_id')
    .distinct()
    .where('scope_type', '=', 'team')
    .where('scope_id', '=', terms.teamId)
    .where('role', 'in', ['admin', 'coach', 'assistant', 'scorekeeper'])
    .execute()
  const recipients = [
    ...new Set([request.sender_id, ...managers.map(row => row.user_id)])
  ]
  await trx
    .insertInto('notification_events')
    .values({
      id: makeId('audit'),
      source_type: 'playerAddRejected',
      source_id: request.id,
      revision: 1,
      actor_id: null,
      // Ids, not words: the player is named when the inbox is read
      // (`playerRemovedWords`).
      metadata: {
        teamId: terms.teamId,
        userId: terms.userId,
        teamName: terms.teamName,
        mode: terms.mode,
        games,
        remover: await removerOf(trx, actor, terms)
      } satisfies PlayerRemovedMetadata,
      recorded_recipients: recipients,
      created_at: clock.now()
    })
    .execute()
}

/**
 * Whether this person is the player's side now, whoever was told at the add:
 * a guardian removed since, or a stand-in who has left the player's other
 * team, may no longer reject it, and a guardian added since may. Whoever made
 * the add is never the side that answers it.
 */
export async function mayAnswerPlayerAdd(
  db: Db,
  actor: Actor,
  request: StoredRequest
): Promise<boolean> {
  const terms = request.terms as PlayerAddTerms
  const { userIds } = await playerAddApprovers(db, terms.userId, terms.teamId)
  const rows = (await personOf(db, actor.userId)).userIds
  const sender = (await personOf(db, request.sender_id)).userIds
  return userIds.some(id => !sender.includes(id) && rows.includes(id))
}

/**
 * Decides a `playerAdd` request for one of its approvers. A notice
 * (`applied`) can only be rejected, within its 90 days, which undoes it; a
 * pending one is accepted, which makes the add then, or declined.
 */
export async function decidePlayerAdd(
  trx: Db,
  actor: Actor,
  request: StoredRequest,
  decision: 'accept' | 'decline',
  clock: Clock
): Promise<StoredRequest> {
  await decideOnce(trx, actor, request, decision, clock)
  return await trx
    .selectFrom('group_requests')
    .selectAll()
    .where('id', '=', request.id)
    .executeTakeFirstOrThrow()
}

async function decideOnce(
  trx: Db,
  actor: Actor,
  request: StoredRequest,
  decision: 'accept' | 'decline',
  clock: Clock
): Promise<void> {
  if (!(await mayAnswerPlayerAdd(trx, actor, request)))
    throw forbidden('Only the player’s side can decide this')
  // Told or not at the add, whoever decides keeps it in their History.
  await recordRequestRecipient(trx, request.id, actor.userId)
  const terms = request.terms as PlayerAddTerms
  const now = clock.now()
  const open = request.expires_at.getTime() > now.getTime()
  const resolve = async (
    status: 'accepted' | 'declined' | 'expired'
  ): Promise<void> => {
    await trx
      .updateTable('group_requests')
      .set({ status, resolved_at: now, resolved_by: actor.userId })
      .where('id', '=', request.id)
      .execute()
    if (status !== 'expired')
      await trx
        .updateTable('group_request_sides')
        .set({ approved_by: actor.userId, approved_at: now })
        .where('request_id', '=', request.id)
        .where('scope_type', '=', 'user')
        .where('scope_id', '=', actor.userId)
        .execute()
  }
  if (request.status === 'applied') {
    if (decision === 'accept') throw conflict('This change is already made')
    if (!open) throw conflict('This can no longer be rejected.')
    if (await supersededPlayerAdd(trx, request))
      throw conflict(
        'They were added again since. Reject the newer notice instead.'
      )
    if (await rejoinedSince(trx, terms))
      throw conflict('They are on the team another way now.')
    const games = await undoPlayerAdd(trx, request, terms)
    await resolve('declined')
    await noticeRemoval(trx, actor, request, terms, games, clock)
    return
  }
  if (request.status !== 'pending') return
  if (!open) {
    await resolve('expired')
    return
  }
  if (decision === 'decline') {
    await resolve('declined')
    return
  }
  const person = await personOf(trx, terms.userId)
  if (terms.mode === 'pool') {
    const game = await trx
      .selectFrom('games')
      .selectAll()
      .where('id', '=', terms.gameId!)
      .forUpdate()
      .executeTakeFirst()
    if (game == null) throw notFound()
    await lockPlayerAdds(trx, person.userId)
    const side = terms.side === 'home' ? game.home_team_id : game.away_team_id
    // Over, swapped, or the player in the game by now: it can never apply.
    const lapsed =
      game.status === 'final' ||
      game.status === 'cancelled' ||
      side !== terms.teamId ||
      (await inGameAs(trx, game, person.userIds)) != null
    if (lapsed) {
      await resolve('expired')
      return
    }
    // Between a pitch and its result: accept again once it is in.
    await guestGameOpen(trx, game)
  } else {
    await lockPlayerAdds(trx, person.userId)
    // On the roster by now: nothing is left to accept, and an accept would
    // read as saying yes to an add it never saw.
    const playing = await trx
      .selectFrom('memberships')
      .select('id')
      .where('team_id', '=', terms.teamId)
      .where('user_id', 'in', person.userIds)
      .where('is_player', '=', true)
      .executeTakeFirst()
    if (playing != null) {
      await resolve('expired')
      return
    }
  }
  // Deleted since it was asked: a later add must not bring them back.
  await refuseDeleted(trx, person.userId)
  const applied = await applyPlayerAdd(trx, terms)
  await trx
    .updateTable('group_requests')
    .set({ terms: JSON.stringify(applied) })
    .where('id', '=', request.id)
    .execute()
  await resolve('accepted')
}
