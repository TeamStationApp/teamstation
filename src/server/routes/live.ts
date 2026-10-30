import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import { asBoolean, asObject, asOptional, asString } from 'cleaners'
import { Router } from 'express'
import type { Kysely } from 'kysely'

import {
  asCameraSource,
  asGameLiveStreams,
  asLiveNow,
  asLiveStatus,
  asLiveStream,
  asStreamAccess,
  type LiveStatus,
  type LiveStream
} from '../../common/api'
import { badRequest, notFound, unauthorized } from '../../common/errors'
import { gameCalendarDay } from '../../common/gameTime'
import { canFilm, canSeeGame, roleScopes, visibleScopes } from '../access'
import { lockKeys } from '../db/advisoryLocks'
import type { Database } from '../db/database'
import { isFullTeam, waitingOwnRequest } from '../groups/requests'
import {
  cameraLabelOf,
  checkCameraLimits,
  createLiveStream,
  deviceIdOf,
  deviceLabelTaken,
  deviceModelOf,
  isActiveStream,
  labelFor,
  labelTaken,
  liveStreamById,
  type LiveStreamRow,
  liveStreamsFor,
  MAX_CAMERAS,
  MAX_GAME_CAMERAS,
  placeByPublisher,
  requestDeviceStream,
  revealKey,
  rotateLiveStreamKey,
  setCameraName,
  streamUrlFor
} from '../live/streamKeys'
import { deleteVideo } from '../media/deleteVideo'
import { imageUrl } from '../media/imageUrls'
import type { SpaceSettings } from '../media/spacesHls'
import { setAudit } from '../middleware/withAudit'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'
import {
  recordRecordingReminder,
  settleRecordingReminder
} from '../notifications/recordingReminders'
import type { LiveSettings } from '../serverConfig'
import { withRevision } from '../socket/syncRevision'

/**
 * The cameras pointed at a game: the URLs they publish to, and what each one
 * is doing.
 *
 * A key is a **publish credential, and it is a person's**. Whoever holds it
 * puts video on this game under that person's name, so: it is issued to an
 * account, it is read back by that account and by nobody else — not even by
 * the people who run the team — and every reveal and rotation is in the audit
 * log. What the team's people *do* see is that a camera exists, whose it is,
 * what it is doing, and how to stop it. That is the difference between knowing
 * who is streaming and being able to stream as them.
 *
 * One person may have up to four cameras active on one game, which is four
 * videos, which is what the watch screen already calls angles, and a game may
 * have six. An ended camera stays on the list with its video and counts against
 * neither limit.
 *
 * Nothing here talks to the ingest. These endpoints write rows; the ingest
 * reads them within the second and acts. See `server/live/controller.ts`.
 */

export interface LiveRouteOptions {
  live: LiveSettings
  sessionSecret: string
  /** The host to print in a stream URL when none is configured. */
  /** What this deployment is called: the host a stream URL names. */
  host: string
  /** Where a discarded camera's video is deleted from. */
  space: SpaceSettings
  mediaRoot: string
}

const asStreamChange = asObject({
  label: asOptional(asString),
  /** Only `recorded`, and only on the caller's own device stream. */
  localRecording: asOptional(asString),
  /**
   * When the stream's first picture was captured, on the publisher's wall
   * clock, as an ISO 8601 instant: where its live video starts.
   */
  liveStartedAt: asOptional(asString)
})
const asNewStream = asObject({
  label: asOptional(asString),
  /** The install asking. With it, the device path below answers. */
  deviceId: asOptional(asString),
  deviceModel: asOptional(asString),
  recordsLocally: asOptional(asBoolean),
  heldStreamId: asOptional(asString),
  /** An external camera. It is tied to the account, so no device applies. */
  source: asOptional(asCameraSource)
})

interface GameRow {
  id: string
  homeTeamId: string
  awayTeamId: string
  seasonId: string | null
  startAt: Date
  /** Its own zone, in which it has a calendar day. */
  timezone: string
  homeTeamName: string
  awayTeamName: string
}

export function liveRoutes(
  db: Kysely<Database>,
  options: LiveRouteOptions
): Router {
  const router = Router()
  const { live, sessionSecret, host, space, mediaRoot } = options

  /**
   * The game, and the team of it this person films — a videographer of it,
   * which its administrators are — or nothing at all.
   */
  const gameToManage = async (
    userId: string,
    isAdmin: boolean,
    gameId: string
  ): Promise<{ game: GameRow; teamId: string }> => {
    const game = await loadGame(db, gameId)
    if (game == null) throw notFound()
    const scopes = await roleScopes(db, userId, isAdmin)
    // Home first: when somebody films both teams of a friendly, the stream
    // belongs to the side the game is listed under.
    for (const teamId of [game.homeTeamId, game.awayTeamId]) {
      if (canFilm(scopes, teamId)) return { game, teamId }
    }
    // 404, not 403: whether a game exists is not something to confirm to
    // somebody who cannot see it.
    throw notFound()
  }

  /** One of this person's own cameras, or nothing. Never somebody else's. */
  const myStream = async (
    userId: string,
    gameId: string,
    streamId: string
  ): Promise<LiveStreamRow> => {
    const row = await liveStreamById(db, streamId)
    // 404 rather than 403 for another person's camera: its id is not something
    // to confirm to somebody who may not act on it.
    if (row?.gameId !== gameId || row.userId !== userId) {
      throw notFound()
    }
    return row
  }

  /**
   * Whether this person films this game, and if not whether they can ask to.
   *
   * 404 for somebody who cannot see the game, as every read of a game is: a
   * member of neither team keeps the members-only message.
   */
  router.get(
    '/games/:gameId/stream-access',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const game = await loadGame(db, pathParam(req.params.gameId))
      const visible = await visibleScopes(db, actor.userId, actor.isAdmin)
      if (game == null || !canSeeGame(visible, game)) throw notFound()
      const scopes = await roleScopes(db, actor.userId, actor.isAdmin)
      const films = [game.homeTeamId, game.awayTeamId].some(teamId =>
        canFilm(scopes, teamId)
      )
      const teamId = visible.teamIds.has(game.homeTeamId)
        ? game.homeTeamId
        : game.awayTeamId
      const now = new Date()
      const upcoming =
        gameCalendarDay(game.startAt.toISOString(), game.timezone) >=
        gameCalendarDay(now.toISOString(), game.timezone)
      res.json(
        asStreamAccess({
          canFilm: films,
          canRequest:
            !films &&
            upcoming &&
            visible.teamIds.has(teamId) &&
            (await isFullTeam(db, teamId)),
          requested:
            (await waitingOwnRequest(
              db,
              'videographer',
              actor.userId,
              teamId,
              now
            )) != null,
          teamId
        })
      )
    })
  )

  /**
   * Everything pointed at this game: mine whole, everybody else's named.
   *
   * One request rather than one per camera, because the panel draws the whole
   * list at once and a game with four cameras would otherwise be four requests
   * every three seconds.
   */
  router.get(
    '/games/:gameId/live-streams',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const { game } = await gameToManage(
        actor.userId,
        actor.isAdmin,
        pathParam(req.params.gameId)
      )
      res.json(await listFor(db, space, game.id, actor.userId))
    })
  )

  /**
   * Another camera of this person's own, up to the fourth, while the game has
   * fewer than six.
   *
   * With a `deviceId`, it is the stream that device holds under that camera
   * name: the same one again (200), one an installed Director claimed under
   * that name (200), or a new one (201). See `requestDeviceStream`. Without
   * one — a browser, streaming software — every request is a new camera.
   *
   * The slot is the lowest they do not already hold, so somebody who ends
   * their second camera and asks for another gets that number back rather
   * than counting upwards for ever.
   */
  router.post(
    '/games/:gameId/live-streams',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const { game, teamId } = await gameToManage(
        actor.userId,
        actor.isAdmin,
        pathParam(req.params.gameId)
      )
      if (!live.enabled) {
        // A key nobody can publish with is worse than no key: the URL looks
        // right, the encoder dials, and nothing answers.
        throw badRequest('Live streaming is switched off on this server.')
      }
      if (sessionSecret === '') {
        // Nothing can be sealed without it, so a key cannot be kept, and a key
        // that cannot be read back cannot be pasted into anything. Saying so
        // beats a five-hundred that reads as "the site is broken".
        throw badRequest(
          'This server has no session secret set, so it cannot issue a stream key.'
        )
      }

      const body = cleanBody(asNewStream, req.body)
      // Blank is the same as omitted: the slot's own name, not an empty one.
      const named = cameraLabelOf(body.label)
      if (body.deviceId != null && body.source == null) {
        const answer = await requestDeviceStream(db, {
          gameId: game.id,
          teamId,
          startAt: game.startAt,
          videoTitle: `${game.awayTeamName} at ${game.homeTeamName}`,
          userId: actor.userId,
          deviceId: deviceIdOf(body.deviceId),
          deviceModel: deviceModelOf(body.deviceModel),
          label: named ?? null,
          recordsLocally: body.recordsLocally === true,
          heldStreamId: body.heldStreamId,
          live,
          sessionSecret
        })
        setAudit(res.locals, {
          entityType: 'liveStream',
          entityId: answer.row.id
        })
        res.status(answer.created ? 201 : 200).json({
          ...(await summaryOf(db, space, answer.row, actor.userId)),
          url: streamUrlFor(live, host, answer.key)
        })
        return
      }
      // Under the game's lock, as a device's request and a Director's claim
      // are, so streaming software and a phone asking at once get a slot
      // each, and neither is handed the other's key.
      const created = await db.transaction().execute(async trx => {
        await lockKeys(trx, [`liveStreams:${game.id}`])
        const slot = await checkCameraLimits(trx, game.id, actor.userId)
        return await createLiveStream(trx, {
          gameId: game.id,
          teamId,
          startAt: game.startAt,
          userId: actor.userId,
          slot,
          label: named ?? undefined,
          live,
          sessionSecret,
          videoTitle: `${game.awayTeamName} at ${game.homeTeamName}`,
          source: body.source
        })
      })

      setAudit(res.locals, { entityType: 'liveStream', entityId: created.id })
      res.status(201).json({
        ...(await summaryOf(db, space, created, actor.userId)),
        url: streamUrlFor(live, host, created.key)
      })
    })
  )

  /** The URL again, key and all — for the person it belongs to. */
  router.post(
    '/games/:gameId/live-streams/:streamId/reveal',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const { game } = await gameToManage(
        actor.userId,
        actor.isAdmin,
        pathParam(req.params.gameId)
      )
      const row = await myStream(
        actor.userId,
        game.id,
        pathParam(req.params.streamId)
      )
      setAudit(res.locals, { entityType: 'liveStream', entityId: row.id })

      let key: string
      try {
        key = revealKey(sessionSecret, row)
      } catch {
        // The server's secret changed. Saying so, and what to do about it, is
        // better than a five-hundred that reads as "the site is broken".
        throw badRequest(
          'This key cannot be read any more. Rotate it to get a new one.'
        )
      }
      res.json({
        ...(await summaryOf(db, space, row, actor.userId)),
        url: streamUrlFor(live, host, key)
      })
    })
  )

  /** A new key for one of this person's cameras. The old one dies at once. */
  router.post(
    '/games/:gameId/live-streams/:streamId/rotate',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const { game } = await gameToManage(
        actor.userId,
        actor.isAdmin,
        pathParam(req.params.gameId)
      )
      const row = await myStream(
        actor.userId,
        game.id,
        pathParam(req.params.streamId)
      )
      const key = await rotateLiveStreamKey(db, row.id, sessionSecret)
      setAudit(res.locals, { entityType: 'liveStream', entityId: row.id })
      const fresh = (await liveStreamById(db, row.id)) ?? row
      res.json({
        ...(await summaryOf(db, space, fresh, actor.userId)),
        url: streamUrlFor(live, host, key)
      })
    })
  )

  /**
   * Renaming a camera, a phone saying it holds its recording, or a publisher
   * saying when its first picture was captured.
   *
   * A device stream's new name follows the label rule: no two of the
   * caller's active device streams on the game share one. The first change
   * of `localRecording` from `none` to `recorded` records the upload
   * reminder. `liveStartedAt` places the live video by the publisher's own
   * clock, once; see `placeByPublisher`.
   */
  router.patch(
    '/games/:gameId/live-streams/:streamId',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const { game } = await gameToManage(
        actor.userId,
        actor.isAdmin,
        pathParam(req.params.gameId)
      )
      const row = await myStream(
        actor.userId,
        game.id,
        pathParam(req.params.streamId)
      )
      const body = cleanBody(asStreamChange, req.body)
      const named = cameraLabelOf(body.label)
      if (body.localRecording != null) {
        if (body.localRecording !== 'recorded') {
          throw badRequest('localRecording can only be set to recorded.')
        }
        if (row.deviceId == null) {
          throw badRequest('Only a device stream holds a recording.')
        }
      }
      const liveStartedAt =
        body.liveStartedAt == null ? undefined : new Date(body.liveStartedAt)
      if (liveStartedAt != null && Number.isNaN(liveStartedAt.getTime())) {
        throw badRequest('liveStartedAt must be an ISO 8601 instant.')
      }
      if (
        named != null &&
        row.deviceId != null &&
        (await deviceLabelTaken(db, {
          gameId: game.id,
          userId: actor.userId,
          label: named,
          exceptId: row.id
        }))
      ) {
        throw labelTaken(named)
      }
      // Absent leaves the stored name. Present writes the label and the
      // video title together, including a blank, which clears it.
      if (named !== undefined) {
        await setCameraName(db, row.id, named)
      }
      if (body.localRecording != null) {
        // A device that holds a recording keeps its own, whatever the
        // request that made its stream said: the upload that settles the
        // reminder looks for streams that do.
        const marked = await db
          .updateTable('live_streams')
          .set({
            local_recording: 'recorded',
            records_locally: true,
            updated_at: new Date()
          })
          .where('id', '=', row.id)
          .where('local_recording', '=', 'none')
          .executeTakeFirst()
        if (Number(marked.numUpdatedRows) > 0) {
          await recordRecordingReminder(db, row.id)
        }
      }
      const placed =
        liveStartedAt != null &&
        (await placeByPublisher(db, row.id, liveStartedAt))

      setAudit(res.locals, {
        entityType: 'liveStream',
        entityId: row.id,
        before: { label: row.label, localRecording: row.localRecording },
        after: {
          label: named === undefined ? row.label : named,
          localRecording:
            body.localRecording != null && row.localRecording === 'none'
              ? 'recorded'
              : row.localRecording,
          ...(placed ? { liveStartedAt: liveStartedAt.toISOString() } : {})
        }
      })
      const fresh = (await liveStreamById(db, row.id)) ?? row
      res.json(await summaryOf(db, space, fresh, actor.userId))
    })
  )

  /**
   * Ends one camera now.
   *
   * A person may end their own; so may anybody who runs the team, because a
   * stream on their game that should not be there is theirs to stop — which is
   * the one thing they can do to somebody else's camera, and it is not the
   * same as being able to publish with it.
   */
  router.post(
    '/games/:gameId/live-streams/:streamId/end',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const { game } = await gameToManage(
        actor.userId,
        actor.isAdmin,
        pathParam(req.params.gameId)
      )
      const row = await liveStreamById(db, pathParam(req.params.streamId))
      if (row?.gameId !== game.id) throw notFound()

      // Closing the window rather than ending the stream from here. The
      // ingest holds the ffmpeg writing the playlist, and it is the only
      // thing that may close that playlist; ending it from an API worker
      // would write `EXT-X-ENDLIST` into a file another process is still
      // appending to. It notices within the second.
      await db
        .updateTable('live_streams')
        .set({ closes_at: new Date(), updated_at: new Date() })
        .where('id', '=', row.id)
        .execute()
      setAudit(res.locals, { entityType: 'liveStream', entityId: row.id })
      const fresh = (await liveStreamById(db, row.id)) ?? row
      res.json(await summaryOf(db, space, fresh, actor.userId))
    })
  )

  /**
   * Removes one of this person's own cameras altogether.
   *
   * Ending a camera stops it; this takes it off the game. They are different
   * things and both are wanted: somebody who added a fourth camera by mistake
   * has no use for a row that says "ended" for ever, and the slot it was
   * holding is one of only four.
   *
   * Their own only — not a camera of somebody else's. Whoever runs the team
   * can already *stop* another person's camera, which is the thing that
   * matters during a game; quietly deleting somebody else's row is not.
   *
   * A camera that never carried any video takes its empty recording and that
   * recording's folder with it. One that did leaves the recording behind: the
   * key is a credential and the video is a game, and throwing away the second
   * because somebody tidied up the first is not a thing to do without being
   * asked. `DELETE /videos/{id}` is how the video goes.
   */
  router.delete(
    '/games/:gameId/live-streams/:streamId',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const { game } = await gameToManage(
        actor.userId,
        actor.isAdmin,
        pathParam(req.params.gameId)
      )
      const row = await myStream(
        actor.userId,
        game.id,
        pathParam(req.params.streamId)
      )
      if (row.state === 'publishing') {
        // Pulling a row out from under a running ffmpeg is how a playlist ends
        // up half written. Stop it first, which takes a second, then remove it.
        throw badRequest(
          'That camera is streaming. End it first, then remove it.'
        )
      }

      // Revoked rather than deleted: the row is the audit trail of a key that
      // existed, and `liveStreamsFor` already hides revoked ones, so the
      // camera disappears from the list and its number comes back.
      const now = new Date()
      await db
        .updateTable('live_streams')
        .set({ state: 'revoked', closes_at: now, updated_at: now })
        .where('id', '=', row.id)
        .execute()

      let removedVideo = false
      if (row.videoId != null) {
        // Only the empty one. `hidden` is how a live video starts and stays
        // until video actually arrives, so a hidden row with no length is a
        // recording that never happened.
        const video = await db
          .selectFrom('videos')
          .select(['id', 'duration_sec', 'size_bytes', 'hidden'])
          .where('id', '=', row.videoId)
          .executeTakeFirst()
        if (
          video != null &&
          video.hidden &&
          video.duration_sec == null &&
          video.size_bytes == null
        ) {
          await db.deleteFrom('videos').where('id', '=', video.id).execute()
          await rm(join(mediaRoot, 'work', 'videos', video.id), {
            recursive: true,
            force: true
          })
          removedVideo = true
        }
      }

      setAudit(res.locals, {
        entityType: 'liveStream',
        entityId: row.id,
        before: { state: row.state, slot: row.slot },
        after: { state: 'revoked', removedVideo }
      })
      res.json(await listFor(db, space, game.id, actor.userId))
    })
  )

  /**
   * Deletes one of this person's own ended cameras, and everything it made.
   *
   * Removing a camera leaves its recording; this is the delete that takes the
   * recording too: its live video and every upload of it, which is what lets
   * a phone drop its own copy. Only once it has stopped. A camera still active
   * has End, and one still `publishing` after End is one whose playlist the
   * ingest has not closed yet.
   */
  router.post(
    '/games/:gameId/live-streams/:streamId/discard',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const { game } = await gameToManage(
        actor.userId,
        actor.isAdmin,
        pathParam(req.params.gameId)
      )
      const row = await myStream(
        actor.userId,
        game.id,
        pathParam(req.params.streamId)
      )
      if (isActiveStream(row) || row.state === 'publishing') {
        throw badRequest('That camera is still running. End it first.')
      }

      const uploads = await db
        .selectFrom('director_uploads')
        .select('video_id as videoId')
        .where('live_stream_id', '=', row.id)
        .where('video_id', 'is not', null)
        .execute()
      const videoIds = [
        ...new Set([row.videoId, ...uploads.map(one => one.videoId)])
      ].filter(id => id != null)
      for (const videoId of videoIds) {
        await deleteVideo({ db, space, mediaRoot }, videoId)
      }

      const now = new Date()
      await db
        .updateTable('live_streams')
        .set({ discarded_at: now, updated_at: now })
        .where('id', '=', row.id)
        .execute()
      await settleRecordingReminder(db, row.id, now)

      setAudit(res.locals, {
        entityType: 'liveStream',
        entityId: row.id,
        before: { state: row.state, slot: row.slot },
        after: { discarded: true, deletedVideos: videoIds }
      })
      res.json(await listFor(db, space, game.id, actor.userId))
    })
  )

  /**
   * What is live right now, for the people who may watch it.
   *
   * Home leads with this, so it is asked for on every load by everybody: it
   * reads two small tables and returns nothing at all on the ordinary day
   * when no game is on.
   */
  router.get(
    '/live',
    requireActor,
    // Home's look at what is on is one of the reads its scope gates, so it
    // carries the revision its rows were read at, as the others do.
    withRevision(db, async (db, req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const scopes = await visibleScopes(db, actor.userId, actor.isAdmin)

      const rows = await db
        .selectFrom('videos')
        .innerJoin('games', 'games.id', 'videos.game_id')
        .innerJoin('teams as home', 'home.id', 'games.home_team_id')
        .innerJoin('teams as away', 'away.id', 'games.away_team_id')
        .select([
          'videos.id as videoId',
          'videos.title as title',
          'videos.start_at as startedAt',
          'games.id as gameId',
          'games.home_team_id as homeTeamId',
          'games.away_team_id as awayTeamId',
          'games.season_id as seasonId',
          'games.start_at as gameStartAt',
          'home.name as homeTeamName',
          'away.name as awayTeamName'
        ])
        .where('videos.status', '=', 'live')
        .where('videos.hidden', '=', false)
        .orderBy('videos.start_at', 'desc')
        .execute()

      // One entry per game, not per camera: four angles of one game are one
      // thing happening, and a home screen that listed them four times would
      // be lying about how much baseball is on. The newest is the one to lead
      // with, and the rest are waiting on the game's own screen.
      const byGame = new Map<
        string,
        (typeof rows)[number] & { angles: number }
      >()
      for (const row of rows) {
        if (!canSeeGame(scopes, row)) continue
        const held = byGame.get(row.gameId)
        if (held == null) {
          byGame.set(row.gameId, { ...row, angles: 1 })
          continue
        }
        held.angles += 1
      }

      res.json(
        [...byGame.values()].map(row =>
          asLiveNow({
            videoId: row.videoId,
            gameId: row.gameId,
            title: row.title,
            homeTeamName: row.homeTeamName,
            awayTeamName: row.awayTeamName,
            startedAt:
              row.startedAt == null
                ? null
                : new Date(row.startedAt).toISOString(),
            gameStartAt: new Date(row.gameStartAt).toISOString(),
            angles: row.angles
          })
        )
      )
    })
  )

  return router
}

/**
 * What a camera looks like to somebody who is not being handed its key.
 *
 * The prefix is here so two keys can be told apart in a list and in the audit
 * log; nine characters of a hundred-and-thirty-bit secret publishes nothing.
 * The owner's name is here because the whole point of a key per person is
 * being able to say whose picture this is.
 */
async function summaryOf(
  db: Kysely<Database>,
  space: SpaceSettings,
  row: LiveStreamRow,
  askedBy: string
): Promise<LiveStream> {
  const [status, owners] = await Promise.all([
    statusOf(db, row.id),
    ownersOf(db, space, [row.userId])
  ])
  return oneStream(row, status, owners.get(row.userId)?.name ?? '', askedBy)
}

/** What a game's list says of a camera beyond what a single answer does. */
interface ListedStream {
  ownerPicture: string | null
  video: PlayableVideo | undefined
}

/**
 * One camera as an answer.
 *
 * Every item of a game's list says what device holds it and how far its
 * recording has got, and the owner's own items say which install. A single
 * camera says so too when a device holds it; one made for a browser or
 * streaming software answers exactly as it always has. Only a list says when
 * the camera ran and what to play.
 */
function oneStream(
  row: LiveStreamRow,
  status: LiveStatus | null,
  ownerName: string,
  askedBy: string,
  listed?: ListedStream
): LiveStream {
  const device = listed != null || row.deviceId != null
  return asLiveStream({
    id: row.id,
    gameId: row.gameId,
    userId: row.userId,
    ownerName,
    slot: row.slot,
    label: labelFor(row),
    keyPrefix: row.keyPrefix,
    state: row.state,
    opensAt: row.opensAt.toISOString(),
    closesAt: row.closesAt?.toISOString() ?? null,
    videoId: row.videoId,
    // Somebody else's trouble is not this person's to read: a refusal can name
    // a key's prefix or a disk, and in any case there is nothing they could do
    // about it but tell them.
    lastError: row.userId === askedBy ? row.lastError : null,
    status: row.userId === askedBy ? status : null,
    ...(device
      ? {
          deviceModel: row.deviceModel,
          localRecording: row.localRecording,
          ...(row.userId === askedBy ? { deviceId: row.deviceId } : {})
        }
      : {}),
    ...(listed == null
      ? {}
      : {
          createdAt: row.createdAt.toISOString(),
          source: row.source,
          publishedAt: row.publishedAt?.toISOString() ?? null,
          endedAt: row.endedAt?.toISOString() ?? null,
          durationSec: listed.video?.durationSec ?? null,
          playableVideoId: listed.video?.id ?? null,
          ownerPicture: listed.ownerPicture
        })
  })
}

/** Everything on one game, split by whose it is. */
async function listFor(
  db: Kysely<Database>,
  space: SpaceSettings,
  gameId: string,
  askedBy: string
): Promise<unknown> {
  const rows = await liveStreamsFor(db, gameId)
  const [owners, videos, discarded] = await Promise.all([
    ownersOf(
      db,
      space,
      rows.map(row => row.userId)
    ),
    playableVideos(db, rows),
    db
      .selectFrom('live_streams')
      .select('id')
      .where('game_id', '=', gameId)
      .where('user_id', '=', askedBy)
      .where('discarded_at', 'is not', null)
      .orderBy('id')
      .execute()
  ])
  const statuses = new Map<string, LiveStatus | null>()
  for (const row of rows) {
    statuses.set(
      row.id,
      row.userId === askedBy ? await statusOf(db, row.id) : null
    )
  }
  const drawn = rows.map(row =>
    oneStream(
      row,
      statuses.get(row.id) ?? null,
      owners.get(row.userId)?.name ?? '',
      askedBy,
      {
        ownerPicture: owners.get(row.userId)?.picture ?? null,
        video: videos.get(row.id)
      }
    )
  )
  const active = rows.filter(row => isActiveStream(row))
  const activeMine = active.filter(row => row.userId === askedBy)
  const gameCanAdd = Math.max(0, MAX_GAME_CAMERAS - active.length)
  return asGameLiveStreams({
    gameId,
    mine: drawn.filter(row => row.userId === askedBy),
    others: drawn.filter(row => row.userId !== askedBy),
    canAdd: Math.min(MAX_CAMERAS - activeMine.length, gameCanAdd),
    maxCameras: MAX_CAMERAS,
    gameCanAdd,
    discarded: discarded.map(row => row.id)
  })
}

interface Owner {
  name: string
  picture: string | null
}

/** Who these people are, in the words a screen would use, and their picture. */
async function ownersOf(
  db: Kysely<Database>,
  space: SpaceSettings,
  userIds: string[]
): Promise<Map<string, Owner>> {
  const wanted = [...new Set(userIds)]
  if (wanted.length === 0) return new Map()
  const rows = await db
    .selectFrom('users')
    .select(['id', 'display_name as displayName', 'avatar_path as avatarPath'])
    .where('id', 'in', wanted)
    .execute()
  return new Map(
    rows.map(row => [
      row.id,
      { name: row.displayName, picture: imageUrl(space, row.avatarPath) }
    ])
  )
}

interface PlayableVideo {
  id: string
  durationSec: number | null
}

/**
 * The video each camera plays: its newest finished upload when that is
 * visible, otherwise its live video when that is. By upload rather than by
 * `replaced_by`, because an upload that stands alone replaced nothing.
 */
async function playableVideos(
  db: Kysely<Database>,
  rows: LiveStreamRow[]
): Promise<Map<string, PlayableVideo>> {
  const ids = rows.map(row => row.id)
  if (ids.length === 0) return new Map()
  const uploads = await db
    .selectFrom('director_uploads')
    .select(['live_stream_id as streamId', 'video_id as videoId'])
    .where('live_stream_id', 'in', ids)
    .where('state', '=', 'ready')
    .where('video_id', 'is not', null)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .execute()
  const live = rows.flatMap(row => (row.videoId == null ? [] : [row.videoId]))
  const wanted = [...live, ...uploads.flatMap(one => one.videoId ?? [])]
  const visible =
    wanted.length === 0
      ? []
      : await db
          .selectFrom('videos')
          .select(['id', 'duration_sec as durationSec'])
          .where('id', 'in', wanted)
          .where('hidden', '=', false)
          .where('status', 'in', ['live', 'ready'])
          .execute()
  const byId = new Map(visible.map(one => [one.id, one]))
  const answer = new Map<string, PlayableVideo>()
  for (const row of rows) {
    const candidates = [
      ...uploads.filter(one => one.streamId === row.id).map(one => one.videoId),
      row.videoId
    ]
    const found = candidates
      .map(id => (id == null ? undefined : byId.get(id)))
      .find(one => one != null)
    if (found != null) answer.set(row.id, found)
  }
  return answer
}

/**
 * The ingest's last snapshot, as it wrote it.
 *
 * Cleaned on the way out like everything else: the column is `jsonb`, so what
 * comes back is whatever was in the database, and an older server's shape must
 * fail here rather than in a screen.
 */
async function statusOf(
  db: Kysely<Database>,
  liveStreamId: string
): Promise<LiveStatus | null> {
  const row = await db
    .selectFrom('live_streams')
    .select(['status'])
    .where('id', '=', liveStreamId)
    .executeTakeFirst()
  if (row?.status == null) return null
  try {
    return asLiveStatus(row.status)
  } catch {
    return null
  }
}

async function loadGame(
  db: Kysely<Database>,
  gameId: string
): Promise<GameRow | undefined> {
  const row = await db
    .selectFrom('games')
    .innerJoin('teams as home', 'home.id', 'games.home_team_id')
    .innerJoin('teams as away', 'away.id', 'games.away_team_id')
    .select([
      'games.id as id',
      'games.home_team_id as homeTeamId',
      'games.away_team_id as awayTeamId',
      'games.season_id as seasonId',
      'games.start_at as startAt',
      'games.timezone as timezone',
      'home.name as homeTeamName',
      'away.name as awayTeamName'
    ])
    .where('games.id', '=', gameId)
    .executeTakeFirst()
  if (row == null) return undefined
  return { ...row, startAt: new Date(row.startAt) }
}

function pathParam(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || value === '') throw notFound()
  return value
}

function cleanBody<T>(cleaner: (raw: unknown) => T, raw: unknown): T {
  try {
    return cleaner(raw)
  } catch (error) {
    throw badRequest(
      error instanceof Error ? error.message : 'Malformed request body'
    )
  }
}
