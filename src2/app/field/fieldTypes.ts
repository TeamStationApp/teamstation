import type { ArcMode, BallArcState } from './ballArcModel'
import type { CameraView, FieldPlayer } from './fieldModel'

export interface FieldCanvasProps {
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
