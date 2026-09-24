import type React from 'react'
export interface RosterSelectorDragProps {
  value: number
  width: number
  onMove: (x: number) => void
  onChange: (value: number) => void
  children: React.ReactNode
}
