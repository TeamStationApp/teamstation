import type { GroundPoint } from '../field/fieldModel'
import { prepareBatterResult, prepareHit } from './runnerRules'
import { type Outcome, outcomeEvents } from './scoringContract'
import { accepted } from './scoringMachine'
import { hitPresentation } from './scoringPresentation'
import {
  baseIds,
  battingSide,
  fieldingSide,
  playerRef
} from './scoringSelectors'
import type { ScoringState } from './scoringTypes'
export function trajectoryLabel(angle: number): string {
  const value = Math.round(angle)
  return value >= 48
    ? 'Pop Fly'
    : value >= 35
      ? 'Fly Ball'
      : value >= 10
        ? 'Line Drive'
        : value >= -25
          ? 'Ground Ball'
          : 'Chopper'
}
export function allowedAngle(angle: number, outcome: Outcome | string): number {
  return Math.round(
    Math.max(outcome === 'Ball Caught' ? 10 : -45, Math.min(70, angle))
  )
}
export function chooseOutcome(
  state: ScoringState,
  outcome: Outcome
): ScoringState {
  if (
    state.phase !== 'ready' ||
    state.moreDraft != null ||
    !(outcome in outcomeEvents)
  )
    return state
  return accepted(state, outcome, next => {
    next.recentPitch = null
    const session = next.session
    const line = session.liveData.linescore
    const play = session.liveData.plays.currentPlay!
    next.pendingPlay = {
      outcome,
      originalRunnerRecordCount: play.runners.length,
      originalBases: baseIds(session),
      originalRuns: line.teams[battingSide(session)].runs,
      originalOuts: line.outs,
      movements: [],
      trajectoryAccepted: false
    }
    next.phase = 'locateFielder'
    const counts =
      session.liveData.boxscore.teams[fieldingSide(session)].pitchCounts
    counts[play.matchup.pitcher.id] = (counts[play.matchup.pitcher.id] ?? 0) + 1
    play.playEvents.push({
      index: play.playEvents.length,
      isPitch: true,
      type: 'pitch',
      details: { description: 'Ball in Play', code: 'X' },
      count: { balls: line.balls, strikes: line.strikes, outs: line.outs },
      player: play.matchup.pitcher
    })
    play.result.event = outcome
    play.result.eventType = outcomeEvents[outcome]
    play.result.description = outcome
    play.source.gamestation.outcome = outcome
    if (outcome === 'Throw Out' || outcome === 'Ball Caught')
      play.source.gamestation.outSubtype = outcome
  })
}
export function placeFielder(
  state: ScoringState,
  id: number,
  point: GroundPoint,
  generation: number
): ScoringState {
  if (
    state.phase !== 'locateFielder' ||
    state.generation !== generation ||
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.z) ||
    !Object.values(state.session.liveData.linescore.defense).some(
      player => player?.id === id
    )
  )
    return state
  return accepted(
    state,
    `Fielded by ${state.session.gameData.players[id].fullName}`,
    next => {
      const pending = next.pendingPlay!
      pending.fielder = id
      pending.location = { ...point }
      pending.angle = 45
      next.phase = 'trajectory'
    }
  )
}
export function acceptTrajectory(
  state: ScoringState,
  angle: number,
  generation: number
): ScoringState {
  if (
    state.phase !== 'trajectory' ||
    state.generation !== generation ||
    !Number.isFinite(angle)
  )
    return state
  const value = allowedAngle(angle, state.pendingPlay!.outcome)
  return accepted(state, `${value}° ${trajectoryLabel(value)}`, next => {
    if (state.presentationEnabled === true)
      next.presentation = hitPresentation(state, value)
    const pending = next.pendingPlay!
    pending.angle = value
    pending.trajectoryAccepted = true
    next.session.liveData.plays.currentPlay!.hitData = {
      launchAngle: value,
      trajectory: trajectoryLabel(value),
      coordinates: { ...pending.location! },
      fielder: playerRef(next.session, pending.fielder!)!
    }
    prepareHit(next)
    prepareBatterResult(next)
  })
}
