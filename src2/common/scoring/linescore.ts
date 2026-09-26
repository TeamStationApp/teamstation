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
      outs: typeof play.about.halfOuts === 'number' ? play.about.halfOuts : 0,
      runs: side == null ? 0 : side - baseline
    }
  })
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

/**
 * `r` is the given total, or 0 when that score is null. `runs` sums to `r`.
 * A side with no half gets `[r]`. Hits and errors stay null when the plays
 * cannot say.
 */
export function lineScore(
  plays: GumboPlay[],
  halves: HalfOutcome[],
  awayScore: number | null,
  homeScore: number | null
): { away: LineScoreSide; home: LineScoreSide } {
  const counted = hitsAndErrors(
    plays.map(play => ({
      halfInning:
        play.about.halfInning === 'top' || play.about.halfInning === 'bottom'
          ? play.about.halfInning
          : null,
      eventType: play.result.eventType,
      errorCredits: errorCredits(play)
    }))
  )
  return {
    away: side('top', halves, awayScore ?? 0, counted, 'away'),
    home: side('bottom', halves, homeScore ?? 0, counted, 'home')
  }
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
