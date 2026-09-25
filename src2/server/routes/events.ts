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
  teamIdsOnCredits
} from '../events/eventWrite'
import { hitsAndErrors } from '../events/hitsAndErrors'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'

type Trx = Kysely<Database>

export interface HalfOutcome {
  inning: number
  half: 'top' | 'bottom'
  awayScore: number | null
  homeScore: number | null
  outs: number
  runs: number
}

/**
 * Post, read, and summarise a game's plays.
 *
 * One POST is the whole set: a stored play whose index the body does not name
 * is deleted, even after `scoringOwner` is `gamestation`. That includes a
 * legacy line-score-only `final_score` play, stored for a game whose sender
 * had nothing but a line score and turned into Gumbo by migration 031. It
 * sits at index 9999 after a game's other plays, or at index 0 in a game that
 * has nothing else.
 *
 * `source.system` is `gamestation`, `manual`, or an outside system spelled as
 * an external id's system is, stored as `external`. A post that names none
 * counts as an outside one, so that a sender has to say it is GameStation's
 * own before it may write a game GameStation scores.
 *
 * A post whose plays carry both teams' scores sets the game `final`, with the
 * last score each side's plays carry, and a final game refuses every later
 * post with 409. So a game takes its plays once it is over, not inning by
 * inning while it is played. Any other post keeps the stored status, except
 * that a scheduled game with plays is `inProgress`. A cancelled game stays
 * cancelled.
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
              'ingest_message'
            ])
            .where('id', '=', gameId)
            .forUpdate()
            .executeTakeFirst()
          if (game == null) throw notFound()
          if (game.status === 'final') {
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
          await replaceGameEvents(trx, {
            gameId,
            homeTeamId: game.home_team_id,
            awayTeamId: game.away_team_id,
            plays
          })
          const stored = await readPlays(trx, gameId)
          const posted = scoresOf(stored)
          const decision = ingestDecision(
            game.away_score,
            game.home_score,
            posted.away,
            posted.home,
            game.ingest_status,
            game.ingest_message
          )
          const halves = halfOutcomes(stored)
          await trx
            .updateTable('games')
            .set({
              away_score: posted.away,
              home_score: posted.home,
              linescore: lineScore(stored, halves, posted.away, posted.home),
              status: statusAfterPost(game.status, posted, stored.length),
              ingest_status: decision.ingestStatus,
              ingest_message: decision.ingestMessage,
              updated_at: new Date()
            })
            .where('id', '=', gameId)
            .execute()
          return { plays: stored.map(playJson) }
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
      res.json({ plays: stored.map(playJson) })
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
      res.json({ halves: halfOutcomes(stored) })
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

/**
 * `about.halfOuts` on the last play of a half is what `GET /halves` reads.
 * A value already on that play stays. An Inning Ended marker in the half
 * supplies the outs. Otherwise the last play's own `count.outs` is copied.
 */
export function withHalfOuts(plays: GumboPlay[]): GumboPlay[] {
  const copies = plays.map(play => structuredClone(play))
  const groups = new Map<string, GumboPlay[]>()
  for (const play of copies) {
    const half = play.about.halfInning
    if (play.about.inning == null || half == null) continue
    const key = `${play.about.inning}:${half}`
    const list = groups.get(key) ?? []
    list.push(play)
    groups.set(key, list)
  }
  for (const list of groups.values()) {
    list.sort((a, b) => a.about.atBatIndex - b.about.atBatIndex)
    const last = list[list.length - 1]
    if (last == null || last.about.halfOuts != null) continue
    const marked = list.reduce<number | null>(
      (found, play) => markerOuts(play) ?? found,
      null
    )
    const outs = marked ?? last.count?.outs
    if (outs != null) last.about.halfOuts = outs
  }
  return copies
}

function markerOuts(play: GumboPlay): number | null {
  if (!Array.isArray(play.playEvents)) return null
  for (const event of play.playEvents) {
    if (event == null || typeof event !== 'object') continue
    const record = event as Record<string, unknown>
    // The marker by its type, never by a sentence written about it.
    const type = typeof record.type === 'string' ? record.type : null
    if (type == null || !/inning[ _]ended/i.test(type)) continue
    if (typeof record.outs === 'number') return record.outs
    const count = record.count
    if (
      count != null &&
      typeof count === 'object' &&
      typeof (count as { outs?: unknown }).outs === 'number'
    ) {
      return (count as { outs: number }).outs
    }
  }
  return null
}

/**
 * One outcome per half that has a stored play. A null half is omitted. A half
 * whose last play carries no score for the side at bat scores no runs, rather
 * than the negative of everything before it.
 */
export function halfOutcomes(rows: StoredPlay[]): HalfOutcome[] {
  const byHalf = new Map<string, StoredPlay>()
  for (const row of rows) {
    if (row.inning == null) continue
    if (row.halfInning !== 'top' && row.halfInning !== 'bottom') continue
    const key = `${row.inning}:${row.halfInning}`
    const previous = byHalf.get(key)
    if (previous == null || row.atBatIndex > previous.atBatIndex) {
      byHalf.set(key, row)
    }
  }
  const ordered = [...byHalf.values()].sort((a, b) => {
    const inning = (a.inning ?? 0) - (b.inning ?? 0)
    if (inning !== 0) return inning
    const aTop = a.halfInning === 'top' ? 0 : 1
    const bTop = b.halfInning === 'top' ? 0 : 1
    return aTop - bTop
  })
  let previousAway = 0
  let previousHome = 0
  return ordered.map(row => {
    const half = row.halfInning === 'bottom' ? 'bottom' : 'top'
    const baseline = half === 'top' ? previousAway : previousHome
    const side = half === 'top' ? row.awayScore : row.homeScore
    const about = aboutOf(row.gumbo)
    const outs = typeof about.halfOuts === 'number' ? about.halfOuts : 0
    previousAway = row.awayScore ?? previousAway
    previousHome = row.homeScore ?? previousHome
    return {
      inning: row.inning ?? 0,
      half,
      awayScore: row.awayScore,
      homeScore: row.homeScore,
      outs,
      runs: side == null ? 0 : side - baseline
    }
  })
}

function aboutOf(gumbo: unknown): { halfOuts?: number } {
  if (gumbo == null || typeof gumbo !== 'object') return {}
  const about = (gumbo as { about?: unknown }).about
  if (about == null || typeof about !== 'object') return {}
  return about
}

/**
 * `r` is the posted total, or 0 when that score is null. `runs` sums to `r`.
 * A side with no stored half gets `[r]`. Hits and errors stay null when the
 * plays cannot say.
 */
export function lineScore(
  rows: StoredPlay[],
  halves: HalfOutcome[],
  awayScore: number | null,
  homeScore: number | null
): {
  away: ReturnType<typeof side>
  home: ReturnType<typeof side>
} {
  const counted = hitsAndErrors(
    rows.map(row => ({
      halfInning:
        row.halfInning === 'top' || row.halfInning === 'bottom'
          ? row.halfInning
          : null,
      eventType: row.eventType ?? ''
    }))
  )
  return {
    away: side('top', halves, awayScore ?? 0, counted, 'away'),
    home: side('bottom', halves, homeScore ?? 0, counted, 'home')
  }
}

function side(
  half: 'top' | 'bottom',
  halves: HalfOutcome[],
  r: number,
  counted: ReturnType<typeof hitsAndErrors>,
  which: 'away' | 'home'
): {
  runs: number[]
  r: number
  h: number | null
  e: number | null
  bb: number | null
  k: number | null
  hr: number | null
  hbp: number | null
} {
  const mine = halves.filter(item => item.half === half)
  const runs = mine.length === 0 ? [r] : mine.map(item => item.runs)
  if (mine.length > 0) {
    const sum = runs.reduce((total, value) => total + value, 0)
    const last = runs.length - 1
    runs[last] = (runs[last] ?? 0) + (r - sum)
  }
  return {
    runs,
    r,
    h: counted.known ? counted.hits[which] : null,
    e: counted.known ? counted.errors[which] : null,
    bb: counted.known ? counted.walks[which] : null,
    k: counted.known ? counted.strikeouts[which] : null,
    hr: counted.known ? counted.homeRuns[which] : null,
    hbp: counted.known ? counted.hitByPitch[which] : null
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
