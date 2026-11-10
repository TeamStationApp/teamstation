import type { Kysely } from 'kysely'

import { keepsAtBat } from '../../common/scoring/actions'
import { atBatUnderWay } from '../../common/scoring/apply'
import { FINAL_INDEX, replayPlays } from '../../common/scoring/gumbo'
import { inPlay } from '../../common/scoring/rules'
import type { SessionContext, StoredGame } from '../../common/scoring/session'
import { type Database, makeDatabase } from '../db/database'
import { serverConfig } from '../serverConfig'
import { refoldGame } from './refoldScoredGames'

/**
 * Puts back the at-bats a scorer ended the half in by hand on a build that
 * dropped them: the pitches, the runners and the runs of an at-bat under way
 * when the half was ended, which that build threw away while the run stayed
 * on the score, so the game's stats could not be built.
 *
 *   npm run keep-interrupted-at-bats -- --game <id> [--preview]
 *
 * Each `endHalf` that came while an at-bat was under way is marked
 * `keepAtBat`, as the End half button marks one now, and the game is folded
 * again from its log (`refoldGame`). The kept at-bat becomes a play of its
 * own, so every play after it moves up an index, and each is checked against
 * the stored play that moved there (`movedBy`): any other change of who
 * played skips the game. An `endHalf` taken between at-bats, or one already
 * marked, is left. `--preview` writes nothing.
 */

/** Where an action sits in a stored game: its record's play and its place. */
export interface ActionAt {
  /** The record's play, by its index; the at-bat in progress's own. */
  atBatIndex: number
  /** The action's place in that record's `actions`. */
  position: number
}

/**
 * Each end of the half the game's log takes while an at-bat is under way and
 * nothing is left to decide, unmarked: the ones a build that dropped the
 * at-bat wrote. One taken on a ball in play still waiting for its result is
 * left: the engine keeps no such at-bat. Null when the log no longer plays.
 */
export function interruptedEndHalves(
  stored: StoredGame,
  context: SessionContext
): ActionAt[] | null {
  const found: ActionAt[] = []
  const positions = new Map<number, number>()
  const replayed = replayPlays(
    stored,
    context,
    (_state, atBatIndex, _time, action, before) => {
      const position = positions.get(atBatIndex) ?? 0
      positions.set(atBatIndex, position + 1)
      const play = before.liveData.plays.currentPlay
      // A ball in play still waiting for its result cannot be kept: the
      // engine refuses to end the half on one, so it stays dropped.
      if (
        action.type === 'gameFlow' &&
        action.kind === 'endHalf' &&
        !keepsAtBat(action) &&
        before.pending == null &&
        play != null &&
        atBatUnderWay(play) &&
        !inPlay(play)
      )
        found.push({ atBatIndex, position })
    }
  )
  return replayed.problems.length > 0 ? null : found
}

/** `stored` with the end of the half at each of `ends` marked `keepAtBat`. */
export function keepingAtBats(
  stored: StoredGame,
  ends: readonly ActionAt[]
): StoredGame {
  const copy = JSON.parse(JSON.stringify(stored)) as StoredGame
  const documents = [...copy.plays, copy.currentPlay]
  for (const { atBatIndex, position } of ends) {
    // The at-bat in progress shares its index with a play an undo reopened:
    // its record is the one replayed.
    const document =
      copy.currentPlay?.about.atBatIndex === atBatIndex
        ? copy.currentPlay
        : documents.find(play => play?.about.atBatIndex === atBatIndex)
    const actions = (
      document as { teamStation?: { actions?: unknown[] } } | null | undefined
    )?.teamStation?.actions
    const action = actions?.[position]
    if (action == null || typeof action !== 'object')
      throw new Error(
        `No action ${position} in the record of play ${atBatIndex}`
      )
    actions![position] = { ...action, keepAtBat: true }
  }
  return copy
}

/**
 * Where each stored play's index goes once the at-bats at `ends` are kept:
 * each is put back as a play of its own at its record's index, so that play
 * and every one after it move up one for each kept at-bat at or before it.
 * The final score stays at its own.
 */
export function movedBy(ends: readonly ActionAt[]): (index: number) => number {
  return index =>
    index === FINAL_INDEX
      ? index
      : index + ends.filter(end => end.atBatIndex <= index).length
}

/** Runs the command line against `db`, printing to `print`; the exit code. */
export async function runKeep(
  db: Kysely<Database>,
  args: string[],
  print: (line: string) => void
): Promise<number> {
  const preview = args.includes('--preview')
  const at = args.indexOf('--game')
  const gameId = at < 0 ? undefined : args[at + 1]
  const known = args.every(
    (arg, i) => arg === '--preview' || arg === '--game' || i === at + 1
  )
  if (!known || gameId == null || gameId.startsWith('--')) {
    print('Usage: npm run keep-interrupted-at-bats -- --game <id> [--preview]')
    return 1
  }
  let kept: ActionAt[] = []
  let unread = false
  const done = await refoldGame(db, gameId, preview, {
    edit: (stored, context) => {
      const ends = interruptedEndHalves(stored, context)
      if (ends == null) {
        unread = true
        return null
      }
      kept = ends
      if (ends.length === 0) return null
      return { stored: keepingAtBats(stored, ends), moved: movedBy(ends) }
    }
  })
  if (done.kind === 'missing') {
    print(`no such game: ${gameId}`)
    return 1
  }
  if (unread) {
    print(`skipped ${gameId}: its log no longer plays`)
    return 1
  }
  if (done.kind === 'skipped') {
    print(`skipped ${gameId}: ${done.problem}`)
    return 1
  }
  if (kept.length === 0) {
    print(`${gameId}: no at-bat was ended by hand under way`)
    return 0
  }
  const verb = preview ? 'would keep' : 'kept'
  for (const end of kept)
    print(
      `${verb} the at-bat the half was ended in, action ${end.position} of play ${end.atBatIndex}'s record`
    )
  if (done.kind === 'changed') {
    const { refold } = done
    print(
      `${preview ? 'would write' : 'wrote'} ${refold.plays} plays` +
        (refold.removed.length === 0
          ? ''
          : `, ${preview ? 'would remove' : 'removed'} ${refold.removed.join(', ')}`) +
        (refold.currentPlay ? ', and the at-bat in progress' : '') +
        (preview ? ' (preview)' : '')
    )
  }
  return 0
}

async function main(): Promise<void> {
  const db = makeDatabase(serverConfig.databaseUrl)
  try {
    process.exitCode = await runKeep(db, process.argv.slice(2), line => {
      console.log(line)
    })
  } finally {
    await db.destroy()
  }
}

const entry = process.argv[1] ?? ''
if (
  entry.endsWith('/keepInterruptedAtBats.ts') ||
  entry.endsWith('/keepInterruptedAtBats.js')
) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
