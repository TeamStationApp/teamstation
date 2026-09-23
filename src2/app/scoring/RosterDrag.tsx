import React, { createContext, useContext, useRef } from 'react'

import type { RosterDragProps } from './rosterDragProps'

interface DragGroup {
  targets: Map<Element, (id: number) => void>
}
const Context = createContext<DragGroup>({ targets: new Map() })
export function RosterDragGroup({
  children
}: {
  children: React.ReactNode
}): React.ReactElement {
  const group = useRef<DragGroup>({ targets: new Map() })
  return <Context.Provider value={group.current}>{children}</Context.Provider>
}

export function RosterDrag(props: RosterDragProps): React.ReactElement {
  const group = useContext(Context)
  const gesture = useRef<{
    id: number
    x: number
    y: number
    moved: boolean
  } | null>(null)
  const release = (
    event: React.PointerEvent<HTMLDivElement>,
    cancel: boolean
  ): void => {
    const drag = gesture.current
    gesture.current = null
    if (drag?.moved === true && !cancel) {
      const elements = document.elementsFromPoint(event.clientX, event.clientY)
      for (const element of elements) {
        const target = group.targets.get(element)
        if (target != null) {
          target(drag.id)
          break
        }
      }
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
  }
  return (
    <div
      data-roster-player={props.playerId}
      data-roster-target={props.targetId}
      ref={node => {
        if (node == null) return
        if (props.onDropPlayer != null)
          group.targets.set(node, props.onDropPlayer)
        else group.targets.delete(node)
        return () => {
          group.targets.delete(node)
        }
      }}
      style={{
        touchAction:
          props.playerId == null || props.disabled === true ? 'auto' : 'none',
        opacity: props.disabled === true ? 0.4 : 1
      }}
      onPointerDown={event => {
        if (
          props.disabled === true ||
          props.playerId == null ||
          event.button !== 0 ||
          (event.target as Element).closest('button,input') != null
        )
          return
        gesture.current = {
          id: props.playerId,
          x: event.clientX,
          y: event.clientY,
          moved: false
        }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={event => {
        const drag = gesture.current
        if (
          drag != null &&
          Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 6
        )
          drag.moved = true
      }}
      onPointerUp={event => {
        release(event, false)
      }}
      onPointerCancel={event => {
        release(event, true)
      }}
      onLostPointerCapture={() => {
        gesture.current = null
      }}
    >
      {props.children}
    </div>
  )
}
