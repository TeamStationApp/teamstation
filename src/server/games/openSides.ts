import type { Kysely } from 'kysely'

import { forbidden, updateRequired } from '../../common/errors'
import { makeId } from '../../common/ids'
import { namedTeamIds, OPEN_SIDE_NAME } from '../../common/openSides'
import { OPEN_SIDES_FEATURE } from '../../common/scoring/teamRecord'
import { canScore, type RoleScopes, roleScopes } from '../access'
import { type Actor, isHumanSession } from '../auth/sessions'
import { lockKeys } from '../db/advisoryLocks'
import { atomic } from '../db/atomic'
import type { Database } from '../db/database'
import { requireVisibleGame } from '../events/requireVisibleGame'
import { type Clock, realClock } from '../groups/requests'
import { notifyGameChange } from '../socket/gameChanges'
import { noteGameFigures } from '../socket/syncRevision'
import type { GameSideIds } from './namedSides'

/** The refusal of an app that cannot yet score a game with an open side. */
export const OPEN_SIDES_UPDATE =
  'Update TeamStation to score a game whose team is TBD.'

/** The refusal of a first scoring write by somebody who may not score. */
export const OPEN_SIDES_FORBIDDEN =
  'Only a scorekeeper of this game may start scoring it'

/**
 * Whether these roles may start scoring a game whose side is open, and so
 * make its TBD placeholders: whoever scores one of its named teams, a site
 * administrator, or, for a game in a season, a scorekeeper of the season.
 */
export function mayScoreOpenSide(
  roles: RoleScopes,
  game: GameSideIds & { season_id: string | null }
): boolean {
  if (roles.isAdmin) return true
  if (
    namedTeamIds(game.home_team_id, game.away_team_id).some(teamId =>
      canScore(roles, teamId)
    )
  )
    return true
  return (
    game.season_id != null && roles.scorekeeper.seasonIds.has(game.season_id)
  )
}

/** A game's sides before and after `fillOpenSides` filled them. */
export interface FilledSides {
  before: { home: string | null; away: string | null }
  after: { home: string; away: string }
}

/**
 * Gives each open side of the game a new placeholder team named TBD, before
 * the first scoring write on it: a lineup, a guest, the players left off, a
 * play or a swap. Answers `undefined`, and changes nothing, when no side is
 * open.
 *
 * A person's app that does not name `OPEN_SIDES_FEATURE` in its scoring
 * features reads the open side as a team `''`, so its write is refused as
 * needing an update; an API key, a machine token or Tess writes as it
 * would. Then only somebody who `mayScoreOpenSide` fills it.
 *
 * Each placeholder is an `external` team kept by the game's season, or by
 * its named team when it has no season. A season's placeholder is under the
 * season (`season_team_parents`) so the season's scorekeepers score it, but
 * is no participant of it (no `season_teams` row): it is in no standings and
 * asks no consent. The game's teams' lists and screens are told, as for any
 * change of a side.
 */
export async function fillOpenSides(
  db: Kysely<Database>,
  gameId: string,
  actor: Actor,
  clock: Clock = realClock,
  features: string | undefined = undefined,
  /**
   * Who else the write lets fill the game, beyond `mayScoreOpenSide`: a
   * lineup save lets whoever may save the named side's lineup.
   */
  mayAlsoFill?: (
    roles: RoleScopes,
    game: GameSideIds & { season_id: string | null }
  ) => boolean
): Promise<FilledSides | undefined> {
  if (!(await seenOpen(db, gameId))) return undefined
  return await atomic(db, async trx => {
    await lockKeys(trx, ['creation:parent-graph', `game:${gameId}`])
    const game = await trx
      .selectFrom('games')
      .select(['home_team_id', 'away_team_id', 'season_id'])
      .where('id', '=', gameId)
      .forUpdate()
      .executeTakeFirst()
    // Another write filled it while this one waited, or it is gone, which
    // the write that follows answers.
    if (
      game == null ||
      (game.home_team_id != null && game.away_team_id != null)
    )
      return undefined
    if (
      isHumanSession(actor) &&
      !(features ?? '')
        .split(',')
        .map(feature => feature.trim())
        .includes(OPEN_SIDES_FEATURE)
    )
      throw updateRequired(OPEN_SIDES_UPDATE)
    const roles = await roleScopes(trx, actor.userId, actor.isAdmin)
    if (!mayScoreOpenSide(roles, game) && mayAlsoFill?.(roles, game) !== true)
      throw forbidden(OPEN_SIDES_FORBIDDEN)
    const named = namedTeamIds(game.home_team_id, game.away_team_id)
    const season =
      game.season_id == null
        ? undefined
        : await trx
            .selectFrom('seasons')
            .select(['id', 'league_id'])
            .where('id', '=', game.season_id)
            .executeTakeFirstOrThrow()
    const placeholder = async (): Promise<string> => {
      const id = makeId('team')
      await trx
        .insertInto('teams')
        .values({
          id,
          name: OPEN_SIDE_NAME,
          kind: 'external',
          created_from: 'manual',
          league_id: season?.league_id ?? null,
          custodian_type: season == null ? 'team' : 'season',
          custodian_id: season?.id ?? named[0]
        })
        .execute()
      if (season != null)
        await trx
          .insertInto('season_team_parents')
          .values({ team_id: id, season_id: season.id })
          .execute()
      return id
    }
    const after = {
      home: game.home_team_id ?? (await placeholder()),
      away: game.away_team_id ?? (await placeholder())
    }
    await trx
      .updateTable('games')
      .set({
        home_team_id: after.home,
        away_team_id: after.away,
        updated_at: clock.now()
      })
      .where('id', '=', gameId)
      .execute()
    // The named team's lists and the new teams' show the game, and every
    // screen holding it reads its sides again.
    await notifyGameChange(trx, { game: gameId, kind: 'game' })
    await noteGameFigures(trx, gameId, game)
    return {
      before: { home: game.home_team_id, away: game.away_team_id },
      after
    }
  })
}

/**
 * Whether the game, read without a lock, has an open side. A side, once
 * named, is never open again: a game read with both named needs no lock,
 * which every write to every named game would otherwise take.
 */
async function seenOpen(
  db: Kysely<Database>,
  gameId: string
): Promise<boolean> {
  const seen = await db
    .selectFrom('games')
    .select(['home_team_id', 'away_team_id'])
    .where('id', '=', gameId)
    .executeTakeFirst()
  return (
    seen != null && (seen.home_team_id == null || seen.away_team_id == null)
  )
}

/**
 * `fillOpenSides` before a scoring route's write, with the scoring features
 * its request names, for a route that settles who may see the game in its
 * own write: a game with an open side is filled only once its caller may see
 * it (404 otherwise), and a named game is left to the write.
 */
export async function fillVisibleOpenSides(
  db: Kysely<Database>,
  actor: Actor,
  gameId: string,
  features: string | undefined
): Promise<FilledSides | undefined> {
  if (!(await seenOpen(db, gameId))) return undefined
  await requireVisibleGame(db, actor.userId, actor.isAdmin, gameId)
  return await fillOpenSides(db, gameId, actor, realClock, features)
}
