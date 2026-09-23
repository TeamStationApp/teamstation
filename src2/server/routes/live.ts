import { asObject, asOptional, asString } from 'cleaners'
import { Router } from 'express'
import type { Kysely } from 'kysely'

import {
  asGameLiveStreams,
  asLiveNow,
  asLiveStatus,
  asLiveStream,
  type LiveStatus,
  type LiveStream
} from '../../common/api'
import { badRequest, notFound, unauthorized } from '../../common/errors'
import { adminScopes, canSeeGame, visibleScopes } from '../access'
import type { Database } from '../db/database'
import {
  createLiveStream,
  freeSlot,
  labelFor,
  liveStreamById,
  type LiveStreamRow,
  liveStreamsFor,
  MAX_CAMERAS,
  myLiveStreams,
  revealKey,
  rotateLiveStreamKey,
  streamUrlFor
} from '../live/streamKeys'
import { setAudit } from '../middleware/withAudit'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'
import type { LiveSettings } from '../serverConfig'

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
 * One person may point up to four cameras at one game, which is four videos,
 * which is what the watch screen already calls angles.
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
}

const asStreamChange = asObject({ label: asOptional(asString) })
const asNewStream = asObject({ label: asOptional(asString) })

interface GameRow {
  id: string
  homeTeamId: string
  awayTeamId: string
  seasonId: string | null
  startAt: Date
  homeTeamName: string
  awayTeamName: string
}

export function liveRoutes(
  db: Kysely<Database>,
  options: LiveRouteOptions
): Router {
  const router = Router()
  const { live, sessionSecret, host } = options

  /** The game, and the team of it this person runs — or nothing at all. */
  const gameToManage = async (
    userId: number,
    isAdmin: boolean,
    gameId: string
  ): Promise<{ game: GameRow; teamId: string }> => {
    const game = await loadGame(db, gameId)
    if (game == null) throw notFound()
    const scopes = await adminScopes(db, userId, isAdmin)
    // Home first: when somebody runs both teams of a friendly, the stream
    // belongs to the side the game is listed under.
    for (const teamId of [game.homeTeamId, game.awayTeamId]) {
      if (scopes.isAdmin || scopes.teamIds.has(teamId)) return { game, teamId }
    }
    // 404, not 403: whether a game exists is not something to confirm to
    // somebody who cannot see it.
    throw notFound()
  }

  /** One of this person's own cameras, or nothing. Never somebody else's. */
  const myStream = async (
    userId: number,
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
      res.json(await listFor(db, game.id, actor.userId))
    })
  )

  /**
   * Another camera of this person's own, up to the fourth.
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
      const mine = await myLiveStreams(db, game.id, actor.userId)
      const slot = freeSlot(mine)
      if (slot == null) {
        throw badRequest(
          `You already have ${MAX_CAMERAS} cameras on this game. End one to add another.`
        )
      }

      let created
      try {
        created = await createLiveStream(db, {
          gameId: game.id,
          teamId,
          startAt: game.startAt,
          userId: actor.userId,
          slot,
          label: body.label,
          live,
          sessionSecret,
          videoTitle: `${game.awayTeamName} at ${game.homeTeamName}`
        })
      } catch (error) {
        // Two presses of the button at once: one of them wins the slot and the
        // other lands here. Hand back what it was asking for rather than a
        // five-hundred.
        const raced = (await myLiveStreams(db, game.id, actor.userId)).find(
          row => row.slot === slot
        )
        if (raced == null) throw error
        setAudit(res.locals, { entityType: 'liveStream', entityId: raced.id })
        res.json({
          ...(await summaryOf(db, raced, actor.userId)),
          url: streamUrlFor(live, host, revealKey(sessionSecret, raced))
        })
        return
      }

      setAudit(res.locals, { entityType: 'liveStream', entityId: created.id })
      res.status(201).json({
        ...(await summaryOf(db, created, actor.userId)),
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
        ...(await summaryOf(db, row, actor.userId)),
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
        ...(await summaryOf(db, fresh, actor.userId)),
        url: streamUrlFor(live, host, key)
      })
    })
  )

  /** Renaming a camera. */
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
      const now = new Date()

      await db
        .updateTable('live_streams')
        .set({
          ...(body.label == null
            ? {}
            : { label: body.label.trim() === '' ? null : body.label.trim() }),
          updated_at: now
        })
        .where('id', '=', row.id)
        .execute()

      setAudit(res.locals, {
        entityType: 'liveStream',
        entityId: row.id,
        before: { label: row.label },
        after: { label: body.label }
      })
      const fresh = (await liveStreamById(db, row.id)) ?? row
      res.json(await summaryOf(db, fresh, actor.userId))
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
      res.json(await summaryOf(db, fresh, actor.userId))
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
   * A camera that never carried any video takes its empty recording with it.
   * One that did leaves the recording behind: the key is a credential and the
   * video is a game, and throwing away the second because somebody tidied up
   * the first is not a thing to do without being asked. `DELETE /videos/{id}`
   * is how the video goes.
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
          removedVideo = true
        }
      }

      setAudit(res.locals, {
        entityType: 'liveStream',
        entityId: row.id,
        before: { state: row.state, slot: row.slot },
        after: { state: 'revoked', removedVideo }
      })
      res.json(await listFor(db, game.id, actor.userId))
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
    withAsync(async (req, res) => {
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
  row: LiveStreamRow,
  askedBy: number
): Promise<LiveStream> {
  const [status, names] = await Promise.all([
    statusOf(db, row.id),
    namesFor(db, [row.userId])
  ])
  return oneStream(row, status, names.get(row.userId) ?? '', askedBy)
}

function oneStream(
  row: LiveStreamRow,
  status: LiveStatus | null,
  ownerName: string,
  askedBy: number
): LiveStream {
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
    status: row.userId === askedBy ? status : null
  })
}

/** Everything on one game, split by whose it is. */
async function listFor(
  db: Kysely<Database>,
  gameId: string,
  askedBy: number
): Promise<unknown> {
  const rows = await liveStreamsFor(db, gameId)
  const names = await namesFor(
    db,
    rows.map(row => row.userId)
  )
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
      names.get(row.userId) ?? '',
      askedBy
    )
  )
  const mine = drawn.filter(row => row.userId === askedBy)
  return asGameLiveStreams({
    gameId,
    mine,
    others: drawn.filter(row => row.userId !== askedBy),
    canAdd: Math.max(0, MAX_CAMERAS - mine.length),
    maxCameras: MAX_CAMERAS
  })
}

/** Who these people are, in the words a screen would use. */
async function namesFor(
  db: Kysely<Database>,
  userIds: number[]
): Promise<Map<number, string>> {
  const wanted = [...new Set(userIds)]
  if (wanted.length === 0) return new Map()
  const rows = await db
    .selectFrom('users')
    .select(['id', 'display_name as displayName'])
    .where('id', 'in', wanted)
    .execute()
  return new Map(rows.map(row => [row.id, row.displayName]))
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
