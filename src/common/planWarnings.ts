import {
  type GamePlan,
  type GamePlanRow,
  OUTFIELD_POSITIONS,
  type PlanCell,
  plannedInnings,
  planPlayerKey,
  type PlanRowCounts,
  planRowCounts
} from './gamePlan'
import {
  type InningDeadline,
  type PlayingTimeRuleKey,
  type PlayingTimeRules,
  ruleRowEnabled
} from './playingTimeRules'
import { isPosition, type Position, POSITIONS } from './scoring/state'

/**
 * Playing-time warnings for a game plan. Like the rest of src/common, which
 * never reads the app's string tables, their text is plain English here.
 */

export interface PlanWarning {
  rule: PlayingTimeRuleKey | 'duplicatePosition'
  level: 'yellow' | 'red'
  message: string
  /** The rows it names, by `fullName`, in batting order. */
  players: string[]
}

/**
 * The team's earlier plans this season, by `planPlayerKey`: each player's
 * innings at each field position and his sits (as `planRowCounts` counts
 * them), the previous game's leadoff and each player's sits in that game.
 */
export interface PlanHistory {
  players: Record<string, PlanRowCounts>
  lastLeadoff: string | null
  lastGameSits: Record<string, number>
}

/**
 * The team's other games' plans on this game's date, by `planPlayerKey`,
 * split at this game: catching in a game that starts before it can block
 * pitching here, and catching here can block a pitch in a game that starts
 * after it.
 */
export interface PlanSameDay {
  /** The games that start before this one. */
  before: {
    /** Innings each player catches in them. */
    catcherInnings: Record<string, number>
    /** Whether he catches the fourth inning of any of them. */
    caughtFourth: Record<string, boolean>
  }
  /** Whether each player pitches in a game that starts after this one. */
  laterPitched: Record<string, boolean>
}

export const EMPTY_PLAN_HISTORY: PlanHistory = {
  players: {},
  lastLeadoff: null,
  lastGameSits: {}
}
export const EMPTY_PLAN_SAME_DAY: PlanSameDay = {
  before: { catcherInnings: {}, caughtFourth: {} },
  laterPitched: {}
}

export interface PlanWarningsInput {
  plan: GamePlan
  /** Null when the team plays by no rules: only duplicates warn. */
  rules: PlayingTimeRules | null
  /**
   * The innings the game has reached: its current one while it is in
   * progress, its last once it is final.
   */
  playedInnings?: number
  /** Whether the game is final: only a final game can be shortened. */
  final?: boolean
  history: PlanHistory
  sameDay: PlanSameDay
}

type Level = PlanWarning['level']
type Finding = Omit<PlanWarning, 'players'> & { player: string }
/**
 * A cell as the warnings judge it: its value in a planned inning, where a
 * blank is a sit, and null, still open, in an inning not planned yet.
 */
type Judged = PlanCell | null
type JudgedRow = Omit<GamePlanRow, 'cells'> & { cells: Judged[]; key: string }

const plural = (count: number, word: string): string =>
  `${count} ${count === 1 ? word : `${word}s`}`
const ordinal = (count: number): string => (count === 2 ? 'second' : 'third')

/**
 * Where a minimum stands for one player: met, still reachable with the
 * innings inside its window not planned yet (yellow), or out of reach of
 * the planned ones (red).
 */
function minimum(
  cells: readonly Judged[],
  counts: (cell: Judged) => boolean,
  required: number
): Level | null {
  const met = cells.filter(counts).length
  if (met >= required) return null
  const open = cells.filter(unplanned).length
  return met + open >= required ? 'yellow' : 'red'
}

/** The longest run of consecutive cells `counts` accepts. */
function longestRun(
  cells: readonly Judged[],
  counts: (cell: Judged) => boolean
): number {
  let longest = 0
  let run = 0
  for (const cell of cells) {
    run = counts(cell) ? run + 1 : 0
    longest = Math.max(longest, run)
  }
  return longest
}

const fielded = (cell: Judged): boolean => isPosition(cell)
const sits = (cell: Judged): boolean => cell === ''
const unplanned = (cell: Judged): boolean => cell == null
const outfield = (cell: Judged): boolean =>
  OUTFIELD_POSITIONS.includes(cell as (typeof OUTFIELD_POSITIONS)[number])

/**
 * The first inning (from 0) of `cells` a player may no longer pitch in,
 * having caught `caughtBefore` innings in the day's earlier games (and
 * their fourth inning, when `fourthBefore`): 0 when they already block him,
 * the inning after the one that blocks him here (`cells.length` when it is
 * this game's last), or null when he may still pitch at its end. With
 * `fourth`, catching a fourth inning blocks him as 4 innings do.
 */
function pitchingBlockedFrom(
  cells: readonly Judged[],
  caughtBefore: number,
  fourthBefore: boolean,
  fourth: boolean
): number | null {
  if (caughtBefore >= 4 || fourthBefore) return 0
  let caught = caughtBefore
  for (let inning = 0; inning < cells.length; inning++) {
    if (cells[inning] !== 'C') continue
    caught++
    if (caught >= 4 || (fourth && inning === 3)) return inning + 1
  }
  return null
}

/**
 * The plan's warnings under `rules`, reds first. Only the planned innings
 * are judged (those whose column holds a field position): a blank in one is
 * a sit, and an inning not planned yet holds no sit and no position. Red
 * means the planned innings break an enabled rule whatever the others
 * become; yellow means a minimum is not met yet but the innings inside its
 * deadline not planned yet could still meet it. The season-tracking rules
 * only ever warn yellow.
 */
export function planWarnings(input: PlanWarningsInput): PlanWarning[] {
  const { plan, rules, history, sameDay } = input
  const shortened =
    input.final === true &&
    input.playedInnings != null &&
    input.playedInnings < plan.innings
  // A shortened game is judged on the innings it played.
  const length = shortened ? (input.playedInnings ?? 0) : plan.innings
  const planned = plannedInnings(plan)
  const rows: JudgedRow[] = plan.rows.map(row => ({
    ...row,
    cells: row.cells
      .slice(0, length)
      .map((cell, inning) => (planned[inning] ? cell : null)),
    key: planPlayerKey(row.player)
  }))
  const findings: Finding[] = []
  const warn = (
    rule: Finding['rule'],
    level: Level | null,
    message: string,
    row: Pick<GamePlanRow, 'player'>
  ): void => {
    if (level != null)
      findings.push({ rule, level, message, player: row.player.fullName })
  }

  for (let inning = 0; inning < length; inning++) {
    for (const position of POSITIONS) {
      const at = rows.filter(row => row.cells[inning] === position)
      if (at.length < 2) continue
      for (const row of at)
        warn(
          'duplicatePosition',
          'red',
          `Two players at ${position} in inning ${inning + 1}`,
          row
        )
    }
  }
  if (rules == null) return grouped(findings)

  const on = (key: PlayingTimeRuleKey): boolean =>
    rules[key] === true && ruleRowEnabled(rules, key)
  const until = (deadline: InningDeadline): number =>
    deadline === 'end' ? length : Math.min(deadline, length)
  const by = (deadline: InningDeadline): string =>
    until(deadline) < length ? `by inning ${until(deadline)}` : 'this game'
  const size = rows.length
  const battery = new Set(
    rows
      .filter(row => row.cells[0] === 'P' || row.cells[0] === 'C')
      .map(row => row.key)
  )
  const minimumExempt = (row: { key: string }): boolean =>
    rules.startingBatteryExemptFromMinimums && battery.has(row.key)
  const sittingExempt = (row: { key: string }): boolean =>
    rules.startingBatteryExemptFromSitting && battery.has(row.key)
  const catcherInfield =
    rules.catcherCountsAsInfield === 'always' ||
    (rules.catcherCountsAsInfield === 'largeRoster' && size > 12)
  const infieldSet = new Set<string>(
    rules.infieldPositions.filter(
      position => position !== 'C' || catcherInfield
    )
  )
  const infield = (cell: Judged): boolean =>
    cell != null && infieldSet.has(cell)

  // A player who bats in any inning meets Mandatory Play's at-bat; one who
  // sits every inning has fielded none, which the outs already refuse.
  if (
    on('mandatoryPlay') &&
    !(shortened && rules.applyInShortenedGames === 'never')
  ) {
    const outs =
      rules.reducedForLargeRosters && size >= rules.largeRosterPlayers
        ? rules.largeRosterOuts
        : rules.defensiveOutsRequired
    const consecutive = rules.mustBeConsecutive ? ' consecutive' : ''
    const local = shortened && rules.applyInShortenedGames === 'localOption'
    for (const row of rows) {
      const level = rules.mustBeConsecutive
        ? longestRun(row.cells, fielded) >= outs / 3
          ? null
          : longestRun(row.cells, cell => fielded(cell) || unplanned(cell)) >=
              outs / 3
            ? 'yellow'
            : 'red'
        : minimum(row.cells, fielded, outs / 3)
      warn(
        'mandatoryPlay',
        local && level === 'red' ? 'yellow' : level,
        level === 'red'
          ? `Cannot reach ${outs}${consecutive} defensive outs`
          : `Not yet ${outs}${consecutive} defensive outs`,
        row
      )
    }
  }

  if (on('stricterMinimumInnings')) {
    const required = rules.minimumFullInnings
    const deadline = rules.minimumInningsBy
    for (const row of rows) {
      const level = minimum(
        row.cells.slice(0, until(deadline)),
        fielded,
        required
      )
      warn(
        'stricterMinimumInnings',
        level,
        `${level === 'red' ? 'Cannot field' : 'Not yet'} ${plural(required, 'inning')} ${by(deadline)}`,
        row
      )
    }
  }

  const minimums = [
    {
      rule: 'requireMinimumInfield',
      counts: infield,
      required: rules.infieldInningsRequired,
      deadline: rules.infieldBy,
      what: 'infield inning'
    },
    {
      rule: 'requireMinimumOutfield',
      counts: outfield,
      required: rules.outfieldInningsRequired,
      deadline: rules.outfieldBy,
      what: 'outfield inning'
    }
  ] as const
  for (const { rule, counts, required, deadline, what } of minimums) {
    if (!on(rule)) continue
    for (const row of rows) {
      if (minimumExempt(row)) continue
      const level = minimum(
        row.cells.slice(0, until(deadline)),
        counts,
        required
      )
      warn(
        rule,
        level,
        `${level === 'red' ? 'Cannot play' : 'Not yet'} ${plural(required, what)} ${by(deadline)}`,
        row
      )
    }
  }

  if (on('enforceSittingLimits')) {
    const sitters = rows.filter(row => !sittingExempt(row))
    if (on('noConsecutiveSits'))
      for (const row of sitters)
        warn(
          'noConsecutiveSits',
          longestRun(row.cells, sits) >= 2 ? 'red' : null,
          'Sits two innings in a row',
          row
        )
    const max = rules.maxSitsPerGame
    for (const row of sitters)
      warn(
        'maxSitsPerGame',
        row.cells.filter(sits).length > max ? 'red' : null,
        `More than ${plural(max, 'sit')}`,
        row
      )
    if (rules.equalSittingOrder !== 'off') {
      // A sit past `before` waits until every other player has sat `before`
      // times, counting the innings up to and including this one.
      const before = rules.equalSittingOrder === 'secondAfterAll' ? 1 : 2
      for (const row of sitters) {
        const inning = row.cells
          .map((cell, at) => (sits(cell) ? at : -1))
          .filter(at => at >= 0)[before]
        if (inning == null) continue
        const upTo = (
          other: JudgedRow,
          counts: (cell: Judged) => boolean
        ): number => other.cells.slice(0, inning + 1).filter(counts).length
        const others = sitters.filter(other => other !== row)
        const level = others.every(other => upTo(other, sits) >= before)
          ? null
          : others.every(
                other =>
                  upTo(other, cell => sits(cell) || unplanned(cell)) >= before
              )
            ? 'yellow'
            : 'red'
        warn(
          'equalSittingOrder',
          level,
          level === 'red'
            ? `Sits a ${ordinal(before + 1)} time before everyone has sat${before === 2 ? ' twice' : ''}`
            : `Sits a ${ordinal(before + 1)} time before everyone has ${before === 2 ? 'two planned sits' : 'a planned sit'}`,
          row
        )
      }
    }
  }

  if (
    on('limitInningsAtPosition') &&
    rules.maxInningsPerPosition !== 'unlimited'
  ) {
    const max = rules.maxInningsPerPosition
    for (const row of rows)
      warn(
        'maxInningsPerPosition',
        POSITIONS.some(
          position => row.cells.filter(cell => cell === position).length > max
        )
          ? 'red'
          : null,
        `More than ${plural(max, 'inning')} at one position`,
        row
      )
  }

  if (on('limitInningsAtPosition') && rules.rotateEvery > 0) {
    const most = rules.rotateEvery
    for (const row of rows)
      warn(
        'rotateEvery',
        POSITIONS.some(
          position => longestRun(row.cells, cell => cell === position) > most
        )
          ? 'red'
          : null,
        `Same position more than ${plural(most, 'inning')} in a row`,
        row
      )
  }

  if (on('mustPlayInfieldAndOutfield')) {
    for (const row of rows) {
      if (minimumExempt(row)) continue
      const missing =
        (row.cells.some(infield) ? 0 : 1) + (row.cells.some(outfield) ? 0 : 1)
      const open = row.cells.filter(unplanned).length
      const level = missing === 0 ? null : open >= missing ? 'yellow' : 'red'
      warn(
        'mustPlayInfieldAndOutfield',
        level,
        `${level === 'red' ? 'Cannot play' : 'Not yet played'} both infield and outfield`,
        row
      )
    }
  }

  if (on('catcherInningLimit')) {
    const max = rules.catcherMaxInnings
    for (const row of rows)
      warn(
        'catcherInningLimit',
        row.cells.filter(cell => cell === 'C').length > max ? 'red' : null,
        `Catches more than ${plural(max, 'inning')}`,
        row
      )
  }

  // After 4 innings catching, no pitching that calendar day: only catching
  // that comes before a pitch blocks it.
  if (on('catcherBlocksPitching')) {
    const fourth = on('catcherBlocksIfCatchesFourth')
    const day = fourth
      ? 'after 4 innings, or the 4th inning, at catcher today'
      : 'after 4 innings at catcher today'
    for (const row of rows) {
      const from = pitchingBlockedFrom(
        row.cells,
        sameDay.before.catcherInnings[row.key] ?? 0,
        fourth && sameDay.before.caughtFourth[row.key],
        fourth
      )
      warn(
        'catcherBlocksPitching',
        from != null && row.cells.slice(from).includes('P') ? 'red' : null,
        `Pitches ${day}`,
        row
      )
      // Blocked by this game's catching, he may not pitch in a later game.
      warn(
        'catcherBlocksPitching',
        from != null && from > 0 && sameDay.laterPitched[row.key]
          ? 'red'
          : null,
        `Pitches in a later game ${day}`,
        row
      )
    }
  }

  // Continuous Batting, Late Arrivals and Departures govern how the
  // scorekeeper's order behaves. A plan lists every present player in
  // batting order, so it cannot break them.

  if (on('trackSeasonInfieldBalance')) {
    // Infield is the minimum's set, applied to the season's innings too.
    const shares = rows.map(row => {
      const past = history.players[row.key]
      const now = planRowCounts(
        row.cells.map(cell => cell ?? ''),
        planned
      )
      const innings = (positions: readonly Position[]): number =>
        positions.reduce(
          (sum, position) =>
            sum + now.positions[position] + (past?.positions[position] ?? 0),
          0
        )
      const fieldedInnings = innings(POSITIONS)
      return fieldedInnings === 0
        ? null
        : innings(POSITIONS.filter(infield)) / fieldedInnings
    })
    const known = shares.filter((share): share is number => share != null)
    const mean = known.reduce((sum, share) => sum + share, 0) / known.length
    rows.forEach((row, at) => {
      const share = shares[at]
      warn(
        'trackSeasonInfieldBalance',
        share != null && share < mean / 2 ? 'yellow' : null,
        'Few infield innings this season',
        row
      )
    })
  }

  if (on('rotateLeadoff') && rows.length > 0)
    warn(
      'rotateLeadoff',
      rows[0].key === history.lastLeadoff ? 'yellow' : null,
      'Led off last game too',
      rows[0]
    )

  if (on('mustPlayNextSuggestions')) {
    const most = Math.max(0, ...Object.values(history.lastGameSits))
    for (const row of rows)
      warn(
        'mustPlayNextSuggestions',
        most > 0 && history.lastGameSits[row.key] === most && sits(row.cells[0])
          ? 'yellow'
          : null,
        'Sat the most last game, and sits in inning 1',
        row
      )
  }

  return grouped(findings)
}

/**
 * One warning per rule, level and message, naming its players: reds first,
 * each level in the order the rules were checked.
 */
function grouped(findings: readonly Finding[]): PlanWarning[] {
  const warnings = new Map<string, PlanWarning>()
  for (const { player, ...finding } of findings) {
    const key = `${finding.rule}|${finding.level}|${finding.message}`
    const warning = warnings.get(key)
    if (warning == null) warnings.set(key, { ...finding, players: [player] })
    else warning.players.push(player)
  }
  const all = [...warnings.values()].map(warning => ({
    ...warning,
    message: `${warning.message}: ${warning.players.join(', ')}`
  }))
  return [
    ...all.filter(warning => warning.level === 'red'),
    ...all.filter(warning => warning.level === 'yellow')
  ]
}

/**
 * Counts for the save and apply notices: "2 red and 1 yellow playing-time
 * warnings" when both kinds are present, else "1 playing-time warning" or
 * "3 playing-time warnings", and empty when there are none.
 */
export function warningSummary(warnings: readonly PlanWarning[]): {
  red: number
  yellow: number
  text: string
} {
  const red = warnings.filter(warning => warning.level === 'red').length
  const yellow = warnings.length - red
  const text =
    red > 0 && yellow > 0
      ? `${red} red and ${yellow} yellow playing-time warnings`
      : warnings.length > 0
        ? plural(warnings.length, 'playing-time warning')
        : ''
  return { red, yellow, text }
}
