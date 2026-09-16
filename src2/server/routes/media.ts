import { Router } from 'express'
import type { Kysely } from 'kysely'

import { notFound, unauthorized } from '../../common/errors'
import { canSeeGame, visibleScopes } from '../access'
import type { Database } from '../db/database'
import { locateVideo, locateVideoFile } from '../media/locations'
import type { MediaContext } from '../media/mediaContext'
import {
  MEDIA_TOKEN_TTL_SEC,
  mediaUrlPath,
  verifyMediaPath
} from '../media/mediaTokens'
import { ensureStill } from '../media/stills'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'

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
  options: MediaContext
): Router {
  const { ffmpegPath, mediaRoot, mediaSecret, publicUrl, workDir } = options
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

  router.get(
    '/videos/:videoId/still',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const videoId = pathParam(req.params.videoId)
      const atSec = secondsParam(req.query.t)
      const scopes = await visibleScopes(db, actor.userId, actor.isAdmin)

      const video = await db
        .selectFrom('videos')
        .innerJoin('games', 'games.id', 'videos.game_id')
        .select([
          'videos.storage as storage',
          'videos.hidden as hidden',
          'games.home_team_id as homeTeamId',
          'games.away_team_id as awayTeamId',
          'games.season_id as seasonId'
        ])
        .where('videos.id', '=', videoId)
        .executeTakeFirst()
      if (video == null || video.hidden) throw notFound()
      if (!canSeeGame(scopes, video)) throw notFound()

      const videoPath = await locateVideoFile({
        mediaRoot,
        storage: video.storage,
        videoId
      })
      if (videoPath == null) throw notFound()

      const still = await ensureStill({
        ffmpegPath,
        videoPath,
        workDir,
        videoId,
        atSec
      }).catch(() => undefined)
      if (still == null) throw notFound()

      // Stills never change for a given second, so they cache hard; the token
      // on the URL is what limits who can ask.
      res.setHeader('cache-control', 'private, max-age=86400')
      res.type('image/jpeg')
      res.sendFile(still)
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

/** `?t=` in seconds. Anything that is not a number starts at the beginning. */
function secondsParam(value: unknown): number {
  if (typeof value !== 'string') return 0
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds < 0) return 0
  return seconds
}

function pathParam(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || value === '') throw notFound()
  return value
}
