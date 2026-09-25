import type React from 'react'
export interface RosterDragProps {
  targetId?: string
  playerId?: number
  label?: string
  disabled?: boolean
  onTap?: () => void
  onReorder?: (delta: number) => void
  insertion?: 'row' | 'end'
  onDropPlayer?: (id: number, edge?: 'before' | 'after') => void
  children: React.ReactNode
}
