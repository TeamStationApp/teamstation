import type { GumboPlay } from '../gumboPlay'
import { hitsAndErrors } from './hitsAndErrors'

export { hitsAndErrors }

/**
 * A game's halves and its line score, worked out from its Gumbo documents.
 * Each value is read from the same place in the document that the `events`
 * table generates its columns from, so the server, which holds rows, and the
 * scoring screen, which holds documents, get the same answer. A play still in
 * progress is never among the documents given.
 */

export interface HalfOutcome {
  inning: number
  half: 'top' | 'bottom'
  awayScore: number | null
  homeScore: number | null
  outs: number
  runs: number
}

/**
 * `about.halfOuts` on the last play of a half is what the halves read. A value
 * already on that play stays. An Inning Ended marker in the half supplies the
 * outs. Otherwise the last play's own `count.outs` is copied.
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
    if (last.about.halfOuts != null) continue
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
 * One outcome per half that has a play. A play with no half is left out. A
 * half whose last play carries no score for the side at bat scores no runs,
 * rather than the negative of everything before it.
 */
export function halfOutcomes(plays: GumboPlay[]): HalfOutcome[] {
  const byHalf = new Map<string, GumboPlay>()
  for (const play of plays) {
    const inning = play.about.inning
    const half = play.about.halfInning
    if (inning == null) continue
    if (half !== 'top' && half !== 'bottom') continue
    const key = `${inning}:${half}`
    const previous = byHalf.get(key)
    if (previous == null || play.about.atBatIndex > previous.about.atBatIndex)
      byHalf.set(key, play)
  }
  const ordered = [...byHalf.values()].sort((a, b) => {
    const inning = (a.about.inning ?? 0) - (b.about.inning ?? 0)
    if (inning !== 0) return inning
    const aTop = a.about.halfInning === 'top' ? 0 : 1
    const bTop = b.about.halfInning === 'top' ? 0 : 1
    return aTop - bTop
  })
  let previousAway = 0
  let previousHome = 0
  return ordered.map(play => {
    const half = play.about.halfInning === 'bottom' ? 'bottom' : 'top'
    const baseline = half === 'top' ? previousAway : previousHome
    const awayScore = play.result.awayScore ?? null
    const homeScore = play.result.homeScore ?? null
    const side = half === 'top' ? awayScore : homeScore
    previousAway = awayScore ?? previousAway
    previousHome = homeScore ?? previousHome
    return {
      inning: play.about.inning ?? 0,
      half,
      awayScore,
      homeScore,
      outs: halfOutsOf(play),
      runs: side == null ? 0 : side - baseline
    }
  })
}

/**
 * The outs a half ended with: the server's `about.halfOuts` when its last play
 * has one, else that play's own `count.outs`, else 0.
 */
function halfOutsOf(play: GumboPlay): number {
  if (typeof play.about.halfOuts === 'number') return play.about.halfOuts
  const outs = play.count?.outs
  return typeof outs === 'number' ? outs : 0
}

export interface LineScoreSide {
  runs: number[]
  r: number
  h: number | null
  e: number | null
  bb: number | null
  k: number | null
  hr: number | null
  hbp: number | null
}

/** One side's figures in one inning, as MLB's `linescore.innings[]` has them. */
export interface InningSide {
  /** Absent for a half that was not played, as MLB leaves it. */
  runs?: number
  hits: number | null
  errors: number | null
  leftOnBase: number | null
}

export interface LineScoreInning {
  num: number
  ordinalNum: string
  home: InningSide
  away: InningSide
}

export interface LineScoreTeam {
  runs: number
  hits: number | null
  errors: number | null
  leftOnBase: number | null
}

export interface LineScore {
  away: LineScoreSide
  home: LineScoreSide
  /** Gumbo's `linescore.innings[]`, beside the totals above. */
  innings: LineScoreInning[]
  /** Gumbo's `linescore.teams`: the same totals, and the runners left. */
  teams: { home: LineScoreTeam; away: LineScoreTeam }
}

/**
 * `r` is the given total, or 0 when that score is null. `runs` sums to `r`.
 * A side with no half gets `[r]`. Hits and errors stay null when the plays
 * cannot say.
 *
 * `innings` and `teams` say the same in Gumbo's shape. An inning's runs are
 * the side's `runs` for that half, so they sum to `r` whenever the side has a
 * half. Hits and errors are counted inning by inning, and are null when the
 * game's are. Runners left on base are counted only for a half TeamStation
 * scored whole (`leftOnBase`), and a side's total is null when any of its
 * innings is, or when there are no innings.
 *
 * An imported game can hold only part of its play-by-play, so its halves do
 * not account for its score. It keeps its totals from the score, and its
 * `innings` from the halves it has: one entry per inning with a half, and no
 * runs for a side that has no half in it. A side's last half takes the runs
 * its halves do not account for, as `runs` always has, so a side's innings
 * still sum to its total whenever it has a half.
 */
export function lineScore(
  plays: GumboPlay[],
  halves: HalfOutcome[],
  awayScore: number | null,
  homeScore: number | null
): LineScore {
  const counted = hitsAndErrors(plays.map(countedPlay))
  const away = side('top', halves, awayScore ?? 0, counted, 'away')
  const home = side('bottom', halves, homeScore ?? 0, counted, 'home')
  const innings = inningsOf(plays, halves, { away, home }, counted.known)
  const team = (which: 'away' | 'home'): LineScoreTeam => {
    const line = which === 'away' ? away : home
    const left = innings.map(inning => inning[which].leftOnBase)
    return {
      runs: line.r,
      hits: line.h,
      errors: line.e,
      // A game with no innings cannot say who was left on.
      leftOnBase:
        left.length === 0 || left.some(value => value == null)
          ? null
          : left.reduce<number>((total, value) => total + (value ?? 0), 0)
    }
  }
  return {
    away,
    home,
    innings,
    teams: { home: team('home'), away: team('away') }
  }
}

function countedPlay(play: GumboPlay): {
  halfInning: 'top' | 'bottom' | null
  eventType: string
  errorCredits: number
} {
  return {
    halfInning:
      play.about.halfInning === 'top' || play.about.halfInning === 'bottom'
        ? play.about.halfInning
        : null,
    eventType: play.result.eventType,
    errorCredits: errorCredits(play)
  }
}

/**
 * One entry per inning that has a half, first inning first. A side's runs in
 * an inning come from its `runs` list, which holds one entry per half it
 * batted, in inning order.
 */
function inningsOf(
  plays: GumboPlay[],
  halves: HalfOutcome[],
  sides: { away: LineScoreSide; home: LineScoreSide },
  known: boolean
): LineScoreInning[] {
  const nums = [...new Set(halves.map(half => half.inning))].sort(
    (a, b) => a - b
  )
  const runsIn = (
    half: 'top' | 'bottom',
    runs: number[]
  ): Map<number, number> =>
    new Map(
      halves
        .filter(item => item.half === half)
        .map((item, index) => [item.inning, runs[index]])
    )
  const awayRuns = runsIn('top', sides.away.runs)
  const homeRuns = runsIn('bottom', sides.home.runs)
  const everyPlayRecorded = plays.every(hasRecord)
  return nums.map(num => {
    const inning = plays.filter(play => play.about.inning === num)
    const counted = hitsAndErrors(inning.map(countedPlay))
    const inningSide = (
      which: 'away' | 'home',
      runs: number | undefined
    ): InningSide => {
      const half = which === 'away' ? 'top' : 'bottom'
      const own = inning.filter(play => play.about.halfInning === half)
      return {
        ...(runs == null ? {} : { runs }),
        hits: known ? counted.hits[which] : null,
        errors: known ? counted.errors[which] : null,
        // A half nobody batted in left nobody on, when the game says so.
        leftOnBase:
          own.length === 0 ? (everyPlayRecorded ? 0 : null) : leftOnBase(own)
      }
    }
    return {
      num,
      ordinalNum: ordinal(num),
      home: inningSide('home', homeRuns.get(num)),
      away: inningSide('away', awayRuns.get(num))
    }
  })
}

const ON_BASE = new Set(['1B', '2B', '3B'])

/**
 * The runners a half left on base: those whose last entry in the half's plays
 * ends on a base, not out.
 *
 * Only a half whose every play carries a `gameStation` record lists every
 * runner, and an override sets the bases without writing an entry, so any
 * other half is null: an imported one, or one with an override.
 */
export function leftOnBase(plays: GumboPlay[]): number | null {
  if (!plays.every(scoredWhole)) return null
  const last = new Map<unknown, { end: unknown; isOut: unknown }>()
  const ordered = [...plays].sort(
    (a, b) => a.about.atBatIndex - b.about.atBatIndex
  )
  for (const play of ordered)
    for (const runner of play.runners ?? []) {
      const person = runner.details?.runner as
        { id?: unknown; fullName?: unknown } | undefined
      const key = person?.id ?? person?.fullName
      if (key == null) continue
      const movement = (runner as { movement?: unknown }).movement
      const { end, isOut } =
        movement != null && typeof movement === 'object'
          ? (movement as { end?: unknown; isOut?: unknown })
          : { end: undefined, isOut: undefined }
      last.set(key, { end, isOut })
    }
  let left = 0
  for (const { end, isOut } of last.values())
    if (typeof end === 'string' && ON_BASE.has(end) && isOut !== true) left += 1
  return left
}

/** A play TeamStation scored, which lists every runner it moved. */
function hasRecord(play: GumboPlay): boolean {
  return play.gameStation != null && typeof play.gameStation === 'object'
}

/** A play TeamStation scored, and whose runners no override set by hand. */
function scoredWhole(play: GumboPlay): boolean {
  if (!hasRecord(play)) return false
  const actions = (play.gameStation as { actions?: unknown }).actions
  if (!Array.isArray(actions)) return true
  return !actions.some(
    action =>
      action != null &&
      typeof action === 'object' &&
      (action as { type?: unknown }).type === 'gameFlow' &&
      (action as { kind?: unknown }).kind === 'override'
  )
}

/** `1st`, `2nd`, `3rd`, `4th` … `11th`, `12th`, `13th` … `21st`. */
export function ordinal(num: number): string {
  const tens = num % 100
  if (tens >= 11 && tens <= 13) return `${num}th`
  const suffix = ['th', 'st', 'nd', 'rd'][num % 10] ?? 'th'
  return `${num}${suffix}`
}

const ERROR_CREDITS = new Set(['f_fielding_error', 'f_throwing_error'])

/** The fielding and throwing errors credited on a play's runners. */
export function errorCredits(play: GumboPlay): number {
  let count = 0
  for (const runner of play.runners ?? []) {
    const credits = (runner as { credits?: unknown }).credits
    if (!Array.isArray(credits)) continue
    for (const credit of credits as unknown[])
      if (
        credit != null &&
        typeof credit === 'object' &&
        ERROR_CREDITS.has(String((credit as { credit?: unknown }).credit))
      )
        count += 1
  }
  return count
}

function side(
  half: 'top' | 'bottom',
  halves: HalfOutcome[],
  r: number,
  counted: ReturnType<typeof hitsAndErrors>,
  which: 'away' | 'home'
): LineScoreSide {
  const mine = halves.filter(item => item.half === half)
  const runs = mine.length === 0 ? [r] : mine.map(item => item.runs)
  if (mine.length > 0) {
    const sum = runs.reduce((total, value) => total + value, 0)
    const last = runs.length - 1
    runs[last] = runs[last] + (r - sum)
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
