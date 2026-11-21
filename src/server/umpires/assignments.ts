import { type Kysely, type Selectable, sql, type Transaction } from 'kysely'

import { badRequest, conflict, forbidden, notFound } from '../../common/errors'
import { DEFAULT_EVENT_DURATION_MS } from '../../common/eventTime'
import { umpirePositions } from '../../common/umpires'
import {
  UMPIRE_LEADERBOARD_MAX_PAGE,
  UMPIRE_RANK_SYMBOLS,
  type UmpireGameBlock,
  type UmpireLeaderboard,
  type UmpireLeaderboardQuery,
  type UmpireRank
} from '../../common/umpireSchedule'
import { hardUmpireConflict, umpireEnd } from '../../common/umpireTime'
import { onePerson } from '../admin/people'
import { type Actor, isMachine } from '../auth/sessions'
import { now } from '../clock'
import type {
  Database,
  GamesTable,
  UmpireAssignmentsTable
} from '../db/database'
import { canAdminister } from '../groups/rights'
import { imageUrl } from '../media/imageUrls'
import type { MediaContext } from '../media/mediaContext'
import { noteScopeChange } from '../socket/syncRevision'
import { type Reader, readerOf } from '../users/readerNames'
import { people } from './admin'
import {
  readerUmpireNames,
  umpireFamily,
  type UmpireIdentity,
  umpireIdentity,
  umpireInterval,
  umpireIsPlaying
} from './context'
import { schedule, umpireAcceptance, umpireAccess } from './schedule'
import { types } from './types'

export async function gameLeague(
  db: Kysely<Database>,
  gameId: string
): Promise<string> {
  const game = await db
    .selectFrom('games')
    .innerJoin('seasons', 'seasons.id', 'games.season_id')
    .select('seasons.league_id')
    .where('games.id', '=', gameId)
    .executeTakeFirst()
  if (game?.league_id == null) throw notFound('No league game')
  return game.league_id
}
export async function saveSlot(
  db: Transaction<Database>,
  actor: Actor,
  gameId: string,
  body: { slot?: unknown; userId?: unknown; creditTeamId?: unknown }
): Promise<void> {
  if (
    typeof body?.slot !== 'string' ||
    typeof body.userId !== 'string' ||
    (body.creditTeamId != null && typeof body.creditTeamId !== 'string')
  )
    throw badRequest('Choose a slot and a person')
  const league = await gameLeague(db, gameId)
  const state = await schedule(db, actor, league, 'umpire', {})
  const game = state.games.find(g => g.id === gameId)
  if (game == null) throw forbidden('This game is outside your umpire schedule')
  if (game.status === 'final')
    throw badRequest('A final game cannot accept a signup')
  if (game.assignments[body.slot] != null)
    throw conflict('That umpire slot is already filled')
  const person = await onePerson(db, body.userId)
  const choice = game.choices[body.slot]?.find(p => p.userId === person.userId)
  if (choice == null)
    throw forbidden('Choose yourself or a current player you guardian')
  if (choice.reason != null) throw conflict(choice.reason)
  let credit: string | null = null
  if (state.settings.credits) {
    if (state.creditTeams.length === 1) credit = state.creditTeams[0].id
    else if (state.creditTeams.length > 1) {
      if (!state.creditTeams.some(t => t.id === body.creditTeamId))
        throw badRequest('Choose a team to receive the credit')
      credit = String(body.creditTeamId)
    }
    if (body.creditTeamId != null && body.creditTeamId !== credit)
      throw badRequest('That team cannot receive this credit')
  }
  await db
    .insertInto('umpire_assignments')
    .values({
      game_id: gameId,
      slot: body.slot,
      user_id: person.userId,
      assigned_by: state.viewerId,
      credit_team_id: credit
    })
    .execute()
}
export async function deleteSlot(
  db: Transaction<Database>,
  actor: Actor,
  gameId: string,
  slot: unknown
): Promise<void> {
  if (typeof slot !== 'string') throw badRequest('Choose a slot')
  const league = await gameLeague(db, gameId)
  const admin = await canAdminister(db, actor, { kind: 'league', id: league })
  await umpireAccess(db, actor, league, admin ? 'league' : 'umpire')
  const assignment = await db
    .selectFrom('umpire_assignments')
    .selectAll()
    .where('game_id', '=', gameId)
    .where('slot', '=', slot)
    .executeTakeFirst()
  if (assignment == null) throw notFound('No assignment in this slot')
  if (!admin) {
    const person = await onePerson(db, actor.userId)
    const holder = await onePerson(db, assignment.user_id)
    const author = await onePerson(db, assignment.assigned_by)
    const game = await db
      .selectFrom('games')
      .select('start_at')
      .where('id', '=', gameId)
      .executeTakeFirstOrThrow()
    if (
      (person.userId !== holder.userId && person.userId !== author.userId) ||
      now() >= new Date(game.start_at).getTime() - 15 * 60000
    )
      throw forbidden('Only an administrator can remove this assignment now')
  }
  await db
    .deleteFrom('umpire_assignments')
    .where('game_id', '=', gameId)
    .where('slot', '=', slot)
    .execute()
}
export async function recheckUmpireAssignments(
  db: Transaction<Database>,
  gameId: string
): Promise<void> {
  const game = await db
    .selectFrom('games')
    .selectAll()
    .where('id', '=', gameId)
    .executeTakeFirstOrThrow()
  const assignments = await db
    .selectFrom('umpire_assignments')
    .selectAll()
    .execute()
  if (assignments.length === 0) return
  const games = await db
    .selectFrom('games')
    .selectAll()
    .where('status', '!=', 'cancelled')
    .where('withdrawn_at', 'is', null)
    .execute()
  await recheckAgainst(
    db,
    game,
    assignments,
    games,
    async id => await umpireIdentity(db, id)
  )
}

/**
 * `recheckUmpireAssignments` for each of many games, in the order they are
 * passed to the function this answers, with the same effects in the same
 * order: the assignments, the games, and the games each of `gameIds` that
 * holds an assignment overlaps, read once here instead of on every call.
 * With no assignment at all, nothing more is read and nothing is checked.
 */
export async function umpireRechecker(
  db: Transaction<Database>,
  gameIds: readonly string[]
): Promise<(gameId: string) => Promise<void>> {
  let live = await db.selectFrom('umpire_assignments').selectAll().execute()
  if (live.length === 0 || gameIds.length === 0) return async () => {}
  const targets = new Map(
    (
      await db
        .selectFrom('games')
        .selectAll()
        .where('id', 'in', gameIds)
        .execute()
    ).map(game => [game.id, game])
  )
  // A game with an assignment of its own is checked against every game it
  // overlaps; any other only against the games that hold an assignment.
  const assigned = new Set(live.map(a => a.game_id))
  const edited = [...targets.values()].filter(game => assigned.has(game.id))
  const games = await db
    .selectFrom('games')
    .selectAll()
    .where('status', '!=', 'cancelled')
    .where('withdrawn_at', 'is', null)
    .where(eb =>
      eb.or([
        eb('id', 'in', [...assigned]),
        ...edited.map(game => {
          const { startAt } = umpireInterval(game)
          // A second either side covers the database's finer clock.
          const from = new Date(Date.parse(startAt) - 1000)
          const to = new Date(umpireEnd(umpireInterval(game)) + 1000)
          return eb.and([
            eb('start_at', '<', to),
            eb(
              sql<Date>`coalesce(end_at, start_at + ${`${DEFAULT_EVENT_DURATION_MS} milliseconds`}::interval)`,
              '>',
              from
            )
          ])
        })
      ])
    )
    .execute()
  const people = new Map<string, Promise<UmpireIdentity>>()
  const identity = async (id: string): Promise<UmpireIdentity> => {
    let person = people.get(id)
    if (person == null) {
      person = umpireIdentity(db, id)
      people.set(id, person)
    }
    return await person
  }
  return async gameId => {
    const game = targets.get(gameId)
    if (game == null) throw new Error(`No game ${gameId} to recheck`)
    const removed = await recheckAgainst(db, game, live, games, identity)
    if (removed.size > 0) live = live.filter(a => !removed.has(a))
  }
}

/**
 * Takes away each of `assignments` that `game`'s time or teams now make
 * impossible, of those to `game` itself or to a game it overlaps, and
 * answers those it took away. `games` are the games not cancelled, or at
 * least those holding an assignment and, when `game` holds one, those it
 * overlaps.
 */
async function recheckAgainst(
  db: Transaction<Database>,
  game: Selectable<GamesTable>,
  assignments: Array<Selectable<UmpireAssignmentsTable>>,
  games: Array<Selectable<GamesTable>>,
  identity: (id: string) => Promise<UmpireIdentity>
): Promise<Set<Selectable<UmpireAssignmentsTable>>> {
  const gameId = game.id
  const removed = new Set<Selectable<UmpireAssignmentsTable>>()
  const byId = new Map(games.map(g => [g.id, g]))
  for (const assignment of assignments) {
    const assignedGame = byId.get(assignment.game_id)
    if (assignedGame == null) continue
    const edited = assignment.game_id === gameId
    if (
      !edited &&
      !hardUmpireConflict(umpireInterval(game), umpireInterval(assignedGame))
    )
      continue
    const person = await identity(assignment.user_id)
    const invalid = edited
      ? games.some(
          other =>
            hardUmpireConflict(umpireInterval(game), umpireInterval(other)) &&
            (umpireIsPlaying(person, other) ||
              assignments.some(
                a =>
                  a.game_id !== gameId &&
                  a.game_id === other.id &&
                  person.userIds.includes(a.user_id)
              ))
        )
      : // `game` itself is one of the games not cancelled.
        game.status !== 'cancelled' &&
        game.withdrawn_at == null &&
        umpireIsPlaying(person, game)
    if (invalid) {
      await db
        .deleteFrom('umpire_assignments')
        .where('game_id', '=', assignment.game_id)
        .where('slot', '=', assignment.slot)
        .execute()
      noteScopeChange(db, { gameId: assignment.game_id })
      removed.add(assignment)
    }
  }
  return removed
}
/**
 * A game's umpire positions and who holds each, named in full to a `reader`
 * who may read them in full and short otherwise. The league's id comes with
 * it only for a `viewer` accepted into the league, who may open its umpires'
 * league cards.
 */
export async function gameUmpires(
  db: Kysely<Database>,
  gameId: string,
  media?: MediaContext,
  reader?: Reader,
  viewer?: Actor
): Promise<UmpireGameBlock | null> {
  const row = await db
    .selectFrom('games')
    .innerJoin('seasons', 'seasons.id', 'games.season_id')
    .innerJoin('leagues', 'leagues.id', 'seasons.league_id')
    .innerJoin('season_umpire_requirements as r', 'r.season_id', 'seasons.id')
    .select([
      'seasons.id as season_id',
      'leagues.id as league_id',
      'leagues.umpire_management'
    ])
    .where('games.id', '=', gameId)
    .executeTakeFirst()
  if (row?.umpire_management !== true) return null
  const counts = await db
    .selectFrom('season_umpire_type_requirements')
    .selectAll()
    .where('season_id', '=', row.season_id)
    .execute()
  const positions = umpirePositions(
    await types(db, row.league_id),
    counts.map(c => ({
      typeId: c.type_id,
      required: c.required_count,
      optional: c.optional_count
    }))
  )
  if (positions.length === 0) return null
  const held = await db
    .selectFrom('umpire_assignments')
    .selectAll()
    .where('game_id', '=', gameId)
    .execute()
  const slots = new Map<
    string,
    {
      userId: string
      name: string
      avatarUrl: string | null
      openable?: true
    }
  >()
  // Each holder's account, avatar included, read together.
  const holders = await Promise.all(
    held.map(async assignment => await umpireIdentity(db, assignment.user_id))
  )
  const names = await readerUmpireNames(
    db,
    reader,
    holders.map(p => p.named)
  )
  // Only somebody who still umpires for the league has a card to open: a
  // revoked umpire keeps their slots on finished games. Asked first, as it
  // is cheaper than who the reader is.
  const umpiring = new Set(
    held.length > 0 && viewer != null && !isMachine(viewer)
      ? (
          await db
            .selectFrom('league_umpires')
            .select('user_id')
            .where('league_id', '=', row.league_id)
            .where(
              'user_id',
              'in',
              holders.flatMap(p => p.userIds)
            )
            .execute()
        ).map(r => r.user_id)
      : []
  )
  // A machine reader opens no cards, and may not ask who administers what;
  // with nobody umpiring in a slot there is no card to open.
  const opens =
    umpiring.size > 0 &&
    viewer != null &&
    // Membership usually accepts; administration is asked only after.
    ((await umpireAcceptance(
      db,
      row.league_id,
      await umpireFamily(db, viewer.userId),
      false
    )) ||
      (await canAdminister(db, viewer, { kind: 'league', id: row.league_id })))
  for (const [i, assignment] of held.entries()) {
    const p = holders[i]
    slots.set(assignment.slot, {
      userId: p.userId,
      name: names.get(p.userId) ?? p.name,
      avatarUrl: media == null ? null : imageUrl(media.space, p.avatarPath),
      ...(opens && p.userIds.some(id => umpiring.has(id))
        ? { openable: true as const }
        : {})
    })
  }
  return {
    positions: positions.map(p => ({
      ...p,
      person: slots.get(p.slot) ?? null
    })),
    ...(opens ? { leagueId: row.league_id } : {})
  }
}
interface LeaderboardCounts {
  userId: string
  name: string
  completed: number
  scheduled: number
}
export async function leaderboard(
  db: Kysely<Database>,
  actor: Actor,
  leagueId: string,
  query?: UmpireLeaderboardQuery
): Promise<UmpireLeaderboard> {
  const admin = await canAdminister(db, actor, { kind: 'league', id: leagueId })
  await umpireAccess(db, actor, leagueId, admin ? 'league' : 'umpire')
  // Any umpire sees the top ten; the whole list is as private as the roster.
  if (query != null && !admin)
    throw forbidden('Only a league administrator can page the leaderboard')
  const league = await db
    .selectFrom('leagues')
    .select('umpire_credits')
    .where('id', '=', leagueId)
    .executeTakeFirstOrThrow()
  const rows = await db
    .selectFrom('umpire_assignments as a')
    .innerJoin('games as g', 'g.id', 'a.game_id')
    .innerJoin('seasons as s', 's.id', 'g.season_id')
    .select(['a.user_id', 'a.credit_team_id', 'g.status'])
    .where('s.league_id', '=', leagueId)
    .where('g.status', 'in', ['scheduled', 'inProgress', 'final'])
    .where('g.withdrawn_at', 'is', null)
    .execute()
  const counts = new Map<string, LeaderboardCounts>()
  const page =
    query == null
      ? undefined
      : {
          order: query.order ?? ('desc' as const),
          limit: query.limit ?? UMPIRE_LEADERBOARD_MAX_PAGE,
          offset: query.offset ?? 0
        }
  const identities = new Map<string, UmpireIdentity>()
  for (const row of rows) {
    let p = identities.get(row.user_id)
    if (p == null) {
      p = await umpireIdentity(db, row.user_id)
      for (const alias of p.userIds) identities.set(alias, p)
    }
    const held = counts.get(p.userId) ?? {
      userId: p.userId,
      name: p.name,
      completed: 0,
      scheduled: 0
    }
    held.scheduled++
    if (row.status === 'final') held.completed++
    counts.set(p.userId, held)
  }
  // A page is named as the roster names its people, and holds them all.
  // Every entry keeps the default answer's name to sort on; the reader's
  // full names are only what it shows.
  const roster = page == null ? [] : await people(db, leagueId)
  const rosterNames = new Map(roster.map(p => [p.id, p.name]))
  for (const p of roster)
    if (!counts.has(p.id))
      counts.set(p.id, {
        userId: p.id,
        name: p.name,
        completed: 0,
        scheduled: 0
      })
  // Whom the rows above loaded are named from their accounts; a roster
  // entry with no assignment is read only if the reader reads it in full.
  const loaded = [...new Set(identities.values())]
  const readerNames = await readerUmpireNames(
    db,
    readerOf(actor),
    loaded.map(p => p.named),
    [...counts.keys()].filter(id => !identities.has(id))
  )
  const rank = (key: 'completed' | 'scheduled'): UmpireRank[] => {
    // Ties break on the default answer's name, so a page lists the top ten in
    // the order of its symbols, whatever name it shows them under.
    const ordered = (direction: 1 | -1): LeaderboardCounts[] =>
      [...counts.values()].sort((a, b) => {
        if (a[key] !== b[key]) return direction * (a[key] - b[key])
        const name = a.name.localeCompare(b.name)
        return name === 0 ? a.userId.localeCompare(b.userId) : name
      })
    const top = ordered(-1)
      .filter(p => p[key] > 0)
      .slice(0, 10)
    const symbolOf = new Map(
      top.map((p, i) => [p.userId, UMPIRE_RANK_SYMBOLS[i]])
    )
    const listed =
      page == null
        ? top
        : ordered(page.order === 'asc' ? 1 : -1).slice(
            page.offset,
            page.offset + page.limit
          )
    return listed.map(p => ({
      userId: p.userId,
      name: readerNames.get(p.userId) ?? rosterNames.get(p.userId) ?? p.name,
      count: p[key],
      symbol: symbolOf.get(p.userId) ?? ''
    }))
  }
  const teams = league.umpire_credits
    ? await db
        .selectFrom('teams')
        .innerJoin('season_teams as st', 'st.team_id', 'teams.id')
        .innerJoin('seasons as s', 's.id', 'st.season_id')
        .select(['teams.id', 'teams.name'])
        .where('s.league_id', '=', leagueId)
        .distinct()
        .execute()
    : null
  return {
    completed: rank('completed'),
    scheduled: rank('scheduled'),
    teams:
      teams == null
        ? null
        : teams
            .map(t => ({
              ...t,
              count: rows.filter(r => r.credit_team_id === t.id).length
            }))
            .sort((a, b) => {
              const count = b.count - a.count
              return count === 0 ? a.name.localeCompare(b.name) : count
            }),
    ...(page == null ? {} : { page: { ...page, total: counts.size } })
  }
}
