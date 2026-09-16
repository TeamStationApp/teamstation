import { Router } from 'express'
import type { Kysely } from 'kysely'

import { notFound, unauthorized } from '../../common/errors'
import { canSeeGame, visibleScopes } from '../access'
import type { Database } from '../db/database'
import { locateVideo } from '../media/locations'
import {
  MEDIA_TOKEN_TTL_SEC,
  mediaUrlPath,
  verifyMediaPath
} from '../media/mediaTokens'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'

export interface MediaRouteOptions {
  /** The media root, for finding a video's directory. */
  mediaRoot: string
  /** Signs the `/media` tokens. The same secret the proxy's auth check uses. */
  mediaSecret: string
  /** The origin playback URLs are built against, e.g. `https://tube2…`. */
  publicUrl: string
}

/**
 * Playback URLs, and the check behind them.
 *
 * Membership is checked **once**, here, when a player asks where a video is.
 * After that the `/media` token carries the decision, because a player fetches
 * a playlist and then hundreds of segments, and a database hit per segment
 * would be the slowest thing on the host. See `mediaTokens.ts`.
 */
export function mediaRoutes(
  db: Kysely<Database>,
  options: MediaRouteOptions
): Router {
  const { mediaRoot, mediaSecret, publicUrl } = options
  const router = Router()

  router.get(
    '/videos/:videoId/playback',
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
          'videos.storage as storage',
          'videos.status as status',
          'videos.duration_sec as durationSec',
          'videos.hidden as hidden',
          'games.home_team_id as homeTeamId',
          'games.away_team_id as awayTeamId',
          'games.season_id as seasonId'
        ])
        .where('videos.id', '=', videoId)
        .executeTakeFirst()
      // 404 rather than 403 throughout, so existence never leaks.
      if (video == null || video.hidden) throw notFound()
      if (!canSeeGame(scopes, video)) throw notFound()

      const location = await locateVideo({
        mediaRoot,
        storage: video.storage,
        videoId
      })
      if (location == null) {
        // The row says there is a video; its files are not there. Better to
        // say so than to hand back a URL that plays black.
        res.json({
          videoId,
          storage: video.storage,
          url: null,
          expiresAt: null,
          durationSec: video.durationSec,
          unavailable: true
        })
        return
      }

      const now = Date.now()
      const url =
        video.storage === 'spaces'
          ? // The API serves these playlists itself, rewriting the media entry
            // to a presigned URL so the bytes come from the Space directly.
            `${publicUrl}/api/v1/videos/${videoId}/hls/${location.master}`
          : publicUrl +
            mediaUrlPath(mediaSecret, location.dir, location.master, now)

      res.json({
        videoId,
        storage: video.storage,
        url,
        expiresAt: new Date(now + MEDIA_TOKEN_TTL_SEC * 1000).toISOString(),
        durationSec: video.durationSec,
        unavailable: false
      })
    })
  )

  return router
}

/**
 * What the reverse proxy's auth check calls before serving a byte of media.
 *
 * It answers 204 or 403 and nothing else: no body, no database, no file
 * system. The URL the proxy is being asked about arrives in `x-forwarded-uri`.
 */
export function mediaAuthRoute(mediaSecret: string): Router {
  const router = Router()

  router.get('/internal/media-auth', (req, res) => {
    const forwarded = req.header('x-forwarded-uri') ?? req.originalUrl
    const path = forwarded.split('?')[0]
    const result = verifyMediaPath(mediaSecret, path)
    if (!result.ok) {
      res.status(403).end()
      return
    }
    res.status(204).end()
  })

  return router
}

function pathParam(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || value === '') throw notFound()
  return value
}
