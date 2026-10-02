import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import { type Response, Router } from 'express'
import type { Kysely } from 'kysely'

import { badRequest, notFound, unauthorized } from '../../common/errors'
import { adminScopes, canSeeGame, visibleScopes } from '../access'
import type { Database } from '../db/database'
import { VIDEO_FILE } from '../media/ffmpeg'
import { locateVideo, videoFrameSource } from '../media/locations'
import type { MediaContext } from '../media/mediaContext'
import {
  MEDIA_TOKEN_TTL_SEC,
  mediaUrlPath,
  signQueryToken,
  verifyMediaPath,
  verifyQueryToken
} from '../media/mediaTokens'
import { presignGetUrl } from '../media/presign'
import {
  PlaylistCache,
  rewriteMasterPlaylist,
  rewriteMediaPlaylist,
  spaceConfigured,
  spaceKey
} from '../media/spacesHls'
import { deleteVideoFromSpace } from '../media/spacesVideo'
import {
  ensureStill,
  stillInSpace,
  stillSpaceUrl,
  stillSubject
} from '../media/stills'
import { setAudit } from '../middleware/withAudit'
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
  const { ffmpegPath, mediaRoot, mediaSecret, publicUrl, space } = options
  const router = Router()
  const playlists = new PlaylistCache({
    space,
    expiresSec: MEDIA_TOKEN_TTL_SEC
  })

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
            // to a presigned URL so the bytes come from the Space directly. A
            // `<video>` element cannot send a bearer token, so the permission
            // rides in the query string.
            `${publicUrl}/api/v1/videos/${videoId}/hls/master.m3u8?t=${signQueryToken(
              mediaSecret,
              hlsSubject(videoId),
              now
            )}`
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

      await redirectToStill(res, video.storage, videoId, atSec)
    })
  )

  /**
   * A still a list handed out, by its signed URL.
   *
   * Not behind `requireActor`: an `<img>` cannot send a header, so the token
   * in the query is the check, minted by the route that listed the video. The
   * answer is a redirect to the still in the Space, cut and kept there first
   * if this is the first time anybody asked for it.
   */
  router.get(
    '/videos/:videoId/stills/:file',
    withAsync(async (req, res) => {
      const videoId = pathParam(req.params.videoId)
      const match = /^(\d{1,6})\.jpg$/.exec(pathParam(req.params.file))
      if (match == null) throw notFound()
      if (!verifyQueryToken(mediaSecret, stillSubject(videoId), req.query.t)) {
        res.status(403).end()
        return
      }
      const atSec = Number(match[1])
      if (!spaceConfigured(space)) throw notFound()
      if (await stillInSpace(space, videoId, atSec)) {
        sendStillRedirect(res, videoId, atSec)
        return
      }
      const video = await db
        .selectFrom('videos')
        .select(['storage', 'hidden'])
        .where('id', '=', videoId)
        .executeTakeFirst()
      if (video == null || video.hidden) throw notFound()
      await redirectToStill(res, video.storage, videoId, atSec)
    })
  )

  /** Cuts and keeps the still if the Space lacks it, then redirects to it. */
  async function redirectToStill(
    res: Response,
    storage: 'peertube' | 'local' | 'spaces',
    videoId: string,
    atSec: number
  ): Promise<void> {
    const source = await videoFrameSource({
      mediaRoot,
      space,
      storage,
      videoId
    })
    if (source == null) throw notFound()
    const kept = await ensureStill({
      ffmpegPath,
      source,
      space,
      videoId,
      atSec
    }).catch(() => undefined)
    if (kept == null) throw notFound()
    sendStillRedirect(res, videoId, atSec)
  }

  /**
   * The redirect to a still in the Space. A still never changes for a given
   * second, so the redirect is cached for as long as the URL it names is good.
   */
  function sendStillRedirect(
    res: Response,
    videoId: string,
    atSec: number
  ): void {
    res.setHeader('cache-control', `private, max-age=${STILL_URL_TTL_SEC - 60}`)
    res.redirect(302, stillSpaceUrl(space, videoId, atSec, STILL_URL_TTL_SEC))
  }

  /**
   * The two playlists of a video that lives in the Space.
   *
   * Not behind `requireActor`: a player cannot send a header, so the token in
   * the query is the check. It was minted by `/playback`, which is where
   * membership was tested.
   */
  router.get(
    '/videos/:videoId/hls/:file',
    withAsync(async (req, res) => {
      const videoId = pathParam(req.params.videoId)
      const file = pathParam(req.params.file)
      const token = typeof req.query.t === 'string' ? req.query.t : ''

      if (!verifyQueryToken(mediaSecret, hlsSubject(videoId), token)) {
        // 403, not 404: the player is told to fetch a fresh playback URL and
        // resume, rather than to give up on the video.
        res.status(403).end()
        return
      }
      if (file !== 'master.m3u8' && file !== 'video.m3u8') throw notFound()
      if (!spaceConfigured(space)) throw notFound()

      const body = await playlists.get(videoId, file)
      if (body == null) throw notFound()

      res.type('application/vnd.apple.mpegurl')
      res.setHeader('cache-control', 'private, max-age=3600')

      if (file === 'master.m3u8') {
        // The variant keeps the same token; a relative URI would lose it.
        const variant = `${publicUrl}/api/v1/videos/${videoId}/hls/video.m3u8?t=${token}`
        res.send(rewriteMasterPlaylist(body, variant))
        return
      }

      // One presigned URL covers the whole file, at every byte range, which is
      // what makes seeking work without a signature per seek.
      const signed = presignGetUrl({
        ...space,
        key: spaceKey(videoId, VIDEO_FILE),
        expiresSec: MEDIA_TOKEN_TTL_SEC
      })
      res.send(rewriteMediaPlaylist(body, VIDEO_FILE, signed))
    })
  )

  /**
   * Deletes a video, its files, and what the Space is being paid to hold.
   *
   * Nothing removed a video before. Deleting one in GameStation — which was
   * not possible either — would have left every byte of it in the bucket
   * being paid for, and a stream somebody started to test the URL leaves a
   * recording of a car park that nobody wants and nobody could get rid of.
   *
   * Who may: whoever runs one of the game's teams, and the person whose camera
   * made it. The second is the addition. A key is a person's, so the recording
   * it produced is theirs to withdraw — somebody who streamed to the wrong
   * game should not have to find an administrator to undo it.
   *
   * Legacy videos are refused. Those live in PeerTube's tree, which this
   * server reads and does not own, and removing the row while the file stays
   * would be the worst of both.
   */
  router.delete(
    '/videos/:videoId',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const videoId = pathParam(req.params.videoId)

      const video = await db
        .selectFrom('videos')
        .leftJoin('games', 'games.id', 'videos.game_id')
        .select([
          'videos.id as id',
          'videos.title as title',
          'videos.kind as kind',
          'videos.storage as storage',
          'videos.status as status',
          'games.id as gameId',
          'games.home_team_id as homeTeamId',
          'games.away_team_id as awayTeamId'
        ])
        .where('videos.id', '=', videoId)
        .executeTakeFirst()
      if (video == null) throw notFound()

      // Every camera that produced this video, so the person who owns one can
      // delete it and so a running one can stop this before it starts.
      const cameras = await db
        .selectFrom('live_streams')
        .select(['id', 'user_id', 'state'])
        .where('video_id', '=', videoId)
        .execute()

      const scopes = await adminScopes(db, actor.userId, actor.isAdmin)
      const runsTheGame =
        scopes.isAdmin ||
        (video.homeTeamId != null && scopes.teamIds.has(video.homeTeamId)) ||
        (video.awayTeamId != null && scopes.teamIds.has(video.awayTeamId))
      const isMine = cameras.some(row => row.user_id === actor.userId)
      // 404 rather than 403: whether a video exists is not something to
      // confirm to somebody who may not touch it.
      if (!runsTheGame && !isMine) throw notFound()

      if (video.storage === 'peertube') {
        throw badRequest(
          'That recording came from the old server, which this one only reads. It cannot be deleted here.'
        )
      }
      if (cameras.some(row => row.state === 'publishing')) {
        throw badRequest(
          'Something is still streaming into that recording. End the camera first.'
        )
      }

      // The Space first. If it fails the row stays, and the delete can be
      // tried again; doing it the other way round loses the only record of
      // which objects were the video's, and they are then paid for for ever.
      let removedFromSpace = 0
      if (spaceConfigured(space)) {
        const { deleted } = await deleteVideoFromSpace({ space, videoId })
        removedFromSpace = deleted
      }

      const local = join(mediaRoot, 'work', 'videos', videoId)
      await rm(local, { recursive: true, force: true })

      // The cameras keep their rows — they are the record that a key existed —
      // and simply stop pointing at a video that is gone.
      if (cameras.length > 0) {
        await db
          .updateTable('live_streams')
          .set({ video_id: null, updated_at: new Date() })
          .where('video_id', '=', videoId)
          .execute()
      }
      // Anything this video displaced comes back. A recording is hidden and
      // dated for deletion only because something better took its place, so
      // deleting that something takes the reason away with it — and without
      // this, undoing a bad upload quietly destroys the recording the upload
      // pushed aside, which is the opposite of what deleting it was for.
      // The foreign key clears the pointer; the hiding and the purge date are
      // ours to undo.
      const restored = await db
        .updateTable('videos')
        .set({ hidden: false, purge_after: null, updated_at: new Date() })
        .where('replaced_by', '=', videoId)
        .returning('id')
        .execute()

      await db.deleteFrom('videos').where('id', '=', videoId).execute()

      setAudit(res.locals, {
        entityType: 'video',
        entityId: videoId,
        before: {
          title: video.title,
          kind: video.kind,
          storage: video.storage,
          gameId: video.gameId
        },
        after: { removedFromSpace, restored: restored.map(one => one.id) }
      })
      res.json({
        id: videoId,
        removedFromSpace,
        // What came back out of hiding because this went.
        restored: restored.map(one => one.id)
      })
    })
  )

  return router
}

/** How long the Space URL a still redirect names stays good for. */
const STILL_URL_TTL_SEC = 60 * 60

/** What an HLS token is signed against: this video's playlists, and no other. */
function hlsSubject(videoId: string): string {
  return `hls:${videoId}`
}

/**
 * What Caddy's `forward_auth` calls before serving a byte of media.
 *
 * It answers 204 or 403 and nothing else: no body, no database, no file
 * system. The URL Caddy is being asked about arrives in `x-forwarded-uri`.
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
