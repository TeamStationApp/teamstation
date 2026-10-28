import { isDeepStrictEqual } from 'node:util'

import { type Kysely, sql } from 'kysely'

import type { CurrentPlay, GumboPlay } from '../../common/gumboPlay'
import {
  type BoardLine,
  boardLineOf,
  boardLineOfPlays
} from '../../common/scoring/boardLine'
import { replayPlays, storedRecordOf } from '../../common/scoring/gumbo'
import { forPlayback } from '../../common/scoring/playbackTimes'
import type { Database } from '../db/database'
import { atBatInProgress } from '../events/atBatInProgress'
import { resolveScoringGame } from './openRow'
import { contextOf } from './replayContext'

/**
 * A game's line score at every moment, from its events alone: the stored
 * plays and the play in progress, replayed one action at a time as the
 * board timeline replays them, and never the scoreboard log, the overrides
 * or the overlay settings. Each step is the line from its `at` until the
 * next. A game with no events has no steps, and so no box score.
 *
 * - Plays TeamStation scored: the line after each action, at that action's
 *   time, or its play's end (its start, for the play in progress) where the
 *   action has none.
 * - Plays imported before TeamStation scored any: the line of the plays
 *   ended so far, at each one's end, or its start where it has no end.
 */

export interface LineStep {
  /** Milliseconds, on the server's clock. */
  at: number
  line: BoardLine
}

export interface LineTimeline {
  /** `"<games.updated_at in µs>:<team names>"`: what every change moves. */
  version: string
  /** The game's team names, the rows the box score is labelled with. */
  teams: { away: string; home: string }
  steps: LineStep[]
}

/** The version a game's line timeline is cached under; undefined: no game. */
export async function lineTimelineVersion(
  db: Kysely<Database>,
  gameId: string
): Promise<string | undefined> {
  const row = await db
    .selectFrom('games')
    .innerJoin('teams as home', 'home.id', 'games.home_team_id')
    .innerJoin('teams as away', 'away.id', 'games.away_team_id')
    .select(
      sql<string>`(extract(epoch from games.updated_at) * 1000000)::bigint::text || ':' || left(md5(home.name || chr(10) || away.name), 16)`.as(
        'version'
      )
    )
    .where('games.id', '=', gameId)
    .executeTakeFirst()
  return row?.version
}

/** Every step of a game's line score; undefined when there is no game. */
export async function computeLineTimeline(
  db: Kysely<Database>,
  gameId: string,
  log: (message: string) => void = () => undefined
): Promise<LineTimeline | undefined> {
  const read = await db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async trx => {
      const version = await lineTimelineVersion(trx, gameId)
      if (version == null) return undefined
      const game = await trx
        .selectFrom('games')
        .innerJoin('teams as home', 'home.id', 'games.home_team_id')
        .innerJoin('teams as away', 'away.id', 'games.away_team_id')
        .select([
          'games.home_team_id',
          'games.away_team_id',
          atBatInProgress('games').as('currentPlay'),
          'games.start_at',
          'home.name as homeTeam',
          'away.name as awayTeam'
        ])
        .where('games.id', '=', gameId)
        .executeTakeFirst()
      if (game == null) return undefined
      const plays = await trx
        .selectFrom('events')
        .select(['atBatIndex', 'gumbo', 'startTime', 'endTime'])
        .where('gameId', '=', gameId)
        .orderBy('atBatIndex')
        .execute()
      const stored = await resolveScoringGame(trx, {
        plays: plays.map(row => row.gumbo as GumboPlay),
        currentPlay: game.currentPlay as CurrentPlay | null
      })
      const context =
        stored.plays.length === 0 && stored.currentPlay == null
          ? null
          : await contextOf(trx, gameId, game, stored)
      return { version, game, plays, stored, context }
    })
  if (read == null) return undefined
  const { version, game, plays, stored, context } = read

  const lines: Array<{ at: number | undefined; line: BoardLine }> = []
  // The plays imported before TeamStation scored any.
  const firstScored = plays.findIndex(row => storedRecordOf(row.gumbo) != null)
  const imported = firstScored < 0 ? plays.length : firstScored
  for (let i = 0; i < imported; i++) {
    if (plays[i].atBatIndex === stored.currentPlay?.about.atBatIndex) continue
    lines.push({
      at: msOf(plays[i].endTime) ?? msOf(plays[i].startTime),
      line: boardLineOfPlays(stored.plays.slice(0, i + 1))
    })
  }
  if (context != null) {
    const fallback = new Map<number, number | undefined>()
    for (const row of plays)
      fallback.set(row.atBatIndex, msOf(row.endTime ?? row.startTime))
    if (stored.currentPlay != null) {
      const about = stored.currentPlay.about as { startTime?: unknown }
      fallback.set(stored.currentPlay.about.atBatIndex, msOf(about.startTime))
    }
    const replayed = replayPlays(
      {
        plays: stored.plays.map(forPlayback),
        currentPlay: forPlayback(stored.currentPlay)
      },
      context,
      (state, atBatIndex, time) => {
        lines.push({
          at: msOf(time) ?? fallback.get(atBatIndex),
          line: boardLineOf(state)
        })
      }
    )
    if (replayed.problems.length > 0)
      log(
        `line timeline: game ${gameId} replays only to ${replayed.problems[0].message}`
      )
  }

  // In the order applied, each at a time no earlier than the one before
  // (lines with no time of their own take their predecessor's, and those
  // before the first known time take it; a game with none takes its start),
  // and a step only where the line changes. Of lines at one instant, the
  // last stands.
  const steps: LineStep[] = []
  let previous =
    lines.find(one => one.at !== undefined)?.at ?? msOf(game.start_at) ?? 0
  for (const one of lines) {
    previous = Math.max(previous, one.at ?? previous)
    if (steps.at(-1)?.at === previous) steps.pop()
    if (isDeepStrictEqual(steps.at(-1)?.line, one.line)) continue
    steps.push({ at: previous, line: one.line })
  }
  return {
    version,
    teams: { away: game.awayTeam, home: game.homeTeam },
    steps
  }
}

/**
 * The steps a query asks for: the one in effect `at` an instant (none before
 * the first), or those in a window with the one already in effect at its
 * start, or all of them.
 */
export function lineStepsFor(
  steps: LineStep[],
  query: { at?: number; from?: number; to?: number }
): LineStep[] {
  if (query.at != null) {
    let found: LineStep | undefined
    for (const step of steps) {
      if (step.at > query.at) break
      found = step
    }
    return found == null ? [] : [found]
  }
  let first = 0
  if (query.from != null) {
    while (first < steps.length && steps[first].at <= query.from) first++
    first = Math.max(0, first - 1)
  }
  const shown: LineStep[] = []
  for (let i = first; i < steps.length; i++) {
    if (query.to != null && steps[i].at > query.to) break
    shown.push(steps[i])
  }
  return shown
}

/** The line timelines this worker has built, by game, under their versions. */
export function makeLineTimelineCache(
  size = 20,
  compute: typeof computeLineTimeline = computeLineTimeline
): {
  get: (
    db: Kysely<Database>,
    gameId: string,
    log?: (message: string) => void
  ) => Promise<LineTimeline | undefined>
} {
  const held = new Map<string, LineTimeline>()
  const building = new Map<string, Promise<LineTimeline | undefined>>()
  return {
    get: async (db, gameId, log) => {
      const version = await lineTimelineVersion(db, gameId)
      if (version == null) {
        held.delete(gameId)
        return undefined
      }
      let timeline = held.get(gameId)
      if (timeline?.version !== version) {
        const key = `${gameId} ${version}`
        let build = building.get(key)
        if (build == null) {
          build = compute(db, gameId, log).finally(() => {
            building.delete(key)
          })
          building.set(key, build)
        }
        timeline = await build
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

const workerCache = makeLineTimelineCache()

/** A game's line timeline, from this worker's cache when it is current. */
export async function lineTimeline(
  db: Kysely<Database>,
  gameId: string,
  log?: (message: string) => void
): Promise<LineTimeline | undefined> {
  return await workerCache.get(db, gameId, log)
}

function msOf(value: unknown): number | undefined {
  if (value instanceof Date) return value.getTime()
  if (typeof value !== 'string') return undefined
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? undefined : ms
}
