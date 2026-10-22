import type { SeasonContext } from './context'
import type { GamePoint, Supply } from './slots'

/** The terms of a score, in the order the true ranking compares them. */
export const UNPLACED = 0
export const DOUBLEHEADERS = 1
export const TIME_OF_DAY = 2
export const SPACING = 3
export const WEEKDAY = 4
export const SCARCITY = 5
export const TERMS = 6

/** The true ranking: every term, most important first. */
export const TRUE_ORDER: readonly number[] = [
  UNPLACED,
  DOUBLEHEADERS,
  TIME_OF_DAY,
  SPACING,
  WEEKDAY,
  SCARCITY
]

/** Scores closer than this are equal, so rounding never decides a move. */
const EPSILON = 1e-9

/**
 * Compares two scores term by term in the given order, lower first: below
 * zero when `a` is better, above when `b` is, zero when they tie.
 */
export function compareScores(
  a: readonly number[],
  b: readonly number[],
  order: readonly number[] = TRUE_ORDER
): number {
  for (const term of order) {
    const difference = a[term] - b[term]
    if (difference < -EPSILON) return -1
    if (difference > EPSILON) return 1
  }
  return 0
}

/** The first of several comparisons that isn't a tie, for sorting by several keys. */
export function firstNonZero(...differences: number[]): number {
  for (const difference of differences) if (difference !== 0) return difference
  return 0
}

/** Two scores added term by term. */
export function addScores(
  a: readonly number[],
  b: readonly number[]
): number[] {
  return a.map((value, i) => value + b[i])
}

/** How far a team's mix of games is from the mix of the season's field time. */
export function mixDeviation(
  counts: readonly number[],
  games: number,
  supply: readonly number[],
  supplyGames: number
): number {
  if (games === 0 || supplyGames === 0) return 0
  let deviation = 0
  for (let i = 0; i < counts.length; i++)
    deviation += Math.abs(counts[i] / games - supply[i] / supplyGames)
  return deviation
}

/** What a team's games in one season add up to, for the score. */
export class TeamTally {
  games = 0
  readonly timeOfDay = [0, 0, 0]
  readonly weekdays = [0, 0, 0, 0, 0, 0, 0]
  /** The days of its games, sorted, a day once per game. */
  readonly days: number[] = []
  /** Games beyond the first on any day. */
  doubleheaders = 0
  private cached: number[] | null = null

  constructor(
    /** Its games between the first and last day once all are placed. */
    readonly planned: number,
    /** The first and last day the season can still get games. */
    readonly firstDay: number,
    readonly lastDay: number
  ) {}

  /** Its game days from the first day to the last; earlier games can't move. */
  spanDays(): number[] {
    return this.days.filter(day => day >= this.firstDay && day <= this.lastDay)
  }

  add(point: GamePoint): void {
    const at = lowerBound(this.days, point.day)
    if (this.days[at] === point.day) this.doubleheaders++
    this.days.splice(at, 0, point.day)
    this.games++
    this.timeOfDay[point.timeOfDay]++
    this.weekdays[point.weekday]++
    this.cached = null
  }

  remove(point: GamePoint): void {
    const at = lowerBound(this.days, point.day)
    this.days.splice(at, 1)
    if (this.days[at] === point.day) this.doubleheaders--
    this.games--
    this.timeOfDay[point.timeOfDay]--
    this.weekdays[point.weekday]--
    this.cached = null
  }

  /** Its games inside the season's open days on a day next to another of its game days. */
  backToBack(days = this.spanDays()): number {
    let count = 0
    for (let i = 0; i < days.length; i++) {
      const day = days[i]
      let j = i
      while (j > 0 && days[j - 1] === day) j--
      let k = i
      while (k < days.length - 1 && days[k + 1] === day) k++
      if (days[j - 1] === day - 1 || days[k + 1] === day + 1) count++
    }
    return count
  }

  /** The gaps between its game days, the season's first and last day included. */
  gaps(): number[] {
    const days = this.spanDays()
    if (days.length === 0) return []
    const gaps: number[] = []
    if (days[0] > this.firstDay) gaps.push(days[0] - this.firstDay)
    for (let i = 1; i < days.length; i++)
      if (days[i] !== days[i - 1]) gaps.push(days[i] - days[i - 1])
    const last = days[days.length - 1]
    if (this.lastDay > last) gaps.push(this.lastDay - last)
    return gaps
  }

  /**
   * How unevenly its games spread over the season: the days from the first
   * to the last are cut into as many equal slices as it has games, and each
   * slice holding other than one game counts the difference. Games bunched
   * at the start leave the later slices empty, so they score worse.
   */
  unevenness(days = this.spanDays()): number {
    if (this.planned === 0) return days.length
    const span = this.lastDay - this.firstDay + 1
    const counts = new Array<number>(this.planned).fill(0)
    for (const day of days)
      counts[
        Math.min(
          this.planned - 1,
          Math.floor(((day - this.firstDay) * this.planned) / span)
        )
      ]++
    let penalty = 0
    for (const count of counts) penalty += Math.abs(count - 1)
    return penalty
  }

  /** Spacing: a point for each game on back-to-back days, plus the unevenness. */
  spacing(): number {
    const days = this.spanDays()
    return this.backToBack(days) + this.unevenness(days)
  }

  /** Its doubleheader, time-of-day, spacing and weekday terms. */
  terms(supply: Supply): number[] {
    this.cached ??= [
      this.doubleheaders,
      mixDeviation(this.timeOfDay, this.games, supply.timeOfDay, supply.games),
      this.spacing(),
      mixDeviation(this.weekdays, this.games, supply.weekdays, supply.games)
    ]
    return this.cached
  }
}

function lowerBound(sorted: readonly number[], value: number): number {
  let low = 0
  let high = sorted.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (sorted[mid] < value) low = mid + 1
    else high = mid
  }
  return low
}

/**
 * The score of one season's schedule, kept up to date as games are placed,
 * moved and taken back. Fixed games count from the start.
 */
export class SeasonLedger {
  readonly tallies = new Map<string, TeamTally>()
  placed = 0
  scarcity = 0

  constructor(
    readonly season: SeasonContext,
    /** The games the run must place in this season. */
    readonly games: number,
    /**
     * Each team's games from the season's first open day to its last once
     * all are placed, fixed ones included.
     */
    planned: Map<string, number>
  ) {
    for (const team of season.teams)
      this.tallies.set(
        team,
        new TeamTally(planned.get(team) ?? 0, season.firstDay, season.lastDay)
      )
    for (const { game, point } of season.fixed) {
      this.tallies.get(game.homeTeamId)?.add(point)
      this.tallies.get(game.awayTeamId)?.add(point)
    }
  }

  /** Counts a placed game at a point, on a field of the given scarcity. */
  add(
    homeTeamId: string,
    awayTeamId: string,
    point: GamePoint,
    scarcity: number
  ): void {
    this.tallies.get(homeTeamId)?.add(point)
    this.tallies.get(awayTeamId)?.add(point)
    this.placed++
    this.scarcity += scarcity
  }

  remove(
    homeTeamId: string,
    awayTeamId: string,
    point: GamePoint,
    scarcity: number
  ): void {
    this.tallies.get(homeTeamId)?.remove(point)
    this.tallies.get(awayTeamId)?.remove(point)
    this.placed--
    this.scarcity -= scarcity
  }

  /** The season's score, in TRUE_ORDER's term positions. */
  score(): number[] {
    const counted = this.season.season.settings.doubleheaders === 'ifNecessary'
    let doubleheaders = 0
    let timeOfDay = 0
    let spacing = 0
    let weekday = 0
    for (const tally of this.tallies.values()) {
      const terms = tally.terms(this.season.supply)
      if (counted) doubleheaders += terms[0]
      timeOfDay += terms[1]
      spacing += terms[2]
      weekday += terms[3]
    }
    return [
      this.games - this.placed,
      doubleheaders,
      timeOfDay,
      spacing,
      weekday,
      this.scarcity
    ]
  }
}
