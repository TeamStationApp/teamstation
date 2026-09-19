import {
  ballInPlayConfig,
  baseRunningConfig,
  count,
  type EventContext,
  text,
  walkGame
} from './gameState'

/**
 * Earned runs, worked out by replaying each inning without its mistakes.
 *
 * Not an approximation of the rule book but a replay. The difference is not a
 * detail: a replay that asks, per run, whether an error was involved gets a
 * different answer, and this one never asks that question at all.
 *
 * **Every runner carries an `earnedBase`** — how far they would have been driven
 * if nobody had made a mistake. It starts at the bases their own plate
 * appearance earned (1 for a walk or a single, 4 for a home run, nothing at all
 * if they reached on an error), and it advances on every legitimate play
 * afterwards. **A run is earned when that count reaches four**, whatever
 * actually happened on the field.
 *
 * The replayed inning ends at three *effectively out* runners, where reaching on
 * an error counts as an out — and it is counted per pitcher rather than per
 * team, because a reliever's three are not the same moment as the team's.
 */
interface Runner {
  runnerId: string | undefined
  pitcherId: string | undefined
  /** They reached without an error. */
  qualified: boolean
  /** How far the legitimate play of the inning would have carried them. */
  earnedBase: number | undefined
  leadoff: boolean
  walked: boolean
  reachedOnCatcherInterference: boolean
  out: boolean
  placed: boolean
  didNotScore: boolean
  scoredOnEventIndex: number | undefined
  unscoredOnEventIndex: number | undefined
  effectivelyOutOnEventIndex: number | undefined
  /**
   * The event at which we actually charged the run, which stands in for
   * re-reading the replay as it was at that moment: taking a run away again is
   * worth a subtraction only if it was added in the first place.
   */
  chargedAtIndex: number | undefined
}

function newRunner(over: Partial<Runner>): Runner {
  return {
    runnerId: undefined,
    pitcherId: undefined,
    qualified: false,
    earnedBase: undefined,
    leadoff: false,
    walked: false,
    reachedOnCatcherInterference: false,
    out: false,
    placed: false,
    didNotScore: false,
    scoredOnEventIndex: undefined,
    unscoredOnEventIndex: undefined,
    effectivelyOutOnEventIndex: undefined,
    chargedAtIndex: undefined,
    ...over
  }
}

function isEffectivelyOut(runner: Runner): boolean {
  if (runner.reachedOnCatcherInterference) return runner.out
  return (
    (!runner.qualified && !runner.placed) || runner.earnedBase === undefined
  )
}

export interface PitcherEarnedRuns {
  er: number
}

export interface EarnedRunTrace {
  index: number
  code: string
  runnerId: string | undefined
  pitcherId: string | undefined
  pitcherOuts: number
  charged: boolean
  half: string
  /** The runner list as it stood, newest first. */
  runners: string
}

/**
 * The replay's own state: who is on, how far their earned progress has got, and
 * the few facts about the current play that the next event needs to know.
 */
class Replay {
  runners: Runner[] = []
  lastBallInPlay: {
    batterId?: string
    ownerId?: string
    playResult?: string
  } = {}

  currentPlayIsError = false
  nextBatterIsUnqualified = false
  nextBatterIsLeadoff = true
  walkOwner: { set: boolean; value: string | undefined } = {
    set: false,
    value: undefined
  }

  clear(): void {
    this.runners = []
    this.lastBallInPlay = {}
    this.currentPlayIsError = false
    this.nextBatterIsLeadoff = true
  }

  /**
   * The per-pitcher out count, which is not the team's.
   *
   * Walked in the order the runners reached: an out is an out for everybody, but
   * a runner who is only *effectively* out counts for this pitcher solely while
   * no later pitcher's runner has intervened.
   */
  effectiveOutsForPitcher(pitcherId: string | undefined): number {
    let seenTheirs = false
    let stillTheirs = true
    let outs = 0
    for (const runner of this.runners) {
      if (runner.out) outs += 1
      else if (runner.pitcherId === pitcherId) {
        seenTheirs = true
        if (stillTheirs && isEffectivelyOut(runner)) outs += 1
      } else if (seenTheirs) stillTheirs = false
    }
    return Math.min(3, outs)
  }

  currentRunner(runnerId: string): Runner | undefined {
    return this.runners.find(
      runner => runner.runnerId === runnerId && !runner.out
    )
  }

  /** Nobody may stand on a base somebody newer is already on. */
  reconcile(index: number): void {
    let nextEligible = 1
    for (const runner of this.runners) {
      if (isEffectivelyOut(runner) || runner.earnedBase === undefined) continue
      let current = runner.earnedBase
      if (nextEligible > runner.earnedBase) {
        if (runner.earnedBase < 4 && nextEligible === 4) {
          runner.scoredOnEventIndex = index
        }
        runner.earnedBase = nextEligible
        current = nextEligible
      }
      nextEligible = Math.min(4, current + 1)
    }
  }

  /** Newest first. */
  addRunner(runner: Runner, index: number): void {
    this.runners.unshift(runner)
    this.reconcile(index)
  }

  addRunnerFromBatting(runner: Runner, index: number): void {
    if (this.nextBatterIsUnqualified) {
      runner.qualified = false
      runner.earnedBase = undefined
      this.nextBatterIsUnqualified = false
    }
    if (this.nextBatterIsLeadoff) {
      runner.leadoff = true
      this.nextBatterIsLeadoff = false
    }
    if (isEffectivelyOut(runner)) runner.effectivelyOutOnEventIndex = index
    this.addRunner(runner, index)
  }

  advanceRunner(runnerId: string, bases: number, index: number): void {
    for (const runner of this.runners) {
      if (runner.runnerId !== runnerId || runner.earnedBase === undefined) {
        continue
      }
      const before = runner.earnedBase
      const after = Math.min(before + bases, 4)
      if (after === 4 && before < 4) runner.scoredOnEventIndex = index
      else if (after < 4 && before === 4) runner.unscoredOnEventIndex = index
      runner.earnedBase = after
    }
    this.reconcile(index)
  }

  advanceAllRunners(bases: number, index: number): void {
    for (const runner of this.runners) {
      if (isEffectivelyOut(runner) || runner.earnedBase === undefined) continue
      const before = runner.earnedBase
      const after = Math.min(4, before + bases)
      if (after === 4 && before < 4) runner.scoredOnEventIndex = index
      runner.earnedBase = after
    }
  }

  /** Only the newest standing copy of a runner. */
  private setOn(
    runnerId: string | undefined,
    change: (runner: Runner) => void,
    onlyIfUnset?: (runner: Runner) => boolean
  ): void {
    for (const runner of this.runners) {
      if (runner.runnerId !== runnerId || runner.out) continue
      if (onlyIfUnset != null && !onlyIfUnset(runner)) return
      change(runner)
      return
    }
  }

  setQualified(runnerId: string | undefined, qualified: boolean): void {
    this.setOn(runnerId, runner => {
      runner.qualified = qualified
    })
  }

  setPitcher(
    runnerId: string | undefined,
    pitcherId: string | undefined
  ): void {
    this.setOn(runnerId, runner => {
      runner.pitcherId = pitcherId
    })
  }

  setEarnedBase(runnerId: string | undefined, base: number | undefined): void {
    this.setOn(runnerId, runner => {
      runner.earnedBase = base
    })
  }

  setUnscoredOnEventIndex(runnerId: string | undefined, index: number): void {
    this.setOn(runnerId, runner => {
      runner.unscoredOnEventIndex = index
    })
  }

  setOut(runnerId: string | undefined): void {
    this.setOn(runnerId, runner => {
      runner.out = true
    })
  }

  setEffectivelyOutIfUnset(runnerId: string | undefined, index: number): void {
    this.setOn(
      runnerId,
      runner => {
        runner.effectivelyOutOnEventIndex = index
      },
      runner => runner.effectivelyOutOnEventIndex === undefined
    )
  }

  setDidNotScore(runnerId: string): void {
    this.setOn(runnerId, runner => {
      runner.didNotScore = true
    })
  }

  replaceRunner(outgoingId: string, incomingId: string): void {
    this.setOn(outgoingId, runner => {
      runner.runnerId = incomingId
    })
  }

  swapRunners(firstId: string, secondId: string): void {
    const firstIndex = this.runners.findIndex(
      runner => runner.runnerId === firstId && !runner.out
    )
    const secondIndex = this.runners.findIndex(
      runner => runner.runnerId === secondId && !runner.out
    )
    if (firstIndex === -1 && secondIndex === -1) return
    if (firstIndex !== -1 && secondIndex !== -1) {
      if (firstIndex > secondIndex) {
        this.replaceRunner(firstId, secondId)
        this.replaceRunner(secondId, firstId)
      } else {
        this.replaceRunner(secondId, firstId)
        this.replaceRunner(firstId, secondId)
      }
    } else if (firstIndex !== -1) this.replaceRunner(firstId, secondId)
    else this.replaceRunner(secondId, firstId)
  }
}

/**
 * Walks a game and hands back the earned runs charged to each pitcher.
 *
 * One pass over the raw stream, with the four engines of `gameState.ts` beside
 * it saying who is batting, who is pitching, where each runner stands and when
 * the inning turned over. Nothing here is inferred from the play-by-play
 * sentences.
 */
export function earnedRunsByPitcher(
  streamEvents: unknown,
  trace?: EarnedRunTrace[]
): Map<string, PitcherEarnedRuns> {
  const charged = new Map<string, PitcherEarnedRuns>()
  const replay = new Replay()

  const add = (pitcherId: string | undefined, by: number): void => {
    if (pitcherId == null || pitcherId === '') return
    const held = charged.get(pitcherId) ?? { er: 0 }
    held.er += by
    charged.set(pitcherId, held)
  }

  walkGame(streamEvents, {
    onEvent: context => {
      // The inning is cleared at the top of the event *after* the one that
      // ended it, so a run scored on the third out is still charged first.
      if (context.before.lastEvent.endedInning) replay.clear()
      updateWalkOwner(replay, context)
      process(replay, context)
      settle(replay, context, add, trace)
    }
  })

  return charged
}

/**
 * Who wears a walk: the pitcher who threw its second ball, not whoever happened
 * to finish it.
 */
function updateWalkOwner(replay: Replay, context: EventContext): void {
  if (context.before.pitchesThisAtBat === 0) {
    replay.walkOwner = { set: false, value: undefined }
  } else if (
    !replay.walkOwner.set &&
    context.after.balls >= 2 &&
    context.after.balls > context.after.strikes
  ) {
    replay.walkOwner = { set: true, value: context.pitcher }
  }
}

function pitcherIdForWalk(
  replay: Replay,
  context: EventContext
): string | undefined {
  return replay.walkOwner.set ? replay.walkOwner.value : context.pitcher
}

function process(replay: Replay, context: EventContext): void {
  const { event, index } = context
  const a = event.attributes ?? {}

  switch (event.code) {
    case 'pitch':
      if (a.advancesRunners === true) replay.advanceAllRunners(1, index)
      addBatterFromCount(replay, context)
      return

    case 'end_at_bat':
      endAtBat(replay, context)
      return

    case 'ball_in_play':
      if (
        a.playResult === 'dropped_third_strike' ||
        a.playResult === 'dropped_third_strike_batter_out'
      ) {
        droppedThirdStrike(replay, context)
      } else ballInPlay(replay, context)
      return

    case 'base_running':
      baseRunning(replay, context)
      return

    case 'place_batter':
      replay.addRunner(
        newRunner({
          runnerId: context.batter,
          pitcherId: context.pitcher,
          qualified: false,
          earnedBase: count(a.base),
          placed: true
        }),
        index
      )
      return

    case 'place_runner':
      replay.addRunner(
        newRunner({
          runnerId: text(a.runnerId),
          pitcherId: context.pitcher,
          qualified: false,
          earnedBase: count(a.base),
          placed: true
        }),
        index
      )
      return

    case 'balk':
      replay.advanceAllRunners(1, index)
      return

    case 'illegal_pitch_advance':
      replay.advanceAllRunners(1, index)
      addBatterFromCount(replay, context)
      return

    case 'end_half':
      replay.clear()
      return

    case 'replace_runner':
      replay.replaceRunner(text(a.outgoingPlayerId), text(a.incomingPlayerId))
      return

    case 'swap_players':
      replay.swapRunners(text(a.firstPlayerId), text(a.secondPlayerId))
      return

    case 'sub_players':
      if (a.applyToBaserunners === true) {
        replay.replaceRunner(text(a.outgoingPlayerId), text(a.incomingPlayerId))
      }
      return

    case 'foul_error':
      replay.nextBatterIsUnqualified = true
      break

    default:
      break
  }
}

/** A walk or a strikeout that the count itself decided, rather than the scorer. */
function addBatterFromCount(replay: Replay, context: EventContext): void {
  const { index } = context
  if (context.after.lastEvent.walk) {
    replay.addRunnerFromBatting(
      newRunner({
        runnerId: context.batter,
        pitcherId: pitcherIdForWalk(replay, context),
        qualified: true,
        earnedBase: 1,
        walked: true
      }),
      index
    )
  } else if (context.after.lastEvent.strikeout) {
    replay.addRunnerFromBatting(
      newRunner({
        runnerId: context.batter,
        pitcherId: context.pitcher,
        qualified: true,
        out: true,
        effectivelyOutOnEventIndex: index
      }),
      index
    )
  }
}

function endAtBat(replay: Replay, context: EventContext): void {
  const a = context.event.attributes ?? {}
  const reason = text(a.reason)
  const batterOut = reason === 'strikeout'
  const qualified = reason !== 'catcher_interference'
  replay.addRunnerFromBatting(
    newRunner({
      runnerId: context.batter,
      pitcherId:
        reason === 'walk' ? pitcherIdForWalk(replay, context) : context.pitcher,
      qualified,
      earnedBase: batterOut || !qualified ? undefined : 1,
      walked: reason === 'walk',
      reachedOnCatcherInterference: reason === 'catcher_interference',
      out: batterOut,
      effectivelyOutOnEventIndex:
        batterOut || !qualified ? context.index : undefined
    }),
    context.index
  )
}

function noteBallInPlay(replay: Replay, context: EventContext): void {
  const a = context.event.attributes ?? {}
  replay.lastBallInPlay = {
    batterId: context.batter,
    ownerId: context.pitcher,
    playResult: text(a.playResult)
  }
  replay.currentPlayIsError = ballInPlayConfig(a.playResult).error
}

function advanceForBallInPlay(
  replay: Replay,
  context: EventContext,
  qualified: boolean
): void {
  if (!qualified || replay.nextBatterIsUnqualified) return
  const config = ballInPlayConfig(context.event.attributes?.playResult)
  replay.advanceAllRunners(config.bases, context.index)
}

function ballInPlay(replay: Replay, context: EventContext): void {
  const a = context.event.attributes ?? {}
  const config = ballInPlayConfig(a.playResult)
  const qualified = !config.error
  advanceForBallInPlay(replay, context, qualified)
  replay.addRunnerFromBatting(
    newRunner({
      runnerId: context.batter,
      pitcherId: context.pitcher,
      qualified,
      earnedBase: !qualified || config.batterOut ? undefined : config.bases,
      out: config.batterOut,
      scoredOnEventIndex:
        qualified && config.bases === 4 ? context.index : undefined,
      effectivelyOutOnEventIndex:
        !qualified || config.batterOut ? context.index : undefined
    }),
    context.index
  )
  noteBallInPlay(replay, context)
}

/**
 * A dropped third strike earns the batter a base only on a wild pitch, and only
 * if the runner in front of them was not going to be driven along anyway — which
 * is the one place the replay looks at who is actually standing where.
 */
function droppedThirdStrike(replay: Replay, context: EventContext): void {
  const a = context.event.attributes ?? {}
  let qualified = false
  if (a.cause === 'wild_pitch') {
    let earliest: string | undefined
    for (const base of [1, 2, 3]) {
      earliest = context.playerAtBase(base)
      if (earliest !== undefined) break
    }
    if (earliest === undefined) qualified = true
    else {
      const held = replay.currentRunner(earliest)
      if (held?.qualified !== true) qualified = true
      else if ((held.earnedBase ?? 0) > 1) qualified = true
    }
  }
  advanceForBallInPlay(replay, context, a.cause === 'wild_pitch')
  const batterOut = a.playResult === 'dropped_third_strike_batter_out'
  replay.addRunnerFromBatting(
    newRunner({
      runnerId: context.batter,
      pitcherId: context.pitcher,
      qualified,
      earnedBase: !qualified || batterOut ? undefined : 1,
      out: batterOut,
      effectivelyOutOnEventIndex:
        !qualified || batterOut ? context.index : undefined
    }),
    context.index
  )
  noteBallInPlay(replay, context)
}

function baseRunning(replay: Replay, context: EventContext): void {
  const a = context.event.attributes ?? {}
  const playType = text(a.playType)
  const runnerId = text(a.runnerId)
  const index = context.index

  // Once a play has been flagged as an error, the movement it caused is not
  // part of the replay at all.
  if (
    replay.currentPlayIsError &&
    [
      'advanced_on_last_play',
      'remained_on_last_play',
      'on_same_pitch'
    ].includes(playType)
  ) {
    return
  }

  if (playType === 'did_not_score') {
    replay.setDidNotScore(runnerId)
    if (replay.currentRunner(runnerId)?.scoredOnEventIndex != null) {
      replay.setUnscoredOnEventIndex(runnerId, index)
    }
    return
  }

  const config = baseRunningConfig(playType)
  if (config.error || playType === 'passed_ball') {
    replay.currentPlayIsError = true
  }

  if (config.runnerOut) {
    // A runner thrown out on a fielder's choice hands their own standing to the
    // batter who forced them: the out was the batter's doing, not the pitcher's
    // new mistake.
    if (
      playType === 'out_on_last_play' &&
      replay.lastBallInPlay.playResult === 'fielders_choice' &&
      replay.lastBallInPlay.batterId !== runnerId
    ) {
      const runner = replay.currentRunner(runnerId)
      if (runner?.qualified === true) {
        replay.setPitcher(replay.lastBallInPlay.batterId, runner.pitcherId)
      } else {
        replay.setQualified(replay.lastBallInPlay.batterId, false)
        replay.setEarnedBase(replay.lastBallInPlay.batterId, undefined)
        replay.setEffectivelyOutIfUnset(replay.lastBallInPlay.batterId, index)
      }
    }
    if (replay.currentRunner(runnerId)?.earnedBase === 4) {
      replay.setUnscoredOnEventIndex(runnerId, index)
    }
    replay.setEarnedBase(runnerId, undefined)
    replay.setEffectivelyOutIfUnset(runnerId, index)
    replay.setOut(runnerId)
    return
  }

  const from = context.baseForPlayer(runnerId)
  const progress = count(a.base) - (from ?? 4)
  if (
    progress !== 0 &&
    !['advanced_on_error', 'on_same_error', 'passed_ball'].includes(playType)
  ) {
    replay.advanceRunner(runnerId, progress, index)
  }
}

/**
 * The end of an event: charge whatever reached home during it, and take back
 * whatever left home again.
 *
 * A run is charged when the runner was not placed there by a rule, has a
 * pitcher, and that pitcher's replayed inning is not already over. Taking one
 * back asks the same question of the moment it was charged, which is what
 * `chargedAtIndex` remembers.
 */
function settle(
  replay: Replay,
  context: EventContext,
  add: (pitcherId: string | undefined, by: number) => void,
  trace?: EarnedRunTrace[]
): void {
  const index = context.index
  for (const runner of replay.runners) {
    if (runner.scoredOnEventIndex !== index) continue
    const pitcherOuts = replay.effectiveOutsForPitcher(runner.pitcherId)
    const ok =
      !runner.placed && runner.pitcherId !== undefined && pitcherOuts < 3
    trace?.push({
      index,
      code: context.event.code,
      runnerId: runner.runnerId,
      pitcherId: runner.pitcherId,
      pitcherOuts,
      charged: ok,
      half: `${context.after.inning} ${context.after.half}`,
      runners: replay.runners
        .map(
          held =>
            `${String(held.runnerId).slice(0, 4)}${held.out ? '/out' : ''}${
              held.qualified ? '' : '/unq'
            }=${held.earnedBase ?? '-'}`
        )
        .join(' ')
    })
    if (!ok) continue
    add(runner.pitcherId, 1)
    runner.chargedAtIndex = index
  }

  for (const runner of replay.runners) {
    if (runner.unscoredOnEventIndex !== index) continue
    if (runner.placed || runner.pitcherId === undefined) continue
    if (runner.scoredOnEventIndex === undefined) continue
    if (runner.chargedAtIndex !== runner.scoredOnEventIndex) continue
    add(runner.pitcherId, -1)
    runner.chargedAtIndex = undefined
  }
}
