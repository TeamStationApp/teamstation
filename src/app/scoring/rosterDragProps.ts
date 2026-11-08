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
  /**
   * No hold on any pointer: a contact that travels 10 px drags at once and a
   * shorter one is a tap.
   */
  immediate?: boolean
  /** A drop target at a fixed spot, which a lifted card never shifts. */
  fixed?: boolean
  onTap?: () => void
  onReorder?: (delta: number) => void
  insertion?: 'row' | 'end'
  onDropPlayer?: (id: number, edge?: 'before' | 'after') => void
  children: React.ReactNode
}
