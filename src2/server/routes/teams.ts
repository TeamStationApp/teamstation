import { Router } from 'express'
import type { Kysely } from 'kysely'

import { notFound, unauthorized } from '../../common/errors'
import { canSeeGame, canSeeTeam, visibleScopes } from '../access'
import type { Database } from '../db/database'
import { computeHighlights } from '../highlights'
import { locateVideoFile } from '../media/locations'
import type { MediaContext } from '../media/mediaContext'
import { mediaUrlPath } from '../media/mediaTokens'
import { stillSecond, warmStills } from '../media/stills'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'
import { highlightSettings } from '../settings'
import { battingLines, battingRates } from '../stats'

/**
 * The watch path: teams, then that team's games newest first, then one game
 * with its videos and the highlights underneath them.
 *
 * Anything the caller may not see answers **404**, never 403, so that probing
 * cannot reveal that a team, game or video exists.
 */
export function teamRoutes(db: Kysely<Database>, media: MediaContext): Router {
  const router = Router()

  router.get(
    '/teams',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const scopes = await visibleScopes(db, actor.userId, actor.isAdmin)

      // External teams are opponents, not teams anybody belongs to: they
      // appear on a game and nowhere else, admin or not.
      const teams = scopes.isAdmin
        ? await db
            .selectFrom('teams')
            .select(['id', 'name', 'short_name', 'logo_path'])
            .where('kind', '=', 'full')
            .orderBy('name')
            .execute()
        : scopes.teamIds.size === 0
          ? []
          : await db
              .selectFrom('teams')
              .select(['id', 'name', 'short_name', 'logo_path'])
              .where('id', 'in', [...scopes.teamIds])
              .where('kind', '=', 'full')
              .orderBy('name')
              .execute()

      res.json(
        teams.map(team => ({
          id: team.id,
          name: team.name,
          shortName: team.short_name,
          logoPath: team.logo_path
        }))
      )
    })
  )

  router.get(
    '/teams/:teamId/games',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const teamId = pathParam(req.params.teamId)
      const scopes = await visibleScopes(db, actor.userId, actor.isAdmin)
      if (!canSeeTeam(scopes, teamId)) throw notFound()

      // Newest first: a team's most recent game is the one people want.
      const games = await db
        .selectFrom('games')
        .select([
          'id',
          'home_team_id',
          'away_team_id',
          'season_id',
          'start_at',
          'venue',
          'status',
          'home_score',
          'away_score',
          'ingest_status'
        ])
        .where(eb =>
          eb.or([
            eb('home_team_id', '=', teamId),
            eb('away_team_id', '=', teamId)
          ])
        )
        .orderBy('start_at', 'desc')
        .execute()

      const ids = games.map(game => game.id)
      const videoCounts = await countVideos(db, ids)
      const names = await teamNames(
        db,
        games.flatMap(game => [game.home_team_id, game.away_team_id])
      )

      res.json(
        games.map(game => ({
          id: game.id,
          homeTeamId: game.home_team_id,
          awayTeamId: game.away_team_id,
          homeTeamName: names.get(game.home_team_id) ?? '',
          awayTeamName: names.get(game.away_team_id) ?? '',
          seasonId: game.season_id,
          startAt: toIso(game.start_at),
          venue: game.venue,
          status: game.status,
          homeScore: game.home_score,
          awayScore: game.away_score,
          ingestStatus: game.ingest_status,
          videoCount: videoCounts.get(game.id) ?? 0
        }))
      )
    })
  )

  router.get(
    '/games/:gameId',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const gameId = pathParam(req.params.gameId)
      const scopes = await visibleScopes(db, actor.userId, actor.isAdmin)

      const game = await db
        .selectFrom('games')
        .selectAll()
        .where('id', '=', gameId)
        .executeTakeFirst()
      if (game == null) throw notFound()
      if (
        !canSeeGame(scopes, {
          homeTeamId: game.home_team_id,
          awayTeamId: game.away_team_id,
          seasonId: game.season_id
        })
      ) {
        throw notFound()
      }

      const videos = await db
        .selectFrom('videos')
        .select([
          'id',
          'kind',
          'title',
          'status',
          'storage',
          'start_at',
          'duration_sec',
          'width',
          'height',
          'codecs'
        ])
        .where('game_id', '=', gameId)
        .where('hidden', '=', false)
        .orderBy('kind')
        .execute()

      const names = await teamNames(db, [game.home_team_id, game.away_team_id])

      res.json({
        id: game.id,
        homeTeamId: game.home_team_id,
        awayTeamId: game.away_team_id,
        homeTeamName: names.get(game.home_team_id) ?? '',
        awayTeamName: names.get(game.away_team_id) ?? '',
        seasonId: game.season_id,
        startAt: toIso(game.start_at),
        venue: game.venue,
        status: game.status,
        homeScore: game.home_score,
        awayScore: game.away_score,
        ingestStatus: game.ingest_status,
        ingestMessage: game.ingest_message,
        videos: videos.map(video => ({
          id: video.id,
          kind: video.kind,
          title: video.title,
          status: video.status,
          storage: video.storage,
          startAt: toIso(video.start_at),
          durationSec: video.duration_sec,
          width: video.width,
          height: video.height,
          codecs: video.codecs
        }))
      })
    })
  )

  router.get(
    '/videos/:videoId/highlights',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const videoId = pathParam(req.params.videoId)
      const scopes = await visibleScopes(db, actor.userId, actor.isAdmin)

      const video = await db
        .selectFrom('videos')
        .innerJoin('games', 'games.id', 'videos.game_id')
        .select([
          'videos.id as id',
          'videos.game_id as gameId',
          'videos.storage as storage',
          'videos.start_at as startAt',
          'videos.sync_offset_sec as syncOffsetSec',
          'videos.duration_sec as durationSec',
          'games.home_team_id as homeTeamId',
          'games.away_team_id as awayTeamId',
          'games.season_id as seasonId',
          'games.ingest_status as ingestStatus'
        ])
        .where('videos.id', '=', videoId)
        .executeTakeFirst()
      if (video == null) throw notFound()
      if (!canSeeGame(scopes, video)) throw notFound()

      // A game whose plays did not add up is not offered as highlights until a
      // manager has accepted it: a wrong seek is worse than none.
      if (video.ingestStatus === 'scoreMismatch') {
        res.json({ withheld: 'scoreMismatch', highlights: [] })
        return
      }

      const events = await db
        .selectFrom('events')
        .select([
          'id',
          'at_bat_index',
          'start_time',
          'event_type',
          'description',
          'title_override',
          'time_nudge_sec',
          'hidden',
          'is_scoring_play'
        ])
        .where('game_id', '=', video.gameId)
        .orderBy('at_bat_index')
        .execute()

      const settings = await highlightSettings(db)
      const highlights = computeHighlights(
        events.map(row => ({
          id: row.id,
          atBatIndex: row.at_bat_index,
          startTime: row.start_time == null ? null : new Date(row.start_time),
          eventType: row.event_type,
          description: row.description,
          titleOverride: row.title_override,
          timeNudgeSec: row.time_nudge_sec,
          hidden: row.hidden,
          isScoringPlay: row.is_scoring_play
        })),
        {
          startAt: video.startAt == null ? null : new Date(video.startAt),
          syncOffsetSec: video.syncOffsetSec,
          durationSec: video.durationSec
        },
        settings
      )

      // A still is one frame of the video at the moment of the play, served
      // from the work directory like any other media: `<sec>.jpg` under this
      // video's own still directory, behind the same signed token.
      const stillDir = `work/stills/${videoId}`
      const now = Date.now()
      const withStills = highlights.map(highlight => ({
        ...highlight,
        stillUrl:
          media.publicUrl +
          mediaUrlPath(
            media.mediaSecret,
            stillDir,
            `${stillSecond(highlight.playOffsetSec)}.jpg`,
            now
          )
      }))

      res.json({ withheld: null, highlights: withStills })

      // Answered first, then the frames are cut. The plan has ingest pre-warm
      // these; until a game can be ingested with its video already in place,
      // opening the list is what warms it, and a still that is not ready yet
      // is a missing thumbnail rather than a slow response.
      warmVideoStills(media, video.storage, videoId, highlights).catch(
        () => undefined
      )
    })
  )

  /**
   * Who is on a team.
   *
   * Players first and then everybody else, because the roster screen is read
   * by parents looking for one child. A person with no jersey still belongs on
   * the list — a late addition has a name before it has a number.
   */
  router.get(
    '/teams/:teamId/roster',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const teamId = pathParam(req.params.teamId)
      const scopes = await visibleScopes(db, actor.userId, actor.isAdmin)
      if (!canSeeTeam(scopes, teamId)) throw notFound()

      const rows = await db
        .selectFrom('memberships')
        .innerJoin('users', 'users.id', 'memberships.user_id')
        .select([
          'memberships.user_id as userId',
          'users.display_name as displayName',
          'memberships.jersey as jersey',
          'memberships.positions as positions',
          'memberships.is_player as isPlayer',
          'memberships.role as role'
        ])
        .where('memberships.team_id', '=', teamId)
        .where('users.merged_into', 'is', null)
        .orderBy('memberships.is_player', 'desc')
        .orderBy('users.display_name')
        .execute()

      res.json(
        rows.map(row => ({
          userId: row.userId,
          displayName: row.displayName,
          jersey: row.jersey,
          positions: row.positions,
          isPlayer: row.isPlayer,
          role: row.role
        }))
      )
    })
  )

  /**
   * A team's batting across a season.
   *
   * Worked out from the stored plays with the same `battingLines` the box score
   * uses, rather than read from the season rollup table. The rollup is a cache
   * that a re-ingest can leave behind; the plays are what everything else is
   * derived from, so a figure here and a figure in a box score cannot disagree.
   */
  router.get(
    '/teams/:teamId/stats',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const teamId = pathParam(req.params.teamId)
      const scopes = await visibleScopes(db, actor.userId, actor.isAdmin)
      if (!canSeeTeam(scopes, teamId)) throw notFound()

      const seasonId =
        typeof req.query.seasonId === 'string' ? req.query.seasonId : undefined

      let query = db
        .selectFrom('event_players')
        .innerJoin('events', 'events.id', 'event_players.event_id')
        .innerJoin('games', 'games.id', 'events.game_id')
        .innerJoin('users', 'users.id', 'event_players.user_id')
        .select([
          'event_players.user_id as userId',
          'event_players.team_id as teamId',
          'events.event_type as eventType',
          'events.rbi as rbi',
          'users.display_name as displayName'
        ])
        .where('event_players.team_id', '=', teamId)
        .where('event_players.role', '=', 'batter')
      if (seasonId != null)
        query = query.where('games.season_id', '=', seasonId)
      const rows = await query.execute()

      const names = new Map(rows.map(row => [row.userId, row.displayName]))
      const lines = battingLines(
        rows.map(row => ({
          batterUserId: row.userId,
          teamId: row.teamId,
          eventType: row.eventType ?? 'unknown',
          rbi: row.rbi
        }))
      )

      res.json(
        lines.map(line => ({
          ...line,
          displayName: names.get(line.userId) ?? 'Unknown',
          rates: battingRates(line)
        }))
      )
    })
  )

  router.get(
    '/games/:gameId/box-score',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const gameId = pathParam(req.params.gameId)
      const scopes = await visibleScopes(db, actor.userId, actor.isAdmin)

      const game = await db
        .selectFrom('games')
        .select(['home_team_id', 'away_team_id', 'season_id'])
        .where('id', '=', gameId)
        .executeTakeFirst()
      if (game == null) throw notFound()
      if (
        !canSeeGame(scopes, {
          homeTeamId: game.home_team_id,
          awayTeamId: game.away_team_id,
          seasonId: game.season_id
        })
      ) {
        throw notFound()
      }

      const rows = await db
        .selectFrom('event_players')
        .innerJoin('events', 'events.id', 'event_players.event_id')
        .innerJoin('users', 'users.id', 'event_players.user_id')
        .select([
          'event_players.user_id as userId',
          'event_players.team_id as teamId',
          'events.event_type as eventType',
          'events.rbi as rbi',
          'users.display_name as displayName'
        ])
        .where('events.game_id', '=', gameId)
        .where('event_players.role', '=', 'batter')
        .execute()

      const names = new Map(rows.map(row => [row.userId, row.displayName]))
      const lines = battingLines(
        rows.map(row => ({
          batterUserId: row.userId,
          teamId: row.teamId,
          eventType: row.eventType ?? 'unknown',
          rbi: row.rbi
        }))
      )

      res.json(
        lines.map(line => ({
          ...line,
          displayName: names.get(line.userId) ?? 'Unknown',
          rates: battingRates(line)
        }))
      )
    })
  )

  return router
}

/**
 * The names behind a set of team ids. Every screen that shows a game shows who
 * played, so the name travels with the game rather than costing the app a
 * second round trip per team.
 */
async function teamNames(
  db: Kysely<Database>,
  teamIds: string[]
): Promise<Map<string, string>> {
  const wanted = [...new Set(teamIds)]
  if (wanted.length === 0) return new Map()
  const rows = await db
    .selectFrom('teams')
    .select(['id', 'name'])
    .where('id', 'in', wanted)
    .execute()
  return new Map(rows.map(row => [row.id, row.name]))
}

/**
 * Cuts the stills a highlight list will ask for. Nothing awaits this and
 * nothing fails because of it.
 */
async function warmVideoStills(
  media: MediaContext,
  storage: 'peertube' | 'local' | 'spaces',
  videoId: string,
  highlights: Array<{ playOffsetSec: number }>
): Promise<void> {
  try {
    const videoPath = await locateVideoFile({
      mediaRoot: media.mediaRoot,
      storage,
      videoId
    })
    if (videoPath == null) return
    await warmStills({
      ffmpegPath: media.ffmpegPath,
      videoPath,
      workDir: media.workDir,
      videoId,
      seconds: highlights.map(highlight => highlight.playOffsetSec)
    })
  } catch {
    // A thumbnail that is not there is not worth reporting as an error.
  }
}

async function countVideos(
  db: Kysely<Database>,
  gameIds: string[]
): Promise<Map<string, number>> {
  if (gameIds.length === 0) return new Map()
  const rows = await db
    .selectFrom('videos')
    .select(['game_id'])
    .where('game_id', 'in', gameIds)
    .where('hidden', '=', false)
    .execute()
  const counts = new Map<string, number>()
  for (const row of rows) {
    if (row.game_id == null) continue
    counts.set(row.game_id, (counts.get(row.game_id) ?? 0) + 1)
  }
  return counts
}

/**
 * Express 5 types a path parameter as `string | string[]`, because a route can
 * repeat one. None of ours do, so anything else is a malformed URL and gets
 * the same 404 as an id that does not exist.
 */
function pathParam(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || value === '') throw notFound()
  return value
}

function toIso(value: Date | string | null): string | null {
  if (value == null) return null
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString()
}
