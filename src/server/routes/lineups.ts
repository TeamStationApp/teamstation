import { Router } from 'express'
import type { Kysely } from 'kysely'

import type { DjBatter, DjGame, DjSide } from '../../common/api'
import { atBatFromCurrentPlay } from '../../common/djAtBat'
import { notFound, unauthorized } from '../../common/errors'
import { shortNames } from '../../common/names'
import {
  type Lineup,
  NO_DEFAULT_LINEUP
} from '../../common/scoring/lineupHistory'
import type { Side } from '../../common/scoring/state'
import {
  canKeepSongs,
  canSeeGame,
  canSeeTeam,
  roleScopes,
  visibleScopes
} from '../access'
import type { Database } from '../db/database'
import {
  defaultOf,
  gameLineups,
  type TeamSideLineups
} from '../events/teamLineups'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'
import { teamWalkUpSongs } from './walkUpSongs'

/**
 * Lineups, read back out of what TeamStation stores.
 *
 * `GET /teams/:teamId/default-lineup` is the team's default lineup: the
 * starting lineup of the last game scored here that began with a different
 * one, with that game's id and when it was taken, or all three null. It
 * needs somebody who can see the team.
 *
 * `GET /games/:gameId/lineups` is each side's lineups in the game: the one it
 * began with (null until the game has begun), every substitution the stored
 * plays announce, and the lineup as it stands now, including a change not
 * announced yet. A game TeamStation did not score, or whose record no longer
 * replays, has only its announced changes. It needs somebody who can see the
 * game; anybody else gets 404.
 *
 * `GET /games/:gameId/dj` is what DJ Game lists: each side's batters in
 * order, with their walk-up songs on that team. The order is the game's own
 * lineup as it stands once TeamStation has a record of it (`'lineup'`), the
 * team's default before that (`'default'`), and otherwise the team's players
 * by jersey number, then name (`'roster'`). `canEditWalkUp` says whether the
 * caller keeps that team's songs. Game lineups share game visibility;
 * defaults and rosters require team visibility.
 */
export function lineupRoutes(db: Kysely<Database>): Router {
  const router = Router()

  router.get(
    '/teams/:teamId/default-lineup',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const teamId = pathParam(req.params.teamId)
      const scopes = await visibleScopes(db, actor.userId, actor.isAdmin)
      if (!canSeeTeam(scopes, teamId)) throw notFound()
      const team = await db
        .selectFrom('teams')
        .select('default_lineup')
        .where('id', '=', teamId)
        .executeTakeFirst()
      if (team == null) throw notFound()
      res.json(defaultOf(team.default_lineup) ?? NO_DEFAULT_LINEUP)
    })
  )

  router.get(
    '/games/:gameId/lineups',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const gameId = pathParam(req.params.gameId)
      const game = await db
        .selectFrom('games')
        .select(['home_team_id', 'away_team_id', 'season_id', 'currentPlay'])
        .where('id', '=', gameId)
        .executeTakeFirst()
      if (game == null) throw notFound()
      const scopes = await visibleScopes(db, actor.userId, actor.isAdmin)
      if (
        !canSeeGame(scopes, {
          homeTeamId: game.home_team_id,
          awayTeamId: game.away_team_id,
          seasonId: game.season_id
        })
      )
        throw notFound()
      res.json(
        await gameLineups(db, {
          id: gameId,
          home_team_id: game.home_team_id,
          away_team_id: game.away_team_id,
          currentPlay: game.currentPlay
        })
      )
    })
  )

  router.get(
    '/games/:gameId/dj',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const gameId = pathParam(req.params.gameId)
      const game = await db
        .selectFrom('games')
        .select(['home_team_id', 'away_team_id', 'season_id', 'currentPlay'])
        .where('id', '=', gameId)
        .executeTakeFirst()
      if (game == null) throw notFound()
      const scopes = await visibleScopes(db, actor.userId, actor.isAdmin)
      if (
        !canSeeGame(scopes, {
          homeTeamId: game.home_team_id,
          awayTeamId: game.away_team_id,
          seasonId: game.season_id
        })
      )
        throw notFound()
      const roles = await roleScopes(db, actor.userId, actor.isAdmin)
      const lineups = await gameLineups(db, {
        id: gameId,
        home_team_id: game.home_team_id,
        away_team_id: game.away_team_id,
        currentPlay: game.currentPlay
      })
      const side = async (which: Side): Promise<DjSide> => {
        const read = lineups[which]
        return {
          teamId: read.teamId,
          teamName: read.teamName,
          canEditWalkUp: canKeepSongs(roles, read.teamId),
          ...(await djBatters(db, read, canSeeTeam(scopes, read.teamId)))
        }
      }
      const answer: DjGame = {
        away: await side('away'),
        home: await side('home'),
        atBat: atBatFromCurrentPlay(game.currentPlay)
      }
      res.json(answer)
    })
  )

  return router
}

/**
 * One side's batters for DJ Game, and where they came from, each with his
 * walk-up song on that team. A placeholder has none.
 */
async function djBatters(
  db: Kysely<Database>,
  read: TeamSideLineups,
  maySeeTeam: boolean
): Promise<Pick<DjSide, 'source' | 'batters'>> {
  // Game visibility shares this game’s lineup, never an unrelated team default
  // or roster. Check before querying either fallback or its private songs.
  if (read.current == null && !maySeeTeam)
    return { source: 'roster', batters: [] }
  const songs = await teamWalkUpSongs(db, read.teamId)
  const withSongs = (lineup: Lineup): DjBatter[] =>
    lineup.batters.map(person => ({
      userId: person.userId,
      name: person.name,
      walkUpSong:
        person.userId == null ? null : (songs.get(person.userId) ?? null)
    }))
  if (read.current != null) {
    return { source: 'lineup', batters: withSongs(read.current) }
  }
  const team = await db
    .selectFrom('teams')
    .select('default_lineup')
    .where('id', '=', read.teamId)
    .executeTakeFirst()
  const kept = defaultOf(team?.default_lineup)
  if (kept?.lineup != null) {
    return { source: 'default', batters: withSongs(kept.lineup) }
  }
  const rows = await db
    .selectFrom('memberships')
    .innerJoin('users', 'users.id', 'memberships.user_id')
    .select([
      'memberships.user_id as userId',
      'users.display_name as displayName',
      'users.first_name as firstName',
      'users.last_name as lastName',
      'memberships.jersey as jersey'
    ])
    .where('memberships.team_id', '=', read.teamId)
    .where('memberships.is_player', '=', true)
    .where('users.merged_into', 'is', null)
    .execute()
  const names = shortNames(
    rows.map(row => ({
      id: row.userId,
      firstName: row.firstName,
      lastName: row.lastName,
      displayName: row.displayName
    }))
  )
  const nameOf = (row: (typeof rows)[number]): string =>
    names.get(row.userId) ?? row.displayName
  const batters = [...rows]
    .sort((a, b) => {
      const byJersey = jerseyNumber(a.jersey) - jerseyNumber(b.jersey)
      return byJersey !== 0 ? byJersey : nameOf(a).localeCompare(nameOf(b))
    })
    .map(row => ({
      userId: row.userId,
      name: nameOf(row),
      walkUpSong: songs.get(row.userId) ?? null
    }))
  return { source: 'roster', batters }
}

/** A jersey as a number to sort by; none, or not a number, sorts last. */
function jerseyNumber(jersey: string | null): number {
  const number = jersey == null ? NaN : Number.parseInt(jersey, 10)
  return Number.isFinite(number) ? number : Number.MAX_SAFE_INTEGER
}

function pathParam(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || value === '') throw notFound()
  return value
}
