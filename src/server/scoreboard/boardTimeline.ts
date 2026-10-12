import { isDeepStrictEqual } from 'node:util'

import { type Kysely, sql } from 'kysely'

import type { CurrentPlay, GumboPlay } from '../../common/gumboPlay'
import {
  composeScoreboard,
  type DashboardOverrides,
  type GameScoreboard,
  NO_OVERRIDES,
  type ScoreboardState,
  type SourceState
} from '../../common/scoreboard'
import { replayPlays } from '../../common/scoring/gumbo'
import { scoreboardOfGame } from '../../common/scoring/scoreboardOf'
import type { Database } from '../db/database'
import { contextOf } from '../scoring/replayContext'

/**
 * A game's board at every moment, rebuilt from what Postgres keeps: the
 * stored plays, replayed one action at a time, and the scoreboard log.
 *
 * Each step is the board as drawn, every override applied, from its `at`
 * until the next step. It is composed by the same rule the live widget uses
 * (`composeScoreboard`), from three streams:
 *
 * - the game's own scoring: the board after each action, at that action's
 *   time. The game source counts as having reported at the time of the newest
 *   action, whatever that action changed, as each live post restamps it;
 * - the score baseline: the score of the newest stored play, of any source,
 *   that had ended by then, or 0–0. The game's final score is never used, so
 *   it cannot appear before the plays that made it;
 * - the log: the publisher's slot and the overrides as each row left them.
 */

export interface BoardStep {
  /** Milliseconds, on the server's clock. */
  at: number
  state: ScoreboardState
}

export interface BoardTimeline {
  /**
   * `"<games.updated_at in µs>:<newest log version, or 0>"`: what changes
   * whenever anything the timeline reads does.
   */
  version: string
  steps: BoardStep[]
}

/** Every step of a game's board; undefined when there is no such game. */
export async function computeBoardTimeline(
  db: Kysely<Database>,
  gameId: string,
  log: (message: string) => void = () => undefined
): Promise<BoardTimeline | undefined> {
  // One snapshot: the version and everything it stands for, read together, so
  // a timeline is never cached under a version newer or older than its data.
  const read = await db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async trx => {
      const version = await timelineVersion(trx, gameId)
      if (version == null) return undefined
      const game = await trx
        .selectFrom('games')
        .innerJoin('teams as home', 'home.id', 'games.home_team_id')
        .innerJoin('teams as away', 'away.id', 'games.away_team_id')
        .select([
          'games.home_team_id',
          'games.away_team_id',
          'games.start_at',
          'games.currentPlay',
          'home.name as homeTeam',
          'away.name as awayTeam'
        ])
        .where('games.id', '=', gameId)
        .executeTakeFirst()
      if (game == null) return undefined
      const plays = await trx
        .selectFrom('events')
        .select([
          'atBatIndex',
          'gumbo',
          'startTime',
          'endTime',
          'awayScore',
          'homeScore'
        ])
        .where('gameId', '=', gameId)
        .orderBy('atBatIndex')
        .execute()
      const stored = {
        plays: plays.map(row => row.gumbo as GumboPlay),
        currentPlay: game.currentPlay as CurrentPlay | null
      }
      const context =
        stored.plays.length === 0 && stored.currentPlay == null
          ? null
          : await contextOf(trx, gameId, game, stored)
      const rows = await trx
        .selectFrom('scoreboard_log')
        .select(['at', 'publisher', 'overrides'])
        .where('game_id', '=', gameId)
        .orderBy('version')
        .execute()
      return { version, game, plays, stored, context, rows }
    })
  if (read == null) return undefined
  const { game, plays, stored, context } = read

  const scoring: Array<{ at: number; state: GameScoreboard }> = []
  if (context != null) {
    // A play without action times puts all its actions at its end, or, for
    // the at-bat in progress, at its start.
    const fallback = new Map<number, number | undefined>()
    for (const row of plays)
      fallback.set(row.atBatIndex, msOf(row.endTime ?? row.startTime))
    if (stored.currentPlay != null) {
      const about = stored.currentPlay.about as { startTime?: unknown }
      fallback.set(stored.currentPlay.about.atBatIndex, msOf(about.startTime))
    }
    const boards: Array<{ at: number | undefined; state: GameScoreboard }> = []
    const replayed = replayPlays(stored, context, (state, atBatIndex, time) => {
      boards.push({
        at: msOf(time) ?? fallback.get(atBatIndex),
        state: scoreboardOfGame(state)
      })
    })
    if (replayed.problems.length > 0) {
      log(
        `scoreboard timeline: game ${gameId} replays only to ${replayed.problems[0].message}`
      )
    }
    scoring.push(...inOrder(boards, msOf(game.start_at) ?? 0))
  }

  const ended = plays
    .map(row => ({
      at: msOf(row.endTime),
      away: row.awayScore,
      home: row.homeScore,
      index: row.atBatIndex
    }))
    .filter(
      (play): play is typeof play & { at: number } => play.at !== undefined
    )
    .sort((a, b) => (a.at === b.at ? a.index - b.index : a.at - b.at))

  const logged = read.rows.map(row => ({
    at: msOf(row.at) ?? 0,
    publisher: (row.publisher ?? undefined) as SourceState | undefined,
    overrides: (row.overrides ?? NO_OVERRIDES) as DashboardOverrides
  }))

  const moments = [
    ...new Set([
      ...scoring.map(step => step.at),
      ...ended.map(play => play.at),
      ...logged.map(row => row.at)
    ])
  ].sort((a, b) => a - b)

  const steps: BoardStep[] = []
  let nextScoring = 0
  let nextEnded = 0
  let nextLogged = 0
  let gameSource: SourceState | undefined
  let awayScore: number | null = null
  let homeScore: number | null = null
  let row: (typeof logged)[number] | undefined
  for (const at of moments) {
    for (; nextScoring < scoring.length; nextScoring++) {
      const step = scoring[nextScoring]
      if (step.at > at) break
      gameSource = { state: step.state, receivedAt: step.at }
    }
    // A play that carries no score, such as a stolen base written without
    // it, keeps the score before it, as the game record's score does.
    for (; nextEnded < ended.length; nextEnded++) {
      const play = ended[nextEnded]
      if (play.at > at) break
      awayScore = play.away ?? awayScore
      homeScore = play.home ?? homeScore
    }
    for (; nextLogged < logged.length; nextLogged++) {
      if (logged[nextLogged].at > at) break
      row = logged[nextLogged]
    }
    const { final } = composeScoreboard({
      baseline: {
        homeTeam: game.homeTeam,
        awayTeam: game.awayTeam,
        homeScore,
        awayScore
      },
      game: gameSource,
      watcher: row?.publisher,
      overrides: row?.overrides ?? NO_OVERRIDES
    })
    const last = steps.at(-1)
    if (last == null || !isDeepStrictEqual(last.state, final))
      steps.push({ at, state: final })
  }
  return { version: read.version, steps }
}

/**
 * The version a game's timeline is cached under, read in one query: the
 * game's `updated_at`, which every play post moves (and which the game
 * source writes as its `sourceVersion`), and the newest log row's version.
 * Undefined when there is no such game.
 */
export async function timelineVersion(
  db: Kysely<Database>,
  gameId: string
): Promise<string | undefined> {
  const row = await db
    .selectFrom('games')
    .select(
      sql<string>`(extract(epoch from games.updated_at) * 1000000)::bigint::text || ':' || coalesce((select max(version) from scoreboard_log where game_id = games.id), 0)::text`.as(
        'version'
      )
    )
    .where('id', '=', gameId)
    .executeTakeFirst()
  return row?.version
}

/**
 * The timelines one worker has built, under their versions, for the most
 * recently asked-for games. Many viewers of one game cost one replay per
 * change, and a recording watched long after its live board expired is
 * served from Postgres the same way.
 */
export interface BoardTimelineCache {
  get: (
    db: Kysely<Database>,
    gameId: string,
    log?: (message: string) => void
  ) => Promise<BoardTimeline | undefined>
}

export function makeBoardTimelineCache(size = 20): BoardTimelineCache {
  // A Map keeps insertion order: each use moves a game to the end, so the
  // first key is the game asked for least recently.
  const held = new Map<string, BoardTimeline>()
  return {
    get: async (db, gameId, log) => {
      const version = await timelineVersion(db, gameId)
      if (version == null) {
        held.delete(gameId)
        return undefined
      }
      let timeline = held.get(gameId)
      if (timeline?.version !== version) {
        timeline = await computeBoardTimeline(db, gameId, log)
        if (timeline == null) {
          held.delete(gameId)
          return undefined
        }
      }
      held.delete(gameId)
      held.set(gameId, timeline)
      while (held.size > size) held.delete(held.keys().next().value!)
      return timeline
    }
  }
}

const workerCache = makeBoardTimelineCache()

/** A game's board timeline, from this worker's cache when it is current. */
export async function boardTimeline(
  db: Kysely<Database>,
  gameId: string,
  log?: (message: string) => void
): Promise<BoardTimeline | undefined> {
  return await workerCache.get(db, gameId, log)
}

/**
 * The steps a window shows: every step inside it, and the one already in
 * effect at its start. Either end may be left open.
 */
export function stepsInWindow(
  steps: BoardStep[],
  from?: number,
  to?: number
): BoardStep[] {
  let first = 0
  if (from != null) {
    while (first < steps.length && steps[first].at <= from) first++
    first = Math.max(0, first - 1)
  }
  const shown: BoardStep[] = []
  for (let i = first; i < steps.length; i++) {
    if (to != null && steps[i].at > to) break
    shown.push(steps[i])
  }
  return shown
}

/**
 * The scoring boards in the order they were applied, each at a time no
 * earlier than the one before: an action whose time is unknown, or earlier
 * than its predecessor's, takes its predecessor's. Actions before the first
 * known time take that time, and a game with no time at all takes its start.
 */
function inOrder(
  boards: Array<{ at: number | undefined; state: GameScoreboard }>,
  startAt: number
): Array<{ at: number; state: GameScoreboard }> {
  let previous = boards.find(board => board.at !== undefined)?.at ?? startAt
  return boards.map(board => {
    previous = Math.max(previous, board.at ?? previous)
    return { at: previous, state: board.state }
  })
}

function msOf(value: unknown): number | undefined {
  if (value instanceof Date) return value.getTime()
  if (typeof value !== 'string') return undefined
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? undefined : ms
}
