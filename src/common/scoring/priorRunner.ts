import {
  BASES,
  destinationBase,
  DESTINATIONS,
  type ScoringAction
} from './actions'
import { applyAction } from './apply'
import { baseIds } from './lineup'
import { previousRunnerError } from './rules'
import { copyState, type GamePlay, type GameState } from './state'

export interface PriorRunner {
  runner: number
  from: number
  to: number
}

/** Only the immediately preceding play can be corrected from the field. */
export function priorRunners(state: GameState): PriorRunner[] {
  const { allPlays, currentPlay } = state.liveData.plays
  const previous = allPlays.at(-1)
  if (
    state.pending != null ||
    state.final ||
    currentPlay == null ||
    previous?.about.inning !== currentPlay.about.inning ||
    previous.about.halfInning !== currentPlay.about.halfInning
  )
    return []
  const bases = baseIds(state)
  const last = new Map(
    previous.runners.map(row => [row.details.runner.id, row])
  )
  return [...last].flatMap(([runner, row]) => {
    const from = row.movement.end
    if (
      currentPlay.runners.some(move => move.details.runner.id === runner) ||
      currentPlay.playEvents.some(
        event =>
          event.isSubstitution === true &&
          (event.player.id === runner || event.replacedPlayer?.id === runner)
      ) ||
      row.movement.isOut ||
      row.movement.forced === true ||
      (previous.result.eventType === 'home_run' &&
        previous.matchup.batter.id !== runner) ||
      from == null ||
      from < 2 ||
      row.movement.start == null ||
      row.movement.start >= from ||
      (from < 4 ? bases[from - 1] !== runner : bases.includes(runner)) ||
      bases[from - 2] != null
    )
      return []
    return [{ runner, from, to: from - 1 }]
  })
}

/** Rewrites the closed segment; the current at-bat's actions remain identical. */
export function returnPriorRunner(
  opening: GameState,
  log: readonly ScoringAction[],
  state: GameState,
  runner: number,
  to: number
): {
  log: ScoringAction[]
  state: GameState
  retainedEvents: Array<{ atBatIndex: number; before: number; after: number }>
} | null {
  const candidate = priorRunners(state).find(
    item => item.runner === runner && item.to === to
  )
  if (candidate == null) return null
  const count = state.liveData.plays.allPlays.length
  let replay = copyState(opening)
  let close = -1
  let start = 0
  const starts: number[] = []
  const errorGroups = new Map<number, string>()
  const priorIndex = state.liveData.plays.allPlays.at(-1)!.about.atBatIndex
  const priorPlay = (game: GameState): GamePlay | null =>
    game.liveData.plays.allPlays.find(
      play => play.about.atBatIndex === priorIndex
    ) ??
    (game.liveData.plays.currentPlay?.about.atBatIndex === priorIndex
      ? game.liveData.plays.currentPlay
      : null)
  const createdEvents: number[][] = []
  for (let i = 0; i < log.length; i++) {
    starts[i] = baseIds(replay).indexOf(runner) + 1
    const before = replay.liveData.plays.allPlays.length
    const action = log[i]
    const atBat = replay.liveData.plays.currentPlay?.about.atBatIndex
    const eventCount = priorPlay(replay)?.playEvents.length ?? 0
    const applied = applyAction(replay, action, { inPlace: true, replay: true })
    if (applied.problems.length > 0) return null
    replay = applied.state
    createdEvents[i] =
      priorPlay(replay)
        ?.playEvents.slice(eventCount)
        .map(event => event.index) ?? []
    if (action.type === 'runnerMovement' && action.error != null) {
      const event = previousRunnerError(replay, action.reason, action.error)
      if (event != null) errorGroups.set(i, `${atBat}:${event}`)
    }
    if (replay.liveData.plays.allPlays.length === count && before < count) {
      close = i
      break
    }
    if (replay.liveData.plays.allPlays.length > before) start = i + 1
  }
  if (
    close < 0 ||
    log[close].type !== 'gameFlow' ||
    (log[close] as { kind: string }).kind !== 'closePlay'
  )
    return null
  // Retain source positions, including when the same action object occurs twice.
  const entries = log.map((action, source) => ({ action, source }))
  interface Entry {
    action: ScoringAction
    source?: number
  }
  const prefix: Entry[] = entries.slice(0, close)
  const options: Entry[][] = []
  for (let i = prefix.length - 1; i >= start; i--) {
    const { action, source } = prefix[i]
    const replace = (replacement: ScoringAction[]): Entry[] => [
      ...prefix.slice(0, i),
      ...replacement.map(action => ({ action, source })),
      ...prefix.slice(i + 1)
    ]
    if (action.type === 'batteryEvent' && action.advances != null) {
      const index = action.advances.findIndex(
        advance =>
          advance.runner === runner &&
          destinationBase(advance.to) === candidate.from
      )
      if (index < 0) continue
      const remaining = action.advances.filter((_, j) => j !== index)
      options.push(
        replace(
          remaining.length === 0 ? [] : [{ ...action, advances: remaining }]
        )
      )
      options.push(
        replace([
          {
            ...action,
            advances: action.advances.map((advance, j) =>
              j === index ? { ...advance, to: DESTINATIONS[to] } : advance
            )
          }
        ])
      )
      break
    }
    if (
      ((action.type === 'result' && action.eventType === 'manual_placement') ||
        (action.type === 'gameFlow' &&
          action.kind === 'placeRunner' &&
          action.runner === runner)) &&
      action.base != null &&
      destinationBase(action.base) === candidate.from
    ) {
      options.push(replace([{ ...action, base: BASES[to - 1] }]))
      break
    }
    if (
      (action.type !== 'runnerMovement' && action.type !== 'baseRunning') ||
      action.runner !== runner ||
      (action.type === 'runnerMovement'
        ? action.out === true
        : !['steal', 'defensive_indifference'].includes(action.kind)) ||
      (action.to == null
        ? Math.min(4, starts[i] + 1)
        : destinationBase(action.to)) !== candidate.from
    )
      continue
    options.push(replace([]))
    options.push(replace([{ ...action, to: DESTINATIONS[to] }]))
    break
  }
  options.push([
    ...prefix,
    { action: { type: 'runnerMovement', runner, to: DESTINATIONS[to] } }
  ])
  options.push([
    ...prefix,
    {
      action: {
        type: 'runnerMovement',
        runner,
        to: DESTINATIONS[to],
        reason: 'Back'
      }
    }
  ])
  for (const edited of options) {
    const nextLog: ScoringAction[] = []
    const retainedEvents: Array<{
      atBatIndex: number
      before: number
      after: number
    }> = []
    // Each attempt owns one disposable copy. Invalid attempts never touch the
    // caller, and completed plays are not deep-copied again for every pitch.
    let next = copyState(opening)
    const events = new Map<string, number>()
    let failed = false
    for (const entry of [...edited, ...entries.slice(close)]) {
      let action = entry.action
      const group =
        entry.source == null ? undefined : errorGroups.get(entry.source)
      if (
        action.type === 'runnerMovement' &&
        action.errorEvent != null &&
        group != null
      ) {
        const errorEvent = events.get(group)
        if (errorEvent !== action.errorEvent) action = { ...action, errorEvent }
        // If the originating advance was removed, the first retained runner
        // now owns the same error; subsequent runners still share its event.
        if (action.errorEvent == null) delete action.errorEvent
      }
      const eventCount = priorPlay(next)?.playEvents.length ?? 0
      const applied = applyAction(next, action, {
        inPlace: true,
        // Saved history keeps the rules it originally replayed under. Only
        // the correction itself is a newly authored scoring decision.
        replay: entry.source != null && entry.action === log[entry.source]
      })
      if (applied.problems.length > 0) {
        failed = true
        break
      }
      next = applied.state
      const added = priorPlay(next)?.playEvents.slice(eventCount) ?? []
      const originalEvents =
        entry.source == null ? [] : (createdEvents[entry.source] ?? [])
      for (let i = 0; i < Math.min(added.length, originalEvents.length); i++)
        retainedEvents.push({
          atBatIndex: priorIndex,
          before: originalEvents[i],
          after: added[i].index
        })
      nextLog.push(action)
      if (group != null && action.type === 'runnerMovement') {
        const event = previousRunnerError(next, action.reason, action.error)
        if (event != null) events.set(group, event)
      }
    }
    if (failed || baseIds(next)[to - 1] !== runner) continue
    if (
      baseIds(state).some(
        (id, index) =>
          id !== runner && index !== to - 1 && baseIds(next)[index] !== id
      )
    )
      continue
    const current = next.liveData.plays.currentPlay
    const original = state.liveData.plays.currentPlay!
    if (
      next.liveData.plays.allPlays.length !== count ||
      current?.matchup.batter.id !== original.matchup.batter.id ||
      JSON.stringify(current.count) !== JSON.stringify(original.count) ||
      JSON.stringify(current.runners) !== JSON.stringify(original.runners) ||
      JSON.stringify(current.playEvents) !== JSON.stringify(original.playEvents)
    )
      continue
    return { log: nextLog, state: next, retainedEvents }
  }
  return null
}
