import { Router } from 'express'
import { type Kysely, sql } from 'kysely'

import { badRequest, notFound, unauthorized } from '../../common/errors'
import { shortNames } from '../../common/names'
import { seasonStandings } from '../../common/seasonStandings'
import { inningsPitched } from '../../common/statExtras'
import { asUserId } from '../../common/userId'
import { guardsPerson, openablePeople, visibleScopes } from '../access'
import { onePerson } from '../admin/people'
import type { Database } from '../db/database'
import {
  isWithdrawnKey,
  publicUserId,
  withdrawnGames
} from '../games/withdrawn'
import { imageUrl } from '../media/imageUrls'
import type { MediaContext } from '../media/mediaContext'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'
import {
  battingLines,
  battingRates,
  pitchingLines,
  pitchingRates
} from '../stats'
import { playerFilterOf, statRows } from '../stats/rows'
import { seasonParticipants } from '../stats/seasonTeams'

/**
 * A player's stats by season and for their career, a season's standings, and
 * the plays behind any of it.
 *
 * Every figure can be opened: `/players/:userId/plays` returns the plays a
 * number was worked out from, so a total is never something a viewer has to
 * take on trust.
 */
export function statsRoutes(
  db: Kysely<Database>,
  media?: MediaContext
): Router {
  const router = Router()

  /**
   * One player's figures, for whichever games the reader is asking about.
   *
   * Filtered on the way in rather than on the way out: a season, a team or a
   * year narrows the rows this is a sum of, and the same request comes back with
   * the seasons, teams and years there are to choose from — which is what the
   * filter on the page offers. A career is the unfiltered answer.
   *
   * Every figure is a sum of `game_player_stats`, so a total here and a line in
   * a box score are the same rows added up differently.
   */
  router.get(
    '/players/:userId/stats',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const userId = userIdParam(req.params.userId)
      const scopes = await visibleScopes(db, actor.userId, actor.isAdmin)

      const { seasonId, teamId, year } = playerFilterOf(req.query)

      // Every row that is this person, not every row under this id: one child
      // on five teams is five ids, and four of them are closed into the fifth.
      const person = await onePerson(db, userId)

      // Everything they have, so the filter can be offered; the figures
      // themselves are then taken from whichever of those rows were asked for.
      //
      // The rows come back under whichever id was current when each game was
      // written, and a total grouped by that id would be one line per team
      // again. They are one person here, so they carry one id.
      const all = (await statRows(db, { userIds: person.userIds })).map(
        row => ({
          ...row,
          userId: person.userId
        })
      )

      // A player's own figures are always theirs to see, and their
      // guardian's, from every team they have played for; anyone else's are
      // visible only for the teams the reader can already see.
      const ownFigures =
        person.userIds.includes(actor.userId) ||
        (await guardsPerson(db, scopes, actor.userId, person))
      const visible =
        ownFigures || scopes.isAdmin
          ? all
          : all.filter(
              row =>
                (row.teamId != null && scopes.teamIds.has(row.teamId)) ||
                (row.seasonId != null && scopes.seasonIds.has(row.seasonId))
            )
      if (visible.length === 0 && all.length > 0 && !ownFigures) {
        throw notFound()
      }

      const chosen = visible.filter(
        row =>
          (seasonId == null || row.seasonId === seasonId) &&
          (teamId == null || row.teamId === teamId) &&
          (year == null || yearOf(row.startAt) === year)
      )

      const [batting] = battingLines(chosen)
      const [pitching] = pitchingLines(chosen)

      const seasons = new Map<string, { name: string; year: number | null }>()
      const teams = new Map<string, string>()
      const years = new Set<number>()
      for (const row of visible) {
        if (row.seasonId != null) {
          seasons.set(row.seasonId, {
            name: row.seasonName ?? 'Season',
            year: row.seasonYear
          })
        }
        if (row.teamId != null) teams.set(row.teamId, row.teamName ?? 'Team')
        const played = yearOf(row.startAt)
        if (played != null) years.add(played)
      }

      res.json({
        // The open row, so a page opened on a closed id says who it really is.
        userId: person.userId,
        filter: {
          seasonId: seasonId ?? null,
          teamId: teamId ?? null,
          year: year ?? null
        },
        games: new Set(chosen.map(row => row.gameId)).size,
        batting:
          batting == null ? null : { ...batting, rates: battingRates(batting) },
        pitching:
          pitching == null
            ? null
            : {
                ...pitching,
                ip: inningsPitched(pitching.outs),
                rates: pitchingRates(pitching)
              },
        // Newest season first, then teams by name: a list whose order is
        // whatever Postgres returned reshuffles itself between two readings of
        // the same page.
        options: {
          seasons: [...seasons]
            .map(([id, season]) => ({
              seasonId: id,
              name: season.name,
              year: season.year
            }))
            .sort((a, b) => {
              const byYear = (b.year ?? 0) - (a.year ?? 0)
              return byYear === 0 ? a.name.localeCompare(b.name) : byYear
            }),
          teams: [...teams]
            .map(([id, name]) => ({ teamId: id, name }))
            .sort((a, b) => a.name.localeCompare(b.name)),
          years: [...years].sort((a, b) => b - a)
        }
      })
    })
  )

  router.get(
    '/seasons/:seasonId/standings',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const seasonId = pathParam(req.params.seasonId)
      const scopes = await visibleScopes(db, actor.userId, actor.isAdmin)

      const teams = await db
        .selectFrom('season_teams')
        .select(['team_id'])
        .where('season_id', '=', seasonId)
        .where('active', '=', true)
        .execute()
      const season = await db
        .selectFrom('seasons')
        .select('id')
        .where('id', '=', seasonId)
        .executeTakeFirst()
      if (season == null) throw notFound()

      // A season's table is visible to anyone in it, or to anyone the season
      // or its league has opened itself up to, and to anybody else signed in
      // once a team plays in it: every team's page is open to them in the
      // non-member view, and shows where the team stands. A season with no
      // team in it has no team page to show it on.
      if (
        teams.length === 0 &&
        !scopes.seasonIds.has(seasonId) &&
        !scopes.isAdmin
      )
        throw notFound()

      const asked = req.query.includeExhibitions
      if (asked !== undefined && asked !== 'true' && asked !== 'false')
        throw badRequest('includeExhibitions must be true or false')
      const participants = await seasonParticipants(db, seasonId)
      res.json(
        seasonStandings(
          participants.teams.filter(
            team =>
              asked !== 'false' ||
              team.activeMember ||
              team.parentMember ||
              participants.games.some(
                game =>
                  !game.exhibition &&
                  (game.homeTeamId === team.id || game.awayTeamId === team.id)
              )
          ),
          participants.games,
          asked !== 'false'
        ).map(({ logoPath, ...row }) => ({
          ...row,
          logoUrl: media == null ? null : imageUrl(media.space, logoPath)
        }))
      )
    })
  )

  router.get(
    '/seasons/:seasonId/stats',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const seasonId = pathParam(req.params.seasonId)
      const scopes = await visibleScopes(db, actor.userId, actor.isAdmin)
      if (!scopes.isAdmin && !scopes.seasonIds.has(seasonId)) throw notFound()
      const season = await db
        .selectFrom('seasons')
        .select('id')
        .where('id', '=', seasonId)
        .executeTakeFirst()
      if (season == null) throw notFound()
      const rows = await statRows(db, { seasonId, visibleGames: scopes })
      const opens = await openablePeople(
        db,
        scopes,
        actor.userId,
        rows.map(row => row.userId).filter(id => !isWithdrawnKey(id))
      )
      const names = shortNames(
        rows.map(row => ({
          id: row.userId,
          firstName: row.firstName,
          lastName: row.lastName,
          displayName: row.displayName
        }))
      )
      res.json({
        seasonId,
        batting: battingLines(rows).map(line => ({
          ...line,
          userId: publicUserId(line.userId),
          openable: opens.has(line.userId),
          shortName: names.get(line.userId) ?? 'Unknown',
          rates: battingRates(line)
        })),
        pitching: pitchingLines(rows).map(line => ({
          ...line,
          userId: publicUserId(line.userId),
          openable: opens.has(line.userId),
          shortName: names.get(line.userId) ?? 'Unknown',
          ip: inningsPitched(line.outs),
          rates: pitchingRates(line)
        }))
      })
    })
  )

  router.get(
    '/players/:userId/plays',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const userId = userIdParam(req.params.userId)
      const scopes = await visibleScopes(db, actor.userId, actor.isAdmin)

      // Every row that is this person: a merge closes a row without moving
      // the plays written under it.
      const person = await onePerson(db, userId)
      // Their own plays, and their guardian's child's, from every team.
      const ownPlays =
        person.userIds.includes(actor.userId) ||
        (await guardsPerson(db, scopes, actor.userId, person))
      // Games their part in was withdrawn from are not on their record.
      const withdrawn = await withdrawnGames(db, person.userIds)

      let query = db
        .selectFrom('event_players')
        .innerJoin('gumbo_ids', 'gumbo_ids.gumbo_id', 'event_players.gumbo_id')
        .innerJoin('events', 'events.id', 'event_players.event_id')
        .innerJoin('games', 'games.id', 'events.gameId')
        .select([
          'events.id as eventId',
          'events.gameId as gameId',
          'events.atBatIndex as atBatIndex',
          'events.inning as inning',
          'events.halfInning as halfInning',
          'events.eventType as eventType',
          'events.rbi as rbi',
          'events.startTime as startTime',
          'games.season_id as seasonId',
          'games.start_at as gameStartAt',
          'event_players.team_id as teamId',
          'event_players.role as role'
        ])
        .where('gumbo_ids.user_id', 'in', person.userIds)
        .where('events.hidden', '=', false)
        .$if(withdrawn.length > 0, query =>
          query.where('events.gameId', 'not in', withdrawn)
        )

      const seasonId = req.query.seasonId
      if (typeof seasonId === 'string' && seasonId !== '') {
        query = query.where('games.season_id', '=', seasonId)
      }
      const eventType = req.query.eventType
      if (typeof eventType === 'string' && eventType !== '') {
        query = query.where('events.eventType', '=', eventType)
      }

      // Opening a batting figure should show the plays that figure came from,
      // not every play the player was anywhere near, so the role can be
      // narrowed. Anything unrecognised is ignored rather than rejected.
      const role = req.query.role
      if (typeof role === 'string' && isPlayerRole(role)) {
        query = query.where('event_players.role', '=', role)
      }

      const rows = await query
        .orderBy('games.start_at', 'desc')
        .orderBy(sql`games.id collate "C"`)
        .orderBy('events.atBatIndex')
        .orderBy(sql`events.id collate "C"`)
        .orderBy(sql`event_players.role collate "C"`)
        .execute()

      // The same rule as everywhere else, applied row by row: a play is
      // visible if its game is.
      const visible = rows.filter(
        row =>
          scopes.isAdmin ||
          ownPlays ||
          (row.teamId != null && scopes.teamIds.has(row.teamId)) ||
          (row.seasonId != null && scopes.seasonIds.has(row.seasonId))
      )

      res.json(
        visible.map(row => ({
          eventId: row.eventId,
          gameId: row.gameId,
          atBatIndex: row.atBatIndex,
          inning: row.inning,
          halfInning: row.halfInning,
          eventType: row.eventType,
          rbi: row.rbi,
          role: row.role,
          seasonId: row.seasonId,
          startTime:
            row.startTime == null ? null : new Date(row.startTime).toISOString()
        }))
      )
    })
  )

  return router
}

/** The calendar year a game was played in, for the year filter. */
function yearOf(startAt: Date | string | null): number | null {
  if (startAt == null) return null
  const when = startAt instanceof Date ? startAt : new Date(startAt)
  return Number.isNaN(when.getTime()) ? null : when.getUTCFullYear()
}

function pathParam(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || value === '') throw notFound()
  return value
}

function userIdParam(value: string | string[] | undefined): string {
  try {
    return asUserId(pathParam(value))
  } catch {
    throw badRequest('Expected a canonical user id')
  }
}

/** The roles a play can tag somebody in, as the schema's check constraint has them. */
const PLAYER_ROLES = [
  'batter',
  'pitcher',
  'runner',
  'scorer',
  'fielder',
  'catcher'
] as const

type PlayerRole = (typeof PLAYER_ROLES)[number]

function isPlayerRole(value: string): value is PlayerRole {
  return (PLAYER_ROLES as readonly string[]).includes(value)
}
