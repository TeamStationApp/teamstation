import {
  BASE_KEYS,
  type BaseKey,
  type ErrorlessOuts,
  type GamePlay,
  type GameState,
  type PlayerRef,
  type RunnerCharge
} from './state'

/**
 * Earned runs, the responsible pitcher and runs batted in, worked out as the
 * runners move.
 *
 * Every runner is charged to a pitcher: a batter who reaches to the pitcher
 * facing him, except that a walk after a pitching change in a 2-0, 2-1, 3-0,
 * 3-1 or 3-2 count is the previous pitcher's (9.16(h)), and a batter who
 * reaches on a fielder's choice that puts out a runner takes that runner's
 * charge (9.16(g)). A runner placed by hand is charged to the pitcher on the
 * mound, and the extra-innings runner to the pitcher who began the half.
 *
 * Whether a run is earned is decided by reconstructing the half without its
 * errors: the outs the defence would have made (`ErrorlessOuts`) are counted
 * for the team over the whole half, and for each pitcher from when he took
 * the mound (9.16(i)). A run is unearned to a count when the runner reached
 * on an error, when he scored after that count reached three, or when he
 * scored on an error or a passed ball.
 */

/** The runners of a play, and those on base, with what each is charged with. */
export type ChargeBook = Map<number, RunnerCharge>

const WALKS = new Set(['walk', 'intent_walk'])

/** A batter who reaches this way would have been out but for the defence. */
export const REACHED_ON_ERROR_REASONS = new Set([
  'Passed Ball',
  'Throwing Error',
  'Fielding Error'
])

/** The pitcher on the mound. */
function mound(state: GameState): PlayerRef | null {
  return (
    state.liveData.linescore.defense.P ??
    state.liveData.plays.currentPlay?.matchup.pitcher ??
    null
  )
}

/**
 * The half's would-be outs. The engine first sees a half at its actual outs:
 * 0 at its start, more when it was restored from documents or corrected.
 */
export function errorlessOuts(state: GameState): ErrorlessOuts {
  const line = state.liveData.linescore
  if (line.errorlessOuts == null) {
    const pitcher = mound(state)
    line.errorlessOuts = {
      team: line.outs,
      pitchers: pitcher == null ? [] : [{ pitcher, outs: line.outs }]
    }
  }
  return line.errorlessOuts
}

/** One more out the defence made, or would have made but for an error. */
export function addErrorlessOut(state: GameState): void {
  const counts = errorlessOuts(state)
  counts.team++
  for (const entry of counts.pitchers) entry.outs++
}

/**
 * The score, the outs or the half were set by hand. A new half starts its
 * counts again at the outs it was given; within the half every count moves
 * with the outs, and none falls below them.
 */
export function outsCorrected(
  state: GameState,
  before: { inning: number; top: boolean; outs: number }
): void {
  const line = state.liveData.linescore
  if (line.currentInning !== before.inning || line.isTopInning !== before.top) {
    delete line.errorlessOuts
    return
  }
  const change = line.outs - before.outs
  if (change === 0) return
  const counts = errorlessOuts(state)
  counts.team = Math.max(line.outs, counts.team + change)
  for (const entry of counts.pitchers)
    entry.outs = Math.max(line.outs, entry.outs + change)
}

/**
 * A pitcher new to this half takes the mound, with the outs as they stand. A
 * reliever keeps whom he relieved, and the count on the batter he inherited.
 */
function takeMound(state: GameState, before: PlayerRef | null): void {
  const counts = errorlessOuts(state)
  const line = state.liveData.linescore
  const pitcher = line.defense.P
  if (pitcher == null || counts.pitchers.some(e => e.pitcher.id === pitcher.id))
    return
  const play = state.liveData.plays.currentPlay
  counts.pitchers.push({
    pitcher,
    outs: line.outs,
    ...(before == null || play == null
      ? {}
      : {
          relieved: {
            pitcher: before,
            atBatIndex: play.about.atBatIndex,
            balls: line.balls,
            strikes: line.strikes
          }
        })
  })
}

/** The pitcher who began the half: the extra-innings runner is his. */
export function halfPitcher(state: GameState): PlayerRef | null {
  return errorlessOuts(state).pitchers[0]?.pitcher ?? mound(state)
}

/**
 * The book as the game holds it: the runners on base when the play began,
 * then everyone on base. A runner on base the game has no charge for was
 * placed by hand, and is charged to the pitcher on the mound.
 */
export function chargeBook(state: GameState): ChargeBook {
  const book: ChargeBook = new Map()
  for (const [id, charge] of Object.entries(state.pending?.charges ?? {}))
    book.set(Number(id), { ...charge })
  const offense = state.liveData.linescore.offense
  for (const key of BASE_KEYS) {
    const id = offense[key]?.id
    if (id == null || book.has(id)) continue
    book.set(id, {
      pitcher: offense.responsiblePitcher?.[key] ?? mound(state),
      reachedOnError: offense.reachedOnError?.[key] ?? false
    })
  }
  return book
}

/**
 * The pitcher a walk is charged to: the one who relieved in a count with the
 * batter ahead passes it back to the one he relieved (9.16(h)).
 */
function walkCharge(
  state: GameState,
  atBatIndex: number,
  pitcher: PlayerRef
): PlayerRef {
  const entries = errorlessOuts(state).pitchers
  const seen = new Set<number>()
  let charged = pitcher
  for (;;) {
    seen.add(charged.id)
    const relieved = entries.find(e => e.pitcher.id === charged.id)?.relieved
    if (
      relieved?.atBatIndex !== atBatIndex ||
      relieved.balls < 2 ||
      relieved.balls <= relieved.strikes ||
      seen.has(relieved.pitcher.id)
    )
      return charged
    charged = relieved.pitcher
  }
}

/** The batter's charge on the play he is batting in. */
function batterCharge(
  state: GameState,
  book: ChargeBook,
  play: GamePlay
): RunnerCharge {
  const pending = state.pending
  const reachedOnError = pending?.batterReachedOnError === true
  if (
    pending != null &&
    (pending.outcome === "Fielder's Choice" || pending.outcome === 'Throw Out')
  ) {
    const replaced = play.runners
      .slice(pending.originalRunnerRecordCount)
      .find(
        runner =>
          runner.movement.isOut &&
          runner.details.runner.id !== play.matchup.batter.id
      )
    const charge =
      replaced == null ? undefined : book.get(replaced.details.runner.id)
    if (charge != null) return { pitcher: charge.pitcher, reachedOnError }
  }
  const pitcher = WALKS.has(play.result.eventType)
    ? walkCharge(state, play.about.atBatIndex, play.matchup.pitcher)
    : play.matchup.pitcher
  return { pitcher, reachedOnError }
}

/** What a runner is charged with now. */
export function chargeOf(
  state: GameState,
  book: ChargeBook,
  id: number
): RunnerCharge {
  const play = state.liveData.plays.currentPlay
  if (state.pending != null && play?.matchup.batter.id === id)
    return batterCharge(state, book, play)
  return book.get(id) ?? { pitcher: mound(state), reachedOnError: false }
}

/**
 * Writes the book back into the game once an action has landed: each base's
 * charge, the charges of the play's runners, the new pitcher's count, and the
 * batter's charge on his own entries, which a later out can change (9.16(g)).
 */
export function keepCharges(
  state: GameState,
  book: ChargeBook,
  before: PlayerRef | null
): void {
  takeMound(state, before)
  const pending = state.pending
  if (pending != null)
    pending.charges = Object.fromEntries(
      pending.originalBases
        .filter((id): id is number => id != null)
        .map(id => [id, chargeOf(state, book, id)])
    )
  const offense = state.liveData.linescore.offense
  const pitchers: Record<BaseKey, PlayerRef | null> = {
    first: null,
    second: null,
    third: null
  }
  const errors = { first: false, second: false, third: false }
  for (const key of BASE_KEYS) {
    const id = offense[key]?.id
    if (id == null) continue
    const charge = chargeOf(state, book, id)
    pitchers[key] = charge.pitcher
    errors[key] = charge.reachedOnError
  }
  offense.responsiblePitcher = pitchers
  offense.reachedOnError = errors
  const play = state.liveData.plays.currentPlay
  if (pending == null || play == null) return
  const batter = play.matchup.batter.id
  for (const runner of play.runners)
    if (runner.details.runner.id === batter && runner.movement.end !== 4)
      runner.details.responsiblePitcher = chargeOf(state, book, batter).pitcher
}

/**
 * Whether a run is earned to the responsible pitcher, and whether it is
 * unearned to the team.
 */
export function runDecision(
  state: GameState,
  charge: RunnerCharge,
  onError: boolean
): { earned: boolean; teamUnearned: boolean } {
  const counts = errorlessOuts(state)
  const own =
    counts.pitchers.find(entry => entry.pitcher.id === charge.pitcher?.id)
      ?.outs ?? counts.team
  const unearned = (outs: number): boolean =>
    charge.reachedOnError || onError || outs >= 3
  return { earned: !unearned(own), teamUnearned: unearned(counts.team) }
}

/** The scoring movement itself was made on an error or a passed ball. */
export function scoredOnError(
  outcome: string | undefined,
  reason: string
): boolean {
  return outcome === 'Error' || REACHED_ON_ERROR_REASONS.has(reason)
}

/** Plays that bat nobody in. */
const NO_RBI_OUTCOMES = new Set(['Balk', 'Error', 'Dropped Third Strike'])
/** Reasons a runner scores that nobody batted in, whatever the play. */
const NO_RBI_REASONS = new Set([
  'Wild Pitch',
  'Passed Ball',
  'Throwing Error',
  'Fielding Error',
  'Balk',
  'Steal',
  'Defensive Indifference'
])
/** Results that bat nobody in, whatever scored on them (9.04(b)(1)). */
const NO_RBI_TYPES = new Set([
  'grounded_into_double_play',
  'grounded_into_triple_play'
])

/**
 * Whether a run is batted in: the batter's plate appearance scored the
 * runner (`outcome` is the play being resolved, undefined between pitches),
 * not the defence's mistake, a balk, a wild pitch or a steal. A walk, a hit
 * batsman or catcher's interference with the bases loaded bats a run in.
 */
export function earnsRbi(outcome: string | undefined, reason: string): boolean {
  return (
    outcome != null &&
    !NO_RBI_OUTCOMES.has(outcome) &&
    !NO_RBI_REASONS.has(reason)
  )
}

/**
 * The play's runs batted in are its runners' `rbi` flags. A ground ball into
 * a double play bats nobody in, so once the play is one its flags are cleared.
 */
export function countRbi(play: GamePlay): void {
  if (NO_RBI_TYPES.has(play.result.eventType))
    for (const runner of play.runners) runner.details.rbi = false
  play.result.rbi = play.runners.filter(
    runner => runner.details.rbi === true
  ).length
}
