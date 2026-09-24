import React, { useRef } from 'react'

import type { RosterSelectorDragProps } from './rosterSelectorDragProps'
export function RosterSelectorDrag({
  children,
  value,
  width,
  onMove,
  onChange
}: RosterSelectorDragProps): React.ReactElement {
  const pointer = useRef<
    | { id: number; start: number; left: number; width: number; moved: boolean }
    | undefined
  >(undefined)
  const suppressClick = useRef(false)
  return (
    <div
      style={{ touchAction: 'none', userSelect: 'none' }}
      onPointerDownCapture={event => {
        if (event.button !== 0) return
        const rect = event.currentTarget.getBoundingClientRect()
        pointer.current = {
          id: event.pointerId,
          start: event.clientX,
          left: rect.left,
          width: rect.width,
          moved: false
        }
        suppressClick.current = false
      }}
      onPointerMoveCapture={event => {
        const drag = pointer.current
        if (drag?.id !== event.pointerId) return
        drag.moved ||= Math.abs(event.clientX - drag.start) > 6
        if (!drag.moved) return
        event.currentTarget.setPointerCapture(event.pointerId)
        suppressClick.current = true
        onMove(
          Math.max(
            0,
            Math.min(drag.width / 2, event.clientX - drag.left - drag.width / 4)
          )
        )
      }}
      onPointerUpCapture={event => {
        const drag = pointer.current
        pointer.current = undefined
        if (drag?.moved !== true) return
        const next = event.clientX - drag.left < drag.width / 2 ? 0 : 1
        onChange(next)
        onMove((next * drag.width) / 2)
      }}
      onPointerCancel={() => {
        pointer.current = undefined
        suppressClick.current = true
        onMove((value * width) / 2)
      }}
      onLostPointerCapture={event => {
        if (event.target !== event.currentTarget || pointer.current == null)
          return
        pointer.current = undefined
        onMove((value * width) / 2)
      }}
      onClickCapture={event => {
        if (!suppressClick.current) return
        event.preventDefault()
        event.stopPropagation()
        suppressClick.current = false
      }}
    >
      {children}
    </div>
  )
}
