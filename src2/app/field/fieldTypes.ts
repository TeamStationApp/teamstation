import type { CameraView, FieldPlayer } from './fieldModel'

export interface FieldCanvasProps {
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
