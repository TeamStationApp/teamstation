import { type Kysely, type RawBuilder, sql } from 'kysely'

import { conflict, HttpError } from '../../common/errors'
import type { CurrentPlay, GumboPlay } from '../../common/gumboPlay'
import { recordOf, replayPlays } from '../../common/scoring/gumbo'
import type { SessionContext, StoredGame } from '../../common/scoring/session'
import type { GameState } from '../../common/scoring/state'
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
    if (document == null || recordOf(document) != null) continue
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
  const inspect = (state: GameState, atBatIndex: number): void => {
    const line = state.liveData.linescore
    const roles = ['batter', 'first', 'second', 'third'] as const
    const occupants = roles.flatMap(role => {
      const player = line.offense[role]
      return player == null
        ? []
        : [{ role, gumboId: player.id, name: player.fullName }]
    })
    for (const [index, person] of occupants.entries()) {
      const other = occupants.slice(index + 1).find(
        other =>
          // A batter who just reached base is still the play's batter.
          other.gumboId !== person.gumboId &&
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
          participants: [person, other]
        }
      )
    }
  }
  const replayed = replayPlays(
    stored,
    context,
    (state, index, _time, _action, before) => {
      inspect(before, index)
      inspect(state, index)
    }
  )
  // A later save may already use canonical IDs while earlier plays retain
  // aliases. Only accept that mixed history when its canonical replay works.
  if (
    replayed.problems.length > 0 &&
    (fallback == null || replayPlays(fallback, context).problems.length > 0)
  )
    throw conflict(
      `Cannot verify saved scoring history in game ${context.gamePk}`
    )
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
