import { Router } from 'express'
import type { Kysely } from 'kysely'

import { asDirectorEvent, type DirectorEvent } from '../../common/api'
import { badRequest, notFound, unauthorized } from '../../common/errors'
import { canFilm, roleScopes } from '../access'
import type { Database } from '../db/database'
import {
  createLiveStream,
  type LiveStreamRow,
  myLiveStreams,
  revealKey,
  streamUrlFor
} from '../live/streamKeys'
import { imageUrl } from '../media/imageUrls'
import type { SpaceSettings } from '../media/spacesHls'
import { setAudit } from '../middleware/withAudit'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'
import type { LiveSettings } from '../serverConfig'

/**
 * What GS Director asks for.
 *
 * One list and one claim. The operator picks a game from the list and the app
 * claims it, which is the whole of choosing a destination: no URL is typed and
 * none is shown. The key comes back to the app and goes in its keychain.
 *
 * The list is of games this account **films**: a videographer of the team, its
 * season or its league, which every administrator of them is — not of games
 * it may watch. A parent's list of forty watchable games would bury the one
 * they want.
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
 * What a game is doing, out of everything pointed at it.
 *
 * A game with four cameras has four rows and one state: if any of them is
 * publishing the game is on, and a camera that has finished says nothing about
 * the three that have not.
 */
function liveStateOf(
  streams: Array<{ state: string }>
): 'none' | 'idle' | 'publishing' | 'ended' {
  if (streams.length === 0) return 'none'
  if (streams.some(one => one.state === 'publishing')) return 'publishing'
  if (streams.some(one => one.state === 'idle')) return 'idle'
  return 'ended'
}

/** How far back a game that has already started still counts as next. */
const LOOK_BACK_HOURS = 2
/** How many to offer. More than a screenful is a worse list, not a longer one. */
const LIMIT = 10

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

export function directorRoutes(
  db: Kysely<Database>,
  options: DirectorRouteOptions
): Router {
  const router = Router()

  /**
   * The next ten games, most recent first — or the last ten finished ones.
   *
   * "Most recent" reaches two hours backwards: a game called for one o'clock
   * that somebody starts filming at ten past three is still the game they mean,
   * and having to scroll past it to find it would be absurd.
   *
   * `?when=finished` turns the list round: the games that have already been
   * played, latest first. That is the list an **upload** needs, and it is the
   * opposite of the one claiming needs — claiming is about the game starting
   * now, uploading is about the game that has just finished. Same rule about
   * whose games they are, same shape of answer, one query parameter.
   */
  router.get(
    '/director/events',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const scopes = await roleScopes(db, actor.userId, actor.isAdmin)
      const finished = req.query.when === 'finished'
      const edge = new Date(Date.now() - LOOK_BACK_HOURS * 3_600_000)

      let query = db
        .selectFrom('games')
        .innerJoin('teams as home', 'home.id', 'games.home_team_id')
        .innerJoin('teams as away', 'away.id', 'games.away_team_id')
        .select([
          'games.id as id',
          'games.start_at as startAt',
          'games.venue as venue',
          'games.home_team_id as homeTeamId',
          'games.away_team_id as awayTeamId',
          'home.name as homeTeamName',
          'away.name as awayTeamName',
          'home.logo_path as homeLogoPath',
          'away.logo_path as awayLogoPath'
        ])
        .where('games.start_at', finished ? '<' : '>=', edge)
        .where('games.status', '<>', 'cancelled')
        .orderBy('games.start_at', finished ? 'desc' : 'asc')
        .limit(LIMIT)

      // An administrator of the site sees every game; everybody else sees the
      // games of the teams they film, and somebody who films none sees none.
      if (!scopes.isAdmin) {
        const teamIds = [...scopes.videographer.teamIds]
        if (teamIds.length === 0) {
          res.json([])
          return
        }
        query = query.where(eb =>
          eb.or([
            eb('games.home_team_id', 'in', teamIds),
            eb('games.away_team_id', 'in', teamIds)
          ])
        )
      }

      const rows = await query.execute()

      // The cameras are asked for separately rather than joined, because a
      // game may have several and a join would list the game once for each of
      // them — which would also spend the ten on one busy game.
      const streams =
        rows.length === 0
          ? []
          : await db
              .selectFrom('live_streams')
              .select([
                'game_id as gameId',
                'user_id as userId',
                'state'
              ])
              .where(
                'game_id',
                'in',
                rows.map(row => row.id)
              )
              .where('state', '<>', 'revoked')
              .execute()

      res.json(
        rows.map(row => {
          const onThisGame = streams.filter(one => one.gameId === row.id)
          return asDirectorEvent({
            gameId: row.id,
            startAt: new Date(row.startAt).toISOString(),
            venue: row.venue,
            homeTeamName: row.homeTeamName,
            awayTeamName: row.awayTeamName,
            homeLogoUrl: logoUrl(options.space, row.homeLogoPath),
            awayLogoUrl: logoUrl(options.space, row.awayLogoPath),
            // What is happening on the game, whosever camera it is.
            liveState: liveStateOf(onThisGame)
          })
        })
      )
    })
  )

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

      // Taking a game twice is the ordinary case, not the exception: the same
      // Director claims it again on every redial. It gets **its own account's**
      // camera — its first one — so a second Director signed in as somebody
      // else is a second camera on the game rather than a second publisher
      // turned away from the same key.
      const mine = await myLiveStreams(db, game.id, actor.userId)
      const existing = mine.find(row => row.slot === 1) ?? mine[0]
      let key: string
      if (existing != null) {
        key = readKey(options.sessionSecret, existing)
      } else {
        try {
          key = (
            await createLiveStream(db, {
              gameId: game.id,
              teamId,
              startAt: new Date(game.startAt),
              userId: actor.userId,
              slot: 1,
              label: options.deviceLabel,
              live: options.live,
              sessionSecret: options.sessionSecret,
              videoTitle: `${game.awayTeamName} at ${game.homeTeamName}`
            })
          ).key
        } catch (error) {
          // Two Directors signed in as the same account, claiming at the same
          // moment: one of them wins slot one and the other lands here.
          const raced = (await myLiveStreams(db, game.id, actor.userId)).find(
            row => row.slot === 1
          )
          if (raced == null) throw error
          key = readKey(options.sessionSecret, raced)
        }
      }

      const row =
        existing ??
        (await myLiveStreams(db, game.id, actor.userId)).find(
          item => item.slot === 1
        )
      setAudit(res.locals, { entityType: 'liveStream', entityId: row?.id })
      res.json({
        gameId: game.id,
        url: streamUrlFor(options.live, options.host, key),
        opensAt: row?.opensAt.toISOString() ?? null,
        closesAt: row?.closesAt?.toISOString() ?? null
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
   * Its own camera only. A Director holds slot one on the game it claimed.
   */
  router.get(
    '/director/events/:gameId/stream',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const gameId = pathParam(req.params.gameId)
      const mine = (await myLiveStreams(db, gameId, actor.userId)).find(
        item => item.slot === 1
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

function logoUrl(
  space: SpaceSettings | undefined,
  path: string | null
): string | null {
  if (space == null) return null
  return imageUrl(space, path)
}

function pathParam(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || value === '') throw notFound()
  return value
}

export type { DirectorEvent }
