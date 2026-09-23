import type React from 'react'
export interface RosterDragProps {
  targetId?: string
  playerId?: number
  disabled?: boolean
  onDropPlayer?: (id: number) => void
  children: React.ReactNode
}
