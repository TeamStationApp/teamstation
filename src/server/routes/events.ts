import { Router } from 'express'
import type { Kysely } from 'kysely'

import {
  badRequest,
  forbidden,
  notFound,
  unauthorized
} from '../../common/errors'
import {
  asPostEventsBody,
  type CurrentPlay,
  type GumboPlay
} from '../../common/gumboPlay'
import { halfOutcomes } from '../../common/scoring/linescore'
import { canScore, roleScopes } from '../access'
import { requireNodeAdmin } from '../admin/nodeAdministration'
import { atomic } from '../db/atomic'
import type { Database } from '../db/database'
import { answerOnce, idempotentCallOf } from '../db/syncIdempotency'
import {
  reconcileEventTags,
  tagChoices,
  writeEventTag
} from '../events/eventTags'
import { addPlayEvents, asPlayEventsBody } from '../events/playEventTimes'
import {
  documentOf,
  playJson,
  playsDigest,
  postGamePlays,
  readPlays
} from '../events/postPlays'
import { requireVisibleGame } from '../events/requireVisibleGame'
import { storedLineupsDigest } from '../events/teamLineups'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'
import { resolveScoringGame } from '../scoring/openRow'
import { notifyGameChange } from '../socket/gameChanges'
import {
  noteScopeChange,
  readSyncClock,
  REVISION_HEADER
} from '../socket/syncRevision'

export interface EventRouteOptions {
  onGameWritten?: (gameId: string) => void
}

/**
 * Post, read, and summarise a game's plays.
 *
 * A post is one of two modes. A `replace` post, the default, is a finished
 * game arriving whole: a stored play whose index the body does not name is
 * deleted, even after `scoringOwner` is `teamstation`. That includes a
 * legacy line-score-only `final_score` play, stored for a game whose sender
 * had nothing but a line score and turned into Gumbo by migration 031. It
 * sits at index 9999 after a game's other plays, or at index 0 in a game that
 * has nothing else.
 *
 * `source.system` is `teamstation`, `manual`, or an outside system spelled as
 * an external id's system is, stored as `external`. A post that names none
 * counts as an outside one, so that a sender has to say it is TeamStation's
 * own before it may write a game
 * TeamStation scores or have its play text kept.
 *
 * A replace post whose plays carry both teams' scores sets the game `final`,
 * with the last score each side's plays carry, and a final game refuses every
 * later post with 409. Other unfinished games are `inProgress` only with a
 * surviving pitch or ball in play; otherwise they are scheduled. A cancelled
 * game stays cancelled.
 *
 * A `live` post is a game being scored in TeamStation, a play at a time. Its
 * plays are written in place at their index, keeping each row's id; exactly
 * the indexes in `remove` are deleted; and `currentPlay`, when the body has
 * the key, is the at-bat in progress, kept on the game rather than as a row.
 * The game is `final` when a stored play is its `final_score`, `inProgress`
 * while it has a surviving pitch or ball in play, otherwise scheduled. A
 * cancelled game stays cancelled. The scorer is the record, so a live post never marks a score
 * mismatch. The owning TeamStation scorer may post to a final game to
 * correct it; nobody else may.
 *
 * A live post may name `lineupsBase`, the lineups digest its sender last read
 * (`lineupsDigest` on `GET` and on each post's answer). When the game's
 * lineups have changed since, someone else saved over them, and the post is
 * refused with 409 and `details: { stale: true }`: the sender reads the game
 * again and posts its own changes on top. A post naming none is written as
 * before.
 *
 * `GET` and each live post's answer carry `playsDigest`, a digest of the
 * stored plays and the at-bat in progress, as the game socket's `plays`
 * notices do; a live post's answer also carries `priorPlaysDigest`, the same
 * of the game as the post found it. A sender whose last digest that is holds
 * everything stored, and can pass over the notice of its own post.
 *
 * The write itself is `postGamePlays` in `events/postPlays.ts`, which the
 * refold script calls too.
 *
 * `options.onGameWritten` is called with the game's id once a post has
 * committed, so the game's scoreboard can be brought up to date. It is fire
 * and forget: it never delays the answer, and whatever it throws is logged
 * and never fails the post.
 *
 * `PATCH /games/:gameId/events` is for a node administrator: it puts every
 * event, with its time, on plays an outside scorer's import stored without
 * them, a final game's included, and writes nothing else; statistics and tags
 * follow the events the next time they are worked out (`addPlayEvents`).
 */
export function eventRoutes(
  db: Kysely<Database>,
  options: EventRouteOptions = {}
): Router {
  const router = Router()

  router.get(
    '/tags',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const includeUnused = req.query.includeUnused
      if (
        includeUnused !== undefined &&
        includeUnused !== 'true' &&
        includeUnused !== 'false'
      )
        throw badRequest('includeUnused must be true or false')
      res.json(await tagChoices(db, actor.userId, includeUnused === 'true'))
    })
  )

  for (const method of ['put', 'delete'] as const) {
    router[method](
      '/games/:gameId/tags/:targetId',
      requireActor,
      withAsync(async (req, res) => {
        const actor = req.actor
        if (actor == null) throw unauthorized()
        const gameId = pathParam(req.params.gameId)
        const targetId = pathParam(req.params.targetId)
        await requireVisibleGame(db, actor.userId, actor.isAdmin, gameId)
        const result = await atomic(db, async trx => {
          const game = await trx
            .selectFrom('games')
            .select(['home_team_id', 'away_team_id'])
            .where('id', '=', gameId)
            .forUpdate()
            .executeTakeFirst()
          if (game == null) throw notFound()
          const scopes = await roleScopes(trx, actor.userId, actor.isAdmin)
          if (
            !canScore(scopes, game.home_team_id) &&
            !canScore(scopes, game.away_team_id)
          )
            throw forbidden('Only a scorekeeper may change event tags')
          const tag = method === 'delete' ? null : req.body?.tag
          if (method !== 'delete' && typeof tag !== 'string')
            throw badRequest('tag must be a nonempty string')
          const result = await writeEventTag(
            trx,
            gameId,
            targetId,
            actor.userId,
            tag
          )
          await notifyGameChange(trx, { game: gameId, kind: 'plays' })
          noteScopeChange(trx, { gameId })
          return result
        })
        res.json(result)
      })
    )
  }

  router.patch(
    '/games/:gameId/events',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const gameId = pathParam(req.params.gameId)
      const body = cleanBody(asPlayEventsBody, req.body)
      await requireNodeAdmin(
        db,
        actor,
        'Only a node administrator can add events to stored plays'
      )
      const added = await addPlayEvents(db, gameId, body)
      // The board's timeline steps at the new events from its next read, the
      // game's updated_at having moved; a viewer watching it is told now, as
      // after a post. The live board itself does not change: nothing it reads
      // from a play's result does, and an imported game writes none.
      try {
        options.onGameWritten?.(gameId)
      } catch (error) {
        console.error(`onGameWritten ${gameId}`, error)
      }
      res.json(added)
    })
  )

  router.post(
    '/games/:gameId/events',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const gameId = pathParam(req.params.gameId)
      const body = cleanBody(asPostEventsBody, req.body)
      // Only a live post, a play at a time, is sent again from a queue.
      const call =
        body.mode === 'live' ? idempotentCallOf(req, actor.userId) : undefined
      // Only whether the game can be seen is settled here. Everything the
      // write depends on is read from the locked row.
      await requireVisibleGame(db, actor.userId, actor.isAdmin, gameId)
      let wrote = false
      const answer = await answerOnce(db, call, {
        write: async claim => {
          const response = await postGamePlays(
            db,
            gameId,
            body,
            async (trx, game) => {
              // A scorekeeper of either team, which an administrator of it is.
              const scorers = await roleScopes(trx, actor.userId, actor.isAdmin)
              if (
                !canScore(scorers, game.home_team_id) &&
                !canScore(scorers, game.away_team_id)
              ) {
                throw forbidden(
                  'Only someone who can score this game may change its plays'
                )
              }
            },
            // Every play of the game is too much to keep per post: the key
            // keeps the two digests that are this post's own, as it commits.
            claim == null
              ? undefined
              : async (trx, posted) => {
                  const kept: LivePostDigests = {
                    priorPlaysDigest: posted.priorPlaysDigest,
                    lineupsDigest: posted.lineupsDigest
                  }
                  await claim(trx, {
                    status: 200,
                    resultId: JSON.stringify(kept)
                  })
                }
          )
          wrote = true
          return { status: 200, body: response }
        },
        keepsAnswer: false,
        // The game's plays as they stand, which hold this post's, with the
        // digests it was answered: a later lineups change by somebody else
        // still shows as stale to the queue's next post.
        rebuild: async held => {
          const kept = JSON.parse(held.resultId!) as LivePostDigests
          const current = await db
            .transaction()
            .setIsolationLevel('repeatable read')
            .execute(async trx => await storedGameAnswer(trx, gameId))
          return { status: 200, body: { ...current, ...kept } }
        }
      })
      if (wrote)
        try {
          options.onGameWritten?.(gameId)
        } catch (error) {
          console.error(`onGameWritten ${gameId}`, error)
        }
      res.status(answer.status).json(answer.body)
    })
  )

  router.get(
    '/games/:gameId/events',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const gameId = pathParam(req.params.gameId)
      await requireVisibleGame(db, actor.userId, actor.isAdmin, gameId)
      const result = await db.transaction().execute(async trx => {
        const locked = await trx
          .selectFrom('games')
          .select('id')
          .where('id', '=', gameId)
          .forUpdate()
          .executeTakeFirst()
        if (locked == null) throw notFound()
        // Read committed, after the lock: a live post that commits while
        // this holds the game waits, and takes a revision newer than this.
        res.setHeader(REVISION_HEADER, await readSyncClock(trx))
        await reconcileEventTags(trx, gameId)
        return await storedGameAnswer(trx, gameId)
      })
      res.json(result)
    })
  )

  router.get(
    '/games/:gameId/halves',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const gameId = pathParam(req.params.gameId)
      await requireVisibleGame(db, actor.userId, actor.isAdmin, gameId)
      const stored = await readPlays(db, gameId)
      res.json({ halves: halfOutcomes(stored.map(documentOf)) })
    })
  )

  return router
}

/** What a live post's key keeps of its answer: the rest is read again. */
interface LivePostDigests {
  priorPlaysDigest: string | null
  lineupsDigest: string | null
}

/**
 * A game's plays as `GET /games/:gameId/events` answers them, read through
 * `db`: each stored play, the at-bat in progress, and both digests.
 */
async function storedGameAnswer(
  db: Kysely<Database>,
  gameId: string
): Promise<{
  plays: unknown[]
  currentPlay: unknown
  playsDigest: string
  lineupsDigest: string | null
}> {
  const stored = await readPlays(db, gameId)
  const game = await db
    .selectFrom('games')
    .select(['home_team_id', 'away_team_id', 'currentPlay', 'lineups_digest'])
    .where('id', '=', gameId)
    .executeTakeFirstOrThrow()
  const resolved = await resolveScoringGame(db, {
    plays: stored.map(row => row.gumbo as GumboPlay),
    currentPlay: game.currentPlay as CurrentPlay | null
  })
  return {
    plays: stored.map((row, index) => ({
      ...playJson(row),
      gumbo: resolved.plays[index]
    })),
    currentPlay: resolved.currentPlay,
    playsDigest: playsDigest(stored, game.currentPlay),
    lineupsDigest: await storedLineupsDigest(db, {
      id: gameId,
      ...game
    })
  }
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

function pathParam(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || value === '') throw notFound()
  return value
}

export {
  readPlays,
  statusAfterLivePost,
  statusAfterPost,
  unknownUser
} from '../events/postPlays'
