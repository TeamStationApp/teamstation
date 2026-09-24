import type React from 'react'
export interface RosterDragProps {
  targetId?: string
  playerId?: number
  label?: string
  disabled?: boolean
  onTap?: () => void
  onReorder?: (delta: number) => void
  onDropPlayer?: (id: number) => void
  children: React.ReactNode
}
