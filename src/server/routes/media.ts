import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import { type Response, Router } from 'express'
import type { Kysely } from 'kysely'

import {
  badRequest,
  membersOnly,
  notFound,
  unauthorized
} from '../../common/errors'
import { adminScopes, canSeeGame, visibleScopes } from '../access'
import { atomic } from '../db/atomic'
import type { Database } from '../db/database'
import { locateVideo, videoFrameSource } from '../media/locations'
import type { MediaContext } from '../media/mediaContext'
import {
  MEDIA_TOKEN_TTL_SEC,
  mediaUrlPath,
  signQueryToken,
  verifyMediaPath,
  verifyQueryToken
} from '../media/mediaTokens'
import {
  mediaVariant,
  rewriteMasterPlaylist,
  spaceConfigured,
  SpacePlayback
} from '../media/spacesHls'
import { deleteVideoFromSpace } from '../media/spacesVideo'
import {
  ensureStill,
  stillInSpace,
  stillSpaceUrl,
  stillSubject
} from '../media/stills'
import { readWallTimeline } from '../media/wallTimeline'
import { setAudit } from '../middleware/withAudit'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'
import { noteGameFigures } from '../socket/syncRevision'

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
  const playback = new SpacePlayback({
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
          'videos.kind as kind',
          'videos.status as status',
          'videos.duration_sec as durationSec',
          'videos.hidden as hidden',
          'games.home_team_id as homeTeamId',
          'games.away_team_id as awayTeamId',
          'games.season_id as seasonId'
        ])
        .where('videos.id', '=', videoId)
        .executeTakeFirst()
      // A video that is not there, or hidden, is 404. Anybody else signed in
      // reads its game, as a member or in the non-member view, and so is
      // told the video is for members when they are not one.
      if (video == null || video.hidden) throw notFound()
      if (!canSeeGame(scopes, video)) throw membersOnly()

      const waitingForOrigin =
        video.storage === 'local' &&
        video.kind === 'live' &&
        spaceConfigured(space)
      const location = waitingForOrigin
        ? undefined
        : await locateVideo({
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
          unavailable: true,
          // Finish may race the first acknowledgement. No node should issue
          // a scratch URL that the pending origin close will immediately remove.
          pending: waitingForOrigin
        })
        return
      }

      let entry = 'master.m3u8'
      if (video.storage === 'spaces' && video.kind === 'live') {
        const master = await playback.playlists.get(videoId, 'master.m3u8')
        if (master != null && mediaVariant(master) === 'index.m3u8')
          entry = 'index.m3u8'
      }
      const now = Date.now()
      const url =
        video.storage === 'spaces'
          ? // The API serves these playlists itself, rewriting the media entry
            // to a presigned URL so the bytes come from the Space directly. A
            // `<video>` element cannot send a bearer token, so the permission
            // rides in the query string.
            `${publicUrl}/api/v1/videos/${videoId}/hls/${entry}?t=${signQueryToken(
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

  /**
   * Where each moment of a video falls on the server's clock, so a player can
   * show the scoreboard as it was at the frame on screen. The same access as
   * the video itself: a player that may not have the picture has no use for
   * its clock.
   */
  router.get(
    '/videos/:videoId/wall-timeline',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const videoId = pathParam(req.params.videoId)
      const afterMs = afterMsParam(req.query.afterMs)
      const scopes = await visibleScopes(db, actor.userId, actor.isAdmin)

      const video = await db
        .selectFrom('videos')
        .innerJoin('games', 'games.id', 'videos.game_id')
        .select([
          'videos.id as id',
          'videos.status as status',
          'videos.start_at as startAt',
          'videos.sync_offset_sec as syncOffsetSec',
          'videos.start_at_clock_offset_ms as clockOffsetMs',
          'videos.hidden as hidden',
          'games.home_team_id as homeTeamId',
          'games.away_team_id as awayTeamId',
          'games.season_id as seasonId'
        ])
        .where('videos.id', '=', videoId)
        .executeTakeFirst()
      if (video == null || video.hidden) throw notFound()
      if (!canSeeGame(scopes, video)) throw membersOnly()

      res.json(await readWallTimeline(db, video, afterMs))
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
          'videos.spaces_verified_at as spacesVerifiedAt',
          'games.home_team_id as homeTeamId',
          'games.away_team_id as awayTeamId',
          'games.season_id as seasonId'
        ])
        .where('videos.id', '=', videoId)
        .executeTakeFirst()
      if (video == null || video.hidden) throw notFound()
      // A non-member has each highlight's signed still from the list; a
      // frame of their own choosing is part of the video, which is for
      // members.
      if (!canSeeGame(scopes, video)) throw membersOnly()

      await redirectToStill(
        res,
        video.storage,
        videoId,
        atSec,
        video.spacesVerifiedAt != null
      )
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
      const atSec = Number(match[1])
      // The token names the second it was minted for, so a URL opens only the
      // frame it was handed out for, not any other second of the video.
      if (
        !verifyQueryToken(
          mediaSecret,
          stillSubject(videoId, atSec),
          req.query.t
        )
      ) {
        res.status(403).end()
        return
      }
      if (!spaceConfigured(space)) throw notFound()
      if (await stillInSpace(space, videoId, atSec)) {
        sendStillRedirect(res, videoId, atSec)
        return
      }
      const video = await db
        .selectFrom('videos')
        .select(['storage', 'hidden', 'spaces_verified_at'])
        .where('id', '=', videoId)
        .executeTakeFirst()
      if (video == null || video.hidden) throw notFound()
      await redirectToStill(
        res,
        video.storage,
        videoId,
        atSec,
        video.spaces_verified_at != null
      )
    })
  )

  /** Cuts and keeps the still if the Space lacks it, then redirects to it. */
  async function redirectToStill(
    res: Response,
    storage: 'peertube' | 'local' | 'spaces',
    videoId: string,
    atSec: number,
    verified: boolean
  ): Promise<void> {
    const source = await videoFrameSource({
      mediaRoot,
      space,
      storage,
      videoId,
      verified
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
      if (!['master.m3u8', 'index.m3u8', 'video.m3u8'].includes(file))
        throw notFound()
      if (!spaceConfigured(space)) throw notFound()
      const video = await db
        .selectFrom('videos')
        .select(['hidden', 'storage', 'spaces_verified_at'])
        .where('id', '=', videoId)
        .executeTakeFirst()
      if (video == null || video.hidden || video.storage !== 'spaces')
        throw notFound()
      const verified = video.spaces_verified_at != null
      const body = await playback.get(videoId, file, verified)
      if (body == null) throw notFound()

      res.type('application/vnd.apple.mpegurl')
      res.setHeader(
        'cache-control',
        file === 'index.m3u8' && !verified
          ? 'private, max-age=1'
          : 'private, max-age=3600'
      )

      if (file === 'master.m3u8') {
        const name = mediaVariant(body)
        if (name == null) throw notFound()
        const variant = `${publicUrl}/api/v1/videos/${videoId}/hls/${name}?t=${token}`
        res.send(rewriteMasterPlaylist(body, variant))
        return
      }
      res.send(playback.rewrite(videoId, file, body))
    })
  )

  /**
   * Deletes a video, its files, and what the Space is being paid to hold.
   *
   * Nothing removed a video before. Deleting one in TeamStation — which was
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

      // The rows change together, and the game's event hears of it from the
      // transaction's last statements.
      const restored = await atomic(db, async trx => {
        // The cameras keep their rows — they are the record that a key
        // existed — and simply stop pointing at a video that is gone.
        if (cameras.length > 0) {
          await trx
            .updateTable('live_streams')
            .set({ video_id: null, updated_at: new Date() })
            .where('video_id', '=', videoId)
            .execute()
        }
        // Anything this video displaced comes back. A recording is hidden
        // and dated for deletion only because something better took its
        // place, so deleting that something takes the reason away with it —
        // and without this, undoing a bad upload quietly destroys the
        // recording the upload pushed aside, which is the opposite of what
        // deleting it was for. The foreign key clears the pointer; the
        // hiding and the purge date are ours to undo.
        const back = await trx
          .updateTable('videos')
          .set({ hidden: false, purge_after: null, updated_at: new Date() })
          .where('replaced_by', '=', videoId)
          .returning('id')
          .execute()

        await trx.deleteFrom('videos').where('id', '=', videoId).execute()
        // One video fewer on its season's row: Home's lists are told.
        if (video.gameId != null) await noteGameFigures(trx, video.gameId)
        return back
      })

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

/** The largest `video_wall_anchors.media_ms`: Postgres's `integer`. */
const MAX_MEDIA_MS = 2 ** 31 - 1

/** `?t=` in seconds. Anything that is not a number starts at the beginning. */
function secondsParam(value: unknown): number {
  if (typeof value !== 'string') return 0
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds < 0) return 0
  return seconds
}

/**
 * `afterMs`: a whole number of ms into the video, or absent. No more than a
 * point's `media_ms` can hold, a 32-bit integer, which Postgres would refuse
 * to compare with.
 */
function afterMsParam(value: unknown): number | undefined {
  if (value == null) return undefined
  const ms =
    typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN
  if (!Number.isSafeInteger(ms) || ms > MAX_MEDIA_MS) {
    throw badRequest('afterMs must be a whole number of milliseconds.')
  }
  return ms
}

function pathParam(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || value === '') throw notFound()
  return value
}
