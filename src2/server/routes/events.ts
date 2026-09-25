import { Router } from 'express'
import type { Kysely, Selectable } from 'kysely'

import {
  badRequest,
  conflict,
  forbidden,
  notFound,
  unauthorized
} from '../../common/errors'
import { asPostEventsBody, type GumboPlay } from '../../common/gumboPlay'
import {
  halfOutcomes,
  lineScore,
  withHalfOuts
} from '../../common/scoring/linescore'
import {
  adminScopes,
  canManageTeam,
  canSeeGame,
  visibleScopes
} from '../access'
import type { Database, EventsTable } from '../db/database'
import {
  type PlaySource,
  type PlayWrite,
  replaceGameEvents,
  teamIdsOnCredits,
  upsertGameEvents
} from '../events/eventWrite'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'

type Trx = Kysely<Database>

/**
 * Post, read, and summarise a game's plays.
 *
 * A post is one of two modes. A `replace` post, the default, is a finished
 * game arriving whole: a stored play whose index the body does not name is
 * deleted, even after `scoringOwner` is `gamestation`. That includes a
 * legacy line-score-only `final_score` play, stored for a game whose sender
 * had nothing but a line score and turned into Gumbo by migration 031. It
 * sits at index 9999 after a game's other plays, or at index 0 in a game that
 * has nothing else.
 *
 * `source.system` is `gamestation`, `manual`, or an outside system spelled as
 * an external id's system is, stored as `external`. A post that names none
 * counts as an outside one, so that a sender has to say it is GameStation's
 * own before it may write a game GameStation scores or have its play text
 * kept.
 *
 * A replace post whose plays carry both teams' scores sets the game `final`,
 * with the last score each side's plays carry, and a final game refuses every
 * later post with 409. Any other replace post keeps the stored status, except
 * that a scheduled game with plays is `inProgress`. A cancelled game stays
 * cancelled.
 *
 * A `live` post is a game being scored in GameStation, a play at a time. Its
 * plays are written in place at their index, keeping each row's id; exactly
 * the indexes in `remove` are deleted; and `currentPlay`, when the body has
 * the key, is the at-bat in progress, kept on the game rather than as a row.
 * The game is `final` when a stored play is its `final_score`, `inProgress`
 * while it has plays or an at-bat in progress, and a cancelled game stays
 * cancelled. The scorer is the record, so a live post never marks a score
 * mismatch. The owning GameStation scorer may post to a final game to
 * correct it; nobody else may.
 */
export function eventRoutes(db: Kysely<Database>): Router {
  const router = Router()

  router.post(
    '/games/:gameId/events',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const gameId = pathParam(req.params.gameId)
      const body = cleanBody(asPostEventsBody, req.body)
      // Only whether the game can be seen is settled here. Everything the
      // write depends on is read from the locked row below.
      await requireVisibleGame(db, actor.userId, actor.isAdmin, gameId)
      // GameStation and a person typing name themselves. Every other sender,
      // and a post that names none, is an outside scorer: the least trusted
      // one.
      const sent = body.source?.system
      const system: PlaySource =
        sent === 'gamestation' || sent === 'manual' ? sent : 'external'
      const indexes = body.plays.map(play => play.about.atBatIndex)
      if (new Set(indexes).size !== indexes.length) {
        throw badRequest('Two plays share an about.atBatIndex')
      }
      const prepared = withHalfOuts(body.plays)

      const response = await db
        .transaction()
        .execute(async trx => {
          // The game row stays locked until this post commits, so a second
          // post to the same game waits and then sees the plays, the final
          // status and the scoring owner this one leaves behind.
          const game = await trx
            .selectFrom('games')
            .select([
              'home_team_id',
              'away_team_id',
              'scoringOwner',
              'status',
              'away_score',
              'home_score',
              'ingest_status',
              'ingest_message',
              'currentPlay'
            ])
            .where('id', '=', gameId)
            .forUpdate()
            .executeTakeFirst()
          if (game == null) throw notFound()
          const live = body.mode === 'live'
          if (
            game.status === 'final' &&
            !(
              live &&
              system === 'gamestation' &&
              game.scoringOwner === 'gamestation'
            )
          ) {
            throw conflict('This game is final')
          }
          const editors = await adminScopes(trx, actor.userId, actor.isAdmin)
          if (
            !canManageTeam(editors, game.home_team_id) &&
            !canManageTeam(editors, game.away_team_id)
          ) {
            throw forbidden(
              'Only someone who can score this game may change its plays'
            )
          }
          if (system === 'external' && game.scoringOwner === 'gamestation') {
            throw conflict('This game is scored in GameStation')
          }

          const teams = {
            homeTeamId: game.home_team_id,
            awayTeamId: game.away_team_id
          }
          const plays: PlayWrite[] = prepared.map(play => ({
            gumbo: {
              ...play,
              credits:
                play.credits == null
                  ? play.credits
                  : teamIdsOnCredits(play.credits, teams)
            },
            startTime: play.about.startTime ?? null,
            endTime: play.about.endTime ?? null,
            source: system
          }))

          if (system === 'gamestation') {
            await trx
              .updateTable('games')
              .set({ scoringOwner: 'gamestation' })
              .where('id', '=', gameId)
              .execute()
          }
          const write = {
            gameId,
            homeTeamId: game.home_team_id,
            awayTeamId: game.away_team_id,
            plays
          }
          if (live) {
            await upsertGameEvents(trx, { ...write, remove: body.remove ?? [] })
          } else {
            await replaceGameEvents(trx, write)
          }
          const currentPlay =
            live && body.currentPlay !== undefined
              ? body.currentPlay
              : game.currentPlay
          const stored = await readPlays(trx, gameId)
          const documents = stored.map(documentOf)
          const posted = scoresOf(stored)
          const decision = live
            ? { ingestStatus: 'ok' as const, ingestMessage: null }
            : ingestDecision(
                game.away_score,
                game.home_score,
                posted.away,
                posted.home,
                game.ingest_status,
                game.ingest_message
              )
          const halves = halfOutcomes(documents)
          await trx
            .updateTable('games')
            .set({
              away_score: posted.away,
              home_score: posted.home,
              linescore: lineScore(documents, halves, posted.away, posted.home),
              status: live
                ? statusAfterLivePost(game.status, stored, currentPlay != null)
                : statusAfterPost(game.status, posted, stored.length),
              ingest_status: decision.ingestStatus,
              ingest_message: decision.ingestMessage,
              ...(live && body.currentPlay !== undefined
                ? { currentPlay: body.currentPlay }
                : {}),
              updated_at: new Date()
            })
            .where('id', '=', gameId)
            .execute()
          return {
            plays: stored.map(playJson),
            currentPlay: currentPlay ?? null
          }
        })
        .catch((error: unknown) => {
          throw unknownUser(error, prepared) ?? error
        })
      res.json(response)
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
      const stored = await readPlays(db, gameId)
      const game = await db
        .selectFrom('games')
        .select('currentPlay')
        .where('id', '=', gameId)
        .executeTakeFirst()
      res.json({
        plays: stored.map(playJson),
        currentPlay: game?.currentPlay ?? null
      })
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

/**
 * A play naming a user who does not exist fails on a foreign key inside the
 * trigger that copies the play out: `eventCredits` for a credit, and
 * `event_players` for the batter, the pitcher or a runner. That is the
 * caller's mistake, not the server's, so it answers 400 naming the play and
 * the user rather than a 500.
 */
export function unknownUser(
  error: unknown,
  plays: GumboPlay[]
): Error | undefined {
  if (error == null || typeof error !== 'object') return
  const { code, table, detail } = error as {
    code?: unknown
    table?: unknown
    detail?: unknown
  }
  if (code !== '23503') return
  // Postgres says which key was missing: `Key (creditUserId)=(7) is not
  // present in table "users".`
  const key = (column: string): number | undefined => {
    const match = new RegExp(`^Key \\(${column}\\)=\\((\\d+)\\)`).exec(
      typeof detail === 'string' ? detail : ''
    )
    return match == null ? undefined : Number(match[1])
  }
  if (table === 'eventCredits') {
    const userId = key('creditUserId')
    const credited = plays.find(
      play =>
        play.credits?.some(credit => credit.creditUserId === userId) === true
    )
    if (userId == null || credited == null) {
      return badRequest('A credit names a user who does not exist')
    }
    return badRequest(
      `play ${credited.about.atBatIndex} credits user ${userId}, who does not exist`
    )
  }
  if (table === 'event_players') {
    const userId = key('user_id')
    if (userId == null) return
    const named = plays.find(play => playerIds(play).includes(userId))
    if (named == null) {
      return badRequest(`A play names user ${userId}, who does not exist`)
    }
    return badRequest(
      `play ${named.about.atBatIndex} names user ${userId}, who does not exist`
    )
  }
}

/** The users the trigger copies into `event_players` from one play. */
function playerIds(play: GumboPlay): Array<number | null | undefined> {
  return [
    play.matchup?.batter?.id,
    play.matchup?.pitcher?.id,
    ...(play.runners ?? []).map(runner => runner.details?.runner?.id)
  ]
}

/** Throws 404 unless the game exists and this person can see it. */
async function requireVisibleGame(
  db: Kysely<Database>,
  userId: number,
  isAdmin: boolean,
  gameId: string
): Promise<void> {
  const game = await db
    .selectFrom('games')
    .select(['home_team_id', 'away_team_id', 'season_id'])
    .where('id', '=', gameId)
    .executeTakeFirst()
  if (game == null) throw notFound()
  const scopes = await visibleScopes(db, userId, isAdmin)
  if (
    !canSeeGame(scopes, {
      homeTeamId: game.home_team_id,
      awayTeamId: game.away_team_id,
      seasonId: game.season_id
    })
  ) {
    throw notFound()
  }
}

const PLAY_COLUMNS = [
  'id',
  'gameId',
  'atBatIndex',
  'inning',
  'halfInning',
  'eventType',
  'awayScore',
  'homeScore',
  'gumbo'
] as const

type StoredPlay = Pick<Selectable<EventsTable>, (typeof PLAY_COLUMNS)[number]>

/**
 * A game's stored plays in index order, with the columns the line score and
 * the halves are worked out from.
 */
export async function readPlays(
  db: Trx,
  gameId: string
): Promise<StoredPlay[]> {
  return await db
    .selectFrom('events')
    .select(PLAY_COLUMNS)
    .where('gameId', '=', gameId)
    .orderBy('atBatIndex')
    .execute()
}

function playJson(row: StoredPlay): {
  id: string
  gameId: string
  gumbo: unknown
} {
  return { id: row.id, gameId: row.gameId, gumbo: row.gumbo }
}

/**
 * The game's score is the last one any play carries. A play that carries none,
 * such as a stolen base written without the score, does not wipe it out.
 */
function scoresOf(rows: StoredPlay[]): {
  away: number | null
  home: number | null
} {
  let away: number | null = null
  let home: number | null = null
  for (const row of rows) {
    away = row.awayScore ?? away
    home = row.homeScore ?? home
  }
  return { away, home }
}

/**
 * A cancelled game stays cancelled, whatever is posted to it: plays with
 * scores must not bring it back as a finished game. Otherwise a post that
 * leaves both teams' scores makes the game final, a scheduled game with plays
 * is under way, and any other status stays.
 */
export function statusAfterPost(
  status: 'scheduled' | 'inProgress' | 'final' | 'cancelled',
  posted: { away: number | null; home: number | null },
  playCount: number
): 'scheduled' | 'inProgress' | 'final' | 'cancelled' {
  if (status === 'cancelled') return status
  if (posted.away != null && posted.home != null) return 'final'
  if (status === 'scheduled' && playCount > 0) return 'inProgress'
  return status
}

/**
 * After a live post the stored plays decide: a cancelled game stays
 * cancelled, a stored `final_score` makes it final, and plays or an at-bat in
 * progress make it under way. A game with neither keeps its status.
 */
export function statusAfterLivePost(
  status: 'scheduled' | 'inProgress' | 'final' | 'cancelled',
  stored: Array<{ eventType: string | null }>,
  atBat: boolean
): 'scheduled' | 'inProgress' | 'final' | 'cancelled' {
  if (status === 'cancelled') return status
  if (stored.some(play => play.eventType === 'final_score')) return 'final'
  if (stored.length > 0 || atBat) return 'inProgress'
  return status
}

/** A stored row's document, which the line score is worked out from. */
function documentOf(row: StoredPlay): GumboPlay {
  return row.gumbo as GumboPlay
}

/**
 * Keep a matching stored score's status, including `scoreMismatch`. A null
 * stored score has nothing to compare. Two stored numbers that the post
 * disagrees with become `scoreMismatch`.
 */
function ingestDecision(
  storedAway: number | null,
  storedHome: number | null,
  postedAway: number | null,
  postedHome: number | null,
  ingestStatus: 'none' | 'ok' | 'scoreMismatch' | 'error',
  ingestMessage: string | null
): {
  ingestStatus: 'none' | 'ok' | 'scoreMismatch' | 'error'
  ingestMessage: string | null
} {
  if (postedAway === storedAway && postedHome === storedHome) {
    return { ingestStatus, ingestMessage }
  }
  if (storedAway == null || storedHome == null) {
    return { ingestStatus: 'ok', ingestMessage: null }
  }
  return {
    ingestStatus: 'scoreMismatch',
    ingestMessage: `Posted ${postedAway ?? '?'}-${postedHome ?? '?'}, stored ${storedAway}-${storedHome}`
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
