import { forcedFrom } from '../../common/scoring/rules'
import type { BallArcState } from '../field/ballArcModel'
import { fieldingLocation } from '../field/fieldingLocation'
import type { FieldCanvasProps } from '../field/fieldTypes'
import { allowedAngle } from './battedBall'
import type { ScoringEvent, ScoringState } from './scoringTypes'

export function fieldStageInstruction(state: ScoringState): string | undefined {
  if (state.phase === 'locateLanding') return 'Drag where the ball was hit'
  if (state.phase === 'locateFielder' || state.phase === 'chooseThrower')
    return 'Tap or drag a player to where the ball was fielded.'
  if (state.phase === 'trajectory')
    return 'Drag up and down for ball trajectory.'
  if (state.phase === 'chooseDefender') {
    if (state.runnerAction?.purpose === 'errorAttribution')
      return 'Tap or drag another defender, or hit Done to choose who committed the error.'
    const offense = state.session.liveData.linescore.offense
    const forced =
      state.runnerAction?.purpose === 'batterRetirement' &&
      [offense.first, offense.second, offense.third].some(
        (runner, index) =>
          runner != null && forcedFrom(state.session, index + 1)
      )
    return forced
      ? 'Tap or drag the next defender, drag a forced runner out at the next base, or hit Done to finish the out.'
      : 'Tap or drag the next defender, or hit Done to finish the out.'
  }
}
/** Renderer callbacks and preview use the same phase and constraints as reducer events. */
export function battedBallField(
  state: ScoringState,
  angle: number,
  landing: BallArcState | null,
  blocked: boolean,
  handlers: {
    dispatch: (event: ScoringEvent) => void
    landing: (arc: BallArcState) => void
    angle: (value: number) => void
  }
): Pick<
  FieldCanvasProps,
  | 'homeRunPlacement'
  | 'acceptDefenderTap'
  | 'deferDefenderPlacement'
  | 'constrainPlacement'
  | 'onLandingAccepted'
  | 'arc'
  | 'arcMode'
  | 'onArcChange'
> {
  const locating = state.phase === 'locateLanding'
  return {
    homeRunPlacement: locating,
    deferDefenderPlacement: state.phase === 'locateFielder',
    acceptDefenderTap:
      state.phase === 'locateFielder' ||
      state.phase === 'chooseThrower' ||
      state.phase === 'chooseDefender',
    constrainPlacement:
      state.phase === 'locateFielder'
        ? point => fieldingLocation(state.pendingPlay!.outcome, point)
        : undefined,
    onLandingAccepted: (arc, generation) => {
      handlers.dispatch({
        type: 'LANDING',
        point: arc.target,
        landingHeight: arc.landingHeight,
        generation
      })
    },
    arc: locating
      ? (landing ?? { target: state.pendingPlay!.location!, angle: 45 })
      : state.phase === 'trajectory' && state.pendingPlay?.location != null
        ? {
            target: state.pendingPlay.location,
            angle,
            landingHeight: state.pendingPlay.landingHeight
          }
        : null,
    arcMode: blocked
      ? 'off'
      : locating
        ? 'aim'
        : state.phase === 'trajectory'
          ? 'edit'
          : 'off',
    onArcChange: arc => {
      if (locating) handlers.landing(arc)
      else
        handlers.angle(
          allowedAngle(
            arc.angle,
            state.pendingPlay?.outcome ?? '',
            state.pendingPlay?.homeRunKind
          )
        )
    }
  }
}
