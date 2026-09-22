import type { CameraView, FieldPlayer } from './fieldModel'

export interface FieldCanvasProps {
  players: FieldPlayer[]
  selected: string
  onSelect: (id: string) => void
  view: CameraView
  zoom: number
}
