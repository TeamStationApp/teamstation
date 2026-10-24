import { type Kysely, type RawBuilder, sql } from 'kysely'

import { conflict, HttpError } from '../../common/errors'
import { storedGuests } from '../../common/guests'
import type { CurrentPlay, GumboPlay } from '../../common/gumboPlay'
import { applyAction } from '../../common/scoring/apply'
import { replayPlays, storedRecordOf } from '../../common/scoring/gumbo'
import { nextDecision } from '../../common/scoring/rules'
import type { SessionContext, StoredGame } from '../../common/scoring/session'
import type { GameState } from '../../common/scoring/state'
import { teamsOfRow } from '../../common/teamLists'
import { storedUnrostered } from '../../common/unroster'
import type { Database } from '../db/database'
import { resolveGumboIds } from './gumboIds'
import {
  projectScoringGame,
  resolveScoringGame,
  scoringIdsIn,
  ScoringProjectionConflict
} from './openRow'
import { contextOf } from './replayContext'

/** Imported documents do not carry enough information to replay every role. */
function assertAffectedHistoryRecorded(
  stored: StoredGame,
  gameId: string,
  affected: ReadonlySet<number>
): void {
  for (const document of [...stored.plays, stored.currentPlay]) {
    if (document == null || storedRecordOf(document) != null) continue
    const ids = scoringIdsIn({
      plays: [],
      currentPlay: document as CurrentPlay
    }).filter(id => affected.has(id))
    if (ids.length === 0) continue
    throw conflict(
      `Cannot verify saved scoring history in game ${gameId}, ` +
        `plate appearance ${document.about.atBatIndex + 1}: scoring actions are unavailable`,
      {
        gameId,
        atBatIndex: document.about.atBatIndex,
        inning: document.about.inning ?? null,
        halfInning: document.about.halfInning ?? null,
        gumboIds: ids
      }
    )
  }
}

/** Physical roles must remain distinct even when their account names change. */
export function assertDistinctScoringRoles(
  stored: StoredGame,
  context: SessionContext,
  resolve: ReadonlyMap<number, number>,
  fallback?: StoredGame
): void {
  const aliases = new Map<number, number[]>()
  for (const [source, target] of resolve)
    aliases.set(target, [...(aliases.get(target) ?? []), source])
  const inspect = (
    state: GameState,
    atBatIndex: number,
    canonical: boolean
  ): void => {
    const line = state.liveData.linescore
    const roles = ['batter', 'first', 'second', 'third'] as const
    const occupants = roles.flatMap(role => {
      // Canonical replay leaves the next appearance unopened when its batter
      // is on base. That is still a conflicting due-batter role.
      const due = role === 'batter' ? state.awaitingBatter?.duePlayerId : null
      const player =
        due == null ? line.offense[role] : state.gameData.players[due]
      return player == null
        ? []
        : [{ role, gumboId: player.id, name: player.fullName }]
    })
    if (state.awaitingBatter != null)
      atBatIndex = state.liveData.plays.allPlays.length
    for (const [index, person] of occupants.entries()) {
      const other = occupants.slice(index + 1).find(other =>
        canonical
          ? other.gumboId === person.gumboId &&
            (aliases.get(person.gumboId)?.length ?? 0) > 1 &&
            // A batter who just reached base is still the play's batter.
            !(person.role === 'batter' && state.pending != null)
          : other.gumboId !== person.gumboId &&
            resolve.get(other.gumboId) === resolve.get(person.gumboId)
      )
      if (other == null) continue
      const half = line.isTopInning ? 'top' : 'bottom'
      throw conflict(
        `These accounts occupy different roles in game ${context.gamePk}, ` +
          `${half} of inning ${line.currentInning}, plate appearance ${atBatIndex + 1}`,
        {
          gameId: context.gamePk,
          atBatIndex,
          inning: line.currentInning,
          halfInning: half,
          outs: line.outs,
          participants: [person, other],
          ...(canonical ? { gumboIds: aliases.get(person.gumboId) } : {})
        }
      )
    }
  }
  const check = (game: StoredGame, canonical: boolean): boolean => {
    const replayed = replayPlays(
      game,
      context,
      (state, index, _time, _action, before) => {
        inspect(before, index, canonical)
        inspect(state, index, canonical)
      }
    )
    if (replayed.problems.length > 0) return false
    // A terminal award can remain open until the next pitch. Check the next
    // appearance too, but only at the end: a later recorded endHalf may have
    // cleared the bases before the next batter was ever due.
    if (nextDecision(replayed.state) === 'close') {
      const advanced = applyAction(
        replayed.state,
        { type: 'gameFlow', kind: 'closePlay' },
        { replay: true }
      )
      if (advanced.problems.length > 0) return false
      inspect(
        advanced.state,
        advanced.state.liveData.plays.currentPlay?.about.atBatIndex ??
          advanced.state.liveData.plays.allPlays.length,
        canonical
      )
    }
    return true
  }
  // A later save may already use canonical IDs while earlier plays retain
  // aliases. Its canonical replay must pass the same role/continuation checks.
  if (!check(stored, false) && (fallback == null || !check(fallback, true)))
    throw conflict(
      `Cannot verify saved scoring history in game ${context.gamePk}`
    )
}

/** Check the roster a new scoring session would receive after this merge. */
async function assertMergeAvailabilitySafe(
  db: Kysely<Database>,
  users: string[],
  ids: number[]
): Promise<void> {
  const memberships = await db
    .selectFrom('memberships')
    .innerJoin('users', 'users.id', 'memberships.user_id')
    .innerJoin('gumbo_ids', 'gumbo_ids.user_id', 'users.id')
    .select(['team_id', 'gumbo_id'])
    .where('memberships.user_id', 'in', users)
    .where('is_player', '=', true)
    .where('merged_into', 'is', null)
    .execute()
  const teams = [...new Set(memberships.map(row => row.team_id))]
  const family = new Set(ids)
  const games = await db
    .selectFrom('games')
    .select(['id', 'home_team_id', 'away_team_id', 'guests', 'unrostered'])
    .where(eb =>
      eb.or([
        sql<boolean>`jsonb_path_exists(guests, ${`$.** ? (${ids.map(id => `@ == ${id}`).join(' || ')})`}::jsonpath)`,
        ...(teams.length === 0
          ? []
          : [eb('home_team_id', 'in', teams), eb('away_team_id', 'in', teams)])
      ])
    )
    .orderBy('id')
    .execute()
  for (const game of games) {
    const guests = storedGuests(game.guests, teamsOfRow(game))
    const excluded = storedUnrostered(game.unrostered, teamsOfRow(game))
    const participants = (['away', 'home'] as const).flatMap(side => {
      const teamId = game[`${side}_team_id`]
      const members = memberships.filter(row => row.team_id === teamId)
      // Membership takes precedence over a guest entry, including when the
      // member is excluded. Exclusions follow every earlier account alias.
      const available =
        members.length > 0
          ? excluded[side].some(id => family.has(id))
            ? []
            : members.map(row => row.gumbo_id)
          : guests[side].filter(id => family.has(id))
      return available.length === 0
        ? []
        : [{ side, teamId, gumboIds: available }]
    })
    if (participants.length === 2)
      throw conflict(
        `Cannot merge accounts in game ${game.id}: the player would be available for opposing teams`,
        { gameId: game.id, participants }
      )
  }
}

/** Called with the merge lock held, before the first account mutation. */
export async function assertMergeScoringSafe(
  db: Kysely<Database>,
  closingUsers: string[],
  keepingUsers: string[]
): Promise<void> {
  const rows = await db
    .selectFrom('gumbo_ids')
    .selectAll()
    .where('user_id', 'in', [...new Set([...closingUsers, ...keepingUsers])])
    .execute()
  const closing = rows
    .filter(row => closingUsers.includes(row.user_id))
    .map(row => row.gumbo_id)
  const keeping = rows
    .filter(row => keepingUsers.includes(row.user_id))
    .map(row => row.gumbo_id)
  if (closing.length === 0 || keeping.length === 0) return
  await assertMergeAvailabilitySafe(
    db,
    [...new Set([...closingUsers, ...keepingUsers])],
    [...closing, ...keeping]
  )
  const path = (ids: number[]): string =>
    `$.** ? (${ids.map(id => `@ == ${id}`).join(' || ')})`
  const matches = (column: string, ids: number[]): RawBuilder<boolean> =>
    sql<boolean>`jsonb_path_exists(${sql.ref(column)}, ${path(ids)}::jsonpath)`
  // Candidate selection includes benched aliases and action-only references.
  // Read full games only when both account families appear in their history.
  const games = await db
    .selectFrom('games')
    .select(['id', 'home_team_id', 'away_team_id', 'currentPlay'])
    .where(eb =>
      eb.or([
        matches('games.currentPlay', closing),
        eb.exists(
          eb
            .selectFrom('events')
            .select('id')
            .whereRef('events.gameId', '=', 'games.id')
            .where(matches('events.gumbo', closing))
        )
      ])
    )
    .where(eb =>
      eb.or([
        matches('games.currentPlay', keeping),
        eb.exists(
          eb
            .selectFrom('events')
            .select('id')
            .whereRef('events.gameId', '=', 'games.id')
            .where(matches('events.gumbo', keeping))
        )
      ])
    )
    .orderBy('id')
    .execute()
  for (const game of games) {
    const plays = await db
      .selectFrom('events')
      .select('gumbo')
      .where('gameId', '=', game.id)
      .orderBy('atBatIndex')
      .execute()
    const stored: StoredGame = {
      plays: plays.map(row => row.gumbo as GumboPlay),
      currentPlay: game.currentPlay as CurrentPlay | null
    }
    const resolved = await resolveGumboIds(db, scoringIdsIn(stored))
    const family = new Set(
      [...closing, ...keeping].map(id => resolved.get(id) ?? id)
    )
    const projected = await resolveScoringGame(db, stored)
    const affected = new Set(
      scoringIdsIn(projected).filter(id => family.has(id))
    )
    // The JSON candidate query also matches non-identity numbers.
    if (affected.size < 2) continue
    assertAffectedHistoryRecorded(projected, game.id, affected)
    const context = await contextOf(db, game.id, game, projected)
    if (context == null)
      throw conflict(`Cannot verify saved scoring history in game ${game.id}`)
    const prospective = new Map(
      scoringIdsIn(projected).map(id => [id, family.has(id) ? keeping[0] : id])
    )
    assertDistinctScoringRoles(projected, context, prospective)
    // Validate exactly what subsequent reads and replay would receive, before
    // any merge mutation. This also checks saved roster and guest additions.
    try {
      const merged = projectScoringGame(projected, id => prospective.get(id)!)
      if (replayPlays(merged, context).problems.length > 0)
        throw conflict('The merged scoring history cannot be replayed')
    } catch (error) {
      if (
        !(error instanceof ScoringProjectionConflict) &&
        (!(error instanceof HttpError) || error.code !== 'conflict')
      )
        throw error
      throw conflict(
        `Cannot merge accounts in game ${game.id}: ${error.message}`,
        {
          ...(error.details as object),
          gameId: game.id
        }
      )
    }
  }
}

/** A stale scoring writer must not introduce an overlap after a merge committed. */
export async function assertStoredScoringRoles(
  db: Kysely<Database>,
  game: { id: string; home_team_id: string; away_team_id: string },
  stored: StoredGame,
  projected?: StoredGame
): Promise<void> {
  const ids = scoringIdsIn(stored)
  if (ids.length === 0) return
  // External writers retain the existing database error for an unknown ID.
  // Check all known aliases even if that invalid post also names unknown IDs.
  const known =
    projected == null
      ? (
          await db
            .selectFrom('gumbo_ids')
            .select('gumbo_id')
            .where('gumbo_id', 'in', ids)
            .execute()
        ).map(row => row.gumbo_id)
      : ids
  const resolved = await resolveGumboIds(db, known)
  if (new Set(resolved.values()).size === resolved.size) return
  const counts = new Map<number, number>()
  for (const id of resolved.values()) counts.set(id, (counts.get(id) ?? 0) + 1)
  const affected = new Set(
    [...resolved]
      .filter(([, target]) => counts.get(target)! > 1)
      .map(([id]) => id)
  )
  assertAffectedHistoryRecorded(stored, game.id, affected)
  const context = await contextOf(db, game.id, game, stored)
  if (context != null)
    assertDistinctScoringRoles(stored, context, resolved, projected)
}
