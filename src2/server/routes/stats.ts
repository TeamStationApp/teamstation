import { Router } from 'express'
import type { Kysely } from 'kysely'

import { notFound, unauthorized } from '../../common/errors'
import { visibleScopes } from '../access'
import type { Database } from '../db/database'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'
import { careerFromLines } from '../rollups'
import { type BattingLine, battingRates } from '../stats'

/**
 * A player's stats by season and for their career, a season's standings, and
 * the plays behind any of it.
 *
 * Every figure can be opened: `/players/:userId/plays` returns the plays a
 * number was worked out from, so a total is never something a viewer has to
 * take on trust.
 */
export function statsRoutes(db: Kysely<Database>): Router {
  const router = Router()

  router.get(
    '/players/:userId/stats',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const userId = pathParam(req.params.userId)
      const scopes = await visibleScopes(db, actor.userId, actor.isAdmin)

      const rows = await db
        .selectFrom('player_season_stats')
        .leftJoin('seasons', 'seasons.id', 'player_season_stats.season_id')
        .leftJoin('teams', 'teams.id', 'player_season_stats.team_id')
        .select([
          'player_season_stats.season_id as seasonId',
          'player_season_stats.team_id as teamId',
          'player_season_stats.g as g',
          'player_season_stats.pa as pa',
          'player_season_stats.ab as ab',
          'player_season_stats.h as h',
          'player_season_stats.singles as singles',
          'player_season_stats.doubles as doubles',
          'player_season_stats.triples as triples',
          'player_season_stats.hr as hr',
          'player_season_stats.rbi as rbi',
          'player_season_stats.bb as bb',
          'player_season_stats.k as k',
          'seasons.name as seasonName',
          'seasons.year as seasonYear',
          'teams.name as teamName'
        ])
        .where('player_season_stats.user_id', '=', userId)
        .execute()

      // A player's own stats are always theirs to see; anyone else's are
      // visible only for the teams the viewer can already see.
      const visible =
        userId === actor.userId || scopes.isAdmin
          ? rows
          : rows.filter(row => scopes.teamIds.has(row.teamId))
      if (visible.length === 0 && rows.length > 0 && userId !== actor.userId) {
        throw notFound()
      }

      const lines: BattingLine[] = visible.map(row => ({
        userId,
        teamId: row.teamId,
        pa: row.pa,
        ab: row.ab,
        h: row.h,
        singles: row.singles,
        doubles: row.doubles,
        triples: row.triples,
        hr: row.hr,
        bb: row.bb,
        k: row.k,
        hbp: 0,
        rbi: row.rbi
      }))

      const career = careerFromLines(lines)
      res.json({
        userId,
        seasons: visible.map((row, index) => ({
          seasonId: row.seasonId,
          seasonName: row.seasonName,
          seasonYear: row.seasonYear,
          teamName: row.teamName,
          g: row.g,
          ...lines[index],
          rates: battingRates(lines[index])
        })),
        career: { ...career, rates: battingRates(career) }
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
        .execute()
      if (teams.length === 0) throw notFound()

      // A season's table is visible to anyone in it, or to anyone the season
      // or its league has opened itself up to.
      const inSeason = teams.some(row => scopes.teamIds.has(row.team_id))
      if (!inSeason && !scopes.seasonIds.has(seasonId) && !scopes.isAdmin) {
        throw notFound()
      }

      const rows = await db
        .selectFrom('team_season_records')
        .innerJoin('teams', 'teams.id', 'team_season_records.team_id')
        .select([
          'team_season_records.team_id as teamId',
          'teams.name as teamName',
          'team_season_records.w as w',
          'team_season_records.l as l',
          'team_season_records.t as t',
          'team_season_records.runs_for as runsFor',
          'team_season_records.runs_against as runsAgainst'
        ])
        .where('team_season_records.season_id', '=', seasonId)
        .execute()

      const table = rows
        .map(row => ({
          ...row,
          played: row.w + row.l + row.t,
          winningPct:
            row.w + row.l + row.t === 0
              ? null
              : Math.round((row.w / (row.w + row.l + row.t)) * 1000) / 1000,
          runDifferential: row.runsFor - row.runsAgainst
        }))
        .sort((a, b) => {
          // Best record first, then run differential as the tie-break.
          const byRecord = (b.winningPct ?? -1) - (a.winningPct ?? -1)
          if (byRecord !== 0) return byRecord
          return b.runDifferential - a.runDifferential
        })

      res.json(table)
    })
  )

  router.get(
    '/players/:userId/plays',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const userId = pathParam(req.params.userId)
      const scopes = await visibleScopes(db, actor.userId, actor.isAdmin)

      let query = db
        .selectFrom('event_players')
        .innerJoin('events', 'events.id', 'event_players.event_id')
        .innerJoin('games', 'games.id', 'events.game_id')
        .select([
          'events.id as eventId',
          'events.game_id as gameId',
          'events.at_bat_index as atBatIndex',
          'events.inning as inning',
          'events.half_inning as halfInning',
          'events.event_type as eventType',
          'events.description as description',
          'events.rbi as rbi',
          'events.start_time as startTime',
          'games.season_id as seasonId',
          'games.start_at as gameStartAt',
          'event_players.team_id as teamId',
          'event_players.role as role'
        ])
        .where('event_players.user_id', '=', userId)
        .where('events.hidden', '=', false)

      const seasonId = req.query.seasonId
      if (typeof seasonId === 'string' && seasonId !== '') {
        query = query.where('games.season_id', '=', seasonId)
      }
      const eventType = req.query.eventType
      if (typeof eventType === 'string' && eventType !== '') {
        query = query.where('events.event_type', '=', eventType)
      }

      const rows = await query.orderBy('games.start_at', 'desc').execute()

      // The same rule as everywhere else, applied row by row: a play is
      // visible if its game is.
      const visible = rows.filter(
        row =>
          scopes.isAdmin ||
          userId === actor.userId ||
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
          description: row.description,
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

function pathParam(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || value === '') throw notFound()
  return value
}
