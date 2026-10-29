import { asNumber, asObject, asOptional, asString } from 'cleaners'
import { Router } from 'express'
import type { Kysely } from 'kysely'

import {
  badRequest,
  conflict,
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
import type { SwapEffect } from '../../common/scoring/playsLost'
import { teamsOfRow } from '../../common/teamLists'
import { canScore, lineupTeams, roleScopes } from '../access'
import { requireNodeAdmin } from '../admin/nodeAdministration'
import { lockPlayerEdits } from '../admin/people'
import { lockKeys } from '../db/advisoryLocks'
import { atomic } from '../db/atomic'
import type { Database } from '../db/database'
import { answerOnce, idempotentCallOf } from '../db/syncIdempotency'
import { atBatOf } from '../events/atBatInProgress'
import { pregameFold } from '../events/currentPlay'
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
import { playForWire } from '../events/wireRecords'
import { swapOrReset } from '../games/resetSwap'
import { gameSwapEffect } from '../games/swapEffect'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'
import { resolveScoringGame } from '../scoring/openRow'
import { notifyGameChange } from '../socket/gameChanges'
import {
  noteScopeChange,
  readSyncClock,
  REVISION_HEADER
} from '../socket/syncRevision'
import { tellGameWritten } from './gameWritten'

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
 * before. A live post naming a `generation` other than the game's, the set
 * of plays a reset left, is refused the same way with `details:
 * { stale: true, generation }`: its sender opens the game again.
 *
 * `GET` answers the game's `generation`, and `GET` and each live post's answer carry `playsDigest`, a digest of the
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
      tellGameWritten(options.onGameWritten, gameId)
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
                },
            {
              expectedGeneration: body.generation,
              halves: async (trx, game) =>
                lineupTeams(
                  await roleScopes(trx, actor.userId, actor.isAdmin),
                  game
                )
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
          // What a swap does is the read's, not a post's answer.
          const { swap: _swap, ...current } = await folded(
            await db
              .transaction()
              .setIsolationLevel('repeatable read')
              .execute(
                async trx =>
                  await storedGameRead(trx, gameId, async game =>
                    lineupTeams(
                      await roleScopes(trx, actor.userId, actor.isAdmin),
                      game
                    )
                  )
              )
          )
          return { status: 200, body: { ...current, ...kept } }
        }
      })
      if (wrote) tellGameWritten(options.onGameWritten, gameId)
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
        // Players' halves for whoever may save their lineups.
        return await storedGameRead(trx, gameId, async game =>
          lineupTeams(await roleScopes(trx, actor.userId, actor.isAdmin), game)
        )
      })
      // The pregame fold replays once the game row is let go.
      res.json(await folded(result))
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

  /**
   * Swaps home and away from the scoring screen, for whoever may score the
   * game: a scorekeeper of either team. Before the first pitch only the
   * teams move. A begun game is reset first (`swapOrReset`): the body must
   * name the `playsDigest` and `generation` its scorer confirmed, or it is
   * refused with 409, as is a withdrawn game or one scored outside
   * TeamStation. The body names the sides the scorer read: a call sent
   * again after its answer was lost finds them already exchanged and
   * changes nothing, rather than swapping them back. The answer is the new
   * sides, the game's generation, and what the reset deleted.
   */
  router.post(
    '/games/:gameId/swap-sides',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const gameId = pathParam(req.params.gameId)
      const read = cleanBody(asSwapSidesBody, req.body)
      await requireVisibleGame(db, actor.userId, actor.isAdmin, gameId)
      const done = await atomic(db, async trx => {
        await lockKeys(trx, ['creation:parent-graph', `game:${gameId}`])
        await lockPlayerEdits(trx)
        const game = await trx
          .selectFrom('games')
          .select(['id', 'home_team_id', 'away_team_id', 'play_generation'])
          .where('id', '=', gameId)
          .forUpdate()
          .executeTakeFirst()
        if (game == null) throw notFound()
        const scorers = await roleScopes(trx, actor.userId, actor.isAdmin)
        if (
          !canScore(scorers, game.home_team_id) &&
          !canScore(scorers, game.away_team_id)
        )
          throw forbidden('Only someone who can score this game may swap it')
        const unchanged = { atBats: 0, innings: 0 }
        if (
          game.home_team_id === read.awayTeamId &&
          game.away_team_id === read.homeTeamId
        )
          return {
            ...read.swapped,
            generation: game.play_generation,
            reset: unchanged,
            swapped: false
          }
        if (
          game.home_team_id !== read.homeTeamId ||
          game.away_team_id !== read.awayTeamId
        )
          throw conflict("This game's teams changed. Open it again.")
        const done = await swapOrReset(trx, gameId, actor.userId, read)
        return {
          ...read.swapped,
          generation: game.play_generation + (done.reset ? 1 : 0),
          reset: done.lost,
          swapped: true
        }
      })
      if (done.swapped) tellGameWritten(options.onGameWritten, gameId)
      res.json({
        homeTeamId: done.homeTeamId,
        awayTeamId: done.awayTeamId,
        generation: done.generation,
        reset: done.reset
      })
    })
  )

  return router
}

/**
 * The sides a swap was asked from, and the sides it makes. A reset names
 * the plays and generation its scorer confirmed; an older app, which only
 * swaps before the first pitch, names neither.
 */
function asSwapSidesBody(raw: unknown): {
  homeTeamId: string
  awayTeamId: string
  generation?: number
  playsDigest?: string
  swapped: { homeTeamId: string; awayTeamId: string }
} {
  const { homeTeamId, awayTeamId, generation, playsDigest } = asObject({
    homeTeamId: asString,
    awayTeamId: asString,
    generation: asOptional(asNumber),
    playsDigest: asOptional(asString)
  })(raw)
  return {
    homeTeamId,
    awayTeamId,
    generation,
    playsDigest,
    swapped: { homeTeamId: awayTeamId, awayTeamId: homeTeamId }
  }
}

/** What a live post's key keeps of its answer: the rest is read again. */
interface LivePostDigests {
  priorPlaysDigest: string | null
  lineupsDigest: string | null
}

/** A game's plays as `GET /games/:gameId/events` answers them. */
interface StoredGameAnswer {
  plays: unknown[]
  currentPlay: unknown
  playsDigest: string
  lineupsDigest: string | null
  generation: number
  swap: SwapEffect
}

/**
 * The answer read through `db`: each stored play, the at-bat in progress,
 * both digests, and what a swap does. Before the first pitch its at-bat is
 * the pregame shell, and `fold` replays it (`pregameFold`), reading nothing,
 * once the caller has let the game row go.
 */
async function storedGameRead(
  db: Kysely<Database>,
  gameId: string,
  halves: (game: {
    home_team_id: string
    away_team_id: string
  }) => Promise<readonly string[]>
): Promise<{
  answer: StoredGameAnswer
  fold: () => Promise<unknown>
  teams: ReturnType<typeof teamsOfRow>
}> {
  const stored = await readPlays(db, gameId)
  const game = await db
    .selectFrom('games')
    .select([
      'home_team_id',
      'away_team_id',
      'currentPlay',
      'pregame',
      'lineups_digest',
      'play_generation',
      'status',
      'cancellation_reason'
    ])
    .where('id', '=', gameId)
    .executeTakeFirstOrThrow()
  const current = atBatOf(game, stored.length > 0)
  const resolved = await resolveScoringGame(
    db,
    {
      plays: stored.map(row => row.gumbo as GumboPlay),
      currentPlay: current as CurrentPlay | null
    },
    { halves: await halves(game), gameId }
  )
  const teams = teamsOfRow(game)
  const answer: StoredGameAnswer = {
    plays: stored.map((row, index) => ({
      ...playJson(row),
      gumbo: playForWire(resolved.plays[index], teams)
    })),
    currentPlay: playForWire(resolved.currentPlay, teams),
    playsDigest: playsDigest(stored, current),
    lineupsDigest: await storedLineupsDigest(db, {
      id: gameId,
      ...game
    }),
    generation: game.play_generation,
    // What swapping home and away would do, as the swap route decides it.
    swap: gameSwapEffect(
      game,
      stored.map(row => row.gumbo)
    )
  }
  return {
    answer,
    fold: await pregameFold(db, gameId, game, resolved),
    teams
  }
}

/** A read's answer, its at-bat folded. */
async function folded(
  read: Awaited<ReturnType<typeof storedGameRead>>
): Promise<StoredGameAnswer> {
  return {
    ...read.answer,
    currentPlay: playForWire(await read.fold(), read.teams)
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
