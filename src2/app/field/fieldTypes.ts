import type { RunnerDecision, RunnerDragView } from '../scoring/runnerDrag'
import type { ArcMode, BallArcState } from './ballArcModel'
import type { CameraView, FieldPlayer, GroundPoint } from './fieldModel'
import type { ScoreboardState } from './scoreboardModel'

export interface FieldInteractionPolicy {
  generation: number
  selectableIds: readonly string[]
  runnerIds?: readonly string[]
  gestures: ReadonlyArray<'place' | 'trajectory'>
}
export interface FieldPlacement {
  entityId: string
  point: GroundPoint
  generation: number
  gestureId: number
}
export interface FieldCanvasProps {
  runnerSafeError?: (id: string, to: number) => string | undefined
  onRunnerDrag?: (view: RunnerDragView | null) => void
  onRunnerDrop?: (
    id: string,
    to: number,
    decision: RunnerDecision,
    generation: number
  ) => void

  onScoreboardBounds?: (bounds: {
    x: number
    y: number
    width: number
    height: number
  }) => void
  onRunnerHold?: (id: string, anchor: { x: number; y: number }) => void
  onRunnerPlacement?: (
    id: string,
    point: GroundPoint,
    anchor: { x: number; y: number },
    generation: number
  ) => void
  onRunnerCancel?: () => void
  onMovementComplete?: (id: string, generation: number) => void
  registerInterruption?: (cancel: (() => void) | null) => void
  interaction?: FieldInteractionPolicy
  onFieldPlacement?: (event: FieldPlacement) => void
  onGestureActive?: (active: boolean) => void
  onTrajectoryAccepted?: (angle: number, generation: number) => void
  hintBatSide?: 'L' | 'R'
  selectableIds?: readonly string[]
  onPlayerPlacement?: (id: string, point: GroundPoint) => void
  scoreboard?: ScoreboardState
  /** Native touch host or coarse-pointer web device; explicit mouse/pen events override. */
  touchPlacement?: boolean
  arc?: BallArcState | null
  arcMode?: ArcMode
  onArcChange?: (arc: BallArcState) => void
  onArcFinish?: () => void
  players: FieldPlayer[]
  selected: string
  onSelect: (id: string) => void
  view: CameraView
  zoom: number
  cameraTilt?: number
  cameraHeight?: number
  /** Wake an on-demand renderer after commands issued from the RN controls. */
  movementRevision?: number
}
