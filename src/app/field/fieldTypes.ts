import type { RunnerDecision, RunnerDragView } from '../scoring/runnerDrag'
import type { PresentationSequence } from '../scoring/scoringPresentation'
import type { ArcMode, BallArcState } from './ballArcModel'
import type { CameraView, FieldPlayer, GroundPoint } from './fieldModel'
import type { NameplatePlacement } from './playerPresentation'
import type { ScoreboardState } from './scoreboardModel'
import type { FieldTeams } from './teamUniform'

export interface FieldInteractionPolicy {
  generation: number
  selectableIds: readonly string[]
  runnerIds?: readonly string[]
  /** Runner field ids that may drag one base backward (unforced hit-offer undo). */
  retreatIds?: readonly string[]
  /**
   * When set, only these runner field ids may drag forward. Others in
   * `runnerIds` are retreat-only (homeDecision trailer on the offered base).
   */
  advanceIds?: readonly string[]
  gestures: ReadonlyArray<'place' | 'trajectory'>
}
export interface FieldPlacement {
  landingHeight?: number
  entityId: string
  point: GroundPoint
  generation: number
  gestureId: number
}
export interface BaseProjection {
  bases: Array<{ x: number; y: number }>
  /** Standing runner silhouette, for controls that do not follow a drag. */
  heads?: Array<{ x: number; y: number }>
  feet?: Array<{ x: number; y: number }>
  width: number
  height: number
}
export interface FieldCanvasProps {
  /** Setup taps use field picking without starting a placement gesture. */
  tapIds?: readonly string[]
  onPlayerTap?: (id: string) => void
  teams?: FieldTeams
  constrainPlacement?: (point: GroundPoint) => GroundPoint
  acceptDefenderTap?: boolean
  /** Record a fielding target without moving the defender before ball contact. */
  deferDefenderPlacement?: boolean
  onLandingAccepted?: (arc: BallArcState, generation: number) => void
  onBaseProjection?: (value: BaseProjection) => void
  homeRunPlacement?: boolean
  onLandingPreview?: (point: GroundPoint | null) => void
  presentation?: PresentationSequence | null
  presentationPaused?: boolean
  onPresentationContact?: (id: string, generation: number) => void
  onPresentationDone?: (
    id: string,
    generation: number,
    stage: PresentationSequence['stage']
  ) => void

  runnerSafeError?: (id: string, to: number) => string | undefined
  /**
   * The runner drag's Safe/Out view, sent when what it offers changes — the
   * base, the target under the finger, whether Safe is allowed — and not for
   * every move of the finger, which the scene follows by itself. Null ends it.
   */
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
  registerKeyboard?: (handler: ((key: string) => boolean) | null) => void
  registerInterruption?: (cancel: (() => void) | null) => void
  interaction?: FieldInteractionPolicy
  onFieldPlacement?: (event: FieldPlacement) => void
  onGestureActive?: (active: boolean) => void
  /**
   * The scorer accepted the trajectory at `angle`: `dragged` when his drag
   * on the field turned the angle, `false` for a gesture that left it where
   * it was (up or down by no more than `TAP_SLOP_PX`, and then `angle` is
   * where it started), and absent from the keyboard, whose arrows leave no
   * gesture to tell by.
   */
  onTrajectoryAccepted?: (
    angle: number,
    generation: number,
    dragged?: boolean
  ) => void
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
  /** Screen-space nameplates, projected after the camera transform. */
  onNameplates?: (plates: NameplatePlacement[]) => void
  players: FieldPlayer[]
  selected: string
  onSelect: (id: string) => void
  view: CameraView
  zoom: number
  cameraTilt?: number
  cameraHeight?: number
  bottomExtension?: number
  /** Wake an on-demand renderer after commands issued from the RN controls. */
  movementRevision?: number
}
