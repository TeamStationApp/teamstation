import { Router } from 'express'
import { type Kysely, sql } from 'kysely'

import { notFound, unauthorized } from '../../common/errors'
import { shortNames } from '../../common/names'
import { canSeeGame, canSeeTeam, visibleScopes } from '../access'
import type { Database } from '../db/database'
import { isRealVideo } from '../db/realVideos'
import { teamNames, teamStandings } from '../db/teamLookups'
import { creditsForHighlight } from '../events/credits'
import { whyEmpty } from '../events/whyEmpty'
import { withDropped } from '../highlights'
import { imageUrl } from '../media/imageUrls'
import type { MediaContext } from '../media/mediaContext'
import { mediaUrlPath } from '../media/mediaTokens'
import {
  posterSecond,
  postersFor,
  posterUrl,
  warmPosters
} from '../media/posters'
import { stillSecond } from '../media/stills'
import { warmVideoStills } from '../media/videoStills'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'
import { highlightSettings } from '../settings'
import {
  battingLines,
  battingRates,
  inningsPitched,
  pitchingLines,
  pitchingRates
} from '../stats'
import { statRows } from '../stats/rows'

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
            .leftJoin('games', join =>
              join.on(eb =>
                eb.or([
                  eb('games.home_team_id', '=', eb.ref('teams.id')),
                  eb('games.away_team_id', '=', eb.ref('teams.id'))
                ])
              )
            )
            .select([
              'teams.id as id',
              'teams.name as name',
              'teams.short_name as short_name',
              'teams.logo_path as logo_path'
            ])
            .select(eb => eb.fn.max('games.start_at').as('lastPlayedAt'))
            .where('teams.kind', '=', 'full')
            .groupBy([
              'teams.id',
              'teams.name',
              'teams.short_name',
              'teams.logo_path'
            ])
            .orderBy('lastPlayedAt', ob => ob.desc().nullsLast())
            .orderBy('teams.name')
            .execute()
        : scopes.teamIds.size === 0
          ? []
          : await db
              .selectFrom('teams')
              .leftJoin('games', join =>
                join.on(eb =>
                  eb.or([
                    eb('games.home_team_id', '=', eb.ref('teams.id')),
                    eb('games.away_team_id', '=', eb.ref('teams.id'))
                  ])
                )
              )
              .select([
                'teams.id as id',
                'teams.name as name',
                'teams.short_name as short_name',
                'teams.logo_path as logo_path'
              ])
              .select(eb => eb.fn.max('games.start_at').as('lastPlayedAt'))
              .where('teams.id', 'in', [...scopes.teamIds])
              .where('teams.kind', '=', 'full')
              .groupBy([
                'teams.id',
                'teams.name',
                'teams.short_name',
                'teams.logo_path'
              ])
              // A team has no season of its own to sort by — only a season
              // does — so the honest ordering is when it last played. The team
              // somebody is here to look at is almost always the one that
              // played last night. A team that has never played has no date,
              // and sorts to the bottom rather than to the top, which is where
              // SQL puts a null by default on a descending sort.
              .orderBy('lastPlayedAt', ob => ob.desc().nullsLast())
              .orderBy('teams.name')
              .execute()

      // A record is per season, counted from the plays — never copied from an
      // import, whose own figures are a check and not a source. The most recent
      // season is the one a team page shows.
      const records =
        teams.length === 0
          ? []
          : await db
              .selectFrom('team_season_records')
              .leftJoin(
                'seasons',
                'seasons.id',
                'team_season_records.season_id'
              )
              .select([
                'team_season_records.team_id as teamId',
                'team_season_records.w as w',
                'team_season_records.l as l',
                'team_season_records.t as t',
                'seasons.name as seasonName',
                'seasons.year as seasonYear'
              ])
              .where(
                'team_season_records.team_id',
                'in',
                teams.map(team => team.id)
              )
              .execute()
      const newest = new Map<string, (typeof records)[number]>()
      for (const row of records) {
        const held = newest.get(row.teamId)
        if (held == null || (row.seasonYear ?? 0) > (held.seasonYear ?? 0)) {
          newest.set(row.teamId, row)
        }
      }

      res.json(
        teams.map(team => {
          const record = newest.get(team.id)
          return {
            id: team.id,
            name: team.name,
            shortName: team.short_name,
            logoPath: team.logo_path,
            logoUrl: imageUrl(media.space, team.logo_path),
            record:
              record == null || record.w + record.l + record.t === 0
                ? null
                : {
                    w: record.w,
                    l: record.l,
                    t: record.t,
                    seasonName: record.seasonName
                  }
          }
        })
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
      const teamPosters = await postersFor(db, ids)
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
          videoCount: videoCounts.get(game.id) ?? 0,
          durationSec: teamPosters.get(game.id)?.durationSec ?? null,
          posterUrl: (() => {
            const poster = teamPosters.get(game.id)
            return poster == null
              ? null
              : posterUrl(
                  media,
                  poster.videoId,
                  posterSecond(poster.durationSec)
                )
          })()
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
          'codecs',
          'num_cameras',
          'sync_offset_sec'
        ])
        .where('game_id', '=', gameId)
        .where('hidden', '=', false)
        .where(isRealVideo)
        // As they arrived. `kind` sorted them alphabetically, which put
        // `combined` first — so the mosaic led the picker, and "the first
        // four" would tick the very thing the multi-camera view replaces into
        // the top-left quadrant. `created_at` on its own is import time rather
        // than upload order, and a camera backfilled a week late would sort a
        // week after its siblings, so the recording's own start wins where it
        // has one.
        .orderBy(sql`coalesce(start_at, created_at)`)
        .orderBy('id')
        .execute()

      const names = await teamNames(db, [game.home_team_id, game.away_team_id])

      // Each side's record in the season this game was played in.
      const recordRows = await db
        .selectFrom('team_season_records')
        .select(['team_id', 'w', 'l', 't'])
        .where('team_id', 'in', [game.home_team_id, game.away_team_id])
        .where(eb =>
          game.season_id == null
            ? eb('season_id', 'is', null)
            : eb('season_id', '=', game.season_id)
        )
        .execute()
      const logos = await db
        .selectFrom('teams')
        .select(['id', 'logo_path'])
        .where('id', 'in', [game.home_team_id, game.away_team_id])
        .execute()
      const logoOf = (teamId: string): string | null =>
        imageUrl(
          media.space,
          logos.find(row => row.id === teamId)?.logo_path ?? null
        )

      const recordOf = (teamId: string): string | null => {
        const row = recordRows.find(item => item.team_id === teamId)
        if (row == null || row.w + row.l + row.t === 0) return null
        return row.t > 0 ? `${row.w}–${row.l}–${row.t}` : `${row.w}–${row.l}`
      }

      // The frames the card and the picker are about to ask for.
      warmPosters(
        media,
        videos
          .filter(video => video.status === 'ready')
          .map(video => ({
            gameId,
            videoId: video.id,
            storage: video.storage,
            durationSec: video.duration_sec
          }))
      ).catch(() => undefined)

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
        awayRecord: recordOf(game.away_team_id),
        homeRecord: recordOf(game.home_team_id),
        awayLogoUrl: logoOf(game.away_team_id),
        homeLogoUrl: logoOf(game.home_team_id),
        linescore: game.linescore,
        videos: videos.map(video => ({
          id: video.id,
          numCameras: video.num_cameras,
          syncOffsetSec: video.sync_offset_sec,
          posterUrl:
            video.status === 'ready'
              ? posterUrl(media, video.id, posterSecond(video.duration_sec))
              : null,
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
          'atBatIndex',
          'startTime',
          'eventType',
          'description',
          'titleOverride',
          'timeNudgeSec',
          'hidden',
          'isScoringPlay'
        ])
        .where('gameId', '=', video.gameId)
        .orderBy('atBatIndex')
        .execute()

      const credits = await creditsForHighlight(
        db,
        events.map(row => row.id)
      )
      const teams = await teamStandings(db)

      const settings = await highlightSettings(db)
      const computed = withDropped(
        events.map(row => ({
          id: row.id,
          atBatIndex: row.atBatIndex,
          startTime: row.startTime == null ? null : new Date(row.startTime),
          eventType: row.eventType,
          description: row.description,
          titleOverride: row.titleOverride,
          timeNudgeSec: row.timeNudgeSec,
          hidden: row.hidden,
          isScoringPlay: row.isScoringPlay === true,
          // `undefined` keeps a play nobody has looked at; `[]` drops one
          // that was looked at and credited to nobody.
          credits: credits.get(row.id)
        })),
        {
          startAt: video.startAt == null ? null : new Date(video.startAt),
          syncOffsetSec: video.syncOffsetSec,
          durationSec: video.durationSec
        },
        settings,
        teams
      )
      const highlights = computed.highlights

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

      res.json({
        withheld: whyEmpty(highlights, events, video),
        // How many plays were left out because nobody could be named on them.
        // An empty list can then say which kind of empty it is.
        droppedCount: computed.dropped,
        highlights: withStills
      })

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
          'users.first_name as firstName',
          'users.last_name as lastName',
          'users.avatar_path as avatarPath',
          'memberships.jersey as jersey',
          'memberships.positions as positions',
          'memberships.is_player as isPlayer',
          'memberships.role as role'
        ])
        .where('memberships.team_id', '=', teamId)
        .where('users.merged_into', 'is', null)
        .orderBy('users.display_name')
        .execute()

      // Everybody who may see this team but is not on it: the right can be
      // given on the team, on its season or on its league, and from the team
      // page's point of view all three are the same thing — somebody who
      // follows it. Gathered separately because they have no membership row.
      const followerRows = await db
        .selectFrom('season_members')
        .innerJoin('users', 'users.id', 'season_members.user_id')
        .innerJoin(
          'season_teams',
          'season_teams.season_id',
          'season_members.season_id'
        )
        .select([
          'users.id as userId',
          'users.display_name as displayName',
          'users.first_name as firstName',
          'users.last_name as lastName',
          'users.avatar_path as avatarPath'
        ])
        .where('season_teams.team_id', '=', teamId)
        .where('users.merged_into', 'is', null)
        .distinct()
        .execute()

      // First name, last initial, worked out across the whole roster so two
      // children called Jordan do not both come out `Jordan P`.
      const names = shortNames(
        rows.map(row => ({
          id: row.userId,
          firstName: row.firstName,
          lastName: row.lastName,
          displayName: row.displayName
        }))
      )

      const onTheTeam = new Set(rows.map(row => row.userId))
      const followers = followerRows.filter(row => !onTheTeam.has(row.userId))
      const followerNames = shortNames(
        followers.map(row => ({
          id: row.userId,
          firstName: row.firstName,
          lastName: row.lastName,
          displayName: row.displayName
        }))
      )

      // Coaches, then players, then followers. A person appears once, in the
      // first group that fits: somebody who coaches and is also a parent is a
      // coach, which is what they are here for.
      const group = (row: (typeof rows)[number]): string =>
        row.role === 'owner' || row.role === 'manager'
          ? 'coach'
          : row.isPlayer
            ? 'player'
            : 'follower'
      const order = { coach: 0, player: 1, follower: 2 }

      res.json([
        ...rows
          .map(row => ({
            userId: row.userId,
            shortName: names.get(row.userId) ?? row.displayName,
            avatarUrl: imageUrl(media.space, row.avatarPath),
            jersey: row.jersey,
            positions: row.positions,
            isPlayer: row.isPlayer,
            role: row.role,
            group: group(row)
          }))
          .sort((a, b) => {
            const byGroup =
              order[a.group as keyof typeof order] -
              order[b.group as keyof typeof order]
            if (byGroup !== 0) return byGroup
            return a.shortName.localeCompare(b.shortName)
          }),
        ...followers
          .map(row => ({
            userId: row.userId,
            shortName: followerNames.get(row.userId) ?? row.displayName,
            avatarUrl: imageUrl(media.space, row.avatarPath),
            jersey: null,
            positions: [] as string[],
            isPlayer: false,
            role: 'member',
            group: 'follower'
          }))
          .sort((a, b) => a.shortName.localeCompare(b.shortName))
      ])
    })
  )

  /**
   * A team's batting and pitching across a season.
   *
   * Added up from the stored stat lines, which is where every figure on the
   * site comes from: one row per player per game, counted by walking the game
   * stream the way a scorebook does. A figure here and the same figure in a box
   * score are sums of the same rows, so they cannot disagree.
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

      const rows = await statRows(db, { teamId, seasonId })
      const names = shortNames(
        rows.map(row => ({
          id: row.userId,
          firstName: row.firstName,
          lastName: row.lastName,
          displayName: row.displayName
        }))
      )

      res.json(
        battingLines(rows).map(line => ({
          ...line,
          shortName: names.get(line.userId) ?? 'Unknown',
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

      const rows = await statRows(db, { gameId })
      const names = shortNames(
        rows.map(row => ({
          id: row.userId,
          firstName: row.firstName,
          lastName: row.lastName,
          displayName: row.displayName
        }))
      )

      // The average beside a name is read as what kind of hitter somebody is,
      // so it is their season to date rather than their afternoon: three
      // at-bats say nothing, and a box score has always printed the running
      // figure.
      const seasonAvg = await averagesToDate(db, gameId, game.season_id)

      const pitching = pitchingLines(rows).map(line => ({
        ...line,
        shortName: names.get(line.userId) ?? 'Unknown',
        ip: inningsPitched(line.outs),
        rates: pitchingRates(line)
      }))
      const lines = battingLines(rows)

      res.json({
        batting: lines.map(line => ({
          ...line,
          shortName: names.get(line.userId) ?? 'Unknown',
          rates: battingRates(line),
          seasonAvg: seasonAvg.get(line.userId) ?? null
        })),
        pitching
      })
    })
  )

  return router
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
    .where(isRealVideo)
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

/**
 * Each batter's average for the season, up to and including this game.
 *
 * The average printed beside a name in a box score is read as what kind of
 * hitter somebody is, and one afternoon does not say. So it is counted over
 * every game of the same season up to this one — and where a game belongs to
 * no season, over every game those teams have played, which is the only honest
 * answer available for a one-off.
 */
async function averagesToDate(
  db: Kysely<Database>,
  gameId: string,
  seasonId: string | null
): Promise<Map<number, number>> {
  const game = await db
    .selectFrom('games')
    .select(['start_at', 'home_team_id', 'away_team_id'])
    .where('id', '=', gameId)
    .executeTakeFirst()
  if (game == null) return new Map()

  const rows = await statRows(db, {
    seasonId: seasonId ?? undefined,
    // A one-off belongs to no season, and the only honest answer for it is
    // every game these two teams have played.
    teamIds:
      seasonId == null ? [game.home_team_id, game.away_team_id] : undefined,
    // Up to and including this one, by when it was played. A game with no date
    // cannot be placed in the order, so it counts only for its own box score.
    playedBy: game.start_at == null ? undefined : new Date(game.start_at)
  })

  const out = new Map<number, number>()
  for (const line of battingLines(rows)) {
    if (line.ab > 0) out.set(line.userId, line.h / line.ab)
  }
  return out
}
