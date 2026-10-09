import type React from 'react'
export interface RosterDragProps {
  targetId?: string
  playerId?: number
  label?: string
  /** Player information announced with the control action. */
  value?: string
  disabled?: boolean
  /** Mouse dragging starts immediately; touch still holds to preserve scrolling. */
  immediateMouseDrag?: boolean
  onTap?: () => void
  onReorder?: (delta: number) => void
  insertion?: 'row' | 'end'
  onDropPlayer?: (id: number, edge?: 'before' | 'after') => void
  children: React.ReactNode
}
