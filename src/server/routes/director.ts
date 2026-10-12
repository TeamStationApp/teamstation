import { asObject, asOptional, asString } from 'cleaners'
import { Router } from 'express'
import type { Kysely } from 'kysely'

import { badRequest, notFound, unauthorized } from '../../common/errors'
import { canFilm, roleScopes } from '../access'
import { lockKeys } from '../db/advisoryLocks'
import type { Database } from '../db/database'
import { cleanBody } from '../jsonBody'
import {
  cameraLabelOf,
  createLiveStream,
  freeSlot,
  type LiveStreamRow,
  MAX_CAMERAS,
  myLiveStreams,
  revealKey,
  setCameraName,
  streamUrlFor
} from '../live/streamKeys'
import type { SpaceSettings } from '../media/spacesHls'
import { setAudit } from '../middleware/withAudit'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'
import type { LiveSettings } from '../serverConfig'

/**
 * What TS Director asks for once it has picked a game.
 *
 * The list itself is `GET /events?scope=film`. The operator picks a game from
 * that list and the app claims it, which is the whole of choosing a
 * destination: no URL is typed and none is shown. The key comes back to the
 * app and goes in its keychain.
 */

export interface DirectorRouteOptions {
  live: LiveSettings
  sessionSecret: string
  /** What this deployment is called: the host a stream URL names. */
  host: string
  space?: SpaceSettings
  /** What a camera claimed by a Director is called in the list. */
  deviceLabel?: string
}

/**
 * The key, or a sentence an operator at a field can act on.
 *
 * An unreadable seal means the server's secret changed under a key that was
 * already issued. The Director cannot rotate it — that is done on the website —
 * so the message has to say where to go.
 */
function readKey(sessionSecret: string, row: LiveStreamRow): string {
  try {
    return revealKey(sessionSecret, row)
  } catch {
    throw badRequest(
      'This game’s stream key cannot be read any more. Rotate it on the website.'
    )
  }
}

const asClaim = asObject({ cameraName: asOptional(asString) })

export function directorRoutes(
  db: Kysely<Database>,
  options: DirectorRouteOptions
): Router {
  const router = Router()

  /**
   * Taking a game: the app gets the URL for it, key and all, and the operator
   * never sees either. Asked for again — a reinstall, a second Director — it
   * answers with the same key rather than minting another, because two keys on
   * one game means the second silently takes the first one's place.
   */
  router.post(
    '/director/events/:gameId/claim',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const gameId = pathParam(req.params.gameId)

      const game = await db
        .selectFrom('games')
        .innerJoin('teams as home', 'home.id', 'games.home_team_id')
        .innerJoin('teams as away', 'away.id', 'games.away_team_id')
        .select([
          'games.id as id',
          'games.start_at as startAt',
          'games.home_team_id as homeTeamId',
          'games.away_team_id as awayTeamId',
          'home.name as homeTeamName',
          'away.name as awayTeamName'
        ])
        .where('games.id', '=', gameId)
        .executeTakeFirst()
      if (game == null) throw notFound()

      const scopes = await roleScopes(db, actor.userId, actor.isAdmin)
      const teamId = [game.homeTeamId, game.awayTeamId].find(id =>
        canFilm(scopes, id)
      )
      if (teamId == null) throw notFound()
      if (!options.live.enabled) {
        // Said here rather than at the ingest: a Director that has been handed
        // a URL will dial it at the first pitch and hear nothing back.
        throw badRequest('Live streaming is switched off on this server.')
      }

      // Refused before any row is written, so a too-long name or one that
      // contains the angle separator leaves a stored name as it was.
      const claim = cleanBody(asClaim, req.body ?? {})
      const cameraName = cameraLabelOf(claim.cameraName) ?? undefined

      // Taking a game twice is the ordinary case, not the exception: the same
      // Director claims it again on every redial. It gets **its own account's**
      // camera — its lowest-numbered one that no device holds — so a second
      // Director signed in as somebody else is a second camera on the game
      // rather than a second publisher turned away from the same key. A
      // phone's stream, or the new Director build's, is never returned or
      // renamed here: those are asked for by device.
      //
      // Under the game's lock, so a claim and a device's request cannot both
      // take the same slot.
      const claimed = await db.transaction().execute(async trx => {
        await lockKeys(trx, [`liveStreams:${game.id}`])
        const mine = await myLiveStreams(trx, game.id, actor.userId)
        const existing = mine.find(row => row.deviceId == null)
        if (existing != null) {
          return {
            row: existing,
            key: readKey(options.sessionSecret, existing)
          }
        }
        const slot = freeSlot(mine)
        if (slot == null) {
          throw badRequest(
            `You already have ${MAX_CAMERAS} cameras on this game. End one to add another.`
          )
        }
        const created = await createLiveStream(trx, {
          gameId: game.id,
          teamId,
          startAt: new Date(game.startAt),
          userId: actor.userId,
          slot,
          label: cameraName ?? options.deviceLabel,
          live: options.live,
          sessionSecret: options.sessionSecret,
          videoTitle: `${game.awayTeamName} at ${game.homeTeamName}`,
          directorClaimed: true
        })
        const { key, ...row } = created
        return { row, key }
      })
      // Every stream this route returns is one an installed Director holds,
      // which is what lets a device updating mid-game adopt it.
      if (!claimed.row.directorClaimed) {
        await db
          .updateTable('live_streams')
          .set({ director_claimed: true, updated_at: new Date() })
          .where('id', '=', claimed.row.id)
          .execute()
      }
      // A later claim with no name, including `{ "cameraName": "" }`, leaves
      // a name already stored. Clearing stays the live-stream PATCH.
      if (cameraName != null) {
        await setCameraName(db, claimed.row.id, cameraName)
      }

      const row = claimed.row
      const key = claimed.key
      setAudit(res.locals, { entityType: 'liveStream', entityId: row.id })
      res.json({
        gameId: game.id,
        url: streamUrlFor(options.live, options.host, key),
        opensAt: row.opensAt.toISOString(),
        closesAt: row.closesAt?.toISOString() ?? null
      })
    })
  )

  /**
   * What this Director's own camera on a game is doing, and why it is not.
   *
   * Asked when a publish fails. The ingest writes the reason on the row — the
   * key is not open, the codec is wrong, there is no room on the disk — and
   * that sentence is far better than the socket's, which can only say that a
   * connection closed.
   *
   * Its own camera only: the one the claim resolves, its lowest-numbered
   * stream that no device holds.
   */
  router.get(
    '/director/events/:gameId/stream',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const gameId = pathParam(req.params.gameId)
      const mine = (await myLiveStreams(db, gameId, actor.userId)).find(
        item => item.deviceId == null
      )
      if (mine == null) throw notFound()
      res.json({
        gameId,
        state: mine.state,
        lastError: mine.lastError
      })
    })
  )

  return router
}

function pathParam(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || value === '') throw notFound()
  return value
}
