import { isDeepStrictEqual } from 'node:util'

import { type Kysely, sql } from 'kysely'

import {
  asPostEventsBody,
  type CurrentPlay,
  type GumboPlay
} from '../../common/gumboPlay'
import { comparablePlay } from '../../common/scoring/comparable'
import { replayPlays } from '../../common/scoring/gumbo'
import {
  type EventStore,
  ScoringSession,
  type StoredGame
} from '../../common/scoring/session'
import { type Database, makeDatabase } from '../db/database'
import { postGamePlays } from '../events/postPlays'
import { readPlays } from '../routes/events'
import { contextOf } from '../scoring/replayContext'
import { serverConfig } from '../serverConfig'

/**
 * Rebuilds every stored play TeamStation scored from its own action log, so
 * each is the document today's engine writes for it.
 *
 *   npm run refold-scored-games -- [--game <id>] [--preview]
 *
 * `--preview` lists what would be written and writes nothing. `--dry-run`
 * means the same when the script is run with node itself, but `socket npm`
 * takes that flag as its own even after `--`, so the script never sees it.
 *
 * Each game with a play or an at-bat in progress that carries a `teamStation`
 * record is opened as the scoring screen opens it, and every play it scored,
 * and its at-bat in progress, is folded again. A play is written only when it
 * differs from the stored one other than in what the server writes on it; the
 * write is the same `postGamePlays` a scorer's post makes. Plays TeamStation
 * did not score are never touched, so a second run changes nothing. A stored
 * play the log no longer makes — one an undo took back that the old code left
 * behind — is removed, as the scoring screen's own save removes it, through
 * the same write's `remove`. A game whose log no longer replays is left alone
 * and listed with its problem.
 *
 * Prints each game it changed, then each game it skipped; exits 1 when it
 * skipped any, or when `--game` names no game. A game is skipped too when a
 * play it would rewrite would name another batter, pitcher or runner than the
 * stored play does: its log, read as today's engine reads it, says another
 * man played, so it is left as the scorer saw it.
 */

export interface GameRefold {
  gameId: string
  /** The plays written, or that would be. */
  plays: number
  /** The indexes of the plays removed, or that would be. */
  removed: number[]
  /** The at-bat in progress was, or would be, written. */
  currentPlay: boolean
}
export interface RefoldReport {
  changed: GameRefold[]
  unchanged: string[]
  skipped: Array<{ gameId: string; problem: string }>
}

/** Games TeamStation scored any of: a play or an at-bat with its record. */
async function scoredGames(db: Kysely<Database>): Promise<string[]> {
  const rows = await sql<{ id: string }>`
    select distinct "gameId" as id from events where gumbo ? 'teamStation'
    union
    select id from games where "currentPlay" ? 'teamStation'
    order by id
  `.execute(db)
  return rows.rows.map(row => row.id)
}

/** A man a stored play names: by his id, or by his name when he has none. */
interface Named {
  id?: number | string | null
  fullName?: string
}
const sameMan = (a: Named | undefined, b: Named | undefined): boolean =>
  a?.id != null && b?.id != null
    ? a.id === b.id
    : (a?.fullName ?? null) === (b?.fullName ?? null)
const nameOf = (man: Named | undefined): string =>
  man?.fullName ?? (man?.id == null ? 'nobody' : String(man.id))

/** A base as either shape of stored runner writes it: 1-3, or none. */
function baseNumber(base: unknown): number | null {
  const number =
    typeof base === 'number'
      ? base
      : typeof base === 'string'
        ? Number(base.charAt(0))
        : 0
  return number >= 1 && number <= 3 ? number : null
}

/**
 * Who a stored play says played: its batter and pitcher, and each runner
 * who moved or was put out, by the base he started the play on (the lowest
 * he left, since the older shape wrote one entry a runner and Gumbo one an
 * event). A runner who stood still is left out, as the older shape listed
 * him and Gumbo does not, and so is the batter taking a further base.
 */
function whoPlayed(
  play: GumboPlay | CurrentPlay
): Array<{ role: string; men: Named[] }> {
  const matchup = (play as { matchup?: { batter?: Named; pitcher?: Named } })
    .matchup
  const entries = ((play as { runners?: unknown[] }).runners ?? []) as Array<{
    movement?: { start?: unknown; end?: unknown; isOut?: boolean }
    details?: { runner?: Named }
  }>
  const runners: Array<{ man: Named; base: number }> = []
  for (const entry of entries) {
    const base = baseNumber(entry.movement?.start)
    const man = entry.details?.runner ?? {}
    const moved =
      entry.movement?.isOut === true ||
      entry.movement?.end !== entry.movement?.start
    if (base == null || !moved || sameMan(man, matchup?.batter)) continue
    const known = runners.find(runner => sameMan(runner.man, man))
    if (known == null) runners.push({ man, base })
    else known.base = Math.min(known.base, base)
  }
  return [
    { role: 'batter', men: [matchup?.batter ?? {}] },
    { role: 'pitcher', men: [matchup?.pitcher ?? {}] },
    ...['1B', '2B', '3B'].map((name, index) => ({
      role: `runner from ${name}`,
      men: runners
        .filter(runner => runner.base === index + 1)
        .map(runner => runner.man)
        .sort((a, b) => nameOf(a).localeCompare(nameOf(b)))
    }))
  ]
}

/**
 * The first place where rebuilding `stored` as `refolded` would change who
 * played, as "play N batter X → Y", or undefined when it would not.
 */
function changedPlayer(
  stored: GumboPlay | CurrentPlay,
  refolded: GumboPlay | CurrentPlay
): string | undefined {
  const after = whoPlayed(refolded)
  for (const [index, { role, men }] of whoPlayed(stored).entries()) {
    const now = after[index].men
    if (
      men.length === now.length &&
      men.every((man, at) => sameMan(man, now[at]))
    )
      continue
    const list = (named: Named[]): string =>
      named.length === 0 ? 'nobody' : named.map(nameOf).join(', ')
    return `play ${stored.about.atBatIndex} ${role} ${list(men)} → ${list(now)}`
  }
}

/**
 * Where the plays a refold would write, and the at-bat in progress when it
 * would be written, name another man than the stored ones: the first such
 * place, or undefined.
 */
function playerChange(
  stored: StoredGame,
  plays: GumboPlay[],
  current: CurrentPlay | null
): string | undefined {
  const pairs: Array<
    [GumboPlay | CurrentPlay | undefined, GumboPlay | CurrentPlay]
  > = plays.map(play => [
    stored.plays.find(was => was.about.atBatIndex === play.about.atBatIndex),
    play
  ])
  if (
    current != null &&
    !isDeepStrictEqual(
      comparablePlay(current),
      comparablePlay(stored.currentPlay)
    )
  )
    pairs.push([stored.currentPlay ?? undefined, current])
  for (const [was, now] of pairs) {
    const change = was == null ? undefined : changedPlayer(was, now)
    if (change != null) return change
  }
}

/** Refolds one game, writing what changed unless it is a preview. */
export async function refoldGame(
  db: Kysely<Database>,
  gameId: string,
  preview: boolean
): Promise<
  | { kind: 'changed'; refold: GameRefold }
  | { kind: 'unchanged' }
  | { kind: 'skipped'; problem: string }
  | { kind: 'missing' }
> {
  const game = await db
    .selectFrom('games')
    .select(['home_team_id', 'away_team_id', 'currentPlay'])
    .where('id', '=', gameId)
    .executeTakeFirst()
  if (game == null) return { kind: 'missing' }
  const rows = await readPlays(db, gameId)
  const stored: StoredGame = {
    plays: rows.map(row => row.gumbo as GumboPlay),
    currentPlay: game.currentPlay as CurrentPlay | null
  }
  const context = await contextOf(db, gameId, game, stored)
  if (context == null) return { kind: 'unchanged' }
  const problems = replayPlays(stored, context).problems
  if (problems.length > 0)
    return { kind: 'skipped', problem: problems[0].message }

  const store: EventStore = {
    load: async () => stored,
    save: async () => {
      throw new Error('The refold writes through postGamePlays')
    }
  }
  const session = await ScoringSession.open(store, gameId, context)
  const picture = session.picture()
  const byIndex = new Map(
    stored.plays.map(play => [play.about.atBatIndex, play])
  )
  const plays = [...picture.plays.values()].filter(
    play =>
      !isDeepStrictEqual(
        comparablePlay(play),
        comparablePlay(byIndex.get(play.about.atBatIndex) ?? null)
      )
  )
  const changed = playerChange(stored, plays, picture.current)
  if (changed != null)
    return {
      kind: 'skipped',
      problem: `rebuilding would change who played: ${changed}`
    }
  const currentPlay = !isDeepStrictEqual(
    comparablePlay(picture.current),
    comparablePlay(stored.currentPlay)
  )
  const removed = session.removals
  if (plays.length === 0 && removed.length === 0 && !currentPlay)
    return { kind: 'unchanged' }
  if (!preview)
    await postGamePlays(
      db,
      gameId,
      asPostEventsBody({
        plays,
        source: { system: 'teamstation' },
        mode: 'live',
        remove: removed,
        ...(currentPlay ? { currentPlay: picture.current } : {})
      })
    )
  return {
    kind: 'changed',
    refold: { gameId, plays: plays.length, removed, currentPlay }
  }
}

/** Refolds one game, or every game TeamStation scored. */
export async function refoldScoredGames(
  db: Kysely<Database>,
  options: { gameId?: string; preview?: boolean } = {}
): Promise<RefoldReport | null> {
  const report: RefoldReport = { changed: [], unchanged: [], skipped: [] }
  const games =
    options.gameId == null ? await scoredGames(db) : [options.gameId]
  for (const gameId of games) {
    const done = await refoldGame(db, gameId, options.preview === true)
    if (done.kind === 'missing') return null
    if (done.kind === 'changed') report.changed.push(done.refold)
    else if (done.kind === 'skipped')
      report.skipped.push({ gameId, problem: done.problem })
    else report.unchanged.push(gameId)
  }
  return report
}

/** Runs the command line against `db`, printing to `print`; the exit code. */
export async function runRefold(
  db: Kysely<Database>,
  args: string[],
  print: (line: string) => void
): Promise<number> {
  const previewing = (arg: string): boolean =>
    arg === '--preview' || arg === '--dry-run'
  const preview = args.some(previewing)
  const at = args.indexOf('--game')
  const gameId = at < 0 ? undefined : args[at + 1]
  const known = args.every(
    (arg, i) => previewing(arg) || arg === '--game' || i === at + 1
  )
  if (!known || (at >= 0 && (gameId == null || gameId.startsWith('--')))) {
    print('Usage: npm run refold-scored-games -- [--game <id>] [--preview]')
    return 1
  }
  const report = await refoldScoredGames(db, { gameId, preview })
  if (report == null) {
    print(`no such game: ${gameId}`)
    return 1
  }
  const verb = preview ? 'would write' : 'wrote'
  const removal = (indexes: number[]): string =>
    indexes.length === 0
      ? ''
      : `, ${preview ? 'would remove' : 'removed'} the play` +
        `${indexes.length === 1 ? '' : 's'} at ${indexes.join(', ')}`
  for (const game of report.changed)
    print(
      `changed ${game.gameId}: ${verb} ${game.plays} plays` +
        removal(game.removed) +
        (game.currentPlay ? ', and the at-bat in progress' : '')
    )
  for (const game of report.skipped)
    print(`skipped ${game.gameId}: ${game.problem}`)
  print(
    `${report.changed.length} changed, ${report.unchanged.length} unchanged, ` +
      `${report.skipped.length} skipped${preview ? ' (preview)' : ''}`
  )
  return report.skipped.length > 0 ? 1 : 0
}

async function main(): Promise<void> {
  const db = makeDatabase(serverConfig.databaseUrl)
  try {
    process.exitCode = await runRefold(db, process.argv.slice(2), line => {
      console.log(line)
    })
  } finally {
    await db.destroy()
  }
}

const entry = process.argv[1] ?? ''
if (
  entry.endsWith('/refoldScoredGames.ts') ||
  entry.endsWith('/refoldScoredGames.js')
) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
