import { fieldingLocation, isFairLocation } from '../field/fieldingLocation'
import type { GroundPoint } from '../field/fieldModel'
import {
  type HomeRunKind,
  homeRunKind,
  homeRunLanding
} from '../field/stadiumBoundary'
import { initialHitTarget } from '../field/trajectoryGuide'
import { fieldPlayersFor } from './fieldAdapter'
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
export function outcomeAvailable(
  outcome: string,
  hasRunners: boolean
): boolean {
  return outcome !== "Fielder's Choice" || hasRunners
}
export function allowedAngle(
  angle: number,
  outcome: Outcome | string,
  kind?: HomeRunKind
): number {
  return Math.round(
    Math.max(
      outcome === 'Ball Caught' ||
        (outcome === 'Home Run' && kind === 'out-of-park')
        ? 10
        : -45,
      Math.min(70, angle)
    )
  )
}
export function chooseOutcome(
  state: ScoringState,
  outcome: Outcome
): ScoringState {
  if (
    state.phase !== 'ready' ||
    state.moreDraft != null ||
    !(outcome in outcomeEvents) ||
    !outcomeAvailable(
      outcome,
      baseIds(state.session).some(id => id != null)
    )
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
    next.phase = outcome === 'Home Run' ? 'locateLanding' : 'locateFielder'
    if (outcome === 'Home Run')
      next.pendingPlay.location = initialHitTarget(play.matchup.batSide.code)
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
  generation: number,
  landingHeight?: number
): ScoringState {
  if (
    state.phase !== 'locateFielder' ||
    state.generation !== generation ||
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.z) ||
    (landingHeight != null && !Number.isFinite(landingHeight)) ||
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
      pending.location = fieldingLocation(pending.outcome, point)
      pending.landingHeight = landingHeight
      if (
        pending.outcome === 'Ball Caught' &&
        !isFairLocation(pending.location)
      ) {
        const play = next.session.liveData.plays.currentPlay!
        play.source.gamestation.foulCaught = true
        play.result.description = 'Foul ball caught'
      }
      pending.angle = 45
      next.phase = 'trajectory'
    }
  )
}
export function placeLanding(
  state: ScoringState,
  point: GroundPoint,
  generation: number,
  landingHeight?: number
): ScoringState {
  if (
    state.phase !== 'locateLanding' ||
    state.pendingPlay?.outcome !== 'Home Run' ||
    generation !== state.generation ||
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.z) ||
    (landingHeight != null && !Number.isFinite(landingHeight))
  )
    return state
  return accepted(state, 'Home-run landing', next => {
    const pending = next.pendingPlay!
    pending.location = homeRunLanding(point)
    pending.homeRunKind = homeRunKind(pending.location)
    pending.landingHeight =
      pending.homeRunKind === 'out-of-park' ? landingHeight : undefined
    pending.angle = 45
    if (pending.homeRunKind === 'in-park') {
      pending.fielder = fieldPlayersFor(next.session)
        .filter(p => p.team === 'defense' && p.playerId != null)
        .sort((a, b) => {
          const difference =
            Math.hypot(
              a.position.x - pending.location!.x,
              a.position.z - pending.location!.z
            ) -
            Math.hypot(
              b.position.x - pending.location!.x,
              b.position.z - pending.location!.z
            )
          return difference === 0 ? a.playerId! - b.playerId! : difference
        })[0]?.playerId
    }
    next.phase = 'trajectory'
  })
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
  const value = allowedAngle(
    angle,
    state.pendingPlay!.outcome,
    state.pendingPlay!.homeRunKind
  )
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
      fielder:
        pending.fielder == null
          ? undefined
          : playerRef(next.session, pending.fielder)!
    }
    if (pending.outcome === 'Home Run') {
      next.session.liveData.plays.currentPlay!.source.gamestation.homeRunKind =
        pending.homeRunKind
      next.session.liveData.plays.currentPlay!.source.gamestation.landingHeight =
        pending.landingHeight
    }
    prepareHit(next)
    prepareBatterResult(next)
  })
}
