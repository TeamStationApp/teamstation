import type { GumboPlay } from '../gumboPlay'
import type { BoardLine, BoardLineSide } from './boardLineTypes'
import { halfOutcomes, lineScore } from './linescore'
import type { GameState, Side } from './state'

export type { BoardLine, BoardLineSide }

/** The line no play has added to: 0 runs, 0 hits, 0 errors, no innings. */
export const ZERO_LINE: BoardLine = {
  away: { innings: [], r: 0, h: 0, e: 0 },
  home: { innings: [], r: 0, h: 0, e: 0 }
}

/**
 * The line score after the actions the state has applied: each half's runs
 * from the last play of the half, the half in progress from the side's runs
 * less its earlier halves, and the totals the engine keeps. The plays a game
 * holds are the completed ones; the one being played is not among them.
 */
export function boardLineOf(state: GameState): BoardLine {
  const { linescore, plays } = state.liveData
  // Each half's last completed play: its scores close the half.
  const last = new Map<string, { index: number; away: number; home: number }>()
  for (const play of plays.allPlays) {
    const key = `${play.about.inning}:${play.about.halfInning}`
    const held = last.get(key)
    if (held == null || play.about.atBatIndex > held.index)
      last.set(key, {
        index: play.about.atBatIndex,
        away: play.result.awayScore,
        home: play.result.homeScore
      })
  }
  const current = linescore.currentInning
  const currentHalf = linescore.isTopInning ? 'top' : 'bottom'
  let innings = current
  for (const key of last.keys())
    innings = Math.max(innings, Number(key.split(':')[0]))
  const side = (which: Side): BoardLineSide => {
    const half = which === 'away' ? 'top' : 'bottom'
    const runs: Array<number | null> = []
    let before = 0
    for (let inning = 1; inning <= innings; inning++) {
      // A finished game has no half in progress: a home side that did not
      // bat in the last inning has no runs there at all.
      const inProgress =
        !state.final && inning === current && half === currentHalf
      const closed = last.get(`${inning}:${half}`)
      if (inProgress) {
        runs.push(linescore.teams[which].runs - before)
        before = linescore.teams[which].runs
      } else if (closed != null) {
        const total = which === 'away' ? closed.away : closed.home
        runs.push(total - before)
        before = total
      } else if (
        inning < current ||
        (inning === current && half === 'top' && currentHalf === 'bottom')
      ) {
        // A half that has gone by without a completed play of its own: none
        // scored in it.
        runs.push(0)
      } else runs.push(null)
    }
    const totals = linescore.teams[which]
    return {
      innings: runs,
      r: totals.runs,
      h: totals.hits,
      e: totals.errors
    }
  }
  const away = side('away')
  const home = side('home')
  // A finished game shows no inning it ended before anybody batted in.
  if (state.final)
    while (
      away.innings.length > 0 &&
      away.innings.at(-1) == null &&
      home.innings.at(-1) == null
    ) {
      away.innings.pop()
      home.innings.pop()
    }
  return { away, home }
}

/**
 * The line score of plays imported before TeamStation scored any, after the
 * last of `plays`: inning by inning from their halves, and the totals from
 * the last score they carry. Hits and errors are null when the plays cannot
 * say.
 */
export function boardLineOfPlays(plays: GumboPlay[]): BoardLine {
  let away: number | null = null
  let home: number | null = null
  for (const play of plays) {
    away = play.result.awayScore ?? away
    home = play.result.homeScore ?? home
  }
  const line = lineScore(plays, halfOutcomes(plays), away, home)
  const innings = Math.max(0, ...line.innings.map(inning => inning.num))
  const side = (which: Side): BoardLineSide => {
    const runs: Array<number | null> = []
    for (let num = 1; num <= innings; num++) {
      const inning = line.innings.find(one => one.num === num)
      runs.push(inning?.[which].runs ?? null)
    }
    const totals = line[which]
    return { innings: runs, r: totals.r, h: totals.h, e: totals.e }
  }
  return { away: side('away'), home: side('home') }
}
