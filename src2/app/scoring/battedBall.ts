import {
  allowedAngle,
  homeRunKind,
  outcomeAvailable,
  trajectoryLabel
} from '../../common/scoring/rules'
import { fieldingLocation } from '../field/fieldingLocation'
import type { GroundPoint } from '../field/fieldModel'
import { homeRunLanding } from '../field/stadiumBoundary'
import { initialHitTarget } from '../field/trajectoryGuide'
import { fieldPlayersFor } from './fieldAdapter'
import {
  type ContactKind,
  type Outcome,
  outcomeEvents
} from './scoringContract'
import { accepted, act, settleRunners } from './scoringFlow'
import { hitPresentation } from './scoringPresentation'
import { baseIds } from './scoringSelectors'
import type { ScoringState } from './scoringTypes'

/**
 * A ball in play as the scorer draws it: the outcome, then the fielder or the
 * landing, then the trajectory. Only when the trajectory is accepted does the
 * game hear of it, as the ball in play and its result.
 */
export { allowedAngle, outcomeAvailable, trajectoryLabel }

export function chooseOutcome(
  state: ScoringState,
  outcome: Outcome,
  contactKind: ContactKind = 'swing'
): ScoringState {
  if (
    (contactKind === 'bunt' && outcome === 'Home Run') ||
    state.phase !== 'ready' ||
    state.moreDraft != null ||
    !(outcome in outcomeEvents) ||
    !outcomeAvailable(
      outcome,
      baseIds(state.session).some(id => id != null)
    )
  )
    return state
  return accepted(
    state,
    contactKind === 'bunt' ? `Bunt: ${outcome}` : outcome,
    next => {
      const play = next.session.liveData.plays.currentPlay!
      act(next, { type: 'ballInPlay', contact: contactKind })
      next.pendingPlay = {
        outcome,
        contactKind,
        trajectoryAccepted: false
      }
      next.phase = outcome === 'Home Run' ? 'locateLanding' : 'locateFielder'
      if (outcome === 'Home Run')
        next.pendingPlay.location = initialHitTarget(play.matchup.batSide.code)
    }
  )
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
    const homeRun = pending.outcome === 'Home Run'
    if (homeRun)
      next.celebration = {
        id: `${next.generation}:${next.session.meta.sequence + 1}:home-run`,
        generation: next.generation,
        kind: pending.homeRunKind ?? 'in-park'
      }
    act(next, {
      type: 'ballInPlay',
      contact: pending.contactKind ?? 'swing',
      launchAngle: value,
      ...(pending.location == null
        ? {}
        : { location: { ...pending.location } }),
      ...(pending.fielder == null ? {} : { fielder: pending.fielder }),
      ...(homeRun && pending.landingHeight != null
        ? { landingHeight: pending.landingHeight }
        : {}),
      ...(homeRun ? { homeRunKind: pending.homeRunKind ?? 'in-park' } : {})
    })
    const outcome = pending.outcome as Outcome
    act(next, {
      type: 'result',
      eventType: outcomeEvents[outcome],
      ...(outcome === 'Throw Out'
        ? { outBy: 'throw' as const }
        : outcome === 'Ball Caught'
          ? { outBy: 'catch' as const }
          : outcome === 'Batter Interference'
            ? { outBy: 'interference' as const }
            : {})
    })
    next.pendingPlay ??= pending
    next.phase = 'runnerMovement'
    settleRunners(next)
  })
}
