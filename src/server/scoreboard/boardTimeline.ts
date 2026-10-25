import { isDeepStrictEqual } from 'node:util'

import { type Kysely, sql } from 'kysely'

import type { CurrentPlay, GumboPlay } from '../../common/gumboPlay'
import { shortNames } from '../../common/names'
import {
  composeScoreboard,
  type DashboardOverrides,
  type GameScoreboard,
  NO_OVERRIDES,
  type ScoreboardState,
  type SourceState
} from '../../common/scoreboard'
import { replayPlays, storedRecordOf } from '../../common/scoring/gumbo'
import { forPlayback } from '../../common/scoring/playbackTimes'
import { scoreboardOfGame } from '../../common/scoring/scoreboardOf'
import type { Database } from '../db/database'
import { atBatInProgress } from '../events/atBatInProgress'
import { resolveScoringGame } from '../scoring/openRow'
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
 *   action, whatever that action changed, as each live post restamps it.
 *   Plays TeamStation did not score count as the game's scoring too, at each
 *   of their events' times (`importedBoards`);
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
   * `"<game update>:<newest log>:<team names>:<account merges>"`,
   * the last a hash of the two teams' names: what changes whenever anything
   * the timeline reads does.
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
          atBatInProgress('games').as('currentPlay'),
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
      const stored = await resolveScoringGame(trx, {
        plays: plays.map(row => row.gumbo as GumboPlay),
        currentPlay: game.currentPlay as CurrentPlay | null
      })
      const context =
        stored.plays.length === 0 && stored.currentPlay == null
          ? null
          : await contextOf(trx, gameId, game, stored)
      const rows = await trx
        .selectFrom('scoreboard_log')
        .select(['at', 'publisher', 'overrides'])
        .where('game_id', '=', gameId)
        // An older packet accepted only for radar does not replace historical
        // board snapshots or invalidate the newest-version cache key.
        .where(
          sql<boolean>`radar -> 'measurementOnly' is distinct from 'true'::jsonb`
        )
        .orderBy('version')
        .execute()
      // Everyone an imported board can name: each play's batter and pitcher,
      // and whoever each of its pitches and pitching changes names.
      const named = [
        ...new Set(
          stored.plays
            .flatMap(play => [
              refId(play.matchup?.batter),
              refId(play.matchup?.pitcher),
              ...eventsOf(play).map(event => refId(event.player))
            ])
            .filter((id): id is number => id != null)
        )
      ]
      const people =
        named.length === 0
          ? []
          : await trx
              .selectFrom('gumbo_ids')
              .innerJoin('users', 'users.id', 'gumbo_ids.user_id')
              .select([
                'gumbo_id as id',
                'display_name',
                'first_name',
                'last_name'
              ])
              .where('gumbo_id', 'in', named)
              .execute()
      // Short names with collisions broken over the game's people, as a box
      // score has them. A rename moves no timeline version, so a board built
      // before it keeps the old name until the game's plays or log next move.
      const short = shortNames(
        people.map(person => ({
          id: Number(person.id),
          displayName: person.display_name,
          firstName: person.first_name,
          lastName: person.last_name
        }))
      )
      const names = new Map(
        [...short].map(([id, name]) => [Number(id), name] as const)
      )
      return {
        version,
        game,
        plays: plays.map((row, index) => ({
          ...row,
          gumbo: stored.plays[index]
        })),
        stored,
        context,
        rows,
        names
      }
    })
  if (read == null) return undefined
  const { game, plays, stored, context, names } = read

  const scoring: Array<{ at: number; state: GameScoreboard }> = []
  // The plays imported before TeamStation scored any, at each of their
  // events' times.
  const imported = importedBoards(
    plays,
    names,
    stored.currentPlay?.about.atBatIndex
  )
  if (context == null && imported.length > 0)
    scoring.push(...inOrder(imported, msOf(game.start_at) ?? 0))
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
    // Plays imported before TeamStation took over the scoring come first.
    const boards: Array<{ at: number | undefined; state: GameScoreboard }> = [
      ...imported
    ]
    const replayed = replayPlays(
      {
        plays: stored.plays.map(forPlayback),
        currentPlay: forPlayback(stored.currentPlay)
      },
      context,
      (state, atBatIndex, time) => {
        boards.push({
          at: msOf(time) ?? fallback.get(atBatIndex),
          state: scoreboardOfGame(state)
        })
      }
    )
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
 * source writes as its `sourceVersion`), the newest log row's version, and
 * the two teams' names, which every step shows and which a rename or a merge
 * changes without touching the game. The merge graph also invalidates cached
 * player identities even when no new play follows a merge. Undefined for no game.
 */
export async function timelineVersion(
  db: Kysely<Database>,
  gameId: string
): Promise<string | undefined> {
  const row = await db
    .selectFrom('games')
    .innerJoin('teams as home', 'home.id', 'games.home_team_id')
    .innerJoin('teams as away', 'away.id', 'games.away_team_id')
    .select(
      sql<string>`(extract(epoch from games.updated_at) * 1000000)::bigint::text || ':' || coalesce((select max(version) from scoreboard_log where game_id = games.id), 0)::text || ':' || left(md5(home.name || chr(10) || away.name), 16) || ':' || (select md5(coalesce(string_agg(id::text || ':' || merged_into::text, ',' order by id), '')) from users where merged_into is not null)`.as(
        'version'
      )
    )
    .where('games.id', '=', gameId)
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

export function makeBoardTimelineCache(
  size = 20,
  compute: typeof computeBoardTimeline = computeBoardTimeline
): BoardTimelineCache {
  // A Map keeps insertion order: each use moves a game to the end, so the
  // first key is the game asked for least recently.
  const held = new Map<string, BoardTimeline>()
  // The builds under way, by game and the version they were started for. One
  // change notice reaches every viewer of a game at once, and they all ask
  // within the same moment: each waits on the one build rather than starting
  // its own. A build that fails is dropped, so the next ask tries again.
  const building = new Map<string, Promise<BoardTimeline | undefined>>()
  return {
    get: async (db, gameId, log) => {
      const version = await timelineVersion(db, gameId)
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

/** One of an imported play's events, as much of it as the board reads. */
interface ImportedEvent {
  startTime?: unknown
  isPitch?: unknown
  /** Who threw a pitch; who a pitching change brings in. */
  player?: unknown
  details?: { eventType?: unknown; awayScore?: unknown; homeScore?: unknown }
  count?: { balls?: unknown; strikes?: unknown; outs?: unknown }
  offense?: { first?: unknown; second?: unknown; third?: unknown }
}

/** A play's `playEvents`, or none. */
function eventsOf(play: unknown): ImportedEvent[] {
  const events = (play as { playEvents?: unknown } | null)?.playEvents
  return Array.isArray(events) ? (events as ImportedEvent[]) : []
}

/**
 * The board after every event of the plays imported before TeamStation
 * scored any — the plays `replayPlays` rebuilds from their documents — each
 * at the time it was tapped: every pitch, steal, pickoff and ball in play
 * the play's `playEvents` carry, with the count, outs, runners and score
 * after it. A play with no events steps once, at its end, or at its start
 * when that is all it has, with the score and outs it left, and nobody on:
 * such a play lists only the runners who scored, not where the others stood.
 * Something with no time of its own has no board of its own: an untimed
 * event inside a play is left to the next one that has a time, and only a
 * play's last event falls back to the play's own time.
 *
 * Each pitch counts for the pitcher who threw it, and the pitcher on the
 * mound follows each pitch and each pitching change. After a play's last
 * event the next play's batter is up at 0–0. When the next play is in
 * another half — a third out, or a half ended short of one — the board
 * turns to that half with nobody on, its first batter and the pitcher that
 * side last had. The game's last play keeps its own half, and a play in no
 * inning, such as a score correction, moves only the score.
 */
export function importedBoards(
  plays: Array<{
    atBatIndex: number
    gumbo: unknown
    startTime: unknown
    endTime: unknown
  }>,
  names: Map<number, string>,
  reopened: number | undefined
): Array<{ at: number | undefined; state: GameScoreboard }> {
  const boards: Array<{ at: number | undefined; state: GameScoreboard }> = []
  const firstLogged = plays.findIndex(row => storedRecordOf(row.gumbo) != null)
  const last = firstLogged < 0 ? plays.length : firstLogged
  const pitches = new Map<number, number>()
  /** The pitcher each side last had on the mound. */
  const mounds = new Map<'top' | 'bottom', number | null>()
  const name = (id: number | null): string =>
    id == null ? '' : (names.get(id) ?? '')
  let away = 0
  let home = 0
  let outs = 0
  let halfKey = ''
  for (let i = 0; i < last; i++) {
    const row = plays[i]
    if (row.atBatIndex === reopened) continue
    const play = row.gumbo as GumboPlay
    if (play.about.inning == null) {
      // A play in no inning, such as a score correction, moves the score
      // and nothing else.
      away = countOf(play.result.awayScore) ?? away
      home = countOf(play.result.homeScore) ?? home
      const at = msOf(row.endTime) ?? msOf(row.startTime)
      const previous = boards.at(-1)
      if (at != null && previous != null)
        boards.push({
          at,
          state: { ...previous.state, awayScore: away, homeScore: home }
        })
      continue
    }
    const inning = play.about.inning
    const half = halfOf(play)
    // The next play in an inning, if any: the one the board turns to.
    const next = plays
      .slice(i + 1)
      .map(item => item.gumbo as GumboPlay)
      .find(item => item.about.inning != null)
    const turns =
      next != null &&
      `${next.about.inning ?? 1} ${halfOf(next)}` !== `${inning} ${half}`
    const batterId = refId(play.matchup?.batter)
    let mound = mounds.get(half) ?? refId(play.matchup?.pitcher)
    const tapped = msOf(row.endTime) ?? msOf(row.startTime)
    if (`${inning} ${half}` !== halfKey) outs = 0
    halfKey = `${inning} ${half}`
    const board = (
      at: number | undefined,
      situation: { balls: number; strikes: number; outs: number },
      bases: [boolean, boolean, boolean],
      ended: boolean
    ): void => {
      // A board with no time is not placed at a neighbour's: what it left
      // carries on to the next board that has one.
      if (at == null) return
      if (next != null && ((ended && turns) || situation.outs >= 3)) {
        const nextHalf = halfOf(next)
        const pitcher = mounds.get(nextHalf) ?? refId(next.matchup?.pitcher)
        boards.push({
          at,
          state: {
            inGame: true,
            balls: 0,
            strikes: 0,
            outs: 0,
            base1: false,
            base2: false,
            base3: false,
            inning: next.about.inning ?? inning,
            half: nextHalf,
            awayScore: away,
            homeScore: home,
            batterName: name(refId(next.matchup?.batter)),
            pitcherName: name(pitcher),
            numPitches: pitcher == null ? 0 : (pitches.get(pitcher) ?? 0)
          }
        })
        return
      }
      const batter =
        ended && next != null ? refId(next.matchup?.batter) : batterId
      boards.push({
        at,
        state: {
          inGame: true,
          balls: ended ? 0 : situation.balls,
          strikes: ended ? 0 : situation.strikes,
          outs: situation.outs,
          base1: bases[0],
          base2: bases[1],
          base3: bases[2],
          inning,
          half,
          awayScore: away,
          homeScore: home,
          batterName: name(batter),
          pitcherName: name(mound),
          numPitches: mound == null ? 0 : (pitches.get(mound) ?? 0)
        }
      })
    }
    const events = eventsOf(play)
    events.forEach((event, j) => {
      const ended = j === events.length - 1
      const who = refId(event.player)
      if (event.details?.eventType === 'pitching_substitution' && who != null)
        mound = who
      if (event.isPitch === true) {
        const thrower = who ?? mound
        if (thrower != null) {
          pitches.set(thrower, (pitches.get(thrower) ?? 0) + 1)
          mound = thrower
        }
      }
      away =
        countOf(event.details?.awayScore) ??
        (ended ? countOf(play.result.awayScore) : undefined) ??
        away
      home =
        countOf(event.details?.homeScore) ??
        (ended ? countOf(play.result.homeScore) : undefined) ??
        home
      outs = countOf(event.count?.outs) ?? outs
      board(
        ended ? (msOf(event.startTime) ?? tapped) : msOf(event.startTime),
        {
          balls: countOf(event.count?.balls) ?? 0,
          strikes: countOf(event.count?.strikes) ?? 0,
          outs
        },
        [
          event.offense?.first != null,
          event.offense?.second != null,
          event.offense?.third != null
        ],
        ended
      )
    })
    if (events.length === 0) {
      away = countOf(play.result.awayScore) ?? away
      home = countOf(play.result.homeScore) ?? home
      outs = countOf(play.count?.outs) ?? outs
      board(tapped, { balls: 0, strikes: 0, outs }, [false, false, false], true)
    }
    mounds.set(half, mound)
  }
  return boards
}

/** A play's half: top unless it says bottom. */
function halfOf(play: GumboPlay): 'top' | 'bottom' {
  return play.about.halfInning === 'bottom' ? 'bottom' : 'top'
}

/** A whole number of balls, strikes, outs or runs, or undefined. */
function countOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : undefined
}

/** The user id a play names somebody by, or null. */
function refId(ref: unknown): number | null {
  const id = (ref as { id?: unknown } | null | undefined)?.id
  return typeof id === 'number' ? id : null
}

function msOf(value: unknown): number | undefined {
  if (value instanceof Date) return value.getTime()
  if (typeof value !== 'string') return undefined
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? undefined : ms
}
