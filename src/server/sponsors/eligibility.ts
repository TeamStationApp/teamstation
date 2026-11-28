import { createHash } from 'node:crypto'

import type { Kysely } from 'kysely'

import { guardedRows, teamsPlayedOnNow } from '../access'
import { onePerson } from '../admin/people'
import { anyOf } from '../db/anyOf'
import type { Database } from '../db/database'

/** A game's two sides, one of which sponsors what a viewer sees. */
export type SponsorSide = 'home' | 'away'

/**
 * Where a viewer belongs, as written and not carried down: the teams they
 * are a member of or hold a role on (or their guarded child plays on now),
 * and the seasons and leagues they are a member of or hold a role on.
 *
 * Not carried down, because a league's admin is not associated with each of
 * its teams: only with those of a game in one of the league's own seasons.
 */
export interface ViewerAssociation {
  teamIds: ReadonlySet<string>
  seasonIds: ReadonlySet<string>
  leagueIds: ReadonlySet<string>
}

/** What the pick reads of a game: its teams', season's and leagues' ids. */
export interface SponsorGame {
  id: string
  /** Null for an open side: no team, so no league sponsors it. */
  homeTeamId: string | null
  awayTeamId: string | null
  seasonId: string | null
  /** The league of the game's season, which may be neither team's. */
  seasonLeagueId: string | null
  /** Each team's own league (`teams.league_id`), which sponsors it. */
  homeLeagueId: string | null
  awayLeagueId: string | null
}

/**
 * The neutral viewer's side: the lowest bit of the last byte of
 * sha256(`gameId:viewerId`), 0 for home and 1 for away. The same viewer
 * gets the same side of a game on every read and every device.
 */
export function pickSide(gameId: string, viewerId: string): SponsorSide {
  const digest = createHash('sha256').update(`${gameId}:${viewerId}`).digest()
  return (digest[digest.length - 1] & 1) === 0 ? 'home' : 'away'
}

/**
 * The sides a viewer is associated with: a team they belong to; both, for
 * one of the game's season; and a team of the season's league, for one of
 * that league.
 */
export function associatedSides(
  viewer: ViewerAssociation,
  game: SponsorGame
): SponsorSide[] {
  const inSeason = game.seasonId != null && viewer.seasonIds.has(game.seasonId)
  const inLeague =
    game.seasonLeagueId != null && viewer.leagueIds.has(game.seasonLeagueId)
  const sides: SponsorSide[] = []
  for (const [side, teamId, leagueId] of [
    ['home', game.homeTeamId, game.homeLeagueId],
    ['away', game.awayTeamId, game.awayLeagueId]
  ] as const)
    if (
      (teamId != null && viewer.teamIds.has(teamId)) ||
      inSeason ||
      (inLeague && leagueId === game.seasonLeagueId)
    )
      sides.push(side)
  return sides
}

/**
 * The side whose league sponsors what this viewer sees: the one side they
 * are associated with, or, associated with neither or both, the hash's.
 */
export function sponsorSideFor(
  viewer: ViewerAssociation,
  game: SponsorGame,
  viewerId: string
): SponsorSide {
  const sides = associatedSides(viewer, game)
  return sides.length === 1 ? sides[0] : pickSide(game.id, viewerId)
}

/** The league of that side: its team's own, or null for a team in none. */
export function sponsorLeagueOf(
  game: SponsorGame,
  side: SponsorSide
): string | null {
  return side === 'home' ? game.homeLeagueId : game.awayLeagueId
}

/** A game as the pick reads it, or undefined when it is not there. */
export async function sponsorGame(
  db: Kysely<Database>,
  gameId: string
): Promise<SponsorGame | undefined> {
  const row = await db
    .selectFrom('games')
    .leftJoin('seasons', 'seasons.id', 'games.season_id')
    .leftJoin('teams as home', 'home.id', 'games.home_team_id')
    .leftJoin('teams as away', 'away.id', 'games.away_team_id')
    .select([
      'games.id as id',
      'games.home_team_id as homeTeamId',
      'games.away_team_id as awayTeamId',
      'games.season_id as seasonId',
      'seasons.league_id as seasonLeagueId',
      'home.league_id as homeLeagueId',
      'away.league_id as awayLeagueId'
    ])
    .where('games.id', '=', gameId)
    .executeTakeFirst()
  if (row == null) return undefined
  return {
    ...row,
    seasonLeagueId: row.seasonLeagueId ?? null,
    homeLeagueId: row.homeLeagueId ?? null,
    awayLeagueId: row.awayLeagueId ?? null
  }
}

/**
 * `ViewerAssociation` of one person, read now, so a membership moved since
 * the last read moves the pick with it. Season and league memberships are
 * read across every row of the person, as `visibleScopes` reads them, since
 * a merge leaves them where they were written.
 */
export async function viewerAssociation(
  db: Kysely<Database>,
  userId: string
): Promise<ViewerAssociation> {
  const teamIds = new Set<string>()
  const seasonIds = new Set<string>()
  const leagueIds = new Set<string>()
  const roles = await db
    .selectFrom('scope_roles')
    .select(['scope_type', 'scope_id'])
    .where('user_id', '=', userId)
    .execute()
  for (const role of roles)
    (role.scope_type === 'team'
      ? teamIds
      : role.scope_type === 'season'
        ? seasonIds
        : leagueIds
    ).add(role.scope_id)
  const memberships = await db
    .selectFrom('memberships')
    .select('team_id')
    .where('user_id', '=', userId)
    .execute()
  for (const row of memberships) teamIds.add(row.team_id)
  const rows = (await onePerson(db, userId)).userIds
  const seasons = await db
    .selectFrom('season_members')
    .select('season_id')
    .where('user_id', '=', anyOf(rows))
    .execute()
  for (const row of seasons) seasonIds.add(row.season_id)
  const leagues = await db
    .selectFrom('league_members')
    .select('league_id')
    .where('user_id', '=', anyOf(rows))
    .execute()
  for (const row of leagues) leagueIds.add(row.league_id)
  for (const teamId of await teamsPlayedOnNow(
    db,
    await guardedRows(db, userId)
  ))
    teamIds.add(teamId)
  return { teamIds, seasonIds, leagueIds }
}

/** The league whose sponsorship this viewer sees on this game, or null. */
export async function sponsorLeagueFor(
  db: Kysely<Database>,
  game: SponsorGame,
  viewerId: string
): Promise<string | null> {
  const viewer = await viewerAssociation(db, viewerId)
  return sponsorLeagueOf(game, sponsorSideFor(viewer, game, viewerId))
}
