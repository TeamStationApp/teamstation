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
  if (state.phase === 'chooseDefender')
    return state.runnerAction?.purpose === 'errorAttribution'
      ? 'Tap and drag another defender, or hit Done to choose who committed the error.'
      : 'Tap and drag the next defender, or hit Done to finish the out.'
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
  | 'constrainPlacement'
  | 'onLandingAccepted'
  | 'arc'
  | 'arcMode'
  | 'onArcChange'
> {
  const locating = state.phase === 'locateLanding'
  return {
    homeRunPlacement: locating,
    acceptDefenderTap:
      state.phase === 'locateFielder' || state.phase === 'chooseThrower',
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
