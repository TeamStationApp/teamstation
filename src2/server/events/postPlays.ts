import type { Kysely, Selectable } from 'kysely'

import { badRequest, conflict, notFound } from '../../common/errors'
import type { GumboPlay, PostEventsBody } from '../../common/gumboPlay'
import {
  halfOutcomes,
  lineScore,
  withHalfOuts
} from '../../common/scoring/linescore'
import type { Database, EventsTable } from '../db/database'
import {
  type PlaySource,
  type PlayWrite,
  replaceGameEvents,
  teamIdsOnCredits,
  upsertGameEvents
} from './eventWrite'

type Trx = Kysely<Database>

/** The game row a post is checked against, locked until it commits. */
export interface PostedGame {
  home_team_id: string
  away_team_id: string
}

export interface PostedPlays {
  plays: Array<{ id: string; gameId: string; gumbo: unknown }>
  currentPlay: unknown
}

/**
 * Writes a checked post to a game: the plays, the half's outs on each half's
 * last play, the credits' team ids, the line score, the at-bat in progress
 * and the status, as `POST /games/:gameId/events` describes. `authorize`
 * sees the locked game row first and throws to refuse the post; the route
 * asks there whether its sender may score the game. The refold script, which
 * rewrites GameStation's own plays, passes none.
 */
export async function postGamePlays(
  db: Kysely<Database>,
  gameId: string,
  body: PostEventsBody,
  authorize?: (trx: Trx, game: PostedGame) => Promise<void>
): Promise<PostedPlays> {
  // GameStation and a person typing name themselves. Every other sender, and
  // a post that names none, is an outside scorer: the least trusted one.
  const sent = body.source?.system
  const system: PlaySource =
    sent === 'gamestation' || sent === 'manual' ? sent : 'external'
  const indexes = body.plays.map(play => play.about.atBatIndex)
  if (new Set(indexes).size !== indexes.length) {
    throw badRequest('Two plays share an about.atBatIndex')
  }
  const prepared = withHalfOuts(body.plays)

  return await db
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
      if (authorize != null) await authorize(trx, game)
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

export function playJson(row: StoredPlay): {
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
export function documentOf(row: StoredPlay): GumboPlay {
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
