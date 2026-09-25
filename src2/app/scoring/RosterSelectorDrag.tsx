import React, { useRef } from 'react'

import type { RosterSelectorDragProps } from './rosterSelectorDragProps'
export function RosterSelectorDrag({
  children,
  count = 2,
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
            Math.min(
              drag.width * (1 - 1 / count),
              event.clientX - drag.left - drag.width / (2 * count)
            )
          )
        )
      }}
      onPointerUpCapture={event => {
        const drag = pointer.current
        pointer.current = undefined
        if (drag?.moved !== true) return
        const next = Math.max(
          0,
          Math.min(
            count - 1,
            Math.floor(
              ((event.clientX - drag.left) / Math.max(1, drag.width)) * count
            )
          )
        )
        onChange(next)
        onMove((next * drag.width) / count)
      }}
      onPointerCancel={() => {
        pointer.current = undefined
        suppressClick.current = true
        onMove((value * width) / count)
      }}
      onLostPointerCapture={event => {
        if (event.target !== event.currentTarget || pointer.current == null)
          return
        pointer.current = undefined
        onMove((value * width) / count)
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
