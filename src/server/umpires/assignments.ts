import type { Kysely, Transaction } from 'kysely'

import { badRequest, conflict, forbidden, notFound } from '../../common/errors'
import {
  UMPIRE_RANK_SYMBOLS,
  type UmpireGameBlock,
  type UmpireLeaderboard
} from '../../common/umpireSchedule'
import { hardUmpireConflict } from '../../common/umpireTime'
import { onePerson } from '../admin/people'
import type { Actor } from '../auth/sessions'
import { now } from '../clock'
import type { Database } from '../db/database'
import { canAdminister } from '../groups/rights'
import {
  type UmpireIdentity,
  umpireIdentity,
  umpireInterval,
  umpireIsPlaying
} from './context'
import { schedule, umpireAccess } from './schedule'

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
    const person = await umpireIdentity(db, assignment.user_id)
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
      : byId.has(gameId) && umpireIsPlaying(person, game)
    if (invalid)
      await db
        .deleteFrom('umpire_assignments')
        .where('game_id', '=', assignment.game_id)
        .where('slot', '=', assignment.slot)
        .execute()
  }
}
export async function gameUmpires(
  db: Kysely<Database>,
  gameId: string
): Promise<UmpireGameBlock | null> {
  const row = await db
    .selectFrom('games')
    .innerJoin('seasons', 'seasons.id', 'games.season_id')
    .innerJoin('leagues', 'leagues.id', 'seasons.league_id')
    .innerJoin('season_umpire_requirements as r', 'r.season_id', 'seasons.id')
    .select(['r.plate', 'r.field_count', 'leagues.umpire_management'])
    .where('games.id', '=', gameId)
    .executeTakeFirst()
  if (
    row == null ||
    !row.umpire_management ||
    (!row.plate && row.field_count === 0)
  )
    return null
  const held = await db
    .selectFrom('umpire_assignments')
    .selectAll()
    .where('game_id', '=', gameId)
    .execute()
  const slots = new Map<string, { userId: string; name: string }>()
  for (const assignment of held) {
    const p = await umpireIdentity(db, assignment.user_id)
    slots.set(assignment.slot, { userId: p.userId, name: p.name })
  }
  return {
    plateNeeded: row.plate,
    plate: row.plate ? (slots.get('plate') ?? null) : null,
    fieldCount: row.field_count,
    field: Array.from(
      { length: row.field_count },
      (_, i) => slots.get(`field:${i + 1}`) ?? null
    )
  }
}
export async function leaderboard(
  db: Kysely<Database>,
  actor: Actor,
  leagueId: string
): Promise<UmpireLeaderboard> {
  const admin = await canAdminister(db, actor, { kind: 'league', id: leagueId })
  await umpireAccess(db, actor, leagueId, admin ? 'league' : 'umpire')
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
  const counts = new Map<
    string,
    { userId: string; name: string; completed: number; scheduled: number }
  >()
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
  const rank = (
    key: 'completed' | 'scheduled'
  ): UmpireLeaderboard['completed'] =>
    [...counts.values()]
      .filter(p => p[key] > 0)
      .sort((a, b) => {
        const count = b[key] - a[key]
        if (count !== 0) return count
        const name = a.name.localeCompare(b.name)
        return name === 0 ? a.userId.localeCompare(b.userId) : name
      })
      .slice(0, 10)
      .map((p, i) => ({
        userId: p.userId,
        name: p.name,
        count: p[key],
        symbol: UMPIRE_RANK_SYMBOLS[i]
      }))
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
            })
  }
}
